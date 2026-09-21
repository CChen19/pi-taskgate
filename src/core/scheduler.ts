/**
 * Deterministic in-memory scheduler kernel.
 *
 * TaskGraph owns lifecycle state. Scheduler only owns transient executor
 * handles, retry deadlines, and observation metadata; every task-state change
 * is submitted back to TaskGraph. Time and randomness are dependencies so this
 * module has no wall-clock, process, or network behavior.
 */

import {
  SETTLEMENT_FAILURE_CODES,
  type AttemptHandle,
  type AttemptPollResult,
  type AttemptSettlement,
  type ExecutorPort,
  type ExecutorStartRequest,
} from './executor-port.ts';
import {
  TaskGraph,
  type TaskGraphError,
  type TaskGraphSnapshot,
  type TaskSnapshot,
} from './task-graph.ts';
import type { TaskState } from './task-state.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export interface BackoffPolicy {
  /** Delay for the first retry; later retries double this base. */
  readonly baseMs: number;
  /** Uniform injected jitter range, in milliseconds. Defaults to zero. */
  readonly jitterMs?: number;
  /** Optional upper bound applied after exponential backoff and jitter. */
  readonly maxMs?: number;
}

export interface SchedulerOptions {
  readonly concurrency: number;
  readonly clock: () => number;
  readonly rng?: () => number;
  readonly backoff?: BackoffPolicy;
  /** Report a running attempt after this much time without activity. */
  readonly stallTimeoutMs?: number;
  /** Consecutive executor.start failures before terminal failure. */
  readonly maxStartFailures?: number;
}

export type SchedulerEvent =
  | {
      readonly type: 'executor_error';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly phase: 'start' | 'poll' | 'close';
      readonly code: 'EXECUTOR_PROTOCOL_VIOLATION' | 'EXECUTOR_START_FAILED' | 'EXECUTOR_CLEANUP_FAILED';
      readonly message: string;
      readonly path: string;
      readonly available: readonly string[];
      readonly failureCount?: number;
    }
  | {
      readonly type: 'scheduler_error';
      readonly at: number;
      readonly code: 'INVALID_CLOCK' | 'INVALID_RNG';
      readonly message: string;
      readonly path: string;
      readonly available: readonly string[];
    }
  | {
      readonly type: 'task_started';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
    }
  | {
      readonly type: 'attempt_settled';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly outcome: string;
      readonly settlement: AttemptSettlement;
    }
  | {
      readonly type: 'acceptance_blocked';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly settlement: AttemptSettlement;
    }
  | {
      readonly type: 'verdict_recorded';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly verdict: 'passed' | 'rejected';
    }
  | {
      readonly type: 'task_passed';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
    }
  | {
      readonly type: 'retry_scheduled';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly reason: 'rejected' | 'policy_rejected' | 'timeout' | 'executor_error';
      readonly delayMs: number;
      readonly dueAt: number;
    }
  | {
      readonly type: 'task_failed';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'task_ready';
      readonly at: number;
      readonly taskId: string;
      readonly reason: 'retry' | 'dependency';
    }
  | {
      readonly type: 'timeout';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly elapsedMs: number;
    }
  | {
      readonly type: 'stuck';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly elapsedMs: number;
    }
  | {
      readonly type: 'attempt_cancelled';
      readonly at: number;
      readonly taskId: string;
      readonly attemptId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'task_cancelled';
      readonly at: number;
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'task_blocked';
      readonly at: number;
      readonly taskId: string;
      readonly blocker: string;
    };

export type SchedulerErrorCode =
  | 'UNKNOWN_TASK'
  | 'INVALID_TASK_ID'
  | 'INVALID_VERDICT'
  | 'INVALID_CLOCK'
  | 'INVALID_RNG'
  | 'INVALID_SCHEDULER_OPTIONS'
  | 'INVALID_SCHEDULER_OPERATION'
  | 'INVALID_STATE_TRANSITION'
  | 'INVALID_TRANSITION_EVENT'
  | 'INVALID_TRANSITION_INPUT'
  | 'EXECUTOR_CLEANUP_FAILED';

export interface SchedulerError {
  readonly code: SchedulerErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
  readonly from?: TaskState;
  readonly to?: TaskState;
}

export type SchedulerCommandResult =
  | { readonly ok: true; readonly events: readonly SchedulerEvent[] }
  | { readonly ok: false; readonly error: SchedulerError };

interface InFlightAttempt {
  readonly taskId: string;
  readonly attemptId: string;
  readonly handle: AttemptHandle;
  readonly startedAt: number;
  lastActivityAt: number;
  stuckReported: boolean;
}

interface RetryDeadline {
  readonly attemptId: string;
  readonly reason: 'rejected' | 'policy_rejected' | 'timeout' | 'executor_error';
  readonly dueAt: number;
}

interface ExecutorFailureInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly now: number;
  readonly phase: 'start' | 'poll' | 'close';
  readonly code: 'EXECUTOR_PROTOCOL_VIOLATION' | 'EXECUTOR_START_FAILED' | 'EXECUTOR_CLEANUP_FAILED';
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
  readonly failureCount?: number;
  readonly terminal?: boolean;
  readonly handle?: AttemptHandle;
}

const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 0, jitterMs: 0 };
const DEFAULT_MAX_START_FAILURES = 3;
const SCHEDULER_OPTION_FIELDS = ['concurrency', 'clock', 'rng', 'backoff', 'stallTimeoutMs', 'maxStartFailures'] as const;
const BACKOFF_OPTION_FIELDS = ['baseMs', 'jitterMs', 'maxMs'] as const;

