/**
 * Pure task board for a main-agent-driven run.
 *
 * The board is a deterministic reducer over TaskGraph plus per-attempt
 * evidence. Every mutation is an event; the live service and a session replay
 * apply the same events through `apply`, so a resumed Pi session rebuilds the
 * same state. The board performs no I/O and never decides what runs next: it
 * only answers what is true and which transitions are legal.
 */
import type { WorkspaceLease } from '../adapters/worktree-manager.ts';
import { TaskGraph, type TaskGraphResult, type TaskSnapshot } from '../core/task-graph.ts';
import type { TaskContract } from '../core/task-contract.ts';
import type { ReviewVerdict } from '../core/reviewer-brief.ts';
import type { EvidenceBundle, VerificationVerdict } from '../core/verification.ts';
import { deepFreeze } from '../core/validate.ts';

export const TASK_EVENT_VERSION = 1 as const;

export type CheckStage = 'artifact' | 'verification';
export type VerdictSource = 'mechanical' | 'review' | 'guard' | 'abandon';

export interface CandidateRecord {
  readonly revision: string;
  readonly changedPaths: readonly string[];
  readonly evidence: EvidenceBundle;
  readonly verdict: VerificationVerdict;
}

/** One accepted candidate entering an integration, pinned to its exact revision. */
export interface IntegrationInput {
  readonly taskId: string;
  readonly revision: string;
  /** What the candidate was built on: the integration base or an earlier input's revision. */
  readonly baseRevision?: string;
  /** Commits of baseRevision..revision, oldest first; these are what gets cherry-picked. */
  readonly commits: readonly string[];
  /** Where the acceptance evidence came from ("this session" or a session file path). */
  readonly source: string;
  readonly implementerAgentIds: readonly string[];
  readonly reviewerAgentId: string;
  readonly reviewId: string;
}

export interface IntegrationSpec {
  readonly baseRevision: string;
  readonly inputs: readonly IntegrationInput[];
}

export interface AppliedCommit {
  readonly source: string;
  readonly integrated: string;
}

export interface IntegrationRecord {
  readonly applied: readonly AppliedCommit[];
  readonly revision?: string;
  readonly conflict?: { readonly input: string; readonly commit: string; readonly paths: readonly string[]; readonly detail: string };
}

export type TaskEvent =
  | { readonly v: 1; readonly type: 'plan'; readonly at: number; readonly tasks: readonly { readonly contract: TaskContract; readonly reviewRequired: boolean; readonly integration?: IntegrationSpec; readonly plannedOverlap?: readonly string[] }[] }
  | { readonly v: 1; readonly type: 'integration_applied'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly applied: readonly AppliedCommit[]; readonly revision: string }
  | { readonly v: 1; readonly type: 'integration_conflict'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly applied: readonly AppliedCommit[]; readonly input: string; readonly commit: string; readonly paths: readonly string[]; readonly detail: string }
  | { readonly v: 1; readonly type: 'start'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly lease: WorkspaceLease; readonly reusedFrom?: string }
  | { readonly v: 1; readonly type: 'bind'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly agentId: string }
  | { readonly v: 1; readonly type: 'check_failed'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly stage: CheckStage; readonly reasons: readonly string[]; readonly revision?: string; readonly evidence?: EvidenceBundle }
  | { readonly v: 1; readonly type: 'settle'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly candidate: CandidateRecord }
  | { readonly v: 1; readonly type: 'review_requested'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly reviewId: string; readonly revision: string }
  | { readonly v: 1; readonly type: 'verdict'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly verdict: 'passed' | 'rejected'; readonly source: VerdictSource; readonly reasons: readonly string[]; readonly reviewerAgentId?: string; readonly review?: ReviewVerdict }
  | { readonly v: 1; readonly type: 'attempt_failed'; readonly at: number; readonly taskId: string; readonly attemptId: string; readonly reason: string; readonly terminal: boolean }
  | { readonly v: 1; readonly type: 'cancel'; readonly at: number; readonly taskId: string; readonly reason: string };

export interface CheckRecord {
  readonly at: number;
  readonly stage: CheckStage;
  readonly reasons: readonly string[];
  readonly revision?: string;
  readonly evidence?: EvidenceBundle;
}

export interface ReviewRecord {
  readonly reviewId: string;
  readonly revision: string;
  readonly issuedAt: number;
  readonly reviewerAgentId?: string;
  readonly verdict?: ReviewVerdict;
}

export interface AttemptRecord {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly lease: WorkspaceLease;
  readonly reusedFrom?: string;
  readonly agentId?: string;
  readonly boundAt?: number;
  readonly checks: readonly CheckRecord[];
  readonly candidate?: CandidateRecord;
  readonly review?: ReviewRecord;
  readonly verdict?: { readonly verdict: 'passed' | 'rejected'; readonly source: VerdictSource; readonly reasons: readonly string[]; readonly at: number };
  readonly failure?: { readonly reason: string; readonly terminal: boolean; readonly at: number };
  readonly integration?: IntegrationRecord;
}

