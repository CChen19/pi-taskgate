import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DurableStateError,
  InMemoryDurableStore,
  buildSnapshot,
  createDurableEvent,
  recoverRun,
  type DurableEventDraft,
} from '../src/core/durable-state.ts';

function contract(id = 'Tdurable'): Record<string, unknown> {
  return {
    id,
    objective: 'Persist the control-plane projection',
    depends_on: [],
    acceptance_criteria: ['replay is deterministic'],
    verification: [],
    retry: { max_attempts: 2 },
  };
}

function draft(
  id: string,
  key: string,
  kind: DurableEventDraft['kind'],
  payload: unknown,
  occurredAt = 10,
): DurableEventDraft {
  return createDurableEvent({
    runId: 'run-s7',
    eventId: id,
    idempotencyKey: key,
    occurredAt,
    kind,
    payload,
  }, { clock: () => occurredAt, idSource: () => id });
}

function lifecycle(
  eventId: string,
  key: string,
  payload: Record<string, unknown>,
): DurableEventDraft {
  return draft(eventId, key, 'task', payload);
}

function baseLog(): DurableEventDraft[] {
  return [
    lifecycle('e-create', 'k-create', {
      change: 'created',
      taskId: 'Tdurable',
      state: 'READY',
      contract: contract(),
    }),
    lifecycle('e-start', 'k-start', {
      change: 'state_changed',
      taskId: 'Tdurable',
      from: 'READY',
      to: 'RUNNING',
      attempts: [{ attemptId: 'Tdurable:attempt-1', status: 'RUNNING' }],
    }),
    draft('e-scheduler', 'k-scheduler', 'scheduler', {
      eventType: 'task_started',
      taskId: 'Tdurable',
      attemptId: 'Tdurable:attempt-1',
      at: 11,
      summary: 'executor start intent observed',
    }),
    draft('e-evidence', 'k-evidence', 'evidence', {
      taskId: 'Tdurable',
      attemptId: 'Tdurable:attempt-1',
      artifactRevision: 'rev-1',
      evidenceRef: 'evidence://rev-1',
      summary: 'bounded evidence summary',
    }),
  ];
}

