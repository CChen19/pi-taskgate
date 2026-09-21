/**
 * Side-effect boundary for task execution.
 *
 * S3 deliberately uses polling rather than callbacks. A scheduler tick can
 * therefore observe all executor results at one injected time, which keeps
 * ordering deterministic and leaves real process/event-loop integration to a
 * later adapter.
 */

import type { TaskContract } from './task-contract.ts';
import { asNonEmptyString, deepFreeze } from './validate.ts';

export interface ExecutorStartRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly contract: TaskContract;
  readonly startedAt: number;
}

export const SETTLEMENT_FAILURE_CODES = [
  'SCOPE_VIOLATION',
  'WORKER_FAILED',
  'WORKER_CANCELLED',
  'SESSION_LOST',
  'INSPECTION_FAILED',
  'MALFORMED_TRANSPORT',
  'TRANSPORT_FAILED',
  'CLEANUP_PENDING',
] as const;
export type SettlementFailureCode = (typeof SETTLEMENT_FAILURE_CODES)[number];

export interface AttemptArtifact {
  /** Host-observed revision; never populated from worker claims. */
  readonly artifactRevision: string;
  readonly diffRef?: string;
  readonly changedPaths: readonly string[];
}

export interface AttemptSettlement {
  readonly conclusion: string;
  readonly acceptanceEligible: boolean;
  readonly artifact: AttemptArtifact;
  readonly failureCode?: SettlementFailureCode;
  readonly reason?: string;
}

export type AttemptPollResult =
  | { readonly status: 'pending'; readonly activity?: boolean }
  | {
      readonly status: 'settled';
      readonly outcome: string;
      readonly settlement: AttemptSettlement;
    };

export interface AttemptHandle {
  /** Return the current result. Pending polling must not settle an attempt. */
  poll(): AttemptPollResult;
  /** Ask the executor to stop this attempt. The scheduler closes it after this call. */
  cancel(reason: string): void;
  /** Release executor-side resources; adapters may retry this operation. */
  close(): void;
  /** Optional structured status for staged close/cleanup failures. */
  lastError?(): unknown;
}

export interface ExecutorPort {
  /** Start one already-authorized task attempt. */
  start(request: ExecutorStartRequest): AttemptHandle;
}

/** A deterministic offline script step for FakeExecutor. */
export type FakeExecutorStep =
  | { readonly status: 'pending'; readonly activity?: boolean }
  | { readonly status: 'settled'; readonly outcome: string; readonly settlement?: AttemptSettlement };

export type FakeExecutorScript =
  | Readonly<Record<string, readonly FakeExecutorStep[]>>
  | ((request: ExecutorStartRequest) => readonly FakeExecutorStep[]);

export interface FakeExecutorOptions {
  readonly scripts?: FakeExecutorScript;
  readonly defaultSteps?: readonly FakeExecutorStep[];
}

export interface FakeExecutorCancelCall {
  readonly taskId: string;
  readonly attemptId: string;
  readonly reason: string;
}

/**
 * In-memory executor for tests. It never starts a process and only advances a
 * script when Scheduler polls its handle. An absent script settles as
 * `completed` on the first poll.
 */
export class FakeExecutor implements ExecutorPort {
  private readonly script: FakeExecutorScript | undefined;
  private readonly defaultSteps: readonly FakeExecutorStep[];
  private readonly recordedStarts: ExecutorStartRequest[] = [];
  private readonly recordedCancels: FakeExecutorCancelCall[] = [];
  private readonly recordedCloses: string[] = [];

  constructor(scriptOrOptions: FakeExecutorScript | FakeExecutorOptions = {}) {
    if (typeof scriptOrOptions === 'function') {
      this.script = scriptOrOptions;
      this.defaultSteps = [{ status: 'settled', outcome: 'completed' }];
      return;
    }
    if (isOptions(scriptOrOptions)) {
      this.script = scriptOrOptions.scripts;
      this.defaultSteps = copySteps(scriptOrOptions.defaultSteps ?? [{ status: 'settled', outcome: 'completed' }]);
      return;
    }
    this.script = scriptOrOptions;
    this.defaultSteps = [{ status: 'settled', outcome: 'completed' }];
  }