interface NormalizedSchedulerOptions {
  readonly concurrency: number;
  readonly clock: () => number;
  readonly rng: () => number;
  readonly backoff: BackoffPolicy;
  readonly stallTimeoutMs: number | undefined;
  readonly maxStartFailures: number;
}

export class SchedulerConfigError extends Error implements SchedulerError {
  readonly code = 'INVALID_SCHEDULER_OPTIONS' as const;
  readonly path: string;
  readonly available: readonly string[];

  constructor(path: string, message: string, available: readonly string[] = []) {
    super(message);
    this.name = 'SchedulerConfigError';
    this.path = path;
    this.available = Object.freeze([...available]);
  }
}

export class Scheduler {
  private readonly graph: TaskGraph;
  private readonly executor: ExecutorPort;
  private readonly clock: () => number;
  private readonly rng: () => number;
  private readonly options: BackoffPolicy;
  private readonly concurrency: number;
  private readonly stallTimeoutMs: number | undefined;
  private readonly maxStartFailures: number;
  private readonly startFailures = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlightAttempt>();
  private readonly retryDeadlines = new Map<string, RetryDeadline>();
  private readonly eventLog: SchedulerEvent[] = [];

  constructor(graph: TaskGraph, executor: ExecutorPort, rawOptions: unknown = undefined) {
    const options = validateOptions(rawOptions);
    this.graph = graph;
    this.executor = executor;
    this.clock = options.clock;
    this.rng = options.rng;
    this.options = options.backoff;
    this.concurrency = options.concurrency;
    this.stallTimeoutMs = options.stallTimeoutMs;
    this.maxStartFailures = options.maxStartFailures;
  }

  /** Immutable cumulative event stream for later event-log integration. */
  events(): readonly SchedulerEvent[] {
    return deepFreeze(this.eventLog.map((event) => ({ ...event })));
  }

  /** Number of executor attempts currently in RUNNING state. */
  activeCount(): number {
    return this.inFlight.size;
  }

  /**
   * Advance the scheduler once. Polling is deliberate: an executor result is
   * observed only here, never through an implicit callback or global queue.
   */
  tick(): readonly SchedulerEvent[] {
    const start = this.eventLog.length;
    const clock = this.readClock();
    if (!clock.ok) {
      this.emitSchedulerError(0, clock.error);
      return this.eventsSince(start);
    }
    const now = clock.value;
    this.reconcileInFlight(now);
    this.promoteRetries(now);
    this.startReady(now);
    this.pollRunning(now);
    return this.eventsSince(start);
  }

  /**
   * Run synchronous work until a tick produces no events. It never advances
   * the injected clock, so pending backoff and pending executor work remain
   * pending rather than causing an accidental busy loop.
   */
  drain(maxTicks = 100): readonly SchedulerEvent[] {
    if (!Number.isInteger(maxTicks) || maxTicks <= 0) {
      throw new SchedulerConfigError('maxTicks', 'maxTicks must be a positive integer');
    }
    const drained: SchedulerEvent[] = [];
    for (let index = 0; index < maxTicks; index++) {
      const events = this.tick();
      drained.push(...events);
      if (events.length === 0) break;
    }
    return deepFreeze(drained.map((event) => ({ ...event })));
  }

  /** Supply the independent verification verdict for a settled attempt. */
  submitVerdict(taskId: unknown, verdict: unknown): SchedulerCommandResult {
    const start = this.eventLog.length;
    if (!isValidTaskId(taskId)) return this.invalidTaskId();
    const clock = this.readClock();
    if (!clock.ok) return { ok: false, error: clock.error };
    const now = clock.value;
    const task = this.graph.getTask(taskId);
    if (task === undefined) return this.unknownTask(taskId);
    if (verdict !== 'passed' && verdict !== 'rejected') {
      return {
        ok: false,
        error: deepFreeze({
          code: 'INVALID_VERDICT' as const,
          message: 'verdict must be passed or rejected',
          path: 'verdict',
          available: ['passed', 'rejected'],
          from: task.state,
        }),
      };
    }
    const attempt = task.attempts[task.attempts.length - 1];
    if (attempt === undefined) return this.operationError('attempts', 'verdict requires a settled current attempt', task.state);
    let retryDelay: number | undefined;
    if (verdict === 'rejected' && task.state === 'VERIFYING' && attempt.status === 'SETTLED' && hasAttemptsRemaining(task)) {
      const delay = this.calculateBackoff(task.attempts.length, now);
      if (!delay.ok) return { ok: false, error: delay.error };
      retryDelay = delay.value;
    }
    const before = this.graph.snapshot();
    const result = this.graph.transitionTask(taskId, { type: 'verdict', verdict });
    if (!result.ok) return { ok: false, error: schedulerError(result.error) };
    this.emit({
      type: 'verdict_recorded',
      at: now,
      taskId,
      attemptId: attempt.attemptId,
      verdict,
    });
    const updated = result.snapshot;
    const current = updated.tasks.find((entry) => entry.id === taskId)!;
    if (current.state === 'PASSED') {
      this.emit({ type: 'task_passed', at: now, taskId, attemptId: attempt.attemptId });
    } else if (current.state === 'RETRYING') {
      this.scheduleRetry(taskId, attempt.attemptId, 'rejected', now, retryDelay!);
    } else if (current.state === 'FAILED') {
      this.emit({
        type: 'task_failed',
        at: now,
        taskId,
        attemptId: attempt.attemptId,
        reason: current.reason ?? 'verification rejected and retry budget exhausted',
      });
    }
    this.emitDerivedStateEvents(before, updated, now, taskId);
    return { ok: true, events: this.eventsSince(start) };
  }

