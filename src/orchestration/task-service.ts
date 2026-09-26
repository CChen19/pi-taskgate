/**
 * Deterministic orchestration primitives for a Pi main agent.
 *
 * The main agent decides what to do next; this service supplies ground truth
 * and enforces invariants. It never spawns agents (Pier does that), never
 * trusts a worker's claims, and never lets completion imply acceptance:
 *
 *   start (host-owned worktree) → worker runs in a Pier pane → verify
 *   (host git inspection + scope + allowlisted commands) → optional fresh
 *   review bound to the exact revision → PASSED.
 *
 * Every mutation is a TaskBoard event. An event is trial-applied to a replayed
 * board before it is persisted, so a refused operation leaves state unchanged.
 */
import { randomBytes } from 'node:crypto';
import { checkArtifact, findAddedAsserts } from '../adapters/artifact-check.ts';
import type { WorktreeManager, WorktreePort, WorkspaceLease, WorkspaceInspection, WorktreeSessionBinding } from '../adapters/worktree-manager.ts';
import { assembleReviewerBrief, decideFinalVerdict } from '../core/reviewer-brief.ts';
import { validateTaskContract, type TaskContract } from '../core/task-contract.ts';
import { decideVerdict, validateEvidenceBundle, type EvidenceBundle, type VerificationCommand, type VerificationOutcome } from '../core/verification.ts';
import { isPlainObject } from '../core/validate.ts';
import type { AsyncVerificationRunner } from '../host/process-verification-runner.ts';
import type { CleanRoomCheckout, CleanRoomPort } from '../host/clean-room.ts';
import type { GitHistoryPort } from '../host/git-history.ts';
import type { WorkerLedger } from '../host/pier-ledger.ts';
import type { RoleCheck } from '../host/pier-roles.ts';
import { parseReviewerOutcome, renderReviewerPrompt, renderWorkerBrief } from './briefs.ts';
import { replayTaskBoard, TaskBoard, TaskBoardError, type AppliedCommit, type AttemptRecord, type CandidateRecord, type CheckStage, type IntegrationInput, type TaskEvent, type TaskView } from './task-board.ts';

export interface TaskServiceSettings {
  readonly verificationAllowlist: readonly string[];
  readonly verificationTimeoutMs: number;
  readonly reviewerRole: string;
  readonly maxChecksPerAttempt: number;
  readonly defaultMaxAttempts: number;
}

export interface TaskServicePorts {
  readonly worktrees: WorktreeManager;
  readonly worktreePort: WorktreePort;
  /** Full object id of the main checkout HEAD, read by the host. */
  headRevision(): string;
  readDiff(workspacePath: string, baseRevision: string, artifactRevision: string): string;
  readonly verifier: AsyncVerificationRunner;
  /** Fresh checkouts of exact revisions; verification never runs in a worker's worktree. */
  readonly cleanRoom: CleanRoomPort;
  readonly ledger: WorkerLedger;
  /** Read-only check of a Pier role (default: the configured reviewer role). */
  checkReviewerRole(role?: string): RoleCheck;
  readonly history: GitHistoryPort;
  clock(): number;
  /** Durable sink (Pi session custom entry). Throwing aborts the operation. */
  persist(event: TaskEvent): void;
  randomId?(): string;
  /** Why a subagent could not run in this worktree cwd (e.g. Pier pipe path too long), or undefined. */
  checkWorkerCwd?(workspacePath: string): string | undefined;
  /** User messages in a subagent's own Pi session file; throws when it cannot be read. */
  sessionUserMessages(sessionFile: string): readonly string[];
}

export type ServiceErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_TASK'
  | 'NOT_READY'
  | 'INVALID_STATE'
  | 'BUDGET_EXHAUSTED'
  | 'LEASE_UNAVAILABLE'
  | 'WORKER_UNBOUND'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_RUNNING'
  | 'INSPECTION_FAILED'
  | 'VERIFICATION_ERROR'
  | 'ROLE_NOT_READ_ONLY'
  | 'REVIEW_NOT_REQUESTED'
  | 'REVIEWER_INVALID'
  | 'REVIEWER_NOT_INDEPENDENT'
  | 'REVIEW_UNPARSEABLE'
  | 'REVISION_MISMATCH'
  | 'STATE_REJECTED'
  | 'NOT_ACCEPTED'
  | 'INTEGRATION_FAILED';

export class TaskServiceError extends Error {
  readonly code: ServiceErrorCode;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = 'TaskServiceError';
    this.code = code;
  }
}

function fail(code: ServiceErrorCode, message: string): never {
  throw new TaskServiceError(code, message);
}

export interface SpawnHint {
  readonly description: string;
  readonly cwd: string;
  readonly role?: string;
  readonly run_in_background: true;
}

export interface StartResult {
  readonly taskId: string;
  readonly state: string;
  readonly attemptId?: string;
  readonly workspacePath?: string;
  readonly branch?: string;
  readonly baseRevision?: string;
  readonly reusedFrom?: string;
  readonly prompt?: string;
  readonly spawn?: SpawnHint;
  readonly reason?: string;
}

export interface CommandReport {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Last part of the (redacted) output; returned to the caller, never persisted. */
  readonly outputTail: string;
}

export interface VerifyResult {
  readonly taskId: string;
  readonly attemptId: string;
  readonly outcome: 'check_failed' | 'attempt_failed' | 'awaiting_review' | 'passed';
  readonly state: string;
  readonly revision?: string;
  readonly changedPaths?: readonly string[];
  readonly reasons: readonly string[];
  readonly commands: readonly CommandReport[];
  readonly checksUsed: number;
  readonly checksAllowed: number;
  /** Throwaway checkout the commands ran in (absent when verification never ran). */
  readonly cleanRoom?: string;
  readonly cleanupWarning?: string;
}

export interface ReviewBriefResult {
  readonly taskId: string;
  readonly outcome: 'review_requested' | 'rejected';
  readonly state: string;
  readonly reviewId?: string;
  readonly revision?: string;
  readonly prompt?: string;
  readonly spawn?: SpawnHint;
  readonly reasons: readonly string[];
}

export interface ReviewRecordResult {
  readonly taskId: string;
  readonly state: string;
  readonly verdict: 'passed' | 'rejected';
  readonly revision: string;
  readonly reasons: readonly string[];
}

interface AcceptedCandidate {
  readonly taskId: string;
  readonly revision: string;
  readonly baseRevision: string;
  readonly workspacePath: string;
  readonly changedPaths: readonly string[];
  readonly verification: readonly string[];
  readonly implementerAgentIds: readonly string[];
  readonly reviewerAgentId: string;
  readonly reviewId: string;
  readonly source: string;
}

export interface Deliverable {
  readonly taskId?: string;
  readonly revision?: string;
  /** Why there is no deliverable revision. */
  readonly reason?: string;
  /** PASSED non-integration tasks the deliverable does not contain. */
  readonly notIncluded: readonly string[];
}