describe('S7 durable state', () => {
  it('assigns continuous sequences through an injected event factory and freezes copies', () => {
    const input = {
      runId: 'run-s7',
      eventId: 'event-1',
      idempotencyKey: 'intent-1',
      kind: 'scheduler',
      payload: { eventType: 'attempt_start_intent', summary: 'start requested' },
    } as const;
    const event = createDurableEvent(input, { clock: () => 42, idSource: () => 'injected-id' });
    assert.equal(event.eventId, 'event-1');
    assert.equal(event.occurredAt, 42);
    assert.equal('sequence' in event, false);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.payload), true);
    assert.equal(Object.isFrozen(input), false);
  });

  it('provides CAS, atomic batches, copied reads, and idempotent retries', () => {
    const store = new InMemoryDurableStore();
    const events = baseLog();
    const first = store.append('run-s7', 0, events);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.appended.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.appended), true);

    const stale = store.append('run-s7', 0, [draft('e-new', 'k-new', 'scheduler', { eventType: 'stuck', taskId: 'Tdurable' })]);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, 'SEQUENCE_CONFLICT');
    const explicitGap = store.append('run-s7', 4, [{ ...draft('e-gap', 'k-gap', 'scheduler', { eventType: 'task_ready', taskId: 'Tdurable' }), sequence: 9 }]);
    assert.equal(explicitGap.ok, false);
    if (!explicitGap.ok) assert.equal(explicitGap.error.code, 'SEQUENCE_ORDER');

    const retry = store.append('run-s7', 0, [first.appended[0]!]);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.deepEqual(retry.appended, []);

    const invalidBatch = store.append('run-s7', 4, [
      draft('e-atomic', 'k-atomic', 'scheduler', { eventType: 'task_ready', taskId: 'Tdurable' }),
      { ...draft('e-bad', 'k-bad', 'scheduler', { eventType: 'task_ready', taskId: 'Tdurable' }), payload: { eventType: 'bad', extra: true } } as never,
    ]);
    assert.equal(invalidBatch.ok, false);
    assert.equal(store.currentSequence('run-s7'), 4, 'invalid batch must not partially append');

    const read = store.read('run-s7');
    assert.equal(Object.isFrozen(read), true);
    assert.equal(Object.isFrozen(read[0]), true);
    assert.throws(() => { (read[0] as { eventId: string }).eventId = 'mutated'; }, TypeError);
  });

  it('rejects same idempotency keys with different content and unknown future versions', () => {
    const store = new InMemoryDurableStore();
    const event = draft('e-one', 'same-key', 'scheduler', { eventType: 'task_ready', taskId: 'Tdurable' });
    assert.equal(store.append('run-s7', 0, [event]).ok, true);
    const conflict = store.append('run-s7', 1, [draft('e-two', 'same-key', 'scheduler', { eventType: 'task_failed', taskId: 'Tdurable' })]);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');

    const future = { ...event, schemaVersion: 99 } as never;
    const result = store.append('run-s7', 1, [future]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_SCHEMA_VERSION');
  });

  it('replays snapshot plus tail identically to the complete log', () => {
    const store = new InMemoryDurableStore();
    const first = store.append('run-s7', 0, baseLog());
    assert.equal(first.ok, true);
    const snapshot = buildSnapshot(store.read('run-s7'));
    assert.equal(snapshot.lastSequence, 4);

    const tailDrafts = [
      lifecycle('e-settle', 'k-settle', {
        change: 'state_changed',
        taskId: 'Tdurable',
        from: 'RUNNING',
        to: 'VERIFYING',
        attempts: [{ attemptId: 'Tdurable:attempt-1', status: 'SETTLED', outcome: 'completed' }],
      }),
      draft('e-verdict', 'k-verdict', 'verdict', {
        taskId: 'Tdurable',
        attemptId: 'Tdurable:attempt-1',
        artifactRevision: 'rev-1',
        verdict: 'passed',
        reasons: [],
      }),
      lifecycle('e-pass', 'k-pass', {
        change: 'state_changed',
        taskId: 'Tdurable',
        from: 'VERIFYING',
        to: 'PASSED',
        attempts: [{ attemptId: 'Tdurable:attempt-1', status: 'PASSED', outcome: 'completed' }],
      }),
    ];
    const appended = store.append('run-s7', 4, tailDrafts);
    assert.equal(appended.ok, true);
    const full = recoverRun(undefined, store.read('run-s7'));
    const tail = recoverRun(snapshot, store.read('run-s7', snapshot.lastSequence));
    assert.deepEqual(tail.projection, full.projection);
    assert.equal(tail.projection.state.tasks[0]?.state, 'PASSED');
  });

  it('fails closed for sequence gaps, run mismatches, duplicate key content, and snapshot tampering', () => {
    const events = baseLog();
    const store = new InMemoryDurableStore();
    assert.equal(store.append('run-s7', 0, events).ok, true);
    const full = store.read('run-s7');
    assert.throws(() => recoverRun(undefined, [{ ...full[1]!, sequence: 3 }]), (error: DurableStateError) => error.code === 'SEQUENCE_GAP');
    assert.throws(() => recoverRun(undefined, [{ ...full[0]!, runId: 'other-run' }], 'run-s7'), (error: DurableStateError) => error.code === 'RUN_ID_MISMATCH');

    const snapshot = buildSnapshot(full);
    const tampered = { ...snapshot, state: { ...snapshot.state, tasks: [] } };
    assert.throws(() => recoverRun(tampered, []), (error: DurableStateError) => error.code === 'INVALID_SNAPSHOT');

    assert.throws(() => recoverRun(undefined, [full[0]!, { ...full[0]!, sequence: 2 }]), (error: DurableStateError) => error.code === 'EVENT_CONFLICT');
    const duplicate = recoverRun(undefined, [full[0]!, full[0]!]);
    assert.equal(duplicate.ignoredDuplicateEventIds.length, 1);
  });

  it('rejects sparse, method-tampered, symbol, non-enumerable, and overlong inputs', () => {
    const store = new InMemoryDurableStore();
    const sparse = new Array(1) as unknown as DurableEventDraft[];
    const sparseResult = store.append('run-s7', 0, sparse);
    assert.equal(sparseResult.ok, false);
    if (!sparseResult.ok) assert.match(sparseResult.error.path, /events\[0\]/);

    const tampered = Object.assign([baseLog()[0]!], { map: null }) as DurableEventDraft[];
    const tamperedResult = store.append('run-s7', 0, tampered);
    assert.equal(tamperedResult.ok, false);

    const symbol = Symbol('unexpected');
    const event = { ...baseLog()[0]! } as Record<PropertyKey, unknown>;
    Object.defineProperty(event, symbol, { value: true, enumerable: false });
    const symbolResult = store.append('run-s7', 0, [event as never]);
    assert.equal(symbolResult.ok, false);

    assert.throws(() => draft('e-long', 'k-long', 'scheduler', { eventType: 'x', summary: 'x'.repeat(161) }), (error: DurableStateError) => {
      assert.ok(error.message.length <= 160);
      return true;
    });
  });

  it('uses snapshot CAS and keeps the log authoritative', () => {
    const store = new InMemoryDurableStore();
    assert.equal(store.append('run-s7', 0, baseLog()).ok, true);
    const snapshot = buildSnapshot(store.read('run-s7'));
    const saved = store.saveSnapshot('run-s7', 4, snapshot);
    assert.equal(saved.ok, true);
    assert.deepEqual(store.loadSnapshot('run-s7'), snapshot);
    const wrongSequence = store.saveSnapshot('run-s7', 3, snapshot);
    assert.equal(wrongSequence.ok, false);
    if (!wrongSequence.ok) assert.equal(wrongSequence.error.code, 'SNAPSHOT_CONFLICT');
    const newer = store.append('run-s7', 4, [draft('e-newer', 'k-newer', 'scheduler', { eventType: 'task_ready', taskId: 'Tdurable' })]);
    assert.equal(newer.ok, true);
    const staleSave = store.saveSnapshot('run-s7', 4, snapshot);
    assert.equal(staleSave.ok, false);
    if (!staleSave.ok) assert.equal(staleSave.error.code, 'SEQUENCE_CONFLICT');
    assert.equal(store.currentSequence('run-s7'), 5);
  });

  it('enforces canonical lifecycle bindings and explicit run isolation', () => {
    assert.throws(() => recoverRun(undefined, [{ ...lifecycle('bad-create', 'bad-create', {
      change: 'created', taskId: 'Tdurable', state: 'READY', contract: contract('Tother'),
    }), sequence: 1 }]), (error: DurableStateError) => error.code === 'INVALID_PROJECTION');
    assert.throws(() => recoverRun(undefined, [{ ...lifecycle('bad-transition', 'bad-transition', {
      change: 'state_changed', taskId: 'Tdurable', from: 'READY', to: 'PASSED', attempts: [],
    }), sequence: 1 }]), (error: DurableStateError) => error.code === 'INVALID_PROJECTION');
    const store = new InMemoryDurableStore();
    assert.equal(store.append('run-s7', 0, baseLog()).ok, true);
    const snapshot = buildSnapshot(store.read('run-s7'));
    assert.throws(() => recoverRun(snapshot, [], 'another-run'), (error: DurableStateError) => error.code === 'RUN_ID_MISMATCH');
    const staleEmpty = store.append('run-s7', 0, []);
    assert.equal(staleEmpty.ok, false);
    if (!staleEmpty.ok) assert.equal(staleEmpty.error.code, 'SEQUENCE_CONFLICT');
  });

  it('replays bounded 5k, 10k, and 100k audit tails with linear accumulator state', () => {
    for (const count of [5_000, 10_000, 100_000]) {
      const events = Array.from({ length: count }, (_, index) => ({
        schemaVersion: 1 as const,
        runId: 'run-performance',
        sequence: index + 1,
        eventId: `audit-${index}`,
        idempotencyKey: `audit-key-${index}`,
        occurredAt: index,
        kind: 'scheduler' as const,
        payload: { eventType: 'audit' },
      }));
      const result = recoverRun(undefined, events, 'run-performance');
      assert.equal(result.projection.lastSequence, count);
      assert.equal(result.projection.state.eventIndex.length, count);
    }
  });
});