  /** Cancel a task and withdraw its executor attempt, if any. */
  cancelTask(taskId: unknown, reason = 'cancelled by scheduler'): SchedulerCommandResult {
    const start = this.eventLog.length;
    if (!isValidTaskId(taskId)) return this.invalidTaskId();
    if (asNonEmptyString(reason) === undefined) return this.operationError('reason', 'reason must be a non-empty string');
    const clock = this.readClock();
    if (!clock.ok) return { ok: false, error: clock.error };
    const now = clock.value;
    const task = this.graph.getTask(taskId);
    if (task === undefined) return this.unknownTask(taskId);
    const running = this.inFlight.get(taskId);
    if (running !== undefined) {
      const lifecycleFailure = cancelAndCloseHandle(running.handle, reason);
      if (lifecycleFailure !== undefined) return { ok: false, error: this.executorCleanupError(taskId, lifecycleFailure) };
      this.inFlight.delete(taskId);
      this.emit({ type: 'attempt_cancelled', at: now, taskId, attemptId: running.attemptId, reason });
    }
    this.retryDeadlines.delete(taskId);
    const before = this.graph.snapshot();
    const result = this.graph.cancelTask(taskId);
    if (!result.ok) return { ok: false, error: schedulerError(result.error) };
    this.emit({ type: 'task_cancelled', at: now, taskId, reason });
    this.emitDerivedStateEvents(before, result.snapshot, now, taskId);
    return { ok: true, events: this.eventsSince(start) };
  }

  private reconcileInFlight(now: number): void {
    for (const [taskId, running] of [...this.inFlight.entries()]) {
      const task = this.graph.getTask(taskId);
      if (task !== undefined && task.state === 'RUNNING') continue;
      const state = task?.state ?? 'UNKNOWN';
      const reason = `task state is ${state}; executor handle withdrawn by scheduler`;
      const lifecycleFailure = cancelAndCloseHandle(running.handle, reason);
      if (lifecycleFailure !== undefined) {
        this.emitExecutorError({ taskId, attemptId: running.attemptId, now, phase: 'close', code: 'EXECUTOR_CLEANUP_FAILED', message: lifecycleFailure.message, path: lifecycleFailure.path, available: lifecycleFailure.available });
        continue;
      }
      this.inFlight.delete(taskId);
      this.emit({ type: 'attempt_cancelled', at: now, taskId, attemptId: running.attemptId, reason });
    }
  }

  private startReady(now: number): void {
    for (const taskId of this.graph.readySet()) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.retryDeadlines.has(taskId)) continue;
      const task = this.graph.getTask(taskId);
      if (task === undefined || task.state !== 'READY') continue;
      const attemptId = `${taskId}:attempt-${task.attempts.length + 1}`;
      const started = this.graph.transitionTask(taskId, { type: 'start', attemptId });
      if (!started.ok) continue;
      const request: ExecutorStartRequest = {
        taskId,
        attemptId,
        contract: task.contract,
        startedAt: now,
      };