export interface TaskView extends TaskSnapshot {
  readonly reviewRequired: boolean;
  readonly integration?: IntegrationSpec;
  readonly plannedOverlap?: readonly string[];
  readonly unmetDependencies: readonly string[];
  readonly attemptRecords: readonly AttemptRecord[];
  readonly cancelReason?: string;
}

export class TaskBoardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskBoardError';
    this.code = code;
  }
}

interface MutableAttempt {
  attemptId: string;
  startedAt: number;
  lease: WorkspaceLease;
  reusedFrom?: string;
  agentId?: string;
  boundAt?: number;
  checks: CheckRecord[];
  candidate?: CandidateRecord;
  review?: ReviewRecord;
  verdict?: NonNullable<AttemptRecord['verdict']>;
  failure?: NonNullable<AttemptRecord['failure']>;
  integration?: IntegrationRecord;
}

interface TaskMeta {
  reviewRequired: boolean;
  integration?: IntegrationSpec;
  plannedOverlap?: readonly string[];
  attempts: MutableAttempt[];
  cancelReason?: string;
}

function graphOk(result: TaskGraphResult, context: string): void {
  if (!result.ok) throw new TaskBoardError(result.error.code, `${context}: ${result.error.message}`);
}

export class TaskBoard {
  private readonly graph = new TaskGraph();
  private readonly meta = new Map<string, TaskMeta>();
  private readonly log: TaskEvent[] = [];

