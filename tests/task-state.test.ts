import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEGAL_STATE_TRANSITIONS,
  TASK_STATES,
  checkStateTransition,
  transitionTaskState,
  type TaskRuntime,
  type TaskState,
} from '../src/core/task-state.ts';

function runtime(state: TaskState = 'PENDING', maxAttempts = 0): TaskRuntime {
  return { state, attempts: [], maxAttempts };
}

function apply(current: TaskRuntime, transition: Parameters<typeof transitionTaskState>[1]): TaskRuntime {
  const result = transitionTaskState(current, transition);
  if (!result.ok) throw new Error(result.error.message);
  return result.runtime;
}

describe('task state machine', () => {
  it('defines all nine states and accepts exactly the declared legal edges', () => {
    assert.deepEqual([...TASK_STATES], [
      'PENDING', 'READY', 'RUNNING', 'VERIFYING', 'PASSED',
      'FAILED', 'RETRYING', 'BLOCKED', 'CANCELLED',
    ]);
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const result = checkStateTransition(from, to);
        assert.equal(result.ok, LEGAL_STATE_TRANSITIONS[from].includes(to), `${from} -> ${to}`);
        if (!result.ok) {
          assert.equal(result.error.code, 'INVALID_STATE_TRANSITION');
          assert.equal(result.error.from, from);
          assert.equal(result.error.to, to);
          assert.deepEqual(result.error.available, LEGAL_STATE_TRANSITIONS[from]);
        }
      }
    }
  });

  it('rejects every illegal transition with a structured error', () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        if (LEGAL_STATE_TRANSITIONS[from].includes(to)) continue;
        const result = checkStateTransition(from, to);
        assert.equal(result.ok, false, `${from} -> ${to}`);
        if (!result.ok) {
          assert.equal(result.error.path, 'state');
          assert.ok(Array.isArray(result.error.available));
        }
      }
    }
  });

  it('requires structured execution settlement and keeps settled separate from accepted', () => {
    let current = apply(runtime(), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'settle', attemptId: 'attempt-1', outcome: 'completed' });
    assert.equal(current.state, 'VERIFYING');
    assert.equal(current.attempts[0]?.status, 'SETTLED');
    const verdict = transitionTaskState(current, { type: 'verdict', verdict: 'passed' });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.runtime.state, 'PASSED');
      assert.equal(verdict.runtime.attempts[0]?.status, 'PASSED');
    }
  });

  it('uses retrying only while attempts remain, then reaches terminal FAILED', () => {
    let current = apply(runtime('PENDING', 2), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'settle', attemptId: 'attempt-1', outcome: 'rejected by execution' });
    current = apply(current, { type: 'verdict', verdict: 'rejected' });
    assert.equal(current.state, 'RETRYING');
    assert.equal(current.attempts[0]?.status, 'REJECTED');

    current = apply(current, { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-2' });
    current = apply(current, { type: 'settle', attemptId: 'attempt-2', outcome: 'rejected again' });
    current = apply(current, { type: 'verdict', verdict: 'rejected' });
    assert.equal(current.state, 'FAILED');
    assert.equal(current.attempts.length, 2);
    assert.equal(current.attempts[1]?.status, 'FAILED');
  });

  it('sends a rejected first attempt directly to FAILED when retry is exhausted', () => {
    let current = apply(runtime(), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'settle', attemptId: 'attempt-1', outcome: 'done' });
    current = apply(current, { type: 'verdict', verdict: 'rejected' });
    assert.equal(current.state, 'FAILED');
  });

  it('treats max_attempts zero as one total attempt and fails on blocked unblocking', () => {
    let current = apply(runtime('PENDING', 0), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'block', blocker: 'dependency' });
    const unblocked = transitionTaskState(current, { type: 'ready' });
    assert.equal(unblocked.ok, true);
    if (unblocked.ok) {
      assert.equal(unblocked.runtime.state, 'FAILED');
      assert.match(unblocked.runtime.reason ?? '', /retry budget exhausted/);
      assert.equal(unblocked.runtime.attempts.length, 1);
    }
  });

  it('counts blocked attempts toward a positive total budget and rejects a third start', () => {
    let current = apply(runtime('PENDING', 2), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'block', blocker: 'dependency-1' });
    current = apply(current, { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-2' });
    current = apply(current, { type: 'block', blocker: 'dependency-2' });
    const unblocked = transitionTaskState(current, { type: 'ready' });
    assert.equal(unblocked.ok, true);
    if (unblocked.ok) assert.equal(unblocked.runtime.state, 'FAILED');

    const exhaustedReady: TaskRuntime = {
      state: 'READY',
      attempts: [
        { attemptId: 'attempt-1', status: 'BLOCKED', outcome: 'dependency-1' },
        { attemptId: 'attempt-2', status: 'BLOCKED', outcome: 'dependency-2' },
      ],
      maxAttempts: 2,
    };
    const third = transitionTaskState(exhaustedReady, { type: 'start', attemptId: 'attempt-3' });
    assert.equal(third.ok, false);
    if (!third.ok) {
      assert.equal(third.error.code, 'INVALID_TRANSITION_INPUT');
      assert.match(third.error.message, /2 attempts recorded; maximum is 2/);
    }
  });

  it('closes an active attempt when blocking, then allows a fresh attempt after READY', () => {
    let current = apply(runtime('PENDING', 2), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'block', blocker: 'Tdependency' });
    assert.equal(current.state, 'BLOCKED');
    assert.deepEqual(current.attempts, [{ attemptId: 'attempt-1', status: 'BLOCKED', outcome: 'Tdependency' }]);
    current = apply(current, { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-2' });
    assert.equal(current.attempts.filter((attempt) => attempt.status === 'RUNNING').length, 1);
  });

  it('supports blocking, unblocking, and cancellation without implicit cascade', () => {
    let current = apply(runtime(), { type: 'block', blocker: 'Tdependency' });
    assert.equal(current.state, 'BLOCKED');
    assert.equal(current.blocker, 'Tdependency');
    current = apply(current, { type: 'ready' });
    assert.equal(current.state, 'READY');
    assert.equal(current.blocker, undefined);
    current = apply(current, { type: 'cancel', reason: 'operator request' });
    assert.equal(current.state, 'CANCELLED');
    const illegal = transitionTaskState(current, { type: 'ready' });
    assert.equal(illegal.ok, false);
    if (!illegal.ok) assert.equal(illegal.error.code, 'INVALID_STATE_TRANSITION');
  });

  it('closes an active attempt when cancelling a RUNNING task', () => {
    let current = apply(runtime(), { type: 'ready' });
    current = apply(current, { type: 'start', attemptId: 'attempt-1' });
    current = apply(current, { type: 'cancel', reason: 'operator request' });
    assert.equal(current.state, 'CANCELLED');
    assert.deepEqual(current.attempts, [{ attemptId: 'attempt-1', status: 'CANCELLED', outcome: 'operator request' }]);
  });

  it('rejects unknown events, invalid verdicts, and non-string attempt IDs structurally', () => {
    const current = apply(runtime(), { type: 'ready' });
    const unknown = transitionTaskState(current, { type: 'bogus' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.error.code, 'INVALID_TRANSITION_EVENT');
      assert.deepEqual(unknown.error.available, ['ready', 'start', 'settle', 'verdict', 'timeout', 'executor_error', 'block', 'cancel']);
    }
    const missingAttempt = transitionTaskState(current, { type: 'start' });
    assert.equal(missingAttempt.ok, false);
    if (!missingAttempt.ok) assert.equal(missingAttempt.error.code, 'INVALID_TRANSITION_INPUT');
    const nonStringAttempt = transitionTaskState(current, { type: 'start', attemptId: 42 });
    assert.equal(nonStringAttempt.ok, false);
    if (!nonStringAttempt.ok) assert.equal(nonStringAttempt.error.path, 'transition.attemptId');

    let verifying = apply(current, { type: 'start', attemptId: 'attempt-1' });
    verifying = apply(verifying, { type: 'settle', attemptId: 'attempt-1', outcome: 'done' });
    const invalidVerdict = transitionTaskState(verifying, { type: 'verdict', verdict: 'bogus' });
    assert.equal(invalidVerdict.ok, false);
    if (!invalidVerdict.ok) {
      assert.equal(invalidVerdict.error.code, 'INVALID_TRANSITION_INPUT');
      assert.deepEqual(invalidVerdict.error.available, ['passed', 'rejected']);
    }
  });

  it('rejects malformed lifecycle events without mutating the runtime', () => {
    const current = apply(runtime(), { type: 'ready' });
    const before = JSON.stringify(current);
    const emptyAttempt = transitionTaskState(current, { type: 'start', attemptId: ' ' });
    assert.equal(emptyAttempt.ok, false);
    const notSettled = transitionTaskState(current, { type: 'settle', attemptId: 'missing', outcome: 'done' });
    assert.equal(notSettled.ok, false);
    assert.equal(JSON.stringify(current), before);

    let running = apply(current, { type: 'start', attemptId: 'attempt-1' });
    const emptyOutcome = transitionTaskState(running, { type: 'settle', attemptId: 'attempt-1', outcome: '' });
    assert.equal(emptyOutcome.ok, false);
    running = apply(running, { type: 'settle', attemptId: 'attempt-1', outcome: 'done' });
    const duplicateVerdict = transitionTaskState(running, { type: 'start', attemptId: 'attempt-1' });
    assert.equal(duplicateVerdict.ok, false);
  });

  it('returns frozen state snapshots', () => {
    const current = apply(runtime(), { type: 'ready' });
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.attempts), true);
    assert.throws(() => {
      (current as { state: TaskState }).state = 'RUNNING';
    }, TypeError);
  });
});
