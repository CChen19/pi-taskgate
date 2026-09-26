/**
 * Companion Pi extension for the main (master) session, loaded next to Pier:
 *
 *   pi -e <pier-ext>/src/index.ts -e <pi-taskgate>/src/pi-extension/index.ts
 *
 * It adds deterministic task tools. It does not spawn agents: the main agent
 * dispatches workers and reviewers with Pier's `subagent` tool, then asks these
 * tools for ground truth (host git inspection, scope, allowlisted verification,
 * revision-bound fresh review). Task events persist as session custom entries,
 * so `/resume` and branch navigation rebuild the same task state.
 *
 * The Pi API is typed structurally; this module has no Pi dependency.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { findGitWrites, isWithin } from '../core/git-write-guard.ts';
import { parseOrchestrationConfig } from '../orchestration/config.ts';
import { createHostTaskService } from '../orchestration/host-wiring.ts';
import type { TaskEvent, TaskView } from '../orchestration/task-board.ts';
import { TaskServiceError, type TaskService } from '../orchestration/task-service.ts';

export const TASK_EVENT_CUSTOM_TYPE = 'agent-orchestrator.task-event';
export const CONFIG_ENV = 'AGENT_ORCHESTRATOR_CONFIG';

export interface PiToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly details?: unknown;
}

export interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown): Promise<PiToolResult>;
}

export interface PiExtensionApi {
  registerTool(definition: PiToolDefinition): void;
  appendEntry(customType: string, data?: unknown): void;
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): unknown;
}

export interface ExtensionDeps {
  /** Build a fresh service; throwing makes every tool fail closed with that message. */
  createService(persist: (event: TaskEvent) => void): TaskService;
  /**
   * Directories (repository and workspace roots) where the main agent may not
   * write git history while the board has tasks. Missing or empty: every
   * directory is protected.
   */
  gitGuardRoots?(): readonly string[];
}

export function defaultExtensionDeps(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ExtensionDeps {
  let roots: readonly string[] = [];
  return {
    gitGuardRoots: () => roots,
    createService(persist) {
      const path = env[CONFIG_ENV] !== undefined && env[CONFIG_ENV].length > 0 ? env[CONFIG_ENV] : join(cwd, '.pi-herdr', 'agent-orchestrator.json');
      if (!existsSync(path)) throw new Error(`orchestration config not found at ${path} (set ${CONFIG_ENV})`);
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`orchestration config ${path} is not valid JSON`); }
      const config = parseOrchestrationConfig(raw);
      const service = createHostTaskService({ config, persist, masterCwd: cwd });
      roots = [config.repoRoot, config.workspaceRoot];
      return service;
    },
  };
}

function readEvents(ctx: unknown): TaskEvent[] {
  const branch = (ctx as { sessionManager?: { getBranch?: () => readonly unknown[] } } | undefined)?.sessionManager?.getBranch?.() ?? [];
  const events: TaskEvent[] = [];
  for (const entry of branch) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type === 'custom' && record.customType === TASK_EVENT_CUSTOM_TYPE) events.push(record.data as TaskEvent);
  }
  return events;
}

/**
 * Task events on the current branch of a Pi session file: walk parentId links
 * back from the last entry so abandoned branches are excluded.
 */
export function readSessionFileEvents(path: string): TaskEvent[] {
  if (!path.endsWith('.jsonl')) throw new Error(`evidence ${path} is not a Pi session .jsonl file`);
  const entries = new Map<string, { parentId: string | null; record: Record<string, unknown> }>();
  let last: string | undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof record.id !== 'string' || record.type === 'session') continue;
    entries.set(record.id, { parentId: typeof record.parentId === 'string' ? record.parentId : null, record });
    last = record.id;
  }
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  for (let id = last; id !== undefined && !visited.has(id);) {
    visited.add(id);
    const entry = entries.get(id);
    if (entry === undefined) break;
    branch.push(entry.record);
    id = entry.parentId ?? undefined;
  }
  return readEvents({ sessionManager: { getBranch: () => branch.reverse() } });
}