  /** Apply one event atomically: on error the board is unchanged except for graph-level no-ops. */
  apply(event: TaskEvent): void {
    if (event === null || typeof event !== 'object' || event.v !== TASK_EVENT_VERSION) throw new TaskBoardError('INVALID_EVENT', 'event version is unsupported');
    switch (event.type) {
      case 'plan': {
        for (const { contract } of event.tasks) {
          if (this.meta.has(contract.id)) throw new TaskBoardError('TASK_ALREADY_EXISTS', `task ${contract.id} already exists`);
        }
        for (const { contract, reviewRequired, integration, plannedOverlap } of event.tasks) {
          graphOk(this.graph.addTask(contract), `plan ${contract.id}`);
          this.meta.set(contract.id, { reviewRequired, ...(integration === undefined ? {} : { integration }), ...(plannedOverlap === undefined ? {} : { plannedOverlap: [...plannedOverlap] }), attempts: [] });
        }
        break;
      }
      case 'start': {
        const meta = this.requireMeta(event.taskId);
        const task = this.graph.getTask(event.taskId)!;
        if (task.state === 'RETRYING') graphOk(this.graph.transitionTask(event.taskId, { type: 'ready' }), `ready ${event.taskId}`);
        const readied = this.graph.getTask(event.taskId)!;
        if (readied.state === 'FAILED') break; // retry budget exhausted by the ready guard
        graphOk(this.graph.transitionTask(event.taskId, { type: 'start', attemptId: event.attemptId }), `start ${event.taskId}`);
        meta.attempts.push({ attemptId: event.attemptId, startedAt: event.at, lease: event.lease, ...(event.reusedFrom === undefined ? {} : { reusedFrom: event.reusedFrom }), checks: [] });
        break;
      }
      case 'bind': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        attempt.agentId = event.agentId;
        attempt.boundAt = event.at;
        break;
      }
      case 'check_failed': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        this.requireState(event.taskId, 'RUNNING');
        attempt.checks.push({ at: event.at, stage: event.stage, reasons: [...event.reasons], ...(event.revision === undefined ? {} : { revision: event.revision }), ...(event.evidence === undefined ? {} : { evidence: event.evidence }) });
        break;
      }
      case 'settle': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        graphOk(this.graph.transitionTask(event.taskId, { type: 'settle', attemptId: event.attemptId, outcome: `candidate ${event.candidate.revision}` }), `settle ${event.taskId}`);
        attempt.candidate = event.candidate;
        break;
      }
      case 'review_requested': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        this.requireState(event.taskId, 'VERIFYING');
        if (attempt.candidate === undefined || attempt.candidate.revision !== event.revision) throw new TaskBoardError('REVISION_MISMATCH', 'review must target the settled candidate revision');
        attempt.review = { reviewId: event.reviewId, revision: event.revision, issuedAt: event.at };
        break;
      }
      case 'verdict': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        graphOk(this.graph.transitionTask(event.taskId, { type: 'verdict', verdict: event.verdict }), `verdict ${event.taskId}`);
        attempt.verdict = { verdict: event.verdict, source: event.source, reasons: [...event.reasons], at: event.at };
        if (event.review !== undefined && attempt.review !== undefined) {
          attempt.review = { ...attempt.review, verdict: event.review, ...(event.reviewerAgentId === undefined ? {} : { reviewerAgentId: event.reviewerAgentId }) };
        }
        break;
      }
      case 'attempt_failed': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        graphOk(this.graph.transitionTask(event.taskId, { type: 'executor_error', attemptId: event.attemptId, outcome: event.reason, terminal: event.terminal }), `fail ${event.taskId}`);
        attempt.failure = { reason: event.reason, terminal: event.terminal, at: event.at };
        break;
      }
      case 'integration_applied': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        this.requireState(event.taskId, 'RUNNING');
        if (this.requireMeta(event.taskId).integration === undefined) throw new TaskBoardError('INVALID_EVENT', `${event.taskId} is not an integration task`);
        if (attempt.integration !== undefined) throw new TaskBoardError('INVALID_EVENT', `${event.attemptId} was already integrated`);
        attempt.integration = { applied: [...event.applied], revision: event.revision };
        break;
      }
      case 'integration_conflict': {
        const attempt = this.requireCurrentAttempt(event.taskId, event.attemptId);
        this.requireState(event.taskId, 'RUNNING');
        if (this.requireMeta(event.taskId).integration === undefined) throw new TaskBoardError('INVALID_EVENT', `${event.taskId} is not an integration task`);
        attempt.integration = { applied: [...event.applied], conflict: { input: event.input, commit: event.commit, paths: [...event.paths], detail: event.detail } };
        break;
      }
      case 'cancel': {
        const meta = this.requireMeta(event.taskId);
        graphOk(this.graph.cancelTask(event.taskId), `cancel ${event.taskId}`);
        meta.cancelReason = event.reason;
        break;
      }
      default:
        throw new TaskBoardError('INVALID_EVENT', `unknown event type ${String((event as { type?: unknown }).type)}`);
    }
    this.log.push(deepFreeze(structuredClone(event)));
  }

  events(): readonly TaskEvent[] {
    return [...this.log];
  }

  has(taskId: string): boolean {
    return this.meta.has(taskId);
  }

  task(taskId: string): TaskView | undefined {
    const snapshot = this.graph.getTask(taskId);
    const meta = this.meta.get(taskId);
    if (snapshot === undefined || meta === undefined) return undefined;
    const graph = this.graph.snapshot();
    const unmet = graph.dependencies.filter((edge) => edge.to === taskId && graph.tasks.find((task) => task.id === edge.from)?.state !== 'PASSED').map((edge) => edge.from);
    return deepFreeze({
      ...snapshot,
      reviewRequired: meta.reviewRequired,
      ...(meta.integration === undefined ? {} : { integration: structuredClone(meta.integration) }),
      ...(meta.plannedOverlap === undefined ? {} : { plannedOverlap: [...meta.plannedOverlap] }),
      unmetDependencies: unmet,
      attemptRecords: structuredClone(meta.attempts) as AttemptRecord[],
      ...(meta.cancelReason === undefined ? {} : { cancelReason: meta.cancelReason }),
    });
  }

  tasks(): readonly TaskView[] {
    return this.graph.snapshot().tasks.map((task) => this.task(task.id)!);
  }

  readySet(): readonly string[] {
    return this.graph.readySet();
  }

  currentAttempt(taskId: string): AttemptRecord | undefined {
    const attempts = this.meta.get(taskId)?.attempts;
    return attempts === undefined || attempts.length === 0 ? undefined : structuredClone(attempts[attempts.length - 1]!);
  }

  private requireMeta(taskId: string): TaskMeta {
    const meta = this.meta.get(taskId);
    if (meta === undefined) throw new TaskBoardError('UNKNOWN_TASK', `unknown task ${taskId}`);
    return meta;
  }

  private requireCurrentAttempt(taskId: string, attemptId: string): MutableAttempt {
    const attempts = this.requireMeta(taskId).attempts;
    const current = attempts[attempts.length - 1];
    if (current === undefined || current.attemptId !== attemptId) throw new TaskBoardError('STALE_ATTEMPT', `attempt ${attemptId} is not the current attempt of ${taskId}`);
    return current;
  }

  private requireState(taskId: string, state: TaskSnapshot['state']): void {
    const task = this.graph.getTask(taskId);
    if (task?.state !== state) throw new TaskBoardError('INVALID_STATE', `task ${taskId} is ${task?.state ?? 'missing'}, expected ${state}`);
  }
}

/** Rebuild a board from persisted events; throws on the first inconsistent event. */
export function replayTaskBoard(events: readonly TaskEvent[]): TaskBoard {
  const board = new TaskBoard();
  for (const event of events) board.apply(event);
  return board;
}