      let handle: AttemptHandle;
      try {
        handle = this.executor.start(request);
      } catch (error) {
        const failureCount = (this.startFailures.get(taskId) ?? 0) + 1;
        this.startFailures.set(taskId, failureCount);
        this.handleExecutorFailure({
          taskId,
          attemptId,
          now,
          phase: 'start',
          code: 'EXECUTOR_START_FAILED',
          message: `executor.start threw: ${errorMessage(error)}`,
          path: 'executor.start',
          available: [],
          failureCount,
          terminal: failureCount >= this.maxStartFailures,
        });
        continue;
      }
      if (!isAttemptHandle(handle)) {
        const failureCount = (this.startFailures.get(taskId) ?? 0) + 1;
        this.startFailures.set(taskId, failureCount);
        this.handleExecutorFailure({
          taskId,
          attemptId,
          now,
          phase: 'start',
          code: 'EXECUTOR_PROTOCOL_VIOLATION',
          message: 'executor.start must return an AttemptHandle',
          path: 'executor.start.return',
          available: ['poll', 'cancel', 'close'],
          failureCount,
          terminal: failureCount >= this.maxStartFailures,
        });
        continue;
      }
      this.startFailures.delete(taskId);
      this.inFlight.set(taskId, {
        taskId,
        attemptId,
        handle,
        startedAt: now,
        lastActivityAt: now,
        stuckReported: false,
      });
      this.emit({ type: 'task_started', at: now, taskId, attemptId });
    }
  }

  private handleExecutorFailure(input: ExecutorFailureInput): void {
    const task = this.graph.getTask(input.taskId);
    const shouldRetry = task !== undefined && !input.terminal && hasAttemptsRemaining(task);
    let terminal = input.terminal === true;
    let delayMs: number | undefined;
    if (shouldRetry) {
      const delay = this.calculateBackoff(task.attempts.length, input.now);
      if (!delay.ok) {
        this.emitSchedulerError(input.now, delay.error);
        terminal = true;
      } else {
        delayMs = delay.value;
      }
    }

    const before = this.graph.snapshot();
    const transitioned = this.graph.transitionTask(input.taskId, {
      type: 'executor_error',
      attemptId: input.attemptId,
      outcome: input.message,
      ...(terminal ? { terminal: true } : {}),
    });
    if (input.handle !== undefined) {
      this.withdrawHandle(input.now, input.taskId, {
        taskId: input.taskId,
        attemptId: input.attemptId,
        handle: input.handle,
        startedAt: 0,
        lastActivityAt: 0,
        stuckReported: false,
      });
    }
    if (!transitioned.ok) {
      this.emitExecutorError({
        now: input.now,
        taskId: input.taskId,
        attemptId: input.attemptId,
        phase: input.phase,
        code: input.code,
        message: `${truncateForMessage(input.message)}; state transition rejected: ${truncateForMessage(transitioned.error.message)}`,
        path: transitioned.error.path,
        available: transitioned.error.available,
        ...(input.failureCount === undefined ? {} : { failureCount: input.failureCount }),
      });
      return;
    }

    this.emitExecutorError(input);
    const updated = transitioned.snapshot;
    const current = updated.tasks.find((entry) => entry.id === input.taskId)!;
    if (current.state === 'RETRYING' && delayMs !== undefined) {
      this.scheduleRetry(input.taskId, input.attemptId, 'executor_error', input.now, delayMs);
    } else if (current.state === 'FAILED') {
      this.emit({
        type: 'task_failed',
        at: input.now,
        taskId: input.taskId,
        attemptId: input.attemptId,
        reason: current.reason ?? input.message,
      });
    }
    this.emitDerivedStateEvents(before, updated, input.now, input.taskId);
  }

  private withdrawHandle(now: number, taskId: string, running: InFlightAttempt): void {
    const lifecycleFailure = cancelAndCloseHandle(running.handle, `executor failure for ${taskId}`);
    if (lifecycleFailure !== undefined) {
      this.emitExecutorError({ taskId, attemptId: running.attemptId, now, phase: 'close', code: 'EXECUTOR_CLEANUP_FAILED', message: lifecycleFailure.message, path: lifecycleFailure.path, available: lifecycleFailure.available });
      return;
    }
    this.inFlight.delete(taskId);
  }

  private executorCleanupError(taskId: string, failure: HandleBoundaryFailure): SchedulerError {
    const from = this.graph.getTask(taskId)?.state;
    return { code: 'EXECUTOR_CLEANUP_FAILED', message: truncateForMessage(failure.message), path: failure.path, available: [...failure.available], ...(from === undefined ? {} : { from }) };
  }

  private emitExecutorError(input: ExecutorFailureInput): void {
    this.emit({
      type: 'executor_error',
      at: input.now,
      taskId: input.taskId,
      attemptId: input.attemptId,
      phase: input.phase,
      code: input.code,
      message: truncateForMessage(input.message),
      path: input.path,
      available: [...input.available],
      ...(input.failureCount === undefined ? {} : { failureCount: input.failureCount }),
    });
  }

  private pollRunning(now: number): void {
    for (const [taskId, running] of [...this.inFlight.entries()]) {
      let rawResult: unknown;
      try {
        rawResult = running.handle.poll();
      } catch (error) {
        this.handleExecutorFailure({
          taskId,
          attemptId: running.attemptId,
          now,
          phase: 'poll',
          code: 'EXECUTOR_PROTOCOL_VIOLATION',
          message: `executor.poll threw: ${errorMessage(error)}`,
          path: 'executor.poll',
          available: ['pending', 'settled'],
          handle: running.handle,
        });
        continue;
      }
      const checked = validatePollResult(rawResult);
      if (!checked.ok) {
        this.handleExecutorFailure({
          taskId,
          attemptId: running.attemptId,
          now,
          phase: 'poll',
          code: 'EXECUTOR_PROTOCOL_VIOLATION',
          message: checked.message,
          path: checked.path,
          available: checked.available,
          handle: running.handle,
        });
        continue;
      }
      const result = checked.result;
      if (result.status === 'settled') {
        const settled = this.graph.transitionTask(taskId, {
          type: 'settle',
          attemptId: running.attemptId,
          outcome: result.outcome,
        });
        if (!settled.ok) {
          this.withdrawHandle(now, taskId, running);
          this.emitExecutorError({
            now,
            taskId,
            attemptId: running.attemptId,
            phase: 'poll',
            code: 'EXECUTOR_PROTOCOL_VIOLATION',
            message: `settled result rejected by graph: ${truncateForMessage(settled.error.message)}`,
            path: 'task.state',
            available: [],
          });
          continue;
        }
        const closeFailure = closeHandle(running.handle);
        if (closeFailure !== undefined) {
          this.emitExecutorError({ taskId, attemptId: running.attemptId, now, phase: 'close', code: 'EXECUTOR_CLEANUP_FAILED', message: closeFailure.message, path: closeFailure.path, available: closeFailure.available });
          continue;
        }
        this.inFlight.delete(taskId);
        this.emit({
          type: 'attempt_settled',
          at: now,
          taskId,
          attemptId: running.attemptId,
          outcome: result.outcome,
          settlement: result.settlement,
        });
        if (!result.settlement.acceptanceEligible) {
          const before = this.graph.snapshot();
          const taskBefore = this.graph.getTask(taskId)!;
          let retryDelay: number | undefined;
          if (hasAttemptsRemaining(taskBefore)) {
            const delay = this.calculateBackoff(taskBefore.attempts.length, now);
            if (!delay.ok) {
              this.emitSchedulerError(now, delay.error);
              continue;
            }
            retryDelay = delay.value;
          }
          const blocked = this.graph.transitionTask(taskId, { type: 'verdict', verdict: 'rejected' });
          if (!blocked.ok) {
            this.emitExecutorError({ now, taskId, attemptId: running.attemptId, phase: 'poll', code: 'EXECUTOR_PROTOCOL_VIOLATION', message: `acceptance block transition rejected: ${truncateForMessage(blocked.error.message)}`, path: blocked.error.path, available: blocked.error.available });
            continue;
          }
          this.emit({ type: 'acceptance_blocked', at: now, taskId, attemptId: running.attemptId, settlement: result.settlement });
          this.emit({ type: 'verdict_recorded', at: now, taskId, attemptId: running.attemptId, verdict: 'rejected' });
          const updated = blocked.snapshot;
          const current = updated.tasks.find((entry) => entry.id === taskId)!;
          if (current.state === 'RETRYING') this.scheduleRetry(taskId, running.attemptId, 'policy_rejected', now, retryDelay!);
          else if (current.state === 'FAILED') this.emit({ type: 'task_failed', at: now, taskId, attemptId: running.attemptId, reason: result.settlement.reason ?? result.settlement.conclusion });
          this.emitDerivedStateEvents(before, updated, now, taskId);
        }
        continue;
      }

      if (result.activity === true) running.lastActivityAt = now;
      const elapsedMs = Math.max(0, now - running.startedAt);
      const timeoutMs = this.graph.getTask(taskId)?.contract.budget?.timeout_ms;
      if (timeoutMs !== undefined && elapsedMs > timeoutMs) {
        const before = this.graph.snapshot();
        const task = this.graph.getTask(taskId)!;
        let timeoutDelay: number | undefined;
        let terminal = !hasAttemptsRemaining(task);
        if (!terminal) {
          const delay = this.calculateBackoff(task.attempts.length, now);
          if (!delay.ok) {
            this.emitSchedulerError(now, delay.error);
            terminal = true;
          } else {
            timeoutDelay = delay.value;
          }
        }
        const timedOut = this.graph.transitionTask(taskId, {
          type: 'timeout',
          attemptId: running.attemptId,
          outcome: `timeout after ${elapsedMs}ms`,
          ...(terminal ? { terminal: true } : {}),
        });
        const lifecycleFailure = cancelAndCloseHandle(running.handle, `timeout after ${elapsedMs}ms`);
        if (lifecycleFailure !== undefined) this.emitExecutorError({ taskId, attemptId: running.attemptId, now, phase: 'close', code: 'EXECUTOR_CLEANUP_FAILED', message: lifecycleFailure.message, path: lifecycleFailure.path, available: lifecycleFailure.available });
        else this.inFlight.delete(taskId);
        if (!timedOut.ok) {
          this.emitExecutorError({
            now,
            taskId,
            attemptId: running.attemptId,
            phase: 'poll',
            code: 'EXECUTOR_PROTOCOL_VIOLATION',
            message: `timeout transition rejected: ${truncateForMessage(timedOut.error.message)}`,
            path: timedOut.error.path,
            available: timedOut.error.available,
          });
          continue;
        }
        this.emit({ type: 'timeout', at: now, taskId, attemptId: running.attemptId, elapsedMs });
        const updated = timedOut.snapshot;
        const current = updated.tasks.find((entry) => entry.id === taskId)!;
        if (current.state === 'RETRYING') {
          this.scheduleRetry(taskId, running.attemptId, 'timeout', now, timeoutDelay!);
        } else if (current.state === 'FAILED') {
          this.emit({
            type: 'task_failed',
            at: now,
            taskId,
            attemptId: running.attemptId,
            reason: current.reason ?? 'attempt timed out',
          });
        }
        this.emitDerivedStateEvents(before, updated, now, taskId);
        continue;
      }

      if (
        this.stallTimeoutMs !== undefined &&
        !running.stuckReported &&
        Math.max(0, now - running.lastActivityAt) > this.stallTimeoutMs
      ) {
        running.stuckReported = true;
        this.emit({ type: 'stuck', at: now, taskId, attemptId: running.attemptId, elapsedMs });
      }
    }
  }

  private promoteRetries(now: number): void {
    for (const [taskId, deadline] of [...this.retryDeadlines.entries()]) {
      if (deadline.dueAt > now) continue;
      const before = this.graph.snapshot();
      const result = this.graph.transitionTask(taskId, { type: 'ready' });
      if (!result.ok) continue;
      this.retryDeadlines.delete(taskId);
      this.emit({ type: 'task_ready', at: now, taskId, reason: 'retry' });
      this.emitDerivedStateEvents(before, result.snapshot, now, taskId);
    }
  }

  private scheduleRetry(
    taskId: string,
    attemptId: string,
    reason: 'rejected' | 'policy_rejected' | 'timeout' | 'executor_error',
    now: number,
    delayMs: number,
  ): void {
    const dueAt = now + delayMs;
    this.retryDeadlines.set(taskId, { attemptId, reason, dueAt });
    this.emit({ type: 'retry_scheduled', at: now, taskId, attemptId, reason, delayMs, dueAt });
  }

  private calculateBackoff(attemptsRecorded: number, now: number):
    | { readonly ok: true; readonly value: number }
    | { readonly ok: false; readonly error: SchedulerError } {
    const exponential = this.options.baseMs * (2 ** Math.max(0, attemptsRecorded - 1));
    const jitterRange = this.options.jitterMs ?? 0;
    let jitter = 0;
    if (jitterRange !== 0) {
      let sample: number;
      try {
        sample = this.rng();
      } catch (error) {
        return {
          ok: false,
          error: schedulerFailure('INVALID_RNG', `rng threw: ${errorMessage(error)}`, 'rng', ['0', '1']),
        };
      }
      if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
        return {
          ok: false,
          error: schedulerFailure('INVALID_RNG', 'rng must return a finite number in [0, 1]', 'rng', ['0', '1']),
        };
      }
      jitter = sample * jitterRange;
    }
    const uncapped = exponential + jitter;
    const delay = this.options.maxMs === undefined ? uncapped : Math.min(uncapped, this.options.maxMs);
    if (!Number.isFinite(delay) || delay < 0 || !Number.isFinite(now + delay)) {
      return {
        ok: false,
        error: schedulerFailure('INVALID_RNG', 'backoff produced a non-finite delay or dueAt', 'backoff', []),
      };
    }
    return { ok: true, value: delay };
  }

  private emitDerivedStateEvents(
    before: TaskGraphSnapshot,
    after: TaskGraphSnapshot,
    at: number,
    changedTaskId: string,
  ): void {
    const previous = new Map(before.tasks.map((task) => [task.id, task]));
    for (const task of after.tasks) {
      if (task.id === changedTaskId) continue;
      const prior = previous.get(task.id);
      if (prior?.state === task.state) continue;
      if (task.state === 'BLOCKED') {
        this.emit({ type: 'task_blocked', at, taskId: task.id, blocker: task.blocker ?? changedTaskId });
      } else if (task.state === 'READY') {
        this.emit({ type: 'task_ready', at, taskId: task.id, reason: 'dependency' });
      }
    }
  }

  private readClock():
    | { readonly ok: true; readonly value: number }
    | { readonly ok: false; readonly error: SchedulerError } {
    try {
      const value = this.clock();
      if (Number.isFinite(value)) return { ok: true, value };
    } catch (error) {
      return { ok: false, error: schedulerFailure('INVALID_CLOCK', `clock threw: ${errorMessage(error)}`, 'clock', ['finite number']) };
    }
    return { ok: false, error: schedulerFailure('INVALID_CLOCK', 'clock must return a finite number', 'clock', ['finite number']) };
  }

  private emitSchedulerError(at: number, error: SchedulerError): void {
    const code = error.code === 'INVALID_RNG' ? 'INVALID_RNG' : 'INVALID_CLOCK';
    this.emit({
      type: 'scheduler_error',
      at: Number.isFinite(at) ? at : 0,
      code,
      message: truncateForMessage(error.message),
      path: error.path,
      available: [...error.available],
    });
  }

  private emit(event: SchedulerEvent): void {
    this.eventLog.push(deepFreeze(event));
  }

  private eventsSince(start: number): readonly SchedulerEvent[] {
    return deepFreeze(this.eventLog.slice(start).map((event) => ({ ...event })));
  }

  private unknownTask(taskId: string): SchedulerCommandResult {
    return {
      ok: false,
      error: deepFreeze({
        code: 'UNKNOWN_TASK' as const,
        message: `unknown task "${truncateForMessage(taskId)}"`,
        path: 'taskId',
        available: this.graph.snapshot().tasks.map((task) => task.id),
      }),
    };
  }

  private invalidTaskId(): SchedulerCommandResult {
    return {
      ok: false,
      error: deepFreeze({
        code: 'INVALID_TASK_ID' as const,
        message: 'taskId must be a non-empty string',
        path: 'taskId',
        available: this.graph.snapshot().tasks.map((task) => task.id),
      }),
    };
  }

  private operationError(path: string, message: string, from?: TaskState): SchedulerCommandResult {
    return {
      ok: false,
      error: deepFreeze({
        code: 'INVALID_SCHEDULER_OPERATION' as const,
        message,
        path,
        available: [],
        ...(from === undefined ? {} : { from }),
      }),
    };
  }
}