/** Canonical path when it exists, so symlinked roots and cwd compare equal. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * Why a main-agent bash command must not run, or undefined. While the board
 * has tasks, git history under the protected roots is written only by workers
 * (in their own worktrees) and by task_integrate, so the delivered revision is
 * always one the task tools accepted. Unresolvable targets are blocked.
 */
export function gitWriteBlockReason(command: string, cwd: string, taskCount: number, roots: readonly string[], home: string = homedir()): string | undefined {
  if (taskCount === 0) return undefined;
  const protectedRoots = roots.map(canonical);
  const writes = findGitWrites(command, canonical(cwd), home).filter((write) => write.directory === undefined || protectedRoots.length === 0 || protectedRoots.some((root) => isWithin(canonical(write.directory!), root)));
  if (writes.length === 0) return undefined;
  return [
    `GIT_WRITE_BLOCKED: the task board has ${taskCount} task(s), so the main agent does not write git history in the repository or task worktrees; workers commit in their own worktrees and task_integrate builds integrations.`,
    `Blocked: ${writes.map((write) => `\`${write.command}\` in ${write.directory ?? 'a directory that cannot be resolved statically'}`).join('; ')}.`,
    'To deliver, report the DELIVERABLE revision from task_status; the human takes it from there. For a further change, plan it as a task (review_required false is allowed for low-risk mechanical work).',
  ].join('\n');
}

function text(value: string, details?: unknown): PiToolResult {
  return { content: [{ type: 'text', text: value }], ...(details === undefined ? {} : { details }) };
}

function short(revision: string | undefined): string {
  return revision === undefined ? '-' : revision.slice(0, 12);
}

export function formatTask(task: TaskView): string {
  const attempt = task.attemptRecords[task.attemptRecords.length - 1];
  const limit = Math.max(1, task.contract.retry?.max_attempts ?? 0);
  const parts = [`${task.id} ${task.state}`, `attempts ${task.attemptRecords.length}/${limit}`, `review ${task.reviewRequired ? 'required' : 'skip'}`];
  if (task.unmetDependencies.length > 0) parts.push(`waiting on ${task.unmetDependencies.join(',')}`);
  if (task.blocker !== undefined) parts.push(`blocker ${task.blocker}`);
  const lines = [parts.join(' · '), `  objective: ${task.contract.objective.split('\n')[0]!.slice(0, 160)}`];
  if (task.integration !== undefined) lines.push(`  integration of ${task.integration.inputs.map((input) => `${input.taskId}@${short(input.revision)}`).join(', ')} onto ${short(task.integration.baseRevision)}`);
  if (attempt !== undefined) {
    lines.push(`  attempt ${attempt.attemptId}: agent ${attempt.agentId ?? (task.integration === undefined ? '(unbound)' : 'host (integration)')} · worktree ${attempt.lease.workspacePath} · branch ${attempt.lease.branch} · base ${short(attempt.lease.baseRevision)}`);
    if (attempt.checks.length > 0) {
      const last = attempt.checks[attempt.checks.length - 1]!;
      lines.push(`  failed checks: ${attempt.checks.length} (last ${last.stage} @${short(last.revision)}: ${last.reasons.join('; ').slice(0, 300)})`);
    }
    if (attempt.integration?.revision !== undefined) lines.push(`  integrated revision ${attempt.integration.revision} (${attempt.integration.applied.length} commit(s))`);
    if (attempt.integration?.conflict !== undefined) lines.push(`  CONFLICT at ${short(attempt.integration.conflict.commit)} (candidate ${short(attempt.integration.conflict.input)}) in ${attempt.integration.conflict.paths.join(', ')}`);
    if (attempt.candidate !== undefined) lines.push(`  candidate ${attempt.candidate.revision} · ${attempt.candidate.changedPaths.length} path(s) · verification ${attempt.candidate.verdict.verdict}`);
    if (attempt.review !== undefined) lines.push(`  review ${attempt.review.reviewId} @${short(attempt.review.revision)}: ${attempt.review.verdict === undefined ? 'awaiting reviewer' : `${attempt.review.verdict.outcome} by ${attempt.review.reviewerAgentId ?? '?'}`}`);
    if (attempt.verdict !== undefined) lines.push(`  verdict ${attempt.verdict.verdict} (${attempt.verdict.source}): ${attempt.verdict.reasons.join('; ').slice(0, 300)}`);
    if (attempt.failure !== undefined) lines.push(`  attempt failed${attempt.failure.terminal ? ' (terminal)' : ''}: ${attempt.failure.reason}`);
  }
  if (task.reason !== undefined) lines.push(`  reason: ${task.reason}`);
  if (task.cancelReason !== undefined) lines.push(`  cancelled: ${task.cancelReason}`);
  return lines.join('\n');
}

function taskId(params: unknown): string {
  const id = (params as { task_id?: unknown } | undefined)?.task_id;
  if (typeof id !== 'string' || id.length === 0) throw new TaskServiceError('INVALID_INPUT', 'task_id is required');
  return id;
}

function stringParam(params: unknown, name: string): string {
  const value = (params as Record<string, unknown> | undefined)?.[name];
  if (typeof value !== 'string' || value.length === 0) throw new TaskServiceError('INVALID_INPUT', `${name} is required`);
  return value;
}

const TASK_ID_PARAM = { type: 'string', description: 'Task id, e.g. "T1"' } as const;
const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;

const WORKFLOW_GUIDELINES = [
  'Orchestration loop for multi-step coding work: plan tasks with task_plan, then repeatedly observe (task_status) → start ready tasks (task_start) → spawn each worker with Pier `subagent` using the returned prompt and cwd, run_in_background true → task_bind the returned agent id → on its settlement notice run task_verify → if a review is required, task_review_brief, spawn the reviewer with the returned role/cwd/prompt, then task_review_record → decide the next action.',
  'Small, single-file fixes that need no delegation do not need task tools or subagents; do them yourself and run the checks. Once a task is planned, git writes (commit, merge, cherry-pick, reset, ...) by you in the repository or task worktrees are blocked; the result to hand over is the DELIVERABLE revision in task_status.',
  'Plan parallel tasks so they do not modify the same shared or coordination file (build files, registries, shared headers). Prefer per-task fragments; if shared wiring is needed first, make it a prerequisite task and start dependents with base_task.',
  'A worker saying "done" is not acceptance. Only task_verify / task_review_record move a task toward PASSED. Never paraphrase a reviewer verdict; task_review_record reads it from Pier.',
  'When task_verify reports check_failed, send the worker the reasons with `subagent send` and verify again, or task_abandon the attempt. After a rejected review, task_start with reuse_worktree true continues on the same branch.',
];

export function createAgentOrchestratorExtension(deps: ExtensionDeps): (pi: PiExtensionApi) => void {
  return (pi) => {
    let service: TaskService | undefined;
    let unavailable: string | undefined;
    let notes: readonly string[] = [];

    const persist = (event: TaskEvent): void => { pi.appendEntry(TASK_EVENT_CUSTOM_TYPE, event); };

    function rebuild(ctx: unknown): void {
      try {
        const next = deps.createService(persist);
        const restored = next.restore(readEvents(ctx));
        service = next;
        unavailable = undefined;
        notes = restored.leaseErrors;
      } catch (error) {
        service = undefined;
        unavailable = error instanceof Error ? error.message : String(error);
      }
    }

    function ready(ctx: unknown): TaskService {
      if (service === undefined && unavailable === undefined) rebuild(ctx);
      if (service === undefined) throw new Error(`task tools are unavailable: ${unavailable ?? 'not initialized'}`);
      return service;
    }

    pi.on('session_start', (_event, ctx) => { rebuild(ctx); });
    pi.on('session_tree', (_event, ctx) => { rebuild(ctx); });
    pi.on('tool_call', (event, ctx) => {
      const call = event as { toolName?: unknown; input?: unknown } | undefined;
      if (call?.toolName !== 'bash' || service === undefined) return undefined;
      const command = (call.input as { command?: unknown } | undefined)?.command;
      if (typeof command !== 'string') return undefined;
      const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
      let reason: string | undefined;
      try {
        reason = gitWriteBlockReason(command, typeof cwd === 'string' ? cwd : process.cwd(), service.status().length, deps.gitGuardRoots?.() ?? []);
      } catch (error) {
        if (/\bgit\b/.test(command)) reason = `GIT_WRITE_BLOCKED: the git write guard could not check this command (${error instanceof Error ? error.message : String(error)})`;
      }
      return reason === undefined ? undefined : { block: true, reason };
    });

    function tool(definition: Omit<PiToolDefinition, 'execute'>, run: (svc: TaskService, params: unknown, signal: AbortSignal | undefined) => Promise<PiToolResult> | PiToolResult): void {
      pi.registerTool({
        ...definition,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const svc = ready(ctx);
          try {
            return await run(svc, params, signal);
          } catch (error) {
            if (error instanceof TaskServiceError) throw new Error(`${error.code}: ${error.message}`);
            throw error;
          }
        },
      });
    }

    tool({
      name: 'task_status',
      label: 'Task Status',
      description: 'Show the structured task board: every task with state, dependencies, attempts, bound Pier agent, worktree, failed checks, candidate revision, review, and verdict. Also lists READY task ids and the DELIVERABLE revision (the latest PASSED integration, or the only task\'s PASSED revision), which is the one result to hand over. This is the source of truth for workflow state; do not rely on chat memory.',
      promptGuidelines: WORKFLOW_GUIDELINES,
      parameters: { type: 'object', properties: { task_id: TASK_ID_PARAM }, additionalProperties: false },
    }, (svc, params) => {
      const id = (params as { task_id?: unknown } | undefined)?.task_id;
      const tasks = typeof id === 'string' && id.length > 0 ? [svc.task(id)] : svc.status();
      const body = tasks.length === 0 ? 'No tasks planned.' : tasks.map(formatTask).join('\n');
      const extra = notes.length > 0 ? `\nLease warnings after restore:\n${notes.map((note) => `- ${note}`).join('\n')}` : '';
      const deliverable = svc.deliverable();
      const deliver = deliverable.revision === undefined
        ? `DELIVERABLE: none (${deliverable.reason ?? 'not ready'})`
        : `DELIVERABLE: ${deliverable.revision} (${deliverable.taskId})${deliverable.notIncluded.length > 0 ? `; PASSED but not included: ${deliverable.notIncluded.join(', ')}` : ''}`;
      return text(`${body}\nREADY: ${svc.readySet().join(', ') || '(none)'}\n${deliver}${extra}`, { tasks: tasks.map((task) => ({ id: task.id, state: task.state, unmetDependencies: task.unmetDependencies, attempts: task.attemptRecords.length })), deliverable });
    });

    tool({
      name: 'task_plan',
      label: 'Task Plan',
      description: 'Add tasks to the board (validated atomically; nothing is added if any task is invalid). Each task is a contract: id (T followed by lowercase letters/digits/hyphens, e.g. T1, Tapi-tests), objective, depends_on (ids that must PASS first), files_in_scope (paths the worker may change; trailing slash = directory; any other change fails verification), acceptance_criteria, verification (exact commands from the host allowlist; the host runs them, not the worker), optional context, retry.max_attempts, review_required (default true; set false only for low-risk mechanical tasks). Planning rule: tasks that can run in parallel (no depends_on path between them) must not have overlapping files_in_scope, because their candidates would conflict at integration; order them with depends_on, give each its own file (e.g. a separate build/test fragment instead of appending to a shared CMakeLists.txt), or declare the shared path in planned_overlap on both tasks.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                objective: { type: 'string' },
                depends_on: STRING_ARRAY,
                context: STRING_ARRAY,
                files_in_scope: STRING_ARRAY,
                acceptance_criteria: STRING_ARRAY,
                verification: STRING_ARRAY,
                retry: { type: 'object', properties: { max_attempts: { type: 'integer', minimum: 1 } }, required: ['max_attempts'], additionalProperties: false },
                review_required: { type: 'boolean' },
                planned_overlap: { ...STRING_ARRAY, description: 'Paths this task intentionally shares with a parallel task (must be declared on both tasks)' },
              },
              required: ['id', 'objective', 'depends_on', 'files_in_scope', 'acceptance_criteria', 'verification'],
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    }, (svc, params) => {
      const added = svc.plan((params as { tasks?: unknown } | undefined)?.tasks);
      return text(`Planned ${added.length} task(s):\n${added.map(formatTask).join('\n')}\nREADY: ${svc.readySet().join(', ') || '(none)'}`);
    });

    tool({
      name: 'task_start',
      label: 'Task Start',
      description: 'Start the next attempt of a READY (or RETRYING) task: the host creates a dedicated git worktree and branch from the main checkout HEAD (or from an accepted dependency with base_task), and returns the worker prompt plus the exact Pier `subagent` spawn arguments (cwd, description). Spawn the worker with those arguments, then call task_bind. reuse_worktree continues on the previous attempt\'s branch (e.g. after a rejected review).',
      parameters: {
        type: 'object',
        properties: {
          task_id: TASK_ID_PARAM,
          reuse_worktree: { type: 'boolean', description: 'Continue on the previous attempt\'s worktree/branch' },
          base_task: { type: 'string', description: 'Branch from this PASSED dependency\'s accepted revision instead of HEAD' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    }, (svc, params) => {
      const p = params as { reuse_worktree?: boolean; base_task?: string };
      const result = svc.start(taskId(params), { ...(p.reuse_worktree === undefined ? {} : { reuseWorktree: p.reuse_worktree }), ...(p.base_task === undefined ? {} : { baseTask: p.base_task }) });
      if (result.prompt === undefined || result.spawn === undefined) return text(`${result.taskId} → ${result.state}: ${result.reason ?? 'not started'}`, result);
      return text([
        `${result.taskId} ${result.state} · ${result.attemptId}${result.reusedFrom === undefined ? '' : ` (continues ${result.reusedFrom})`}`,
        `worktree ${result.workspacePath} · branch ${result.branch} · base ${result.baseRevision}`,
        '',
        `Next: subagent spawn with description "${result.spawn.description}", cwd "${result.spawn.cwd}", run_in_background true, and exactly this prompt; then task_bind ${result.taskId} with the returned agent id.${result.reusedFrom === undefined ? '' : ' To keep the same worker, send it this prompt with `subagent send` instead of spawning.'}`,
        '',
        '--- worker prompt ---',
        result.prompt,
      ].join('\n'), result);
    });

    tool({
      name: 'task_bind',
      label: 'Task Bind',
      description: 'Record which Pier subagent (agent id / pane id) runs the current attempt. The host checks Pier\'s ledger that the subagent was launched in the task worktree.',
      parameters: { type: 'object', properties: { task_id: TASK_ID_PARAM, agent_id: { type: 'string', description: 'Pier agent id returned by subagent spawn' } }, required: ['task_id', 'agent_id'], additionalProperties: false },
    }, (svc, params) => {
      const attempt = svc.bind(taskId(params), stringParam(params, 'agent_id'));
      return text(`${taskId(params)} ${attempt.attemptId} bound to ${attempt.agentId}. Wait for its settlement notice, then task_verify.`);
    });

    tool({
      name: 'task_verify',
      label: 'Task Verify',
      description: 'After the worker settles: the host inspects the worktree (HEAD revision, changed paths, clean, commits ahead), enforces files_in_scope, then runs the task\'s allowlisted verification commands in a fresh clean checkout of exactly that revision (never in the worker\'s worktree, so no worker build output is reused). Passing settles the attempt with a candidate revision (PASSED directly when review is not required). Failing records a failed check and returns the reasons and output tails; fix via `subagent send` and verify again.',
      parameters: { type: 'object', properties: { task_id: TASK_ID_PARAM }, required: ['task_id'], additionalProperties: false },
    }, async (svc, params) => {
      const result = await svc.verify(taskId(params));
      const lines = [`${result.taskId} ${result.attemptId}: ${result.outcome} → ${result.state} · revision ${result.revision ?? '-'} · checks ${result.checksUsed}/${result.checksAllowed}`];
      if (result.changedPaths !== undefined) lines.push(`changed: ${result.changedPaths.join(', ')}`);
      if (result.cleanRoom !== undefined) lines.push(`verified in clean checkout ${result.cleanRoom} (removed${result.cleanupWarning === undefined ? '' : ` with warning: ${result.cleanupWarning}`})`);
      if (result.reasons.length > 0) lines.push('reasons:', ...result.reasons.map((reason) => `- ${reason}`));
      for (const command of result.commands) {
        lines.push(`$ ${command.command} → exit ${command.exitCode}${command.timedOut ? ' (timed out)' : ''} in ${command.durationMs}ms`);
        if (command.exitCode !== 0 || command.timedOut) lines.push(command.outputTail);
      }
      if (result.outcome === 'awaiting_review') lines.push('Next: task_review_brief.');
      return text(lines.join('\n'), { ...result, commands: result.commands.map(({ outputTail: _outputTail, ...rest }) => rest) });
    });

    tool({
      name: 'task_review_brief',
      label: 'Task Review Brief',
      description: 'Issue a fresh-review brief for a VERIFYING task, bound to its exact candidate revision and a one-time review id. The host first checks the reviewer role is read-only and that the candidate is still HEAD and clean. Spawn a NEW reviewer with the returned role, cwd, and prompt (never reuse the implementer), then call task_review_record.',
      parameters: { type: 'object', properties: { task_id: TASK_ID_PARAM }, required: ['task_id'], additionalProperties: false },
    }, (svc, params) => {
      const result = svc.reviewBrief(taskId(params));
      if (result.outcome === 'rejected' || result.prompt === undefined || result.spawn === undefined) return text(`${result.taskId} → ${result.state}: candidate rejected: ${result.reasons.join('; ')}`, result);
      return text([
        `${result.taskId} review ${result.reviewId} for ${result.revision}`,
        `Next: subagent spawn with role "${result.spawn.role}", description "${result.spawn.description}", cwd "${result.spawn.cwd}", run_in_background true, and exactly this prompt; after it settles call task_review_record ${result.taskId} with its agent id.`,
        '',
        '--- reviewer prompt ---',
        result.prompt,
      ].join('\n'), { ...result, prompt: undefined });
    });

    tool({
      name: 'task_review_record',
      label: 'Task Review Record',
      description: 'Apply a fresh reviewer\'s verdict. The host reads the reviewer\'s closing output from Pier\'s ledger (never from your paraphrase), checks the reviewer ran the read-only role, is fresh, is not an implementer, and that the verdict names the issued review id and the candidate revision, then re-checks the worktree. Passed → PASSED; rejected → RETRYING (or FAILED when the attempt budget is spent).',
      parameters: { type: 'object', properties: { task_id: TASK_ID_PARAM, agent_id: { type: 'string', description: 'Pier agent id of the reviewer' } }, required: ['task_id', 'agent_id'], additionalProperties: false },
    }, (svc, params) => {
      const result = svc.recordReview(taskId(params), stringParam(params, 'agent_id'));
      return text(`${result.taskId} review ${result.verdict} for ${result.revision} → ${result.state}\n${result.reasons.map((reason) => `- ${reason}`).join('\n')}\nREADY: ${svc.readySet().join(', ') || '(none)'}`, result);
    });

    tool({
      name: 'task_integrate',
      label: 'Task Integrate',
      description: 'Integrate exact accepted candidate revisions onto an exact base revision in a new host-owned integration worktree/branch (the main checkout is never touched). Every input must be a PASSED task whose candidate revision passed clean-room verification and a fresh review; the host re-confirms each review in Pier\'s ledger. Candidates accepted in earlier sessions need their Pi session .jsonl files in evidence_sessions. Commits of base..candidate are cherry-picked (-x) in the given order; any conflict aborts, is recorded, and fails the integration (no auto-resolution). On success it returns an integration task id: run task_verify on it, then task_review_brief / spawn a fresh reviewer / task_review_record, exactly like a normal task.',
      parameters: {
        type: 'object',
        properties: {
          base_revision: { type: 'string', description: 'Full object id of the base (not HEAD or a branch name)' },
          revisions: { ...STRING_ARRAY, description: 'Accepted candidate revisions in integration order (full ids or unique prefixes of accepted candidates)' },
          evidence_sessions: { ...STRING_ARRAY, description: 'Absolute paths of Pi session .jsonl files holding the acceptance of candidates from earlier sessions' },
        },
        required: ['base_revision', 'revisions'],
        additionalProperties: false,
      },
    }, (svc, params) => {
      const p = params as { base_revision?: unknown; revisions?: unknown; evidence_sessions?: unknown };
      const sessions = Array.isArray(p.evidence_sessions) ? p.evidence_sessions.map(String) : [];
      const evidence = sessions.map((path) => {
        try { return { source: path, events: readSessionFileEvents(path) }; } catch (error) { throw new TaskServiceError('INVALID_INPUT', `cannot read evidence ${path}: ${error instanceof Error ? error.message : String(error)}`); }
      });
      const result = svc.integrate({ baseRevision: String(p.base_revision ?? ''), revisions: Array.isArray(p.revisions) ? p.revisions.map(String) : [], evidence });
      const lines = [
        `${result.taskId} ${result.state} · base ${result.baseRevision}`,
        `branch ${result.branch} · worktree ${result.workspacePath}`,
        'inputs:',
        ...result.inputs.map((input) => `- ${input.taskId} ${input.revision} (${input.commits.length} own commit(s)${input.baseRevision === undefined || input.baseRevision === result.baseRevision ? '' : ` on top of ${input.baseRevision.slice(0, 12)}`}; reviewed by ${input.reviewerAgentId}; evidence: ${input.source})`),
        'applied:',
        ...(result.applied.length === 0 ? ['- (none)'] : result.applied.map((entry) => `- ${entry.source.slice(0, 12)} → ${entry.integrated.slice(0, 12)}`)),
      ];
      if (result.conflict !== undefined) lines.push(`CONFLICT cherry-picking ${result.conflict.commit}${result.conflict.commit === result.conflict.input ? '' : ` (candidate ${result.conflict.input})`} in: ${result.conflict.paths.join(', ') || '(none reported)'}`, `detail: ${result.conflict.detail}`, 'The integration FAILED closed; nothing was resolved automatically. The worktree is left at the last cleanly applied commit for audit.');
      else if (result.integratedRevision !== undefined) lines.push(`integrated revision ${result.integratedRevision}`, `Next: task_verify ${result.taskId}.`);
      else if (result.reason !== undefined) lines.push(`FAILED: ${result.reason}`);
      return text(lines.join('\n'), result);
    });

    tool({
      name: 'task_abandon',
      label: 'Task Abandon',
      description: 'Give up on the current attempt of a RUNNING or VERIFYING task (the retry budget decides RETRYING vs FAILED; terminal true forces FAILED for a RUNNING attempt), or with cancel true cancel the task entirely (its dependents become blocked). Always give a concrete reason.',
      parameters: { type: 'object', properties: { task_id: TASK_ID_PARAM, reason: { type: 'string' }, terminal: { type: 'boolean' }, cancel: { type: 'boolean' } }, required: ['task_id', 'reason'], additionalProperties: false },
    }, (svc, params) => {
      const p = params as { terminal?: boolean; cancel?: boolean };
      const reason = stringParam(params, 'reason');
      const view = p.cancel === true ? svc.cancel(taskId(params), reason) : svc.abandon(taskId(params), reason, p.terminal === true);
      return text(formatTask(view));
    });
  };
}

export default function agentOrchestratorExtension(pi: PiExtensionApi): void {
  createAgentOrchestratorExtension(defaultExtensionDeps())(pi);
}