  start(request: ExecutorStartRequest): AttemptHandle {
    const recorded = deepFreeze({ ...request });
    this.recordedStarts.push(recorded);
    const configured = this.stepsFor(request);
    const steps = configured === undefined || configured.length === 0
      ? this.defaultSteps
      : copySteps(configured);
    let cursor = 0;
    let cancelled = false;
    let closed = false;

    return {
      poll: () => {
        if (cancelled || closed) return { status: 'pending' };
        const step = steps[Math.min(cursor, steps.length - 1)];
        if (step === undefined) return { status: 'settled', outcome: 'completed', settlement: fakeSettlement('completed') };
        if (cursor < steps.length - 1 || step.status === 'settled') cursor++;
        if (step.status === 'pending') {
          return step.activity === undefined ? { status: 'pending' } : { status: 'pending', activity: step.activity };
        }
        return { status: 'settled', outcome: step.outcome, settlement: step.settlement ?? fakeSettlement(step.outcome) };
      },
      cancel: (reason: string) => {
        if (cancelled || closed) return;
        cancelled = true;
        this.recordedCancels.push(deepFreeze({ taskId: request.taskId, attemptId: request.attemptId, reason }));
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.recordedCloses.push(request.attemptId);
      },
    };
  }

  get startCalls(): readonly ExecutorStartRequest[] {
    return deepFreeze(this.recordedStarts.map((entry) => ({ ...entry })));
  }

  get cancelCalls(): readonly FakeExecutorCancelCall[] {
    return deepFreeze(this.recordedCancels.map((entry) => ({ ...entry })));
  }

  get closeCalls(): readonly string[] {
    return Object.freeze([...this.recordedCloses]);
  }

  /** Alias useful in tests that only need to count starts. */
  get calls(): readonly ExecutorStartRequest[] {
    return this.startCalls;
  }

  private stepsFor(request: ExecutorStartRequest): readonly FakeExecutorStep[] | undefined {
    if (this.script === undefined || typeof this.script === 'function') {
      return typeof this.script === 'function' ? this.script(request) : undefined;
    }
    return Object.hasOwn(this.script, request.taskId) ? this.script[request.taskId] : undefined;
  }
}

function isOptions(value: FakeExecutorScript | FakeExecutorOptions): value is FakeExecutorOptions {
  return typeof value === 'object' && value !== null && (Object.hasOwn(value, 'scripts') || Object.hasOwn(value, 'defaultSteps'));
}

function fakeSettlement(conclusion: string): AttemptSettlement {
  return deepFreeze({
    conclusion,
    acceptanceEligible: true,
    artifact: { artifactRevision: 'fake-observed', changedPaths: [] },
  });
}

function normalizeFakeSettlement(value: AttemptSettlement, outcome: string, index: number): AttemptSettlement {
  if (typeof value !== 'object' || value === null || typeof value.conclusion !== 'string' || value.conclusion.length === 0 || value.conclusion !== outcome || typeof value.acceptanceEligible !== 'boolean' || typeof value.artifact !== 'object' || value.artifact === null || typeof value.artifact.artifactRevision !== 'string' || value.artifact.artifactRevision.length === 0 || !Array.isArray(value.artifact.changedPaths)) {
    throw new TypeError(`fake script settlement ${index} is invalid`);
  }
  if (value.artifact.changedPaths.length > 256 || value.artifact.changedPaths.some((path) => typeof path !== 'string' || path.length === 0 || path.length > 256)) throw new TypeError(`fake script settlement ${index} has invalid changedPaths`);
  if (value.artifact.diffRef !== undefined && (typeof value.artifact.diffRef !== 'string' || value.artifact.diffRef.length === 0 || value.artifact.diffRef.length > 256)) throw new TypeError(`fake script settlement ${index} has invalid diffRef`);
  if (value.failureCode !== undefined && !SETTLEMENT_FAILURE_CODES.includes(value.failureCode)) throw new TypeError(`fake script settlement ${index} has unknown failureCode`);
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 160)) throw new TypeError(`fake script settlement ${index} has invalid reason`);
  if (!value.acceptanceEligible && (value.failureCode === undefined || value.reason === undefined)) throw new TypeError(`fake script settlement ${index} must explain ineligibility`);
  return deepFreeze({
    conclusion: value.conclusion,
    acceptanceEligible: value.acceptanceEligible,
    artifact: {
      artifactRevision: value.artifact.artifactRevision,
      ...(value.artifact.diffRef === undefined ? {} : { diffRef: value.artifact.diffRef }),
      changedPaths: [...value.artifact.changedPaths],
    },
    ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

function copySteps(steps: readonly FakeExecutorStep[]): readonly FakeExecutorStep[] {
  return Object.freeze(steps.map((step, index) => {
    if (step.status === 'pending') {
      if (step.activity !== undefined && typeof step.activity !== 'boolean') {
        throw new TypeError(`fake script step ${index}.activity must be boolean`);
      }
      return step.activity === undefined ? { status: 'pending' as const } : { status: 'pending' as const, activity: step.activity };
    }
    if (step.status !== 'settled' || asNonEmptyString(step.outcome) === undefined) {
      throw new TypeError(`fake script step ${index} must settle with a non-empty outcome`);
    }
    return { status: 'settled' as const, outcome: step.outcome, settlement: normalizeFakeSettlement(step.settlement ?? fakeSettlement(step.outcome), step.outcome, index) };
  }));
}