function schedulerFailure(
  code: 'INVALID_CLOCK' | 'INVALID_RNG',
  message: string,
  path: string,
  available: readonly string[],
): SchedulerError {
  return deepFreeze({ code, message, path, available: [...available] });
}

function isValidTaskId(value: unknown): value is string {
  return asNonEmptyString(value) !== undefined;
}

function hasAttemptsRemaining(task: TaskSnapshot): boolean {
  const maxAttempts = Math.max(1, task.contract.retry?.max_attempts ?? 0);
  return task.attempts.length < maxAttempts;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return truncateForMessage(error.message || 'executor threw an Error');
  if (typeof error === 'string') return truncateForMessage(error);
  return 'executor threw a non-Error value';
}

interface HandleBoundaryFailure {
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
}

function readHandleError(handle: AttemptHandle): HandleBoundaryFailure | undefined {
  try {
    const raw = handle.lastError?.();
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'object' && raw !== null) {
      const value = raw as Record<string, unknown>;
      const message = typeof value['message'] === 'string' ? value['message'] : 'executor handle lifecycle failed';
      const path = typeof value['path'] === 'string' ? value['path'] : 'executor.handle';
      const available = Array.isArray(value['available']) && value['available'].every((entry) => typeof entry === 'string') ? [...value['available']] as string[] : [];
      return { message: truncateForMessage(message), path, available };
    }
    return { message: 'executor handle lifecycle failed', path: 'executor.handle', available: [] };
  } catch {
    return { message: 'executor handle error could not be inspected', path: 'executor.handle', available: [] };
  }
}

