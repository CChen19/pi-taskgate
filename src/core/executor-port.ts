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

export type AttemptPollResult =
  | { readonly status: 'pending'; readonly activity?: boolean }
  | { readonly status: 'settled'; readonly outcome: string };

export interface AttemptHandle {
  /** Return the current result. Pending polling must not settle an attempt. */
  poll(): AttemptPollResult;
  /** Ask the executor to stop this attempt. The scheduler closes it after this call. */
  cancel(reason: string): void;
  /** Release executor-side resources. This is called exactly once by Scheduler. */
  close(): void;
}

export interface ExecutorPort {
  /** Start one already-authorized task attempt. */
  start(request: ExecutorStartRequest): AttemptHandle;
}

/** A deterministic offline script step for FakeExecutor. */
export type FakeExecutorStep =
  | { readonly status: 'pending'; readonly activity?: boolean }
  | { readonly status: 'settled'; readonly outcome: string };

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
        if (step === undefined) return { status: 'settled', outcome: 'completed' };
        if (cursor < steps.length - 1 || step.status === 'settled') cursor++;
        if (step.status === 'pending') {
          return step.activity === undefined ? { status: 'pending' } : { status: 'pending', activity: step.activity };
        }
        return { status: 'settled', outcome: step.outcome };
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
    return { status: 'settled' as const, outcome: step.outcome };
  }));
}
