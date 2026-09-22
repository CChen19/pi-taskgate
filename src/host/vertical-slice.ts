import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Catalog, ModelProfile } from '../core/contracts.ts';
import { planDispatch } from '../core/preflight.ts';
import { TaskGraph } from '../core/task-graph.ts';
import { Scheduler, type SchedulerEvent, type SchedulerOptions } from '../core/scheduler.ts';
import type { ExecutorPort, AttemptSettlement } from '../core/executor-port.ts';
import { MechanicalVerifier, decideVerdict, type EvidenceBundle, type VerificationRunner, type VerificationVerdict } from '../core/verification.ts';
import { assembleReviewerBrief, decideFinalVerdict, s2VerdictInput, validateReviewVerdict, type ReviewBrief, type ReviewVerdict } from '../core/reviewer-brief.ts';
import { needsFreshReview, planRoute, type ReviewerStrategy } from '../core/gate.ts';
import { planIntegration, runIntegration, type IntegrationReport, type IntegrationRunner, type IntegrationUnit } from '../core/integration.ts';
import { type TaskContract } from '../core/task-contract.ts';
import { WorktreeManager, type WorktreePort, type WorkspaceLease } from '../adapters/worktree-manager.ts';
import { PiHerdrExecutor, type HerdrSpawnRequest, type HerdrSubagentPort } from '../adapters/pi-herdr-executor.ts';
import { assembleScopedContext, renderScopedPrompt } from '../adapters/scoped-context.ts';
import { createRealHost, type RealHostOptions } from './index.ts';
import type { HerdrCliConfig } from './herdr-cli-port.ts';
import { StructuredAgentRunner } from './structured-agent-runner.ts';
import { buildPlannerPrompt, validateRunPlan, RunPlanValidationError, type RunPlan } from './run-plan.ts';
import { GitIntegrationRunner } from './git-integration-runner.ts';
import { validateRuntimeManifest } from './runtime-manifests.ts';

/**
 * Run-wide immutable base: only complete git object ids are accepted
 * (SHA-1 repos use 40 hex characters; 64 hex covers SHA-256 object ids).
 * HEAD/branch/tag/short-SHA/revspec values are rejected because every
 * worker/integration workspace resolves them against its own HEAD.
 */
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Shared rejection text; tells the user exactly how to obtain a valid value. */
export const BASE_REVISION_REJECTION = 'baseRevision must be a complete immutable git object id (40 or 64 hex characters). Run `git rev-parse HEAD` in the target repository and paste the full SHA verbatim. HEAD, branch/tag names, short SHAs, and revision expressions are rejected because worker and integration worktrees would resolve them against their own HEAD.';

/** Test-facing predicate for immutable full git object ids. */
export function isValidGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID_PATTERN.test(value);
}

/** Normalize an accepted object id to git's canonical lowercase form. */
export function normalizeGitObjectId(value: string): string {
  return value.toLowerCase();
}

export interface VerticalSliceConfig {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly baseRevision: string;
  readonly userTask: string;
  readonly catalog: Catalog;
  readonly provider?: string;
  readonly model?: string;
  readonly plannerRoleId: string;
  readonly implementerRoleId: string;
  readonly reviewerRoleId: string;
  readonly plannerModelProfileId: string;
  readonly implementerModelProfileId: string;
  readonly reviewerModelProfileId: string;
  readonly herdr: HerdrCliConfig;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly runTimeoutMs: number;
  readonly reviewerStrategy: ReviewerStrategy;
  readonly finalOutputDir: string;
  readonly verificationAllowlist: readonly string[];
  readonly verificationTimeoutMs: number;
  readonly plannerRetries?: number;
  readonly planFile?: string;
}

export interface VerticalHost {
  readonly herdr: HerdrSubagentPort;
  readonly worktree: WorktreePort;
  readonly createVerificationRunner: (workspacePath: string, commands: readonly string[]) => VerificationRunner;
  readonly readArtifactDiff: (workspacePath: string, baseRevision: string, artifactRevision: string) => string;
  readonly commandRunner?: RealHostOptions['commandRunner'];
}

export interface PlannerPort {
  plan(input: { readonly userTask: string; readonly repoRoot: string; readonly baseRevision: string; readonly authorizedVerificationCommands: readonly string[]; readonly feedback?: string }): Promise<unknown> | unknown;
  cancel?(reason: string): void;
}
export interface ReviewerPort {
  review(brief: ReviewBrief, context: { readonly workspacePath: string }): Promise<unknown> | unknown;
  cancel?(reason: string): void;
}
export interface SchedulerFactory { create(graph: TaskGraph, executor: ExecutorPort, options: SchedulerOptions): Scheduler; }
export interface ArtifactFinalizer { finalizeArtifact(taskId: string, attemptId: string): unknown; }