function closeHandle(handle: AttemptHandle): HandleBoundaryFailure | undefined {
  try { handle.close(); } catch (error) { return { message: errorMessage(error), path: 'executor.close', available: [] }; }
  return readHandleError(handle);
}

function cancelAndCloseHandle(handle: AttemptHandle, reason: string): HandleBoundaryFailure | undefined {
  let thrown: HandleBoundaryFailure | undefined;
  try { handle.cancel(reason); } catch (error) { thrown = { message: errorMessage(error), path: 'executor.cancel', available: [] }; }
  const closeFailure = closeHandle(handle);
  return thrown ?? closeFailure;
}

function isAttemptHandle(value: unknown): value is AttemptHandle {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['poll'] === 'function'
    && typeof candidate['cancel'] === 'function'
    && typeof candidate['close'] === 'function';
}

type PollValidation =
  | { readonly ok: true; readonly result: AttemptPollResult }
  | { readonly ok: false; readonly message: string; readonly path: string; readonly available: readonly string[] };

function validatePollResult(value: unknown): PollValidation {
  try {
    if (!isPlainObject(value)) {
      return { ok: false, message: 'executor.poll must return an object', path: 'executor.poll.return', available: ['pending', 'settled'] };
    }
    const status = ownValue(value, 'status');
    if (status === 'pending') {
      if (!hasExactFields(value, ['status', 'activity'])) {
        return { ok: false, message: 'pending poll result has unknown field(s)', path: 'executor.poll.return', available: ['status', 'activity'] };
      }
      const activity = ownValue(value, 'activity');
      if (activity !== undefined && typeof activity !== 'boolean') {
        return { ok: false, message: 'executor.poll.return.activity must be boolean', path: 'executor.poll.return.activity', available: ['true', 'false'] };
      }
      return activity === undefined
        ? { ok: true, result: { status: 'pending' } }
        : { ok: true, result: { status: 'pending', activity } };
    }
    if (status === 'settled') {
      const outcome = ownValue(value, 'outcome');
      if (typeof outcome !== 'string' || asNonEmptyString(outcome) === undefined) {
        return { ok: false, message: 'executor.poll.return.outcome must be a non-empty string', path: 'executor.poll.return.outcome', available: ['outcome'] };
      }
      if (!hasExactFields(value, ['status', 'outcome', 'settlement'])) {
        return { ok: false, message: 'settled poll result requires structured settlement', path: 'executor.poll.return.settlement', available: ['settlement'] };
      }
      const settlement = validateSettlement(ownValue(value, 'settlement'), outcome);
      if (!settlement.ok) return settlement;
      return { ok: true, result: { status: 'settled', outcome, settlement: settlement.value } };
    }
    return { ok: false, message: 'executor.poll.return.status must be pending or settled', path: 'executor.poll.return.status', available: ['pending', 'settled'] };
  } catch (error) {
    return { ok: false, message: 'executor.poll.return could not be inspected', path: 'executor.poll.return', available: ['pending', 'settled'] };
  }
}

