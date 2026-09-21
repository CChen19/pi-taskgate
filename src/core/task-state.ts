/**
 * Task lifecycle state machine.
 *
 * This is the single authority for task-state transitions. It records an
 * execution attempt as settled before verification, so settled never implies
 * accepted. No executor or verifier is implemented here.
 */

import { asNonEmptyString, deepFreeze, isPlainObject, ownValue } from './validate.ts';

export const TASK_STATES = [
  'PENDING',
  'READY',
  'RUNNING',
  'VERIFYING',
  'PASSED',
  'FAILED',
  'RETRYING',
  'BLOCKED',
  'CANCELLED',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Event names accepted by the state machine. */
export const TASK_TRANSITION_TYPES = [
  'ready',
  'start',
  'settle',
  'verdict',
  'block',
  'cancel',
] as const;

export type TaskTransitionType = (typeof TASK_TRANSITION_TYPES)[number];

/** Closed lifecycle state of one attempt; RUNNING is the only active state. */
export type AttemptStatus = 'RUNNING' | 'SETTLED' | 'PASSED' | 'REJECTED' | 'BLOCKED' | 'CANCELLED' | 'FAILED';

export interface TaskAttempt {
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly outcome?: string;
}

export interface TaskRuntime {
  readonly state: TaskState;
  readonly attempts: readonly TaskAttempt[];
  /** Contract retry.max_attempts, normalized to zero by contract validation. */
  readonly maxAttempts: number;
  readonly blocker?: string;
  /** Structured terminal reason, e.g. retry budget exhaustion. */
  readonly reason?: string;
}

/** Explicit state graph; event guards below add attempt/verdict semantics. */
export const LEGAL_STATE_TRANSITIONS: Readonly<{ [K in TaskState]: readonly TaskState[] }> = deepFreeze({
  PENDING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['RUNNING', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['PASSED', 'RETRYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  PASSED: [],
  FAILED: [],
  RETRYING: ['READY', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['READY', 'CANCELLED'],
  CANCELLED: [],
});

export type TaskTransition =
  | { readonly type: 'ready' }
  | { readonly type: 'start'; readonly attemptId: string }
  | { readonly type: 'settle'; readonly attemptId: string; readonly outcome: string }
  | { readonly type: 'verdict'; readonly verdict: 'passed' | 'rejected' }
  | { readonly type: 'block'; readonly blocker: string }
  | { readonly type: 'cancel'; readonly reason?: string };

export type StateTransitionErrorCode =
  | 'INVALID_STATE_TRANSITION'
  | 'INVALID_TRANSITION_EVENT'
  | 'INVALID_TRANSITION_INPUT';

export interface StateTransitionError {
  readonly code: StateTransitionErrorCode;
  readonly message: string;
  readonly path: string;
  readonly from: TaskState;
  readonly to?: TaskState;
  readonly available: readonly string[];
}

export type StateTransitionResult =
  | { readonly ok: true; readonly runtime: TaskRuntime }
  | { readonly ok: false; readonly error: StateTransitionError };

export function isLegalStateTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_STATE_TRANSITIONS[from].includes(to);
}

export type StateTransitionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: StateTransitionError };

/** Checks only the state graph, useful to callers that need a preflight guard. */
export function checkStateTransition(from: TaskState, to: TaskState): StateTransitionCheck {
  if (isLegalStateTransition(from, to)) return { ok: true };
  return {
    ok: false,
    error: deepFreeze({
      code: 'INVALID_STATE_TRANSITION' as const,
      message: `cannot transition ${from} to ${to}`,
      path: 'state' as const,
      from,
      to,
      available: [...LEGAL_STATE_TRANSITIONS[from]],
    }),
  };
}

function failure(
  runtime: TaskRuntime,
  message: string,
  to?: TaskState,
  code: StateTransitionErrorCode = 'INVALID_STATE_TRANSITION',
  path = 'state',
  available: readonly string[] = LEGAL_STATE_TRANSITIONS[runtime.state],
): StateTransitionResult {
  const error: StateTransitionError = {
    code,
    message,
    path,
    from: runtime.state,
    ...(to === undefined ? {} : { to }),
    available: [...available],
  };
  return { ok: false, error: deepFreeze(error) };
}

function nextRuntime(
  runtime: TaskRuntime,
  state: TaskState,
  attempts: readonly TaskAttempt[] = runtime.attempts,
  blocker?: string,
  reason?: string,
): StateTransitionResult {
  const next: {
    state: TaskState;
    attempts: readonly TaskAttempt[];
    maxAttempts: number;
    blocker?: string;
    reason?: string;
  } = {
    state,
    attempts: attempts.map((attempt) => ({ ...attempt })),
    maxAttempts: runtime.maxAttempts,
  };
  if (blocker !== undefined) next.blocker = blocker;
  if (reason !== undefined) next.reason = reason;
  return { ok: true, runtime: deepFreeze(next) };
}

function latestAttempt(runtime: TaskRuntime): TaskAttempt | undefined {
  return runtime.attempts[runtime.attempts.length - 1];
}

/** `0` means one initial attempt; positive values are total attempt limits. */
function attemptLimit(maxAttempts: number): number {
  return Math.max(1, maxAttempts);
}

function withAttemptStatus(
  attempt: TaskAttempt,
  status: AttemptStatus,
  outcome?: string,
): TaskAttempt {
  const replacement: { attemptId: string; status: AttemptStatus; outcome?: string } = {
    attemptId: attempt.attemptId,
    status,
  };
  if (outcome !== undefined) replacement.outcome = outcome;
  else if (attempt.outcome !== undefined) replacement.outcome = attempt.outcome;
  return replacement;
}

function closeCurrentAttempt(
  runtime: TaskRuntime,
  status: Exclude<AttemptStatus, 'RUNNING' | 'SETTLED'>,
  outcome: string,
): readonly TaskAttempt[] | undefined {
  const attempt = latestAttempt(runtime);
  if (attempt === undefined || attempt.status !== 'RUNNING') return undefined;
  return runtime.attempts.slice(0, -1).concat(withAttemptStatus(attempt, status, outcome));
}

/**
 * Applies one guarded lifecycle event without mutating the input runtime.
 * Unknown/malformed events return structured errors; no transition throws.
 */
export function transitionTaskState(
  runtime: TaskRuntime,
  transition: unknown,
): StateTransitionResult {
  if (!isPlainObject(transition)) {
    return failure(runtime, 'transition must be an object', undefined, 'INVALID_TRANSITION_EVENT', 'transition', TASK_TRANSITION_TYPES);
  }
  const rawType = ownValue(transition, 'type');
  if (typeof rawType !== 'string' || !TASK_TRANSITION_TYPES.includes(rawType as TaskTransitionType)) {
    return failure(
      runtime,
      'transition.type must be a supported event type',
      undefined,
      'INVALID_TRANSITION_EVENT',
      'transition.type',
      TASK_TRANSITION_TYPES,
    );
  }
  const type = rawType as TaskTransitionType;

  switch (type) {
    case 'ready': {
      const target: TaskState = 'READY';
      if (!isLegalStateTransition(runtime.state, target)) {
        return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
      }
      const limit = attemptLimit(runtime.maxAttempts);
      if (runtime.attempts.length >= limit) {
        return nextRuntime(
          runtime,
          'FAILED',
          runtime.attempts,
          undefined,
          `retry budget exhausted: ${runtime.attempts.length} attempts recorded; maximum is ${limit}`,
        );
      }
      return nextRuntime(runtime, target);
    }
    case 'start': {
      const target: TaskState = 'RUNNING';
      if (!isLegalStateTransition(runtime.state, target)) {
        return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
      }
      const attemptId = ownValue(transition, 'attemptId');
      if (typeof attemptId !== 'string') {
        return failure(runtime, 'start.attemptId must be a string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.attemptId', ['attemptId']);
      }
      if (asNonEmptyString(attemptId) === undefined) {
        return failure(runtime, 'start.attemptId must be a non-empty string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.attemptId', ['attemptId']);
      }
      const limit = attemptLimit(runtime.maxAttempts);
      if (runtime.attempts.length >= limit) {
        return failure(
          runtime,
          `retry budget exhausted: ${runtime.attempts.length} attempts recorded; maximum is ${limit}`,
          undefined,
          'INVALID_TRANSITION_INPUT',
          'attempts',
          [],
        );
      }
      if (runtime.attempts.some((attempt) => attempt.status === 'RUNNING')) {
        return failure(runtime, 'cannot start while an attempt is already RUNNING', undefined, 'INVALID_TRANSITION_INPUT', 'attempts', []);
      }
      if (runtime.attempts.some((attempt) => attempt.attemptId === attemptId)) {
        return failure(runtime, `attemptId "${attemptId}" is already recorded`, undefined, 'INVALID_TRANSITION_INPUT', 'transition.attemptId', ['attemptId']);
      }
      const attempts: TaskAttempt[] = [
        ...runtime.attempts,
        { attemptId, status: 'RUNNING' },
      ];
      return nextRuntime(runtime, target, attempts);
    }
    case 'settle': {
      const target: TaskState = 'VERIFYING';
      if (!isLegalStateTransition(runtime.state, target)) {
        return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
      }
      const attemptId = ownValue(transition, 'attemptId');
      if (typeof attemptId !== 'string') {
        return failure(runtime, 'settle.attemptId must be a string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.attemptId', ['attemptId']);
      }
      const outcome = ownValue(transition, 'outcome');
      if (typeof outcome !== 'string' || asNonEmptyString(outcome) === undefined) {
        return failure(runtime, 'settle.outcome must be a non-empty string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.outcome', ['outcome']);
      }
      const attempt = latestAttempt(runtime);
      if (attempt === undefined || attempt.attemptId !== attemptId || attempt.status !== 'RUNNING') {
        return failure(runtime, 'settle must reference the current RUNNING attempt', undefined, 'INVALID_TRANSITION_INPUT', 'transition.attemptId', ['attemptId']);
      }
      const attempts = runtime.attempts.slice(0, -1).concat(withAttemptStatus(attempt, 'SETTLED', outcome));
      return nextRuntime(runtime, target, attempts);
    }
    case 'verdict': {
      const verdict = ownValue(transition, 'verdict');
      if (verdict !== 'passed' && verdict !== 'rejected') {
        return failure(runtime, 'verdict must be passed or rejected', undefined, 'INVALID_TRANSITION_INPUT', 'transition.verdict', ['passed', 'rejected']);
      }
      const attempt = latestAttempt(runtime);
      if (runtime.state !== 'VERIFYING' || attempt?.status !== 'SETTLED') {
        return failure(runtime, 'verdict requires VERIFYING with a settled current attempt');
      }
      if (verdict === 'passed') {
        const target: TaskState = 'PASSED';
        if (!isLegalStateTransition(runtime.state, target)) {
          return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
        }
        const attempts = runtime.attempts.slice(0, -1).concat(withAttemptStatus(attempt, 'PASSED'));
        return nextRuntime(runtime, target, attempts);
      }
      const canRetry = runtime.attempts.length < attemptLimit(runtime.maxAttempts);
      const target: TaskState = canRetry ? 'RETRYING' : 'FAILED';
      if (!isLegalStateTransition(runtime.state, target)) {
        return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
      }
      const attempts = runtime.attempts.slice(0, -1).concat(
        withAttemptStatus(attempt, canRetry ? 'REJECTED' : 'FAILED'),
      );
      return nextRuntime(runtime, target, attempts);
    }
    case 'block': {
      const target: TaskState = 'BLOCKED';
      if (!isLegalStateTransition(runtime.state, target)) {
        return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
      }
      const blocker = ownValue(transition, 'blocker');
      if (typeof blocker !== 'string' || asNonEmptyString(blocker) === undefined) {
        return failure(runtime, 'block.blocker must be a non-empty string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.blocker', ['blocker']);
      }
      let attempts = runtime.attempts;
      if (runtime.state === 'RUNNING') {
        const closed = closeCurrentAttempt(runtime, 'BLOCKED', blocker);
        if (closed === undefined) return failure(runtime, 'RUNNING must have a current active attempt before blocking');
        attempts = closed;
      }
      return nextRuntime(runtime, target, attempts, blocker);
    }
    case 'cancel': {
      const target: TaskState = 'CANCELLED';
      if (!isLegalStateTransition(runtime.state, target)) {
        return failure(runtime, `cannot transition ${runtime.state} to ${target}`, target);
      }
      const rawReason = ownValue(transition, 'reason');
      if (Object.hasOwn(transition, 'reason') && typeof rawReason !== 'string') {
        return failure(runtime, 'cancel.reason must be a string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.reason', ['reason']);
      }
      const reason = rawReason === undefined ? 'cancelled explicitly' : (rawReason as string);
      if (asNonEmptyString(reason) === undefined) {
        return failure(runtime, 'cancel.reason must be a non-empty string', undefined, 'INVALID_TRANSITION_INPUT', 'transition.reason', ['reason']);
      }
      let attempts = runtime.attempts;
      if (runtime.state === 'RUNNING') {
        const closed = closeCurrentAttempt(runtime, 'CANCELLED', reason);
        if (closed === undefined) return failure(runtime, 'RUNNING must have a current active attempt before cancellation');
        attempts = closed;
      }
      // Cancellation is terminal; `reason` is validated but is not a BLOCKED blocker.
      return nextRuntime(runtime, target, attempts);
    }
  }
}