export interface VerticalSliceDependencies {
  readonly host?: VerticalHost;
  readonly executor?: ExecutorPort;
  readonly planner?: PlannerPort;
  readonly reviewer?: ReviewerPort;
  readonly schedulerFactory?: SchedulerFactory;
  readonly integrationRunner?: IntegrationRunner;
  readonly integrationLease?: WorkspaceLease;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly runId?: string;
}

export interface TaskRunResult {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly verification: VerificationVerdict;
  readonly evidence: EvidenceBundle;
  readonly review?: ReviewVerdict;
}

export interface VerticalRunSummary {
  readonly runId: string;
  readonly status: 'passed' | 'failed';
  readonly plan?: RunPlan;
  readonly taskResults: readonly TaskRunResult[];
  readonly integration?: IntegrationReport;
  readonly finalRevision?: string;
  readonly finalBranch?: string;
  readonly finalPath?: string;
  readonly metrics: { readonly modelCalls: number; readonly attempts: number; readonly schedulerEvents: number; readonly humanInterventions: 0; readonly retries: number };
  readonly error?: string;
}

class RunJournal {
  readonly runId: string;
  readonly path: string;
  private sequence = 0;
  constructor(root: string, runId: string) {
    this.runId = runId; this.path = resolve(root, '.agent-orchestrator', 'runs', `${runId}.jsonl`);
    mkdirSync(resolve(root, '.agent-orchestrator', 'runs'), { recursive: true, mode: 0o700 });
  }
  write(kind: string, payload: Record<string, unknown>, clock: () => number): void {
    this.sequence++;
    appendFileSync(this.path, `${JSON.stringify({ sequence: this.sequence, runId: this.runId, kind, timestamp: clock(), ...payload })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function idSource(runId: string): () => string {
  let count = 0;
  return () => createHash('sha256').update(`${runId}:${++count}`).digest('hex').slice(0, 24);
}

function profile(catalog: Catalog, profileId: string): ModelProfile {
  const id = profileId;
  const result = catalog.getModelProfile(id);
  if (result === undefined) throw new Error(`unknown model profile ${id}`);
  return result;
}

function fakeContract(id: string, objective: string): TaskContract {
  return { id, objective, depends_on: [], files_in_scope: [], acceptance_criteria: ['return a structured result'], verification: [], retry: { max_attempts: 0 } };
}

function structuredRequest(config: VerticalSliceConfig, catalog: Catalog, roleId: string, profileId: string, taskId: string, prompt: string, cwd: string, withContext = true): HerdrSpawnRequest {
  const role = catalog.getRole(roleId);
  if (role === undefined) throw new Error(`unknown role ${roleId}`);
  const model = profile(catalog, profileId);
  const contract = fakeContract(taskId, prompt.slice(0, 120));
  const context = assembleScopedContext({ taskId, objective: contract.objective, acceptanceCriteria: contract.acceptance_criteria, filesInScope: [], verificationCommands: [], role: { id: role.id, kind: role.kind }, model: { profileId: model.id, provider: model.provider, model: model.model }, baseRevision: config.baseRevision, artifactRevision: config.baseRevision, evidenceSummaries: [], referenceSummaries: [] });
  return Object.freeze({ taskId, attemptId: `${taskId}:attempt-1`, cwd, roleId, modelProfileId: model.id, provider: model.provider, model: model.model, contract, scopedContext: context, prompt: withContext ? `${renderScopedPrompt(context)}\n\n${prompt}` : prompt, baseRevision: config.baseRevision });
}

export class StructuredPlanner implements PlannerPort {
  private readonly config: VerticalSliceConfig;
  private readonly runner: StructuredAgentRunner;
  private readonly cwd: string;
  constructor(config: VerticalSliceConfig, runner: StructuredAgentRunner, cwd = process.cwd()) { this.config = config; this.runner = runner; this.cwd = cwd; }
  async plan(input: { readonly userTask: string; readonly repoRoot: string; readonly baseRevision: string; readonly authorizedVerificationCommands: readonly string[]; readonly feedback?: string }): Promise<RunPlan> {
    const profileId = this.config.plannerModelProfileId;
    const request = structuredRequest(this.config, this.config.catalog, this.config.plannerRoleId, profileId, 'Tplanner', buildPlannerPrompt(input), this.cwd);
    const result = await this.runner.run(request);
    return validateRunPlan(JSON.parse(result.assistantText) as unknown);
  }
  cancel(reason = 'planner cancelled'): void { this.runner.cancel(reason); }
}

export class StructuredReviewer implements ReviewerPort {
  private readonly config: VerticalSliceConfig;
  private readonly runner: StructuredAgentRunner;
  constructor(config: VerticalSliceConfig, runner: StructuredAgentRunner) { this.config = config; this.runner = runner; }
  async review(brief: ReviewBrief, context: { readonly workspacePath: string }): Promise<ReviewVerdict> {
    if (context.workspacePath.length === 0) throw new Error('review workspacePath is required');
    const profileId = this.config.reviewerModelProfileId;
    const prompt = 'Review only the supplied spec, actual revision-bound diff, and S5 evidence. Do not edit or execute commands. Return exact JSON only: {"outcome":"passed"|"rejected","reasons":[string],"artifactRevision":string}.\n' + JSON.stringify({ spec: brief.spec, diff: brief.diff, evidence: brief.evidence });
    const request = structuredRequest(this.config, this.config.catalog, this.config.reviewerRoleId, profileId, 'Treviewer', prompt, context.workspacePath, false);
    const result = await this.runner.run(request);
    return validateReviewVerdict(JSON.parse(result.assistantText) as unknown);
  }
  cancel(reason = 'reviewer cancelled'): void { this.runner.cancel(reason); }
}

function orderedTasks(plan: RunPlan): readonly TaskContract[] {
  const remaining = [...plan.tasks]; const result: TaskContract[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((task) => task.depends_on.every((dependency) => result.some((entry) => entry.id === dependency)));
    if (index < 0) throw new Error('plan dependencies cannot be topologically ordered');
    result.push(remaining.splice(index, 1)[0]!);
  }
  return result;
}

function eventPayload(event: SchedulerEvent): Record<string, unknown> {
  if (event.type === 'attempt_settled') return { type: event.type, taskId: event.taskId, attemptId: event.attemptId, outcome: event.outcome, acceptanceEligible: event.settlement.acceptanceEligible, artifact: event.settlement.artifact };
  if (event.type === 'acceptance_blocked') return { type: event.type, taskId: event.taskId, attemptId: event.attemptId, acceptanceEligible: event.settlement.acceptanceEligible, artifact: event.settlement.artifact };
  const payload: Record<string, unknown> = { type: event.type };
  if ('taskId' in event) payload.taskId = event.taskId;
  if ('attemptId' in event) payload.attemptId = event.attemptId;
  return payload;
}

export class VerticalSliceCoordinator {
  private readonly config: VerticalSliceConfig;
  private readonly dependencies: VerticalSliceDependencies;
  private integrationLease: WorkspaceLease | undefined;
  private activeScheduler: Scheduler | undefined;
  private activeGraph: TaskGraph | undefined;
  private cancelled = false;
  private activePlanner: PlannerPort | undefined;
  private activeReviewer: ReviewerPort | undefined;
  constructor(config: VerticalSliceConfig, dependencies: VerticalSliceDependencies = {}) { validateConfig(config); this.config = config; this.dependencies = dependencies; this.integrationLease = dependencies.integrationLease; this.activePlanner = dependencies.planner; this.activeReviewer = dependencies.reviewer; }
  /** Cancel running workers while leaving real cancelled artifacts auditable. */
  cancel(reason = 'cancelled by host'): void {
    this.cancelled = true;
    try { this.activePlanner?.cancel?.(reason); } catch { /* cleanup continues */ }
    try { this.activeReviewer?.cancel?.(reason); } catch { /* cleanup continues */ }
    if (this.activeScheduler === undefined || this.activeGraph === undefined) return;
    for (const task of this.activeGraph.snapshot().tasks) if (task.state === 'RUNNING') this.activeScheduler.cancelTask(task.id, reason);
  }

  async run(): Promise<VerticalRunSummary> {
    const clock = this.dependencies.clock ?? (() => Date.now());
    const sleep = this.dependencies.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
    const runId = this.dependencies.runId ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const journal = new RunJournal(this.config.workspaceRoot, runId);
    journal.write('run_started', {}, clock);
    let modelCalls = 0; let retries = 0; let attempts = 0; let schedulerEventCount = 0;
    let plan: RunPlan;
    try {
      plan = await this.makePlan(journal, clock, (feedback) => { modelCalls++; if (feedback !== undefined) retries++; });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 160) : 'planner failed';
      journal.write('run_failed', { phase: 'planner', error: message }, clock);
      journal.write('run_finished', { status: 'failed' }, clock);
      const summary = this.summary(runId, 'failed', undefined, [], undefined, { modelCalls, attempts, schedulerEvents: 0, humanInterventions: 0, retries }, message);
      this.persistSummary(summary); return summary;
    }
    if (this.cancelled) {
      const message = 'vertical slice cancelled';
      journal.write('run_failed', { phase: 'planner', error: message }, clock);
      journal.write('run_finished', { status: 'failed' }, clock);
      const summary = this.summary(runId, 'failed', undefined, [], undefined, { modelCalls, attempts, schedulerEvents: 0, humanInterventions: 0, retries }, message);
      this.persistSummary(summary); return summary;
    }
    try { validatePlanVerification(plan, this.config.verificationAllowlist); }
    catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 160) : 'plan verification command is not authorized';
      journal.write('run_failed', { phase: 'plan', error: message }, clock);
      journal.write('run_finished', { status: 'failed' }, clock);
      const summary = this.summary(runId, 'failed', plan, [], undefined, { modelCalls, attempts, schedulerEvents: 0, humanInterventions: 0, retries }, message);
      this.persistSummary(summary); return summary;
    }
    const graph = new TaskGraph();
    for (const task of orderedTasks(plan)) { const added = graph.addTask(task); if (!added.ok) throw new Error(added.error.message); }
    const { host, executor } = this.runtime(runId, clock);
    const scheduler = this.makeScheduler(graph, executor, clock);
    this.activeScheduler = scheduler;
    this.activeGraph = graph;
    const results = new Map<string, TaskRunResult>();
    let processedEvents = 0;
    const startedAt = clock();
    let failure: string | undefined;
    try {
      for (;;) {
        if (this.cancelled) throw new Error('vertical slice cancelled');
        if (clock() - startedAt > this.config.runTimeoutMs) throw new Error('vertical slice run timed out');
        const events = scheduler.tick();
        schedulerEventCount += events.length;
        for (const event of events) {
          journal.write('scheduler', eventPayload(event), clock);
          processedEvents++;
          if (event.type === 'retry_scheduled') retries++;
          // Scheduler emits task_started only after executor.start returned a
          // valid handle, so each event is exactly one real model session and
          // pure start failures (executor_error) are never counted.
          if (event.type === 'task_started') modelCalls++;
          if (event.type === 'attempt_settled') {
            attempts++;
            if (event.settlement.acceptanceEligible) {
              const outcome = await this.acceptAttempt(event.taskId, event.attemptId, event.settlement, graph, scheduler, host, executor, journal, clock, () => { modelCalls++; });
              if (outcome !== undefined) results.set(event.taskId, outcome);
            }
          }
        }
        const snapshot = graph.snapshot();
        if (snapshot.tasks.some((task) => task.state === 'FAILED' || task.state === 'BLOCKED')) {
          failure = 'a task failed or was blocked by a failed dependency';
          for (const task of snapshot.tasks) if (task.state === 'RUNNING' || task.state === 'READY' || task.state === 'RETRYING') scheduler.cancelTask(task.id, 'run stopped after task failure');
          break;
        }
        if (snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.state === 'PASSED')) break;
        if (events.length === 0 && scheduler.activeCount() === 0) await sleep(this.config.pollIntervalMs);
        else if (scheduler.activeCount() > 0) await sleep(this.config.pollIntervalMs);
        if (processedEvents > 100_000) throw new Error('scheduler event limit exceeded');
      }
      if (failure !== undefined) throw new Error(failure);
      const integration = await this.integrate(plan, [...results.values()], host, executor, runId, clock, journal);
      schedulerEventCount = scheduler.events().length;
      const passed = integration.outcome === 'merged' && integration.finalVerification?.verdict.verdict === 'passed';
      const summary = this.summary(runId, passed ? 'passed' : 'failed', plan, [...results.values()], integration, { modelCalls, attempts, schedulerEvents: schedulerEventCount, humanInterventions: 0, retries }, passed ? undefined : `integration outcome: ${integration.outcome}`);
      journal.write('run_finished', { status: summary.status }, clock);
      this.persistSummary(summary); return summary;
    } catch (error) {
      this.cancel(error instanceof Error ? error.message : 'vertical slice failed');
      schedulerEventCount = scheduler.events().length;
      const message = error instanceof Error ? error.message.slice(0, 160) : 'vertical slice failed';
      journal.write('run_failed', { phase: 'execution', error: message }, clock);
      journal.write('run_finished', { status: 'failed' }, clock);
      const summary = this.summary(runId, 'failed', plan, [...results.values()], undefined, { modelCalls, attempts, schedulerEvents: schedulerEventCount, humanInterventions: 0, retries }, message);
      this.persistSummary(summary); return summary;
    }
  }

  private async makePlan(journal: RunJournal, clock: () => number, count: (feedback?: string) => void): Promise<RunPlan> {
    if (this.config.planFile !== undefined) {
      const plan = validateRunPlan(JSON.parse(readFileSync(this.config.planFile, 'utf8')) as unknown);
      validatePlanVerification(plan, this.config.verificationAllowlist);
      journal.write('planner_result', { source: 'plan-file', taskCount: plan.tasks.length, executionMode: plan.executionMode }, clock);
      return plan;
    }
    if (this.dependencies.planner === undefined) throw new Error('planner is required unless planFile is supplied');
    let feedback: string | undefined;
    const maxRetries = this.config.plannerRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.cancelled) throw new Error('vertical slice cancelled before planner attempt');
      journal.write(attempt === 0 ? 'planner_start' : 'planner_retry', { attempt: attempt + 1 }, clock);
      count(feedback);
      try {
        const raw = await this.dependencies.planner.plan({ userTask: this.config.userTask, repoRoot: this.config.repoRoot, baseRevision: this.config.baseRevision, authorizedVerificationCommands: this.config.verificationAllowlist, ...(feedback === undefined ? {} : { feedback }) });
        const plan = validateRunPlan(raw);
        journal.write('planner_result', { source: 'planner', attempt: attempt + 1, taskCount: plan.tasks.length, executionMode: plan.executionMode }, clock);
        return plan;
      } catch (error) {
        // Cancellation (SIGINT/transport interrupt) and transport/model failures
        // are never structural planner-output errors; they fail the run now.
        if (this.cancelled || !isStructuralPlannerFailure(error)) throw error;
        feedback = `planner output failed strict RunPlan structural validation: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown structural error'}`;
        if (attempt >= maxRetries) throw error;
      }
    }
    throw new Error('planner exhausted retries');
  }

  private runtime(runId: string, clock: () => number): { readonly host: VerticalHost; readonly executor: ExecutorPort } {
    if (this.dependencies.executor !== undefined) {
      if (this.dependencies.host === undefined) throw new Error('host is required with an injected executor');
      return { host: this.dependencies.host, executor: this.dependencies.executor };
    }
    const host = this.dependencies.host ?? createRealHost({ repoRoot: this.config.repoRoot, workspaceRoot: this.config.workspaceRoot, herdr: this.config.herdr, verificationAllowlist: this.config.verificationAllowlist, verificationTimeoutMs: this.config.verificationTimeoutMs });
    const workspace = new WorktreeManager({ repoRoot: this.config.repoRoot, workspaceRoot: this.config.workspaceRoot, idSource: idSource(runId) });
    const implementerProfile = profile(this.config.catalog, this.config.implementerModelProfileId).id;
    const executor = new PiHerdrExecutor({ herdr: host.herdr, workspace, worktreePort: host.worktree, dispatchResolver: (request) => planDispatch(this.config.catalog, request), roleId: this.config.implementerRoleId, modelProfileId: implementerProfile, baseRevision: this.config.baseRevision, clock, retainCancelledArtifacts: true });
    return { host, executor };
  }

  private makeScheduler(graph: TaskGraph, executor: ExecutorPort, clock: () => number): Scheduler {
    const options: SchedulerOptions = { concurrency: this.config.concurrency, clock };
    return this.dependencies.schedulerFactory?.create(graph, executor, options) ?? new Scheduler(graph, executor, options);
  }

  private async acceptAttempt(taskId: string, attemptId: string, settlement: AttemptSettlement, graph: TaskGraph, scheduler: Scheduler, host: VerticalHost, executor: ExecutorPort, journal: RunJournal, clock: () => number, onModelCall: () => void): Promise<TaskRunResult | undefined> {
    const artifact = settlement.artifact;
    if (artifact.workspacePath === undefined || artifact.branch === undefined || artifact.artifactRevision.length === 0) throw new Error(`task ${taskId} settlement lacks artifact provenance`);
    const workspacePath = artifact.workspacePath;
    const task = graph.getTask(taskId); if (task === undefined) throw new Error(`task ${taskId} disappeared`);
    const verifier = new MechanicalVerifier();
    const commands = task.contract.verification.map((command) => ({ command, cwd: workspacePath, timeoutMs: this.config.verificationTimeoutMs }));
    const runner = host.createVerificationRunner(workspacePath, this.config.verificationAllowlist);
    const evidence = verifier.run(commands, { taskId, attemptId, artifactRevision: artifact.artifactRevision, clock, runner });
    const mechanical = decideVerdict(evidence);
    journal.write('verification', { taskId, attemptId, artifact: { workspacePath: artifact.workspacePath, branch: artifact.branch, revision: artifact.artifactRevision }, verdict: mechanical.verdict }, clock);
    if (mechanical.verdict === 'rejected') {
      const rejected = scheduler.submitVerdict(taskId, 'rejected');
      if (!rejected.ok) throw new Error(rejected.error.message);
      for (const event of rejected.events) journal.write('scheduler', eventPayload(event), clock);
      this.finalize(executor, taskId, attemptId);
      return undefined;
    }
    const route = planRoute(task.contract, { reviewer: this.config.reviewerStrategy });
    const reviewRequired = needsFreshReview(route, { status: 'passed' });
    let review: ReviewVerdict | undefined;
    if (reviewRequired.required) {
      if (this.dependencies.reviewer === undefined) throw new Error('reviewer is required by route');
      let patch: string;
      try {
        patch = host.readArtifactDiff(workspacePath, this.config.baseRevision, artifact.artifactRevision);
        if (typeof patch !== 'string' || patch.length === 0) throw new Error('artifact diff was empty');
      }
      catch (error) {
        const rejected = scheduler.submitVerdict(taskId, 'rejected');
        if (!rejected.ok) throw new Error(rejected.error.message);
        for (const event of rejected.events) journal.write('scheduler', eventPayload(event), clock);
        this.finalize(executor, taskId, attemptId);
        return undefined;
      }
      const brief = assembleReviewerBrief({ spec: { objective: task.contract.objective, acceptance_criteria: task.contract.acceptance_criteria, files_in_scope: task.contract.files_in_scope ?? [] }, artifactRevision: artifact.artifactRevision, diff: { artifactRevision: artifact.artifactRevision, patch }, evidence });
      try { onModelCall(); review = validateReviewVerdict(await this.dependencies.reviewer.review(brief, { workspacePath })); }
      catch (error) { review = { outcome: 'rejected', reasons: [error instanceof Error ? error.message.slice(0, 160) : 'reviewer returned malformed JSON'], artifactRevision: artifact.artifactRevision }; }
      journal.write('reviewer', { taskId, attemptId, outcome: review.outcome, artifactRevision: review.artifactRevision }, clock);
    }
    let final: 'passed' | 'rejected' | 'needs_review';
    try { final = decideFinalVerdict(mechanical, review, reviewRequired); }
    catch (error) {
      journal.write('reviewer', { taskId, attemptId, outcome: 'rejected', artifactRevision: artifact.artifactRevision, reason: error instanceof Error ? error.message.slice(0, 160) : 'review revision mismatch' }, clock);
      final = 'rejected';
    }
    if (final === 'needs_review') final = 'rejected';
    const submitted = scheduler.submitVerdict(taskId, s2VerdictInput(final));
    if (!submitted.ok) throw new Error(submitted.error.message);
    for (const event of submitted.events) journal.write('scheduler', eventPayload(event), clock);
    if (final === 'rejected') { this.finalize(executor, taskId, attemptId); return undefined; }
    return { taskId, attemptId, artifactRevision: artifact.artifactRevision, workspacePath: artifact.workspacePath, branch: artifact.branch, verification: mechanical, evidence, ...(review === undefined ? {} : { review }) };
  }

  private finalize(executor: ExecutorPort, taskId: string, attemptId: string): void {
    const finalizer = executor as ExecutorPort & Partial<ArtifactFinalizer>;
    if (typeof finalizer.finalizeArtifact !== 'function') return;
    const result = finalizer.finalizeArtifact(taskId, attemptId) as { ok?: boolean };
    if (result !== undefined && result.ok === false) throw new Error(`artifact cleanup failed for ${taskId}/${attemptId}`);
  }

  private async integrate(plan: RunPlan, results: readonly TaskRunResult[], host: VerticalHost, executor: ExecutorPort, runId: string, clock: () => number, journal: RunJournal): Promise<IntegrationReport> {
    if (results.length !== plan.tasks.length) throw new Error('not all tasks produced accepted artifacts');
    const units: IntegrationUnit[] = results.map((result) => ({ taskId: result.taskId, branch: result.branch, revision: result.artifactRevision, verification: result.verification }));
    const mergePlan = planIntegration(units, { baseRevision: this.config.baseRevision, order: plan.tasks.map((task) => task.id), dependencies: plan.tasks.map((task) => ({ taskId: task.id, dependsOn: [...task.depends_on] })), verificationCommands: plan.finalVerification });
    let runner = this.dependencies.integrationRunner;
    let integrationLease = this.dependencies.integrationLease;
    const manager = new WorktreeManager({ repoRoot: this.config.repoRoot, workspaceRoot: this.config.workspaceRoot, idSource: idSource(`${runId}:integration`) });
    if (runner === undefined) {
      integrationLease = integrationLease ?? manager.acquire(host.worktree, 'Tintegration', 'Tintegration:attempt-1', this.config.baseRevision);
      if (host.commandRunner === undefined) throw new Error('real integration requires host commandRunner');
      // Hold only the frozen plain port; the class instance must never cross
      // the strict core boundary (core rejects non-plain runner objects).
      runner = new GitIntegrationRunner({ commandRunner: host.commandRunner, integration: integrationLease, baseRevision: this.config.baseRevision, verificationAllowlist: this.config.verificationAllowlist, verificationTimeoutMs: this.config.verificationTimeoutMs }).asPort();
    }
    this.integrationLease = integrationLease;
    const report = runIntegration(mergePlan, runner, { clock });
    journal.write('integration', { outcome: report.outcome, conflicts: report.conflicts, finalRevision: report.finalVerification?.evidence.artifactRevision, integrationWorkspace: integrationLease?.workspacePath, integrationBranch: integrationLease?.branch }, clock);
    if (report.outcome === 'merged') for (const result of results) this.finalize(executor, result.taskId, result.attemptId);
    return report;
  }

  private summary(runId: string, status: 'passed' | 'failed', plan: RunPlan | undefined, results: readonly TaskRunResult[], integration: IntegrationReport | undefined, metrics: VerticalRunSummary['metrics'], error?: string): VerticalRunSummary {
    const summary = { runId, status, ...(plan === undefined ? {} : { plan }), taskResults: results, ...(integration === undefined ? {} : { integration }), ...(integration?.finalVerification === undefined ? {} : { finalRevision: integration.finalVerification.evidence.artifactRevision }), ...(this.integrationLease === undefined ? {} : { finalBranch: this.integrationLease.branch, finalPath: this.integrationLease.workspacePath }), metrics, ...(error === undefined ? {} : { error }) } as VerticalRunSummary;
    return Object.freeze(summary);
  }

  private persistSummary(summary: VerticalRunSummary): void {
    const directory = resolve(this.config.finalOutputDir, '.agent-orchestrator', 'runs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(directory, `${summary.runId}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function validatePlanVerification(plan: RunPlan, allowlist: readonly string[]): void {
  for (const command of [...plan.tasks.flatMap((task) => task.verification), ...plan.finalVerification]) {
    if (!allowlist.includes(command)) throw new Error(`verification command is not authorized: ${command}`);
  }
}

/** Only structural output failures (JSON syntax or RunPlan shape) earn a retry with feedback. */
function isStructuralPlannerFailure(error: unknown): boolean {
  return error instanceof RunPlanValidationError || error instanceof SyntaxError;
}

function validateConfig(config: VerticalSliceConfig): void {
  for (const [name, value] of [['repoRoot', config.repoRoot], ['workspaceRoot', config.workspaceRoot], ['userTask', config.userTask], ['plannerRoleId', config.plannerRoleId], ['implementerRoleId', config.implementerRoleId], ['reviewerRoleId', config.reviewerRoleId], ['plannerModelProfileId', config.plannerModelProfileId], ['implementerModelProfileId', config.implementerModelProfileId], ['reviewerModelProfileId', config.reviewerModelProfileId], ['finalOutputDir', config.finalOutputDir]] as const) if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be non-empty`);
  if (!isValidGitObjectId(config.baseRevision)) throw new TypeError(BASE_REVISION_REJECTION);
  if (!Array.isArray(config.verificationAllowlist) || config.verificationAllowlist.length === 0 || config.verificationAllowlist.some((command) => typeof command !== 'string' || command.trim().length === 0)) throw new TypeError('verificationAllowlist must be a non-empty array of non-blank strings');
  if (new Set(config.verificationAllowlist).size !== config.verificationAllowlist.length) throw new TypeError('verificationAllowlist must not contain duplicate commands');
  if (config.reviewerStrategy !== 'auto' && config.reviewerStrategy !== 'always' && config.reviewerStrategy !== 'never') throw new TypeError('reviewerStrategy must be auto, always, or never');
  if (config.plannerRetries !== undefined && (!Number.isInteger(config.plannerRetries) || config.plannerRetries < 0 || config.plannerRetries > 2)) throw new TypeError('plannerRetries must be an integer between 0 and 2');
  if (!Number.isInteger(config.verificationTimeoutMs) || config.verificationTimeoutMs <= 0) throw new TypeError('verificationTimeoutMs must be positive');
  if (!Number.isInteger(config.concurrency) || config.concurrency <= 0) throw new TypeError('concurrency must be positive');
  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs <= 0) throw new TypeError('pollIntervalMs must be positive');
  if (!Number.isInteger(config.runTimeoutMs) || config.runTimeoutMs <= 0) throw new TypeError('runTimeoutMs must be positive');
  const roleEntries = [
    ['planner', config.plannerRoleId, ['read', 'todo_write', 'ask_user_question']],
    ['implementer', config.implementerRoleId, ['read', 'bash', 'edit', 'write', 'todo_write', 'ask_user_question']],
    ['reviewer', config.reviewerRoleId, ['read', 'todo_write', 'ask_user_question']],
  ] as const;
  if (new Set(roleEntries.map((entry) => entry[1])).size !== roleEntries.length) throw new Error('planner, implementer, and reviewer roles must be distinct');
  for (const [label, roleId, requiredTools] of roleEntries) {
    const manifest = config.herdr.roleManifests[roleId];
    if (!validateRuntimeManifest(manifest, roleId) || JSON.stringify(manifest.tools) !== JSON.stringify(requiredTools)) throw new Error(`${label} role ${roleId} requires the exact runtime tool set`);
    if (manifest.unknownTools !== 'deny') throw new Error(`${label} role ${roleId} must deny unknown tools`);
    if (label === 'implementer' && (manifest.permissions.subagent !== 'deny' || manifest.permissions.terminal !== 'deny')) throw new Error('implementer must deny subagent and terminal permissions');
    const base = config.herdr.roleBases[roleId];
    if (typeof base !== 'string' || base.length === 0 || !isAbsolute(base)) throw new Error(`role ${roleId} requires an absolute role base directory`);
  }
  validateAgentPolicy(config);
}

function validateAgentPolicy(config: VerticalSliceConfig): void {
  const agents = [
    ['planner', config.plannerRoleId, config.plannerModelProfileId] as const,
    ['implementer', config.implementerRoleId, config.implementerModelProfileId] as const,
    ['reviewer', config.reviewerRoleId, config.reviewerModelProfileId] as const,
  ];
  for (const [label, roleId, profileId] of agents) {
    const role = config.catalog.getRole(roleId);
    if (role === undefined) throw new Error(`unknown ${label} role ${roleId}`);
    if (config.catalog.getModelProfile(profileId) === undefined) throw new Error(`unknown ${label} model profile ${profileId}`);
    const result = planDispatch(config.catalog, { description: `validate ${label}`, instructions: `validate ${label}`, roleId, modelProfileId: profileId });
    if (!result.ok) throw new Error(`${label} dispatch policy rejected: ${result.error.message}`);
  }
}

export function createRealVerticalSlice(config: VerticalSliceConfig, dependencies: Omit<VerticalSliceDependencies, 'host' | 'executor' | 'planner' | 'reviewer'> = {}): VerticalSliceCoordinator {
  validateConfig(config);
  const host = createRealHost({ repoRoot: config.repoRoot, workspaceRoot: config.workspaceRoot, herdr: config.herdr, verificationAllowlist: config.verificationAllowlist, verificationTimeoutMs: config.verificationTimeoutMs });
  const runner = new StructuredAgentRunner({ herdr: host.herdr, clock: dependencies.clock ?? (() => Date.now()), sleep: dependencies.sleep ?? ((ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))), pollIntervalMs: config.pollIntervalMs, timeoutMs: config.runTimeoutMs });
  const planner = new StructuredPlanner(config, runner, config.repoRoot);
  const reviewer = new StructuredReviewer(config, runner);
  return new VerticalSliceCoordinator(config, { ...dependencies, host, planner, reviewer });
}