function validateSettlement(value: unknown, outcome: string):
  | { readonly ok: true; readonly value: AttemptSettlement }
  | { readonly ok: false; readonly message: string; readonly path: string; readonly available: readonly string[] } {
  if (!isPlainObject(value) || !hasExactFields(value, ['conclusion', 'acceptanceEligible', 'artifact', 'failureCode', 'reason'])) {
    return { ok: false, message: 'settlement must be an exact object', path: 'executor.poll.return.settlement', available: ['conclusion', 'acceptanceEligible', 'artifact', 'failureCode', 'reason'] };
  }
  const conclusion = ownValue(value, 'conclusion');
  if (typeof conclusion !== 'string' || asNonEmptyString(conclusion) === undefined || conclusion !== outcome) {
    return { ok: false, message: 'settlement.conclusion must equal outcome', path: 'executor.poll.return.settlement.conclusion', available: ['conclusion'] };
  }
  const eligible = ownValue(value, 'acceptanceEligible');
  if (typeof eligible !== 'boolean') return { ok: false, message: 'settlement.acceptanceEligible must be boolean', path: 'executor.poll.return.settlement.acceptanceEligible', available: ['true', 'false'] };
  const artifact = ownValue(value, 'artifact');
  if (!isPlainObject(artifact) || !hasExactFields(artifact, ['artifactRevision', 'diffRef', 'changedPaths'])) return { ok: false, message: 'settlement.artifact is malformed', path: 'executor.poll.return.settlement.artifact', available: ['artifactRevision', 'diffRef', 'changedPaths'] };
  const artifactRevision = ownValue(artifact, 'artifactRevision');
  if (typeof artifactRevision !== 'string' || asNonEmptyString(artifactRevision) === undefined || artifactRevision.length > 256) return { ok: false, message: 'artifactRevision must be bounded', path: 'executor.poll.return.settlement.artifact.artifactRevision', available: ['artifactRevision'] };
  const diffRef = ownValue(artifact, 'diffRef');
  if (diffRef !== undefined && (typeof diffRef !== 'string' || asNonEmptyString(diffRef) === undefined || diffRef.length > 256)) return { ok: false, message: 'diffRef must be bounded', path: 'executor.poll.return.settlement.artifact.diffRef', available: ['diffRef'] };
  const changedPaths = ownValue(artifact, 'changedPaths');
  if (!Array.isArray(changedPaths) || changedPaths.length > 256 || changedPaths.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 256)) return { ok: false, message: 'changedPaths must be a bounded string array', path: 'executor.poll.return.settlement.artifact.changedPaths', available: ['changedPaths'] };
  const failureCode = ownValue(value, 'failureCode');
  if (failureCode !== undefined && (typeof failureCode !== 'string' || !SETTLEMENT_FAILURE_CODES.includes(failureCode as (typeof SETTLEMENT_FAILURE_CODES)[number]))) return { ok: false, message: 'failureCode is unknown', path: 'executor.poll.return.settlement.failureCode', available: SETTLEMENT_FAILURE_CODES };
  const reason = ownValue(value, 'reason');
  if (reason !== undefined && (typeof reason !== 'string' || asNonEmptyString(reason) === undefined || reason.length > 160)) return { ok: false, message: 'reason must be bounded', path: 'executor.poll.return.settlement.reason', available: ['reason'] };
  if (!eligible && (failureCode === undefined || reason === undefined)) return { ok: false, message: 'ineligible settlement requires failureCode and reason', path: 'executor.poll.return.settlement', available: ['failureCode', 'reason'] };
  return { ok: true, value: deepFreeze({ conclusion, acceptanceEligible: eligible, artifact: deepFreeze({ artifactRevision, ...(diffRef === undefined ? {} : { diffRef }), changedPaths: Object.freeze([...changedPaths]) }), ...(failureCode === undefined ? {} : { failureCode: failureCode as (typeof SETTLEMENT_FAILURE_CODES)[number] }), ...(reason === undefined ? {} : { reason: reason as string }) }) };
}