export interface IntegrateResult {
  readonly taskId: string;
  readonly state: string;
  readonly baseRevision: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly inputs: readonly IntegrationInput[];
  readonly applied: readonly AppliedCommit[];
  readonly integratedRevision?: string;
  readonly conflict?: { readonly input: string; readonly commit: string; readonly paths: readonly string[]; readonly detail: string };
  readonly reason?: string;
}

const AGENT_ID = /^[A-Za-z0-9:._-]{1,128}$/;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OUTPUT_TAIL = 2000;

function tail(value: string | undefined): string {
  if (value === undefined) return '';
  return value.length <= OUTPUT_TAIL ? value : `…${value.slice(-OUTPUT_TAIL)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TaskService {
  private board = new TaskBoard();
  private readonly ports: TaskServicePorts;
  private readonly settings: TaskServiceSettings;
  /** Live lease objects owned by the WorktreeManager, keyed by ownership token. */
  private readonly leases = new Map<string, WorkspaceLease>();
  private readonly leaseErrors = new Map<string, string>();

  constructor(ports: TaskServicePorts, settings: TaskServiceSettings) {
    this.ports = ports;
    this.settings = settings;
  }

  /** Rebuild from persisted events and re-adopt host-owned worktree leases. */
  restore(events: readonly TaskEvent[]): { readonly tasks: number; readonly leaseErrors: readonly string[] } {
    const board = replayTaskBoard(events);
    this.board = board;
    this.leaseErrors.clear();
    for (const task of board.tasks()) {
      for (const attempt of task.attemptRecords) {
        const token = attempt.lease.ownershipToken;
        if (this.leases.has(token) || this.leaseErrors.has(token)) continue;
        try {
          const adopted = this.ports.worktrees.adoptLease(this.ports.worktreePort, attempt.lease, this.binding(attempt.lease, task.contract));
          this.leases.set(token, adopted);
        } catch (error) {
          this.leaseErrors.set(token, `${task.id}/${attempt.attemptId}: ${message(error)}`);
        }
      }
    }
    return { tasks: board.tasks().length, leaseErrors: [...this.leaseErrors.values()] };
  }

  status(): readonly TaskView[] {
    return this.board.tasks();
  }

  task(taskId: string): TaskView {
    const view = this.board.task(taskId);
    if (view === undefined) fail('UNKNOWN_TASK', `unknown task ${taskId}; known: ${this.board.tasks().map((task) => task.id).join(', ') || '(none)'}`);
    return view;
  }

  readySet(): readonly string[] {
    return this.board.readySet();
  }

  /**
   * The one revision to hand over: the most recently planned PASSED integration,
   * or, on a board with a single non-integration task and no integration, that
   * task's PASSED revision. Anything else has no deliverable.
   */
  deliverable(): Deliverable {
    const tasks = this.board.tasks();
    const accepted = (task: TaskView) => task.attemptRecords[task.attemptRecords.length - 1]?.candidate?.revision;
    const integrations = tasks.filter((task) => task.integration !== undefined);
    const passed = integrations.filter((task) => task.state === 'PASSED' && accepted(task) !== undefined);
    const latest = passed[passed.length - 1];
    if (latest !== undefined) {
      const included = new Set(latest.integration!.inputs.map((input) => input.taskId));
      const notIncluded = tasks.filter((task) => task.integration === undefined && task.state === 'PASSED' && !included.has(task.id)).map((task) => task.id);
      return { taskId: latest.id, revision: accepted(latest)!, notIncluded };
    }
    const own = tasks.filter((task) => task.integration === undefined);
    if (integrations.length === 0 && own.length === 1 && own[0]!.state === 'PASSED' && accepted(own[0]!) !== undefined) return { taskId: own[0]!.id, revision: accepted(own[0]!)!, notIncluded: [] };
    if (tasks.length === 0) return { reason: 'no tasks planned', notIncluded: [] };
    return { reason: integrations.length > 0 ? 'no integration has PASSED' : 'more than one task: integrate the PASSED candidates with task_integrate, then verify and review the integration', notIncluded: [] };
  }

  /** Add tasks. Validates everything before any state changes. */
  plan(inputs: unknown): readonly TaskView[] {
    if (!Array.isArray(inputs) || inputs.length === 0) fail('INVALID_INPUT', 'tasks must be a non-empty array');
    const parsed: { contract: TaskContract; reviewRequired: boolean; plannedOverlap?: readonly string[] }[] = [];
    const problems: string[] = [];
    for (const [index, raw] of inputs.entries()) {
      if (!isPlainObject(raw)) { problems.push(`tasks[${index}] must be an object`); continue; }
      const { review_required: reviewRaw, planned_overlap: overlapRaw, ...rest } = raw as Record<string, unknown>;
      if (reviewRaw !== undefined && typeof reviewRaw !== 'boolean') problems.push(`tasks[${index}].review_required must be boolean`);
      if (overlapRaw !== undefined && (!Array.isArray(overlapRaw) || overlapRaw.some((entry) => typeof entry !== 'string' || entry.length === 0))) problems.push(`tasks[${index}].planned_overlap must be an array of paths`);
      const candidate = rest.retry === undefined ? { ...rest, retry: { max_attempts: this.settings.defaultMaxAttempts } } : rest;
      const validated = validateTaskContract(candidate);
      if (!validated.ok) { problems.push(`tasks[${index}]: ${validated.error.message}`); continue; }
      const contract = validated.contract;
      if ((contract.files_in_scope ?? []).length === 0) problems.push(`${contract.id}: files_in_scope must list at least one path`);
      if (contract.verification.length === 0) problems.push(`${contract.id}: verification must list at least one command`);
      const unauthorized = contract.verification.filter((command) => !this.settings.verificationAllowlist.includes(command));
      if (unauthorized.length > 0) problems.push(`${contract.id}: verification commands not in the host allowlist: ${unauthorized.join(' | ')} (allowed: ${this.settings.verificationAllowlist.join(' | ')})`);
      const plannedOverlap = Array.isArray(overlapRaw) && overlapRaw.length > 0 ? [...new Set(overlapRaw as string[])] : undefined;
      parsed.push({ contract, reviewRequired: reviewRaw === undefined ? true : reviewRaw as boolean, ...(plannedOverlap === undefined ? {} : { plannedOverlap }) });
    }
    const ids = new Set<string>();
    for (const { contract } of parsed) {
      if (ids.has(contract.id) || this.board.has(contract.id)) problems.push(`${contract.id}: duplicate task id`);
      ids.add(contract.id);
    }
    for (const { contract } of parsed) {
      for (const dependency of contract.depends_on) {
        if (!ids.has(dependency) && !this.board.has(dependency)) problems.push(`${contract.id}: unknown dependency ${dependency}`);
      }
    }
    if (problems.length === 0) problems.push(...this.parallelOverlaps(parsed));
    if (problems.length > 0) fail('INVALID_INPUT', problems.join('; '));
    const ordered = this.topologicalOrder(parsed);
    this.commit({ v: 1, type: 'plan', at: this.ports.clock(), tasks: ordered });
    return ordered.map(({ contract }) => this.task(contract.id));
  }

  start(taskId: string, options: { readonly reuseWorktree?: boolean; readonly baseTask?: string } = {}): StartResult {
    const task = this.task(taskId);
    if (task.state !== 'READY' && task.state !== 'RETRYING') {
      fail('NOT_READY', `${taskId} is ${task.state}${task.unmetDependencies.length > 0 ? `; waiting on ${task.unmetDependencies.join(', ')}` : ''}`);
    }
    if (task.unmetDependencies.length > 0) fail('NOT_READY', `${taskId} is waiting on ${task.unmetDependencies.join(', ')}`);
    const limit = Math.max(1, task.contract.retry?.max_attempts ?? 0);
    if (task.attemptRecords.length >= limit) {
      if (task.state === 'RETRYING') {
        // Let the state machine record budget exhaustion; no workspace is created.
        this.commit({ v: 1, type: 'start', at: this.ports.clock(), taskId, attemptId: `${taskId}:attempt-${task.attemptRecords.length + 1}`, lease: task.attemptRecords[task.attemptRecords.length - 1]!.lease });
        return { taskId, state: this.task(taskId).state, reason: `retry budget exhausted (${limit} attempts)` };
      }
      fail('BUDGET_EXHAUSTED', `${taskId} has used ${task.attemptRecords.length}/${limit} attempts`);
    }
    const attemptId = `${taskId}:attempt-${task.attemptRecords.length + 1}`;
    const previous = task.attemptRecords[task.attemptRecords.length - 1];
    let lease: WorkspaceLease;
    let fresh = false;
    let reusedFrom: string | undefined;
    if (options.reuseWorktree === true) {
      if (previous === undefined) fail('INVALID_INPUT', `${taskId} has no previous attempt to reuse`);
      if (options.baseTask !== undefined) fail('INVALID_INPUT', 'base_task cannot be combined with reuse_worktree');
      lease = this.liveLease(previous);
      reusedFrom = previous.attemptId;
    } else {
      const base = this.resolveBase(task, options.baseTask);
      try {
        lease = this.ports.worktrees.acquire(this.ports.worktreePort, taskId, attemptId, base);
        this.ports.worktrees.bindSession(this.ports.worktreePort, lease, this.binding(lease, task.contract));
      } catch (error) {
        fail('LEASE_UNAVAILABLE', `could not create worktree for ${taskId}: ${message(error)}`);
      }
      const problem = this.ports.checkWorkerCwd?.(lease.workspacePath);
      if (problem !== undefined) {
        this.ports.worktrees.cleanup(this.ports.worktreePort, lease);
        fail('LEASE_UNAVAILABLE', problem);
      }
      fresh = true;
    }
    try {
      this.commit({ v: 1, type: 'start', at: this.ports.clock(), taskId, attemptId, lease, ...(reusedFrom === undefined ? {} : { reusedFrom }) });
    } catch (error) {
      if (fresh) this.ports.worktrees.cleanup(this.ports.worktreePort, lease);
      throw error;
    }
    this.leases.set(lease.ownershipToken, lease);
    const feedback = previous === undefined ? [] : this.feedbackFrom(previous);
    return {
      taskId,
      state: this.task(taskId).state,
      attemptId,
      workspacePath: lease.workspacePath,
      branch: lease.branch,
      baseRevision: lease.baseRevision,
      ...(reusedFrom === undefined ? {} : { reusedFrom }),
      prompt: renderWorkerBrief({ contract: task.contract, attemptId, workspacePath: lease.workspacePath, branch: lease.branch, baseRevision: lease.baseRevision, feedback }),
      spawn: { description: `${taskId}:impl`, cwd: lease.workspacePath, run_in_background: true },
    };
  }

  /** Associate the Pier pane running the current attempt. Checked against Pier's ledger. */
  bind(taskId: string, agentId: string): AttemptRecord {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('INVALID_INPUT', 'agent_id must be a Pier pane id');
    const task = this.task(taskId);
    if (task.state !== 'RUNNING') fail('INVALID_STATE', `${taskId} is ${task.state}; bind requires RUNNING`);
    const attempt = this.currentAttempt(task);
    const row = this.ports.ledger.latest(attempt.lease.workspacePath, agentId);
    if (row === undefined) fail('WORKER_NOT_FOUND', `Pier has no subagent ${agentId} launched in ${attempt.lease.workspacePath}; spawn it with cwd set to that path`);
    if (row.kind === this.settings.reviewerRole) fail('INVALID_INPUT', `${agentId} runs the reviewer role and cannot implement`);
    if (attempt.reusedFrom === undefined && row.createdAt < attempt.startedAt) fail('INVALID_INPUT', `${agentId} was launched before ${attempt.attemptId} started`);
    this.commit({ v: 1, type: 'bind', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, agentId });
    return this.currentAttempt(this.task(taskId));
  }

  /** Host inspection + scope + allowlisted verification of the current attempt. */
  async verify(taskId: string): Promise<VerifyResult> {
    const task = this.task(taskId);
    if (task.state !== 'RUNNING') fail('INVALID_STATE', `${taskId} is ${task.state}; verify requires RUNNING${task.state === 'VERIFYING' ? ' (already verified; request or record a review)' : ''}`);
    const attempt = this.currentAttempt(task);
    if (task.integration === undefined) {
      if (attempt.agentId === undefined) fail('WORKER_UNBOUND', `${taskId} has no bound worker; call task_bind with the Pier agent id first`);
      const row = this.ports.ledger.latest(attempt.lease.workspacePath, attempt.agentId);
      if (row === undefined) fail('WORKER_NOT_FOUND', `Pier ledger has no row for ${attempt.agentId} in ${attempt.lease.workspacePath}`);
      if (row.status === 'running') fail('WORKER_RUNNING', `worker ${attempt.agentId} is still running; wait for its settlement notice`);
    } else if (attempt.integration?.revision === undefined) {
      fail('INVALID_STATE', `${taskId} has no integrated revision to verify`);
    }
    const lease = this.liveLease(attempt);
    const inspection = this.inspect(lease);
    const check = checkArtifact(inspection, task.contract.files_in_scope ?? []);
    if (!check.ok) return this.checkFailed(task, attempt, 'artifact', check.reasons, inspection.artifactRevision, undefined, []);
    const guard = this.artifactGuards(task, attempt, lease, inspection.artifactRevision);
    if (guard.length > 0) return this.checkFailed(task, attempt, 'artifact', guard, inspection.artifactRevision, undefined, []);

    // Clean room: verify the exact candidate revision in a fresh checkout built from git
    // objects only, so nothing the worker left in its worktree (ignored build output,
    // stale binaries) can influence the verdict.
    let room: CleanRoomCheckout;
    try {
      room = this.ports.cleanRoom.prepare(inspection.artifactRevision);
    } catch (error) {
      fail('VERIFICATION_ERROR', `clean-room checkout of ${inspection.artifactRevision} failed: ${message(error)}`);
    }
    const commands: VerificationCommand[] = task.contract.verification.map((command) => ({ command, cwd: room.path, timeoutMs: this.settings.verificationTimeoutMs }));
    const outcomes: VerificationOutcome[] = [];
    const reports: CommandReport[] = [];
    const startedAt = this.ports.clock();
    let cleanupProblem: string | undefined;
    try {
      for (const command of commands) {
        const commandStartedAt = this.ports.clock();
        let result: Awaited<ReturnType<AsyncVerificationRunner['run']>>;
        try {
          result = await this.ports.verifier.run(command);
        } catch (error) {
          fail('VERIFICATION_ERROR', `verification command could not run: ${message(error)}`);
        }
        const durationMs = Math.max(0, this.ports.clock() - commandStartedAt);
        outcomes.push({ exitCode: result.exitCode, durationMs, timedOut: result.timedOut, ...(result.output === undefined ? {} : { output: result.output }), ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }) });
        reports.push({ command: command.command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs, outputTail: tail(result.output) });
      }
    } finally {
      cleanupProblem = room.dispose();
    }
    let evidence: EvidenceBundle;
    try {
      evidence = validateEvidenceBundle({ taskId, attemptId: attempt.attemptId, artifactRevision: inspection.artifactRevision, commands, outcomes, startedAt, endedAt: Math.max(startedAt, this.ports.clock()) });
    } catch (error) {
      fail('VERIFICATION_ERROR', `verification evidence is invalid: ${message(error)}`);
    }
    const roomInfo = { cleanRoom: room.path, ...(cleanupProblem === undefined ? {} : { cleanupWarning: cleanupProblem }) };
    const after = this.inspect(lease);
    if (after.artifactRevision !== inspection.artifactRevision) {
      return { ...roomInfo, ...this.checkFailed(task, attempt, 'verification', [`HEAD moved during verification (${inspection.artifactRevision} → ${after.artifactRevision})`], after.artifactRevision, evidence, reports) };
    }
    const verdict = decideVerdict(evidence, { minimumCommands: 1 });
    if (verdict.verdict === 'rejected') return { ...roomInfo, ...this.checkFailed(task, attempt, 'verification', verdict.reasons, inspection.artifactRevision, evidence, reports) };

    const candidate: CandidateRecord = { revision: inspection.artifactRevision, changedPaths: check.changedPaths, evidence, verdict };
    this.commit({ v: 1, type: 'settle', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, candidate });
    if (!task.reviewRequired) {
      this.commit({ v: 1, type: 'verdict', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, verdict: 'passed', source: 'mechanical', reasons: ['mechanical verification passed; review not required'] });
    }
    const after2 = this.task(taskId);
    return {
      taskId,
      attemptId: attempt.attemptId,
      outcome: task.reviewRequired ? 'awaiting_review' : 'passed',
      state: after2.state,
      revision: candidate.revision,
      changedPaths: candidate.changedPaths,
      reasons: [],
      commands: reports,
      checksUsed: attempt.checks.length,
      checksAllowed: this.settings.maxChecksPerAttempt,
      ...roomInfo,
    };
  }

  /** Issue a fresh-review brief bound to the settled candidate revision. */
  reviewBrief(taskId: string): ReviewBriefResult {
    const task = this.task(taskId);
    if (task.state !== 'VERIFYING') fail('INVALID_STATE', `${taskId} is ${task.state}; a review brief requires VERIFYING`);
    if (!task.reviewRequired) fail('INVALID_STATE', `${taskId} does not require review`);
    const attempt = this.currentAttempt(task);
    const candidate = attempt.candidate;
    if (candidate === undefined) fail('INVALID_STATE', `${taskId} has no settled candidate`);
    const role = this.ports.checkReviewerRole();
    if (!role.ok) fail('ROLE_NOT_READ_ONLY', `reviewer role refused: ${role.reason}`);
    const lease = this.liveLease(attempt);
    const guard = this.guardCandidate(task, attempt, lease, candidate);
    if (guard !== undefined) return { taskId, outcome: 'rejected', state: this.task(taskId).state, reasons: guard };
    let diff: string;
    try {
      diff = this.ports.readDiff(lease.workspacePath, lease.baseRevision, candidate.revision);
    } catch (error) {
      fail('INSPECTION_FAILED', `could not read the artifact diff: ${message(error)}`);
    }
    const brief = assembleReviewerBrief({ spec: { objective: task.contract.objective, acceptance_criteria: task.contract.acceptance_criteria, files_in_scope: task.contract.files_in_scope ?? [] }, artifactRevision: candidate.revision, diff, evidence: candidate.evidence });
    const reviewId = this.ports.randomId?.() ?? randomBytes(8).toString('hex');
    this.commit({ v: 1, type: 'review_requested', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, reviewId, revision: candidate.revision });
    return {
      taskId,
      outcome: 'review_requested',
      state: this.task(taskId).state,
      reviewId,
      revision: candidate.revision,
      prompt: renderReviewerPrompt(brief, reviewId, taskId, this.integrationBriefLines(task, attempt)),
      spawn: { description: `${taskId}:review`, cwd: lease.workspacePath, role: this.settings.reviewerRole, run_in_background: true },
      reasons: [],
    };
  }

  /** Read the reviewer's closing text from Pier's ledger and apply the verdict. */
  recordReview(taskId: string, agentId: string): ReviewRecordResult {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) fail('INVALID_INPUT', 'agent_id must be a Pier pane id');
    const task = this.task(taskId);
    if (task.state !== 'VERIFYING') fail('INVALID_STATE', `${taskId} is ${task.state}; recording a review requires VERIFYING`);
    const attempt = this.currentAttempt(task);
    const candidate = attempt.candidate;
    const review = attempt.review;
    if (candidate === undefined || review === undefined) fail('REVIEW_NOT_REQUESTED', `${taskId} has no outstanding review; call task_review_brief first`);
    const implementers = new Set([...task.attemptRecords.map((record) => record.agentId).filter((id): id is string => id !== undefined), ...(task.integration?.inputs.flatMap((input) => input.implementerAgentIds) ?? [])]);
    if (implementers.has(agentId)) fail('REVIEWER_INVALID', `${agentId} implemented ${taskId} and cannot review it`);
    const row = this.ports.ledger.latest(attempt.lease.workspacePath, agentId);
    if (row === undefined) fail('WORKER_NOT_FOUND', `Pier has no subagent ${agentId} launched in ${attempt.lease.workspacePath}`);
    if (row.status === 'running') fail('WORKER_RUNNING', `reviewer ${agentId} is still running; wait for its settlement notice`);
    if (row.kind !== this.settings.reviewerRole) fail('REVIEWER_INVALID', `${agentId} ran role "${row.kind}", not the read-only reviewer role "${this.settings.reviewerRole}"`);
    if (row.revivedFrom !== null) fail('REVIEWER_INVALID', `${agentId} is a revived session, not a fresh reviewer`);
    if (row.createdAt < review.issuedAt) fail('REVIEWER_INVALID', `${agentId} was launched before review ${review.reviewId} was issued`);
    this.requireBriefOnly(agentId, row.sessionFile, review.reviewId);
    if (row.outcome === null || row.outcome.trim().length === 0) fail('REVIEW_UNPARSEABLE', `reviewer ${agentId} has no closing output in the ledger`);
    const parsed = parseReviewerOutcome(row.outcome, review.reviewId);
    if (!parsed.ok) fail('REVIEW_UNPARSEABLE', `${parsed.reason}; a settled reviewer cannot be re-asked (subagent send revives it, and revived sessions are not fresh). Call task_review_brief again and spawn a new reviewer, or task_abandon the attempt if the reviewer's findings already warrant a retry`);
    if (parsed.verdict.artifactRevision !== candidate.revision) fail('REVISION_MISMATCH', `review is for ${parsed.verdict.artifactRevision}, candidate is ${candidate.revision}`);
    const lease = this.liveLease(attempt);
    const guard = this.guardCandidate(task, attempt, lease, candidate);
    if (guard !== undefined) return { taskId, state: this.task(taskId).state, verdict: 'rejected', revision: candidate.revision, reasons: guard };
    const final = decideFinalVerdict(candidate.verdict, parsed.verdict, true);
    const verdict = final === 'passed' ? 'passed' : 'rejected';
    this.commit({ v: 1, type: 'verdict', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, verdict, source: 'review', reasons: [...parsed.verdict.reasons], reviewerAgentId: agentId, review: parsed.verdict });
    return { taskId, state: this.task(taskId).state, verdict, revision: candidate.revision, reasons: parsed.verdict.reasons };
  }

  /** Main-agent decision to give up on the current attempt (retry budget applies). */
  abandon(taskId: string, reason: string, terminal = false): TaskView {
    if (typeof reason !== 'string' || reason.trim().length === 0) fail('INVALID_INPUT', 'reason is required');
    const task = this.task(taskId);
    const attempt = this.currentAttempt(task);
    if (task.state === 'RUNNING') {
      this.commit({ v: 1, type: 'attempt_failed', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, reason, terminal });
    } else if (task.state === 'VERIFYING') {
      this.commit({ v: 1, type: 'verdict', at: this.ports.clock(), taskId, attemptId: attempt.attemptId, verdict: 'rejected', source: 'abandon', reasons: [reason] });
    } else {
      fail('INVALID_STATE', `${taskId} is ${task.state}; only RUNNING or VERIFYING attempts can be abandoned`);
    }
    return this.task(taskId);
  }

  cancel(taskId: string, reason: string): TaskView {
    if (typeof reason !== 'string' || reason.trim().length === 0) fail('INVALID_INPUT', 'reason is required');
    this.task(taskId);
    this.commit({ v: 1, type: 'cancel', at: this.ports.clock(), taskId, reason });
    return this.task(taskId);
  }

  /**
   * Integrate exact accepted candidate revisions onto an exact base in a new
   * host-owned worktree. Only candidates that are PASSED with a passing fresh
   * review bound to that revision (confirmed again in Pier's ledger) may enter.
   * Commits are cherry-picked in the given order; a conflict aborts, is
   * recorded, and fails the integration without any resolution attempt.
   */
  integrate(options: { readonly baseRevision: string; readonly revisions: readonly string[]; readonly evidence?: readonly { readonly source: string; readonly events: readonly TaskEvent[] }[] }): IntegrateResult {
    const base = typeof options.baseRevision === 'string' ? options.baseRevision.trim() : '';
    if (!FULL_OBJECT_ID.test(base)) fail('INVALID_INPUT', 'base_revision must be a full object id (not HEAD or a branch)');
    const wanted = Array.isArray(options.revisions) ? options.revisions.map((revision) => String(revision).trim().toLowerCase()) : [];
    if (wanted.length === 0) fail('INVALID_INPUT', 'revisions must list at least one accepted candidate revision');
    if (wanted.some((revision) => !/^[0-9a-f]{7,64}$/.test(revision))) fail('INVALID_INPUT', 'revisions must be hex commit ids (at least 7 characters)');
    const pool = [...this.acceptedCandidates(this.board, 'this session')];
    for (const evidence of options.evidence ?? []) {
      let replayed: TaskBoard;
      try { replayed = replayTaskBoard(evidence.events); } catch (error) { fail('INVALID_INPUT', `evidence ${evidence.source} cannot be replayed: ${message(error)}`); }
      pool.push(...this.acceptedCandidates(replayed, evidence.source));
    }
    const inputs: IntegrationInput[] = [];
    const files = new Set<string>();
    const verification: string[] = [];
    const seen = new Set<string>();
    for (const revision of wanted) {
      const matches = [...new Map(pool.filter((candidate) => candidate.revision.startsWith(revision)).map((candidate) => [candidate.revision, candidate])).values()];
      if (matches.length === 0) fail('NOT_ACCEPTED', `${revision} is not a PASSED candidate with a passing fresh review in this session or the supplied evidence`);
      if (matches.length > 1) fail('INVALID_INPUT', `${revision} is ambiguous among accepted candidates`);
      const candidate = matches[0]!;
      if (seen.has(candidate.revision)) fail('INVALID_INPUT', `${candidate.revision} is listed twice`);
      seen.add(candidate.revision);
      // A candidate is built on the integration base, or stacked on an earlier input (e.g. a
      // prerequisite wiring task); only its own base..revision commits are picked.
      const allowedBases = [base, ...inputs.map((input) => input.revision)];
      if (!allowedBases.includes(candidate.baseRevision)) fail('NOT_ACCEPTED', `${candidate.taskId}@${candidate.revision} was built on ${candidate.baseRevision}, which is neither the integration base ${base} nor an earlier input`);
      this.confirmReview(candidate);
      const unauthorized = candidate.verification.filter((command) => !this.settings.verificationAllowlist.includes(command));
      if (unauthorized.length > 0) fail('NOT_ACCEPTED', `${candidate.taskId} used verification commands outside the current allowlist: ${unauthorized.join(' | ')}`);
      let commits: readonly string[];
      try { commits = this.ports.history.commitRange(candidate.baseRevision, candidate.revision); } catch (error) { fail('NOT_ACCEPTED', `${candidate.revision}: ${message(error)}`); }
      if (commits.length === 0) fail('NOT_ACCEPTED', `${candidate.revision} has no commits over ${candidate.baseRevision}`);
      candidate.changedPaths.forEach((path) => files.add(path));
      candidate.verification.forEach((command) => { if (!verification.includes(command)) verification.push(command); });
      inputs.push({ taskId: candidate.taskId, revision: candidate.revision, baseRevision: candidate.baseRevision, commits: [...commits], source: candidate.source, implementerAgentIds: candidate.implementerAgentIds, reviewerAgentId: candidate.reviewerAgentId, reviewId: candidate.reviewId });
    }
    const taskId = this.nextIntegrationId();
    const contract = {
      id: taskId,
      objective: `Integrate ${inputs.length} accepted candidate revision(s) onto ${base}: ${inputs.map((input) => `${input.taskId}@${input.revision.slice(0, 12)}`).join(', ')}`,
      depends_on: [],
      files_in_scope: [...files].sort(),
      acceptance_criteria: [
        'The integrated history is exactly the declared source commits, in the declared order, each cherry-picked with -x and patch-identical to its source',
        'The combined diff contains only the union of the input changes; no unexpected files or edits',
        'Cross-task interactions are correct: shared files (e.g. CMakeLists.txt) keep every input\'s additions, with no duplicate or clobbered targets/tests and correct include/link wiring',
        'Every test added by an input is still built and registered with add_test',
        'Full verification passes on the integrated revision in a clean checkout',
      ],
      verification,
      retry: { max_attempts: 1 },
    };
    const validated = validateTaskContract(contract);
    if (!validated.ok) fail('INVALID_INPUT', `integration contract is invalid: ${validated.error.message}`);
    this.commit({ v: 1, type: 'plan', at: this.ports.clock(), tasks: [{ contract: validated.contract, reviewRequired: true, integration: { baseRevision: base, inputs } }] });
    const attemptId = `${taskId}:attempt-1`;
    let lease: WorkspaceLease;
    try {
      lease = this.ports.worktrees.acquire(this.ports.worktreePort, taskId, attemptId, base);
      this.ports.worktrees.bindSession(this.ports.worktreePort, lease, this.binding(lease, validated.contract));
    } catch (error) {
      this.commit({ v: 1, type: 'cancel', at: this.ports.clock(), taskId, reason: `integration worktree could not be created: ${message(error)}` });
      fail('LEASE_UNAVAILABLE', `could not create the integration worktree: ${message(error)}`);
    }
    const problem = this.ports.checkWorkerCwd?.(lease.workspacePath);
    if (problem !== undefined) {
      this.ports.worktrees.cleanup(this.ports.worktreePort, lease);
      this.commit({ v: 1, type: 'cancel', at: this.ports.clock(), taskId, reason: problem });
      fail('LEASE_UNAVAILABLE', problem);
    }
    this.commit({ v: 1, type: 'start', at: this.ports.clock(), taskId, attemptId, lease });
    this.leases.set(lease.ownershipToken, lease);
    const owner = new Map<string, string>();
    inputs.forEach((input) => input.commits.forEach((commit) => owner.set(commit, input.revision)));
    let applied;
    try {
      applied = this.ports.history.cherryPick(lease.workspacePath, inputs.flatMap((input) => input.commits));
    } catch (error) {
      this.commit({ v: 1, type: 'attempt_failed', at: this.ports.clock(), taskId, attemptId, reason: `integration could not run: ${message(error)}`, terminal: true });
      return { taskId, state: this.task(taskId).state, baseRevision: base, branch: lease.branch, workspacePath: lease.workspacePath, inputs, applied: [], reason: message(error) };
    }
    if (!applied.ok) {
      const input = owner.get(applied.commit) ?? 'unknown';
      this.commit({ v: 1, type: 'integration_conflict', at: this.ports.clock(), taskId, attemptId, applied: applied.applied, input, commit: applied.commit, paths: applied.paths, detail: applied.detail });
      this.commit({ v: 1, type: 'attempt_failed', at: this.ports.clock(), taskId, attemptId, reason: `conflict cherry-picking ${applied.commit}${applied.commit === input ? '' : ` (candidate ${input})`} in ${applied.paths.join(', ') || '(no conflicted paths reported)'}`, terminal: true });
      return { taskId, state: this.task(taskId).state, baseRevision: base, branch: lease.branch, workspacePath: lease.workspacePath, inputs, applied: applied.applied, conflict: { input, commit: applied.commit, paths: applied.paths, detail: applied.detail } };
    }
    this.commit({ v: 1, type: 'integration_applied', at: this.ports.clock(), taskId, attemptId, applied: applied.applied, revision: applied.revision });
    return { taskId, state: this.task(taskId).state, baseRevision: base, branch: lease.branch, workspacePath: lease.workspacePath, inputs, applied: applied.applied, integratedRevision: applied.revision };
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Candidates that are PASSED through a passing fresh review bound to the exact revision. */
  private acceptedCandidates(board: TaskBoard, source: string): AcceptedCandidate[] {
    const accepted: AcceptedCandidate[] = [];
    for (const task of board.tasks()) {
      if (task.state !== 'PASSED' || task.integration !== undefined || !task.reviewRequired) continue;
      const attempt = task.attemptRecords[task.attemptRecords.length - 1];
      const candidate = attempt?.candidate;
      const review = attempt?.review;
      if (attempt === undefined || candidate === undefined || review === undefined) continue;
      if (attempt.verdict?.verdict !== 'passed' || attempt.verdict.source !== 'review') continue;
      if (review.verdict?.outcome !== 'passed' || review.revision !== candidate.revision || review.verdict.artifactRevision !== candidate.revision || review.reviewerAgentId === undefined) continue;
      if (candidate.verdict.verdict !== 'passed' || candidate.verdict.artifactRevision !== candidate.revision) continue;
      accepted.push({
        taskId: task.id,
        revision: candidate.revision,
        baseRevision: attempt.lease.baseRevision,
        workspacePath: attempt.lease.workspacePath,
        changedPaths: candidate.changedPaths,
        verification: task.contract.verification,
        implementerAgentIds: [...new Set(task.attemptRecords.map((record) => record.agentId).filter((id): id is string => id !== undefined))],
        reviewerAgentId: review.reviewerAgentId,
        reviewId: review.reviewId,
        source,
      });
    }
    return accepted;
  }

  /** Re-read the input's review from Pier's ledger: fresh, read-only, passed, bound to the revision. */
  /**
   * A fresh review is one prompt: the brief. Anything the main agent sent the
   * running reviewer afterwards (Pier records no revive for that) lands in the
   * reviewer's own session as another user message and makes the verdict
   * non-independent.
   */
  private requireBriefOnly(agentId: string, sessionFile: string | null, reviewId: string): void {
    if (sessionFile === null) fail('REVIEWER_NOT_INDEPENDENT', `Pier's ledger has no session file for reviewer ${agentId}, so what it was told cannot be checked`);
    let messages: readonly string[];
    try { messages = this.ports.sessionUserMessages(sessionFile); } catch (error) { fail('REVIEWER_NOT_INDEPENDENT', `cannot read reviewer ${agentId}'s session ${sessionFile}: ${message(error)}`); }
    const retry = 'Call task_review_brief again and spawn a new reviewer, and do not message it while it runs';
    if (messages.length !== 1) fail('REVIEWER_NOT_INDEPENDENT', `reviewer ${agentId} received ${messages.length} prompts; a fresh review receives only the brief, so messages sent to it while it ran make its verdict non-independent. ${retry}`);
    if (!messages[0]!.includes(reviewId)) fail('REVIEWER_NOT_INDEPENDENT', `reviewer ${agentId}'s prompt does not carry review id ${reviewId}, so it is not this review's brief. ${retry}`);
  }

  private confirmReview(candidate: AcceptedCandidate): void {
    const row = this.ports.ledger.latest(candidate.workspacePath, candidate.reviewerAgentId);
    const label = `${candidate.taskId}@${candidate.revision}`;
    if (row === undefined) fail('NOT_ACCEPTED', `${label}: Pier ledger has no reviewer ${candidate.reviewerAgentId} in ${candidate.workspacePath}`);
    if (row.status === 'running' || row.revivedFrom !== null || row.outcome === null) fail('NOT_ACCEPTED', `${label}: reviewer ${candidate.reviewerAgentId} is not a settled fresh session in Pier's ledger`);
    const role = this.ports.checkReviewerRole(row.kind);
    if (!role.ok) fail('NOT_ACCEPTED', `${label}: reviewer role "${row.kind}" is not read-only (${role.reason})`);
    const parsed = parseReviewerOutcome(row.outcome, candidate.reviewId);
    if (!parsed.ok || parsed.verdict.outcome !== 'passed' || parsed.verdict.artifactRevision !== candidate.revision) {
      fail('NOT_ACCEPTED', `${label}: Pier's ledger does not hold a passing verdict for review ${candidate.reviewId} on this revision${parsed.ok ? '' : ` (${parsed.reason})`}`);
    }
  }

  /** Guards on the committed diff beyond scope: new assert() in tests, and integration history fidelity. */
  private artifactGuards(task: TaskView, attempt: AttemptRecord, lease: WorkspaceLease, revision: string): string[] {
    const reasons: string[] = [];
    try {
      const diff = this.ports.history.changedLineDiff(lease.workspacePath, lease.baseRevision, revision);
      if (diff.truncated) reasons.push('diff is too large to scan for assert() in tests');
      const asserts = findAddedAsserts(diff.text);
      if (asserts.length > 0) {
        reasons.push(`new assert() in test code is compiled out by Release builds (-DNDEBUG); use the repo's non-assert check pattern: ${asserts.slice(0, 5).map((entry) => `${entry.path}: ${entry.text}`).join(' | ')}`);
      }
    } catch (error) {
      reasons.push(`could not scan the diff: ${message(error)}`);
    }
    const spec = task.integration;
    const record = attempt.integration;
    if (spec !== undefined) {
      try {
        const expectedSources = spec.inputs.flatMap((input) => input.commits);
        const applied = record?.applied ?? [];
        if (record?.revision !== revision) reasons.push(`HEAD ${revision} is not the recorded integrated revision ${record?.revision ?? '(none)'}`);
        if (applied.map((entry) => entry.source).join(',') !== expectedSources.join(',')) reasons.push('applied commits do not match the declared source commits in order');
        const actual = this.ports.history.commitsSince(lease.workspacePath, spec.baseRevision);
        if (actual.join(',') !== applied.map((entry) => entry.integrated).join(',')) reasons.push(`history ${spec.baseRevision}..HEAD does not match the recorded integrated commits`);
        for (const entry of applied) {
          if (this.ports.history.pickedFrom(entry.integrated) !== entry.source) reasons.push(`${entry.integrated} does not name ${entry.source} as its cherry-pick source`);
          if (this.ports.history.patchId(entry.integrated) !== this.ports.history.patchId(entry.source)) reasons.push(`${entry.integrated} is not patch-identical to ${entry.source}`);
        }
      } catch (error) {
        reasons.push(`could not check integration history: ${message(error)}`);
      }
    }
    return reasons;
  }

  private integrationBriefLines(task: TaskView, attempt: AttemptRecord): readonly string[] {
    const spec = task.integration;
    if (spec === undefined) return [];
    const byIntegrated = new Map((attempt.integration?.applied ?? []).map((entry) => [entry.source, entry.integrated]));
    return [
      `This is an INTEGRATION review. Base revision: ${spec.baseRevision}. Integrated revision: ${attempt.integration?.revision ?? '(none)'}.`,
      'Declared inputs (each was separately verified and freshly reviewed; review how they combine):',
      ...spec.inputs.map((input) => `- ${input.taskId} candidate ${input.revision} (built on ${input.baseRevision === undefined || input.baseRevision === spec.baseRevision ? 'the base' : input.baseRevision.slice(0, 12)}): ${input.commits.map((commit) => `${commit.slice(0, 12)} → ${byIntegrated.get(commit)?.slice(0, 12) ?? '?'}`).join(', ')}`),
      'Focus on: the combined diff; cross-task interactions; CMake/test wiring (every new test built and registered once); unexpected files; and whether the integrated history matches the declared revisions.',
    ];
  }

  private nextIntegrationId(): string {
    let index = this.board.tasks().filter((task) => task.integration !== undefined).length + 1;
    while (this.board.has(`Tint-${index}`)) index += 1;
    return `Tint-${index}`;
  }


  private commit(event: TaskEvent): void {
    let trial: TaskBoard;
    try {
      trial = replayTaskBoard([...this.board.events(), event]);
    } catch (error) {
      if (error instanceof TaskBoardError) fail('STATE_REJECTED', error.message);
      throw error;
    }
    this.ports.persist(event);
    this.board = trial;
  }

  private checkFailed(task: TaskView, attempt: AttemptRecord, stage: CheckStage, reasons: readonly string[], revision: string | undefined, evidence: EvidenceBundle | undefined, commands: readonly CommandReport[]): VerifyResult {
    this.commit({ v: 1, type: 'check_failed', at: this.ports.clock(), taskId: task.id, attemptId: attempt.attemptId, stage, reasons: [...reasons], ...(revision === undefined ? {} : { revision }), ...(evidence === undefined ? {} : { evidence }) });
    const used = attempt.checks.length + 1;
    let outcome: VerifyResult['outcome'] = 'check_failed';
    if (task.integration !== undefined) {
      this.commit({ v: 1, type: 'attempt_failed', at: this.ports.clock(), taskId: task.id, attemptId: attempt.attemptId, reason: `integration check failed: ${reasons.join('; ').slice(0, 400)}`, terminal: true });
      outcome = 'attempt_failed';
    } else if (used >= this.settings.maxChecksPerAttempt) {
      this.commit({ v: 1, type: 'attempt_failed', at: this.ports.clock(), taskId: task.id, attemptId: attempt.attemptId, reason: `${used} failed checks in one attempt (limit ${this.settings.maxChecksPerAttempt})`, terminal: false });
      outcome = 'attempt_failed';
    }
    return {
      taskId: task.id,
      attemptId: attempt.attemptId,
      outcome,
      state: this.task(task.id).state,
      ...(revision === undefined ? {} : { revision }),
      reasons: [...reasons],
      commands,
      checksUsed: used,
      checksAllowed: this.settings.maxChecksPerAttempt,
    };
  }

  /** Re-inspect before a review decision: the candidate must still be HEAD and clean. */
  private guardCandidate(task: TaskView, attempt: AttemptRecord, lease: WorkspaceLease, candidate: CandidateRecord): readonly string[] | undefined {
    const inspection = this.inspect(lease);
    const reasons: string[] = [];
    if (inspection.artifactRevision !== candidate.revision) reasons.push(`artifact changed after verification (${candidate.revision} → ${inspection.artifactRevision})`);
    if (inspection.clean !== true) reasons.push('worktree became dirty after verification');
    if (reasons.length === 0) return undefined;
    this.commit({ v: 1, type: 'verdict', at: this.ports.clock(), taskId: task.id, attemptId: attempt.attemptId, verdict: 'rejected', source: 'guard', reasons });
    return reasons;
  }

  private inspect(lease: WorkspaceLease): WorkspaceInspection {
    try {
      return this.ports.worktrees.inspect(this.ports.worktreePort, lease);
    } catch (error) {
      fail('INSPECTION_FAILED', `host inspection of ${lease.workspacePath} failed: ${message(error)}`);
    }
  }

  private liveLease(attempt: AttemptRecord): WorkspaceLease {
    const token = attempt.lease.ownershipToken;
    const lease = this.leases.get(token);
    if (lease !== undefined) return lease;
    fail('LEASE_UNAVAILABLE', this.leaseErrors.get(token) ?? `worktree lease for ${attempt.attemptId} is not owned by this session`);
  }

  private currentAttempt(task: TaskView): AttemptRecord {
    const attempt = task.attemptRecords[task.attemptRecords.length - 1];
    if (attempt === undefined) fail('INVALID_STATE', `${task.id} has no attempt`);
    return attempt;
  }

  private resolveBase(task: TaskView, baseTask: string | undefined): string {
    if (baseTask === undefined) {
      let head: string;
      try { head = this.ports.headRevision().trim(); } catch (error) { fail('INSPECTION_FAILED', `could not read HEAD: ${message(error)}`); }
      if (!FULL_OBJECT_ID.test(head)) fail('INSPECTION_FAILED', 'HEAD is not a full object id');
      return head;
    }
    if (!task.contract.depends_on.includes(baseTask)) fail('INVALID_INPUT', `base_task ${baseTask} is not a dependency of ${task.id}`);
    const base = this.task(baseTask);
    const revision = base.state === 'PASSED' ? base.attemptRecords[base.attemptRecords.length - 1]?.candidate?.revision : undefined;
    if (revision === undefined) fail('INVALID_INPUT', `base_task ${baseTask} has no accepted revision`);
    return revision;
  }

  private feedbackFrom(previous: AttemptRecord): readonly string[] {
    const reasons = [...(previous.verdict?.reasons ?? []), ...(previous.failure === undefined ? [] : [previous.failure.reason])];
    const lastCheck = previous.checks[previous.checks.length - 1];
    if (reasons.length === 0 && lastCheck !== undefined) reasons.push(...lastCheck.reasons);
    return reasons.slice(0, 10);
  }

  private binding(lease: WorkspaceLease, contract: TaskContract): WorktreeSessionBinding {
    return {
      taskId: lease.taskId,
      attemptId: lease.attemptId,
      sessionId: lease.attemptId,
      roleId: 'implementer',
      modelProfileId: 'pier-managed',
      filesInScope: contract.files_in_scope ?? [],
      baseRevision: lease.baseRevision,
      workspacePath: lease.workspacePath,
      branch: lease.branch,
      ownershipToken: lease.ownershipToken,
      managedMarker: lease.managedMarker,
    };
  }

  /**
   * Planning rule: tasks that may run in parallel (neither depends on the other,
   * directly or transitively) must not touch overlapping paths, because their
   * candidates would conflict at integration. An overlap is allowed only when
   * both tasks list the path in planned_overlap.
   */
  private parallelOverlaps(items: readonly { contract: TaskContract; plannedOverlap?: readonly string[] }[]): string[] {
    const live = this.board.tasks()
      .filter((task) => task.integration === undefined && task.state !== 'FAILED' && task.state !== 'CANCELLED')
      .map((task) => ({ contract: task.contract, plannedOverlap: task.plannedOverlap ?? [], fresh: false }));
    const all = [...live, ...items.map((item) => ({ contract: item.contract, plannedOverlap: item.plannedOverlap ?? [], fresh: true }))];
    const byId = new Map(all.map((entry) => [entry.contract.id, entry]));
    const ancestors = new Map<string, Set<string>>();
    const ancestorsOf = (id: string, trail: Set<string> = new Set()): Set<string> => {
      const cached = ancestors.get(id);
      if (cached !== undefined) return cached;
      const result = new Set<string>();
      if (trail.has(id)) return result;
      trail.add(id);
      for (const dependency of byId.get(id)?.contract.depends_on ?? this.board.task(id)?.contract.depends_on ?? []) {
        result.add(dependency);
        ancestorsOf(dependency, trail).forEach((ancestor) => result.add(ancestor));
      }
      ancestors.set(id, result);
      return result;
    };
    const overlaps = (a: string, b: string) => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
    const problems: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (!a.fresh && !b.fresh) continue;
        if (ancestorsOf(a.contract.id).has(b.contract.id) || ancestorsOf(b.contract.id).has(a.contract.id)) continue;
        for (const pa of a.contract.files_in_scope ?? []) {
          for (const pb of b.contract.files_in_scope ?? []) {
            if (!overlaps(pa, pb)) continue;
            const planned = (entry: typeof a) => entry.plannedOverlap.includes(pa) || entry.plannedOverlap.includes(pb);
            if (planned(a) && planned(b)) continue;
            problems.push(`${a.contract.id} and ${b.contract.id} can run in parallel but both touch ${pa === pb ? pa : `${pa} / ${pb}`}; their candidates would conflict at integration. Order them with depends_on, give each its own file (e.g. a separate build fragment), or list the path in planned_overlap on both tasks if the overlap is intended`);
          }
        }
      }
    }
    return problems;
  }

  private topologicalOrder<T extends { contract: TaskContract }>(items: readonly T[]): T[] {
    const pending = new Map(items.map((item) => [item.contract.id, item]));
    const ordered: T[] = [];
    while (pending.size > 0) {
      const next = [...pending.values()].find((item) => item.contract.depends_on.every((dependency) => !pending.has(dependency)));
      if (next === undefined) fail('INVALID_INPUT', `dependency cycle among: ${[...pending.keys()].join(', ')}`);
      ordered.push(next);
      pending.delete(next.contract.id);
    }
    return ordered;
  }
}
