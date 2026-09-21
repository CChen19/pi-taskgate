import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RecoveryError,
  planRecovery,
  recoveryActionPayload,
} from '../src/core/recovery.ts';
import {
  InMemoryDurableStore,
  buildSnapshot,
  createDurableEvent,
  recoverRun,
  type DurableEventDraft,
} from '../src/core/durable-state.ts';

type AnyRecord = Record<string, unknown>;

function persisted(
  taskId: string,
  attemptId: string,
  taskState: string,
  attemptStatus: string,
  artifactRevision = 'rev-1',
): AnyRecord {
  return { taskId, attemptId, taskState, attemptStatus, artifactRevision };
}

function observed(
  taskId: string,
  attemptId: string,
  status: string,
  extra: AnyRecord = {},
  artifactRevision = 'rev-1',
): AnyRecord {
  return { taskId, attemptId, status, artifactRevision, ...extra };
}

function recoveryDraft(
  eventId: string,
  key: string,
  payload: unknown,
): DurableEventDraft {
  return createDurableEvent({
    runId: 'run-recovery',
    eventId,
    idempotencyKey: key,
    occurredAt: 1,
    kind: 'recovery',
    payload,
  }, { clock: () => 1, idSource: () => eventId });
}

describe('S7 recovery reconciliation', () => {
  it('covers reattach, settle, missing, stale, and orphan actions deterministically', () => {
    const result = planRecovery({
      persisted: [
        persisted('Tmissing', 'a-1', 'RUNNING', 'RUNNING'),
        persisted('Tterminal', 'a-1', 'PASSED', 'PASSED'),
        persisted('Trunning', 'a-1', 'RUNNING', 'RUNNING'),
        persisted('Tsettle', 'a-1', 'RUNNING', 'RUNNING'),
      ],
      observed: [
        observed('Tterminal', 'a-1', 'running'),
        observed('Trunning', 'a-1', 'running'),
        observed('Tsettle', 'a-1', 'terminal', { outcome: 'completed', resultRef: 'result://a-1' }),
        observed('Torphan', 'a-9', 'running'),
      ],
    });
    assert.deepEqual(result.actions.map((entry) => [entry.taskId, entry.action]), [
      ['Tmissing', 'mark-lost'],
      ['Torphan', 'cancel-orphan'],
      ['Trunning', 'reattach'],
      ['Tsettle', 'settle'],
      ['Tterminal', 'cancel-stale'],
    ]);
    const settle = result.actions.find((entry) => entry.action === 'settle');
    assert.equal(settle?.outcome, 'completed');
    assert.equal(settle?.resultRef, 'result://a-1');
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.actions), true);
    assert.equal(Object.isFrozen(result.actions[0]), true);
  });

  it('allows the explicit retry-scheduler policy but never restarts an attempt itself', () => {
    const result = planRecovery({
      persisted: [persisted('Tlost', 'a-1', 'RUNNING', 'RUNNING')],
      observed: [],
    }, { onMissing: 'retry-scheduler' });
    assert.equal(result.actions[0]?.action, 'retry-scheduler');
    assert.match(result.actions[0]?.reason ?? '', /budget/);
  });

  it('persists default mark-lost for a missing in-flight attempt and replays the audit consistently', () => {
    const store = new InMemoryDurableStore();
    const startIntent = recoveryDraft('missing-intent-1', 'missing-intent-1', {
      action: 'human',
      taskId: 'Tmissing',
      attemptId: 'Tmissing:attempt-1',
      artifactRevision: 'rev-1',
      reason: 'start intent persisted before executor launch',
      observedStatus: 'missing',
    });
    const taskCreated = createDurableEvent({
      runId: 'run-recovery',
      eventId: 'missing-task-1',
      idempotencyKey: 'missing-task-1',
      occurredAt: 1,
      kind: 'task',
      payload: {
        change: 'created',
        taskId: 'Tmissing',
        state: 'RUNNING',
        contract: {
          id: 'Tmissing',
          objective: 'missing attempt recovery fixture',
          depends_on: [],
          acceptance_criteria: ['replay is stable'],
          verification: [],
          retry: { max_attempts: 1 },
        },
        attempts: [{ attemptId: 'Tmissing:attempt-1', status: 'RUNNING' }],
      },
    }, { clock: () => 1, idSource: () => 'missing-task-1' });
    assert.equal(store.append('run-recovery', 0, [startIntent, taskCreated]).ok, true);

    const plan = planRecovery({
      persisted: [persisted('Tmissing', 'Tmissing:attempt-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Tmissing', 'Tmissing:attempt-1', 'missing')],
    });
    const action = plan.actions[0]!;
    assert.equal(action.action, 'mark-lost');
    assert.notEqual(action.action, 'reattach');
    assert.notEqual(action.action, 'retry-scheduler');
    const recoveryEvent = recoveryDraft('missing-recovery-1', 'missing-recovery-1', recoveryActionPayload(action));
    const snapshot = buildSnapshot(store.read('run-recovery'));
    assert.equal(snapshot.lastSequence, 2);
    assert.equal(store.append('run-recovery', 2, [recoveryEvent]).ok, true);

    const full = recoverRun(undefined, store.read('run-recovery'));
    const snapshotTail = recoverRun(snapshot, store.read('run-recovery', snapshot.lastSequence));
    assert.deepEqual(snapshotTail.projection, full.projection);
    assert.equal(full.projection.state.tasks[0]?.state, 'RUNNING');
    assert.equal(full.projection.state.tasks[0]?.attempts[0]?.status, 'RUNNING');
    assert.equal(full.projection.state.eventIndex.length, 3);
    const persistedRecovery = store.read('run-recovery')[2]!;
    assert.equal(persistedRecovery.kind, 'recovery');
    assert.equal((persistedRecovery.payload as { action: string }).action, 'mark-lost');
    assert.equal((persistedRecovery.payload as { observedStatus: string }).observedStatus, 'missing');
    assert.equal((persistedRecovery.payload as { artifactRevision: string }).artifactRevision, 'rev-1');
  });

  it('enforces exact input, sparse/method-safe arrays, duplicate bindings, and revision binding', () => {
    const valid = {
      persisted: [persisted('Ttask', 'a-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Ttask', 'a-1', 'running')],
    };
    const duplicateObserved = { ...valid, observed: [valid.observed[0]!, valid.observed[0]!] };
    assert.throws(() => planRecovery(duplicateObserved), (error: RecoveryError) => error.code === 'DUPLICATE_ATTEMPT');
    assert.throws(() => planRecovery({
      persisted: [persisted('Ttask', 'a-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Ttask', 'a-1', 'running', {}, 'other-revision')],
    }), (error: RecoveryError) => error.code === 'REVISION_MISMATCH');
    assert.throws(() => planRecovery({
      persisted: [persisted('Ttask', 'a-1', 'READY', 'RUNNING')],
      observed: [],
    }), (error: RecoveryError) => error.code === 'INVALID_BINDING');
    assert.throws(() => planRecovery({ ...valid, extra: true }), (error: RecoveryError) => error.path === 'recovery');

    const sparse = new Array(1) as unknown[];
    assert.throws(() => planRecovery({ persisted: sparse, observed: [] }), (error: RecoveryError) => /persisted\[0\]/.test(error.path));
    const tampered = Object.assign([valid.persisted[0]!], { map: null });
    assert.throws(() => planRecovery({ persisted: tampered, observed: [] }), RecoveryError);
    const symbol = Symbol('unexpected');
    const withSymbol = { ...valid } as Record<PropertyKey, unknown>;
    Object.defineProperty(withSymbol, symbol, { value: true, enumerable: false });
    assert.throws(() => planRecovery(withSymbol), RecoveryError);
  });

  it('preserves terminal observed results and rejects malformed terminal observations', () => {
    assert.throws(() => planRecovery({
      persisted: [persisted('Ttask', 'a-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Ttask', 'a-1', 'terminal')],
    }), (error: RecoveryError) => error.code === 'INVALID_BINDING');
    const result = planRecovery({
      persisted: [persisted('Ttask', 'a-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Ttask', 'a-1', 'terminal', { resultRef: 'executor://result' })],
    });
    assert.equal(result.actions[0]?.action, 'settle');
    assert.equal(result.actions[0]?.resultRef, 'executor://result');
  });

  it('supports a crash window from start intent to persisted reconciliation event and replay', () => {
    const store = new InMemoryDurableStore();
    const startIntent = recoveryDraft('intent-1', 'intent-1', {
      action: 'human',
      taskId: 'Tcrash',
      attemptId: 'Tcrash:attempt-1',
      artifactRevision: 'rev-1',
      reason: 'start intent persisted before executor launch',
      observedStatus: 'missing',
    });
    const taskCreated = createDurableEvent({
      runId: 'run-recovery',
      eventId: 'task-1',
      idempotencyKey: 'task-1',
      occurredAt: 1,
      kind: 'task',
      payload: {
        change: 'created',
        taskId: 'Tcrash',
        state: 'RUNNING',
        contract: {
          id: 'Tcrash',
          objective: 'crash recovery fixture',
          depends_on: [],
          acceptance_criteria: ['replay is stable'],
          verification: [],
          retry: { max_attempts: 2 },
        },
        attempts: [{ attemptId: 'Tcrash:attempt-1', status: 'RUNNING' }],
      },
    }, { clock: () => 1, idSource: () => 'task-1' });
    assert.equal(store.append('run-recovery', 0, [startIntent, taskCreated]).ok, true);

    const actions = planRecovery({
      persisted: [persisted('Tcrash', 'Tcrash:attempt-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Tcrash', 'Tcrash:attempt-1', 'terminal', { outcome: 'completed', resultRef: 'executor://done' })],
    });
    const settlement = actions.actions[0]!;
    assert.equal(settlement.action, 'settle');
    const recoveryEvent = recoveryDraft('recovery-1', 'recovery-1', recoveryActionPayload(settlement));
    const settledTask = createDurableEvent({
      runId: 'run-recovery',
      eventId: 'task-settle-1',
      idempotencyKey: 'task-settle-1',
      occurredAt: 2,
      kind: 'task',
      payload: {
        change: 'state_changed',
        taskId: 'Tcrash',
        from: 'RUNNING',
        to: 'VERIFYING',
        attempts: [{ attemptId: 'Tcrash:attempt-1', status: 'SETTLED', outcome: 'completed' }],
      },
    }, { clock: () => 2, idSource: () => 'task-settle-1' });
    assert.equal(store.append('run-recovery', 2, [recoveryEvent, settledTask]).ok, true);

    const full = recoverRun(undefined, store.read('run-recovery'));
    const snapshot = buildSnapshot(store.read('run-recovery'));
    const snapshotTail = recoverRun(snapshot, store.read('run-recovery', snapshot.lastSequence));
    assert.deepEqual(snapshotTail.projection, full.projection);
    assert.equal(full.projection.state.tasks[0]?.state, 'VERIFYING');
    assert.equal(full.projection.state.eventIndex.length, 4);
  });

  it('reconciles a running executor when the started event was lost, then replays consistently', () => {
    const actions = planRecovery({
      persisted: [persisted('Twindow', 'Twindow:attempt-1', 'RUNNING', 'RUNNING')],
      observed: [observed('Twindow', 'Twindow:attempt-1', 'running')],
    });
    assert.equal(actions.actions[0]?.action, 'reattach');
    const recoveryEvent = recoveryDraft('reattach-1', 'reattach-1', recoveryActionPayload(actions.actions[0]));
    const started = createDurableEvent({
      runId: 'run-recovery', eventId: 'started-1', idempotencyKey: 'started-1', occurredAt: 2, kind: 'task',
      payload: { change: 'state_changed', taskId: 'Twindow', from: 'READY', to: 'RUNNING', attempts: [{ attemptId: 'Twindow:attempt-1', status: 'RUNNING' }] },
    }, { clock: () => 2, idSource: () => 'started-1' });
    // The registration is READY, so this transition is the missing canonical start.
    const taskReady = createDurableEvent({
      runId: 'run-recovery', eventId: 'ready-1', idempotencyKey: 'ready-1', occurredAt: 1, kind: 'task',
      payload: { change: 'created', taskId: 'Twindow', state: 'READY', contract: { id: 'Twindow', objective: 'window', depends_on: [], acceptance_criteria: ['replay'], verification: [], retry: { max_attempts: 1 } } },
    }, { clock: () => 1, idSource: () => 'ready-1' });
    const fresh = new InMemoryDurableStore();
    assert.equal(fresh.append('run-recovery', 0, [taskReady]).ok, true);
    assert.equal(fresh.append('run-recovery', 1, [recoveryEvent, started]).ok, true);
    const full = recoverRun(undefined, fresh.read('run-recovery'));
    const snap = buildSnapshot(fresh.read('run-recovery'));
    assert.deepEqual(recoverRun(snap, fresh.read('run-recovery', snap.lastSequence)).projection, full.projection);
    assert.equal(full.projection.state.tasks[0]?.state, 'RUNNING');
  });

  it('rejects an orphan observation bound to a different persisted task revision', () => {
    assert.throws(() => planRecovery({
      persisted: [persisted('Torphan', 'a-1', 'RUNNING', 'RUNNING', 'rev-1')],
      observed: [observed('Torphan', 'a-2', 'orphan', {}, 'rev-2')],
    }), (error: RecoveryError) => error.code === 'REVISION_MISMATCH');
  });

  it('bounds recovery messages and returned audit payloads', () => {
    const result = planRecovery({
      persisted: [persisted('Tbounded', 'a-1', 'RUNNING', 'RUNNING')],
      observed: [],
    });
    assert.ok((result.actions[0]?.reason.length ?? Infinity) <= 160);
    const payload = recoveryActionPayload(result.actions[0]);
    assert.ok(payload.reason.length <= 160);
    assert.throws(() => recoveryActionPayload({
      action: 'mark-lost',
      taskId: 'Tbounded',
      attemptId: 'a-1',
      artifactRevision: 'rev-1',
      reason: 'x'.repeat(161),
    }), RecoveryError);
  });
});