function schedulerError(error: TaskGraphError): SchedulerError {
  return deepFreeze({
    code: error.code as SchedulerErrorCode,
    message: error.message,
    path: error.path,
    available: [...error.available],
    ...(error.from === undefined ? {} : { from: error.from }),
    ...(error.to === undefined ? {} : { to: error.to }),
  });
}

function validateOptions(input: unknown): NormalizedSchedulerOptions {
  if (input === undefined) {
    return {
      concurrency: 1,
      clock: () => 0,
      rng: () => 0,
      backoff: DEFAULT_BACKOFF,
      stallTimeoutMs: undefined,
      maxStartFailures: DEFAULT_MAX_START_FAILURES,
    };
  }
  if (!isPlainObject(input)) {
    throw new SchedulerConfigError('options', 'options must be a plain object or undefined');
  }
  if (!hasExactFields(input, SCHEDULER_OPTION_FIELDS)) {
    const unknown = Reflect.ownKeys(input)
      .filter((key) => typeof key !== 'string' || !SCHEDULER_OPTION_FIELDS.includes(key as (typeof SCHEDULER_OPTION_FIELDS)[number]))
      .map((key) => typeof key === 'symbol' ? key.toString() : key);
    throw new SchedulerConfigError(
      'options',
      `options has unknown field(s): ${truncateForMessage(unknown.join(', '))}`,
      SCHEDULER_OPTION_FIELDS,
    );
  }

  const rawConcurrency = ownValue(input, 'concurrency');
  if (!isPositiveInteger(rawConcurrency)) {
    throw new SchedulerConfigError('options.concurrency', 'options.concurrency must be a positive integer');
  }
  const rawClock = ownValue(input, 'clock');
  if (typeof rawClock !== 'function') {
    throw new SchedulerConfigError('options.clock', 'options.clock must be a function');
  }
  const rawRng = ownValue(input, 'rng');
  if (rawRng !== undefined && typeof rawRng !== 'function') {
    throw new SchedulerConfigError('options.rng', 'options.rng must be a function');
  }

  const rawBackoff = ownValue(input, 'backoff');
  const backoff = rawBackoff === undefined ? DEFAULT_BACKOFF : validateBackoff(rawBackoff);
  const stallTimeoutMs = validateNonNegativeNumber(ownValue(input, 'stallTimeoutMs'), 'options.stallTimeoutMs');
  const maxStartFailures = ownValue(input, 'maxStartFailures') === undefined
    ? DEFAULT_MAX_START_FAILURES
    : ownValue(input, 'maxStartFailures');
  if (!isPositiveInteger(maxStartFailures)) {
    throw new SchedulerConfigError('options.maxStartFailures', 'options.maxStartFailures must be a positive integer');
  }
  return {
    concurrency: rawConcurrency,
    clock: rawClock as () => number,
    rng: rawRng === undefined ? (() => 0) : rawRng as () => number,
    backoff,
    stallTimeoutMs,
    maxStartFailures,
  };
}

function validateBackoff(value: unknown): BackoffPolicy {
  if (!isPlainObject(value)) throw new SchedulerConfigError('options.backoff', 'options.backoff must be a plain object');
  if (!hasExactFields(value, BACKOFF_OPTION_FIELDS)) {
    const unknown = Reflect.ownKeys(value)
      .filter((key) => typeof key !== 'string' || !BACKOFF_OPTION_FIELDS.includes(key as (typeof BACKOFF_OPTION_FIELDS)[number]))
      .map((key) => typeof key === 'symbol' ? key.toString() : key);
    throw new SchedulerConfigError(
      'options.backoff',
      `options.backoff has unknown field(s): ${truncateForMessage(unknown.join(', '))}`,
      BACKOFF_OPTION_FIELDS,
    );
  }
  const rawBaseMs = ownValue(value, 'baseMs');
  if (!Object.hasOwn(value, 'baseMs') || !isPositiveInteger(rawBaseMs)) {
    throw new SchedulerConfigError('options.backoff.baseMs', 'options.backoff.baseMs must be explicitly provided as a positive integer');
  }
  const baseMs = rawBaseMs;
  const jitterMs = ownValue(value, 'jitterMs') === undefined ? 0 : ownValue(value, 'jitterMs');
  const maxMs = ownValue(value, 'maxMs');
  assertNonNegativeNumber(jitterMs, 'options.backoff.jitterMs');
  if (maxMs !== undefined) assertNonNegativeNumber(maxMs, 'options.backoff.maxMs');
  return {
    baseMs,
    jitterMs,
    ...(maxMs === undefined ? {} : { maxMs }),
  };
}

function validateNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  assertNonNegativeNumber(value, path);
  return value;
}

function assertNonNegativeNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SchedulerConfigError(path, `${path} must be a finite non-negative number`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
