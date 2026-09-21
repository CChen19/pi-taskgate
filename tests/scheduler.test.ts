import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeExecutor } from '../src/core/executor-port.ts';
import { Scheduler, SchedulerConfigError } from '../src/core/scheduler.ts';
import { TaskGraph } from '../src/core/task-graph.ts';
import type { TaskContract } from '../src/core/task-contract.ts';

function contract(
  id: string,
  depends_on: readonly string[] = [],
  extra: Record<string, unknown> = {},
): TaskContract {
  return {
    id,
    objective: `Objective for ${id}`,
    depends_on: [...depends_on],
    acceptance_criteria: [`${id} accepted`],
    verification: [],
    ...extra,
  } as TaskContract;
}

function add(graph: TaskGraph, task: TaskContract): void {
  const result = graph.addTask(task);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
}

function pass(scheduler: Scheduler, taskId: string): void {
  const result = scheduler.submitVerdict(taskId, 'passed');
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
}

describe('Scheduler', () => {
  it('preserves trusted artifact workspace and branch provenance in settlement events', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tartifact'));
    const executor = new FakeExecutor({
      Tartifact: [{ status: 'settled', outcome: 'done', settlement: { conclusion: 'done', acceptanceEligible: true, artifact: { artifactRevision: 'rev-1', workspacePath: '/workspace/t-artifact', branch: 'orchestrator/t-artifact', changedPaths: [], clean: true, commitsAhead: 1 } } }],
    });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });
    const events = scheduler.tick();
    const settled = events.find((event) => event.type === 'attempt_settled');
    assert.ok(settled && settled.type === 'attempt_settled');
    assert.equal(settled.settlement.artifact.workspacePath, '/workspace/t-artifact');
    assert.equal(settled.settlement.artifact.branch, 'orchestrator/t-artifact');
    assert.equal(Object.isFrozen(settled.settlement.artifact), true);
  });

  it('honors the concurrency limit while selecting READY tasks', () => {
    const graph = new TaskGraph();
    for (const id of ['Ta', 'Tb', 'Tc', 'Td', 'Te']) add(graph, contract(id));
    const executor = new FakeExecutor({
      Ta: [{ status: 'pending' }],
      Tb: [{ status: 'pending' }],
      Tc: [{ status: 'pending' }],
      Td: [{ status: 'pending' }],
      Te: [{ status: 'pending' }],
    });
    const scheduler = new Scheduler(graph, executor, { concurrency: 3, clock: () => 0 });

    const events = scheduler.tick();
    assert.deepEqual(events.map((event) => event.type), ['task_started', 'task_started', 'task_started']);
    assert.equal(executor.startCalls.length, 3);
    assert.equal(scheduler.activeCount(), 3);
    assert.deepEqual(graph.readySet(), ['Td', 'Te']);
  });

  it('reconciles a graph reblock, closes the old handle, and lets later work fill the slot', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Td', ['Ta']));
    const executor = new FakeExecutor({ Td: [{ status: 'pending' }] });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });

    scheduler.tick();
    pass(scheduler, 'Ta');
    scheduler.tick();
    assert.equal(graph.getTask('Td')?.state, 'RUNNING');
    assert.equal(scheduler.activeCount(), 1);

    const inserted = graph.insertSubtask('Ta', contract('Tc'), { reblockDependents: true });
    assert.equal(inserted.ok, true);
    assert.equal(graph.getTask('Td')?.state, 'BLOCKED');
    assert.equal(scheduler.activeCount(), 1, 'reconciliation is explicit at tick boundaries');

    const reblocked = scheduler.tick();
    assert.deepEqual(reblocked.map((event) => event.type), ['attempt_cancelled', 'task_started', 'attempt_settled']);
    assert.deepEqual(executor.closeCalls, ['Ta:attempt-1', 'Td:attempt-1', 'Tc:attempt-1']);
    assert.equal(scheduler.activeCount(), 0);

    add(graph, contract('Tf'));
    scheduler.tick();
    assert.equal(executor.startCalls.at(-1)?.taskId, 'Tf');
  });

  it('fills a freed slot only on the next explicit tick after completion or cancellation', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tdone'));
    add(graph, contract('Tnext'));
    const executor = new FakeExecutor({ Tdone: [{ status: 'settled', outcome: 'done' }], Tnext: [{ status: 'pending' }] });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });

    scheduler.tick();
    assert.equal(executor.startCalls.length, 1);
    assert.equal(scheduler.activeCount(), 0);
    scheduler.tick();
    assert.equal(executor.startCalls.length, 2);

    const cancelGraph = new TaskGraph();
    add(cancelGraph, contract('Tcancel'));
    add(cancelGraph, contract('Tafter'));
    const cancelExecutor = new FakeExecutor({ Tcancel: [{ status: 'pending' }], Tafter: [{ status: 'pending' }] });
    const cancelScheduler = new Scheduler(cancelGraph, cancelExecutor, { concurrency: 1, clock: () => 0 });
    cancelScheduler.tick();
    assert.equal(cancelScheduler.cancelTask('Tcancel').ok, true);
    assert.equal(cancelExecutor.startCalls.length, 1);
    cancelScheduler.tick();
    assert.equal(cancelExecutor.startCalls.length, 2);
  });

  it('blocks acceptance for a non-eligible settlement and never exposes VERIFYING for passed', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tblocked'));
    const executor = new FakeExecutor({
      Tblocked: [{
        status: 'settled',
        outcome: 'scope violation',
        settlement: {
          conclusion: 'scope violation',
          acceptanceEligible: false,
          artifact: { artifactRevision: 'observed-1', changedPaths: ['outside.ts'] },
          failureCode: 'SCOPE_VIOLATION',
          reason: 'changed paths exceed filesInScope',
        },
      }],
    });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });
    const events = scheduler.tick();
    assert.deepEqual(events.map((event) => event.type), ['task_started', 'attempt_settled', 'acceptance_blocked', 'verdict_recorded', 'task_failed']);
    assert.equal(graph.getTask('Tblocked')?.state, 'FAILED');
    const passed = scheduler.submitVerdict('Tblocked', 'passed');
    assert.equal(passed.ok, false);
    assert.equal(scheduler.events().some((event) => event.type === 'acceptance_blocked'), true);
  });

  it('labels non-eligible retry scheduling as policy_rejected', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tpolicy', [], { retry: { max_attempts: 2 } }));
    const executor = new FakeExecutor({
      Tpolicy: [{
        status: 'settled',
        outcome: 'worker failed',
        settlement: {
          conclusion: 'worker failed',
          acceptanceEligible: false,
          artifact: { artifactRevision: 'observed-1', changedPaths: [] },
          failureCode: 'WORKER_FAILED',
          reason: 'worker failed',
        },
      }],
    });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });
    const events = scheduler.tick();
    const retry = events.find((event) => event.type === 'retry_scheduled');
    assert.equal(retry?.type, 'retry_scheduled');
    assert.equal(retry?.reason, 'policy_rejected');
  });

  it('does not start a dependent until its prerequisite is PASSED', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', ['Ta']));
    const executor = new FakeExecutor();
    let now = 0;
    const scheduler = new Scheduler(graph, executor, { concurrency: 2, clock: () => now });

    assert.deepEqual(scheduler.tick().map((event) => event.type), ['task_started', 'attempt_settled']);
    assert.equal(executor.startCalls.length, 1);
    assert.equal(graph.getTask('Tb')?.state, 'PENDING');
    pass(scheduler, 'Ta');
    assert.equal(graph.getTask('Tb')?.state, 'READY');
    now = 1;
    assert.deepEqual(scheduler.tick().map((event) => event.type), ['task_started', 'attempt_settled']);
    assert.equal(executor.startCalls.length, 2);
  });

  it('caps backoff and uses the recorded-attempt count for the second retry', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tcap', [], { retry: { max_attempts: 3 } }));
    const executor = new FakeExecutor({ Tcap: [{ status: 'settled', outcome: 'rejected' }] });
    let now = 0;
    const scheduler = new Scheduler(graph, executor, {
      concurrency: 1,
      clock: () => now,
      backoff: { baseMs: 10, maxMs: 15 },
    });

    scheduler.tick();
    const first = scheduler.submitVerdict('Tcap', 'rejected');
    assert.equal(first.ok, true);
    if (first.ok) {
      const retry = first.events.find((event) => event.type === 'retry_scheduled');
      assert.equal(retry?.type, 'retry_scheduled');
      if (retry?.type === 'retry_scheduled') assert.equal(retry.delayMs, 10);
    }
    now = 10;
    scheduler.tick();
    const second = scheduler.submitVerdict('Tcap', 'rejected');
    assert.equal(second.ok, true);
    if (second.ok) {
      const retry = second.events.find((event) => event.type === 'retry_scheduled');
      assert.equal(retry?.type, 'retry_scheduled');
      if (retry?.type === 'retry_scheduled') assert.equal(retry.delayMs, 15);
    }
  });

  it('applies deterministic exponential backoff without injected jitter', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tretry', [], { retry: { max_attempts: 2 } }));
    const executor = new FakeExecutor({ Tretry: [{ status: 'settled', outcome: 'execution returned' }] });
    let now = 0;
    const scheduler = new Scheduler(graph, executor, {
      concurrency: 1,
      clock: () => now,
      backoff: { baseMs: 10 },
    });

    scheduler.tick();
    const rejected = scheduler.submitVerdict('Tretry', 'rejected');
    assert.equal(rejected.ok, true);
    if (rejected.ok) {
      const retry = rejected.events.find((event) => event.type === 'retry_scheduled');
      assert.equal(retry?.type, 'retry_scheduled');
      if (retry?.type === 'retry_scheduled') assert.deepEqual({ delayMs: retry.delayMs, dueAt: retry.dueAt }, { delayMs: 10, dueAt: 10 });
    }
    assert.equal(executor.startCalls.length, 1);
    now = 9;
    assert.deepEqual(scheduler.tick(), []);
    assert.equal(executor.startCalls.length, 1);
    now = 10;
    assert.deepEqual(scheduler.tick().map((event) => event.type), ['task_ready', 'task_started', 'attempt_settled']);
    assert.equal(executor.startCalls.length, 2);
  });

  it('uses the legal timeout transition, cancels and closes the attempt, then retries', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tslow', [], {
      budget: { max_turns: 1, timeout_ms: 10 },
      retry: { max_attempts: 2 },
    }));
    const executor = new FakeExecutor({ Tslow: [{ status: 'pending' }] });
    let now = 0;
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => now });

    scheduler.tick();
    now = 11;
    const events = scheduler.tick();
    assert.deepEqual(events.map((event) => event.type), ['timeout', 'retry_scheduled']);
    assert.equal(executor.cancelCalls[0]?.reason, 'timeout after 11ms');
    assert.deepEqual(executor.closeCalls, ['Tslow:attempt-1']);
    assert.equal(graph.getTask('Tslow')?.state, 'RETRYING');
    assert.equal(graph.getTask('Tslow')?.attempts[0]?.status, 'CANCELLED');
    assert.match(graph.getTask('Tslow')?.attempts[0]?.outcome ?? '', /timeout/);

    now = 12;
    scheduler.tick();
    assert.equal(executor.startCalls.length, 2);
  });

  it('turns an invalid settled poll into a cancelled attempt and structured retry error', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tbadpoll', [], { retry: { max_attempts: 2 } }));
    let cancelled = 0;
    let closed = 0;
    const executor = {
      start: () => ({
        poll: () => ({ status: 'settled', outcome: '' }),
        cancel: () => { cancelled++; },
        close: () => { closed++; },
      }),
    } as never;
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });

    const events = scheduler.tick();
    assert.deepEqual(events.map((event) => event.type), ['task_started', 'executor_error', 'retry_scheduled']);
    const error = events.find((event) => event.type === 'executor_error');
    assert.equal(error?.type, 'executor_error');
    if (error?.type === 'executor_error') {
      assert.equal(error.code, 'EXECUTOR_PROTOCOL_VIOLATION');
      assert.equal(error.path, 'executor.poll.return.outcome');
      assert.deepEqual(error.available, ['outcome']);
    }
    assert.equal(graph.getTask('Tbadpoll')?.state, 'RETRYING');
    assert.equal(graph.getTask('Tbadpoll')?.attempts[0]?.status, 'CANCELLED');
    assert.equal(cancelled, 1);
    assert.equal(closed, 1);
    assert.equal(scheduler.activeCount(), 0);
  });

  it('converts an unknown poll status to a bounded structured executor error', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tstatus', [], { retry: { max_attempts: 0 } }));
    const executor = {
      start: () => ({
        poll: () => ({ status: 'mystery', payload: 'ignored' }),
        cancel: () => undefined,
        close: () => undefined,
      }),
    } as never;
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });

    const events = scheduler.tick();
    assert.equal(events.find((event) => event.type === 'executor_error')?.type, 'executor_error');
    assert.equal(graph.getTask('Tstatus')?.state, 'FAILED');
    assert.equal(graph.getTask('Tstatus')?.attempts[0]?.status, 'CANCELLED');
  });

  it('caps consecutive executor.start failures and does not leave a RUNNING task', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tstart', [], { retry: { max_attempts: 10 } }));
    let starts = 0;
    const executor = {
      start: () => {
        starts++;
        throw new Error('fixture start failure');
      },
    } as never;
    let now = 0;
    const scheduler = new Scheduler(graph, executor, {
      concurrency: 1,
      clock: () => now,
      maxStartFailures: 2,
    });

    const first = scheduler.tick();
    assert.equal(first.filter((event) => event.type === 'executor_error').length, 1);
    assert.equal(graph.getTask('Tstart')?.state, 'RETRYING');
    now = 1;
    const second = scheduler.tick();
    assert.deepEqual(second.map((event) => event.type), ['task_ready', 'executor_error', 'task_failed']);
    assert.equal(starts, 2);
    assert.equal(graph.getTask('Tstart')?.state, 'FAILED');
    assert.equal(scheduler.activeCount(), 0);
    assert.deepEqual(scheduler.tick(), []);
  });

  it('fails a timeout at the final attempt instead of leaving RETRYING', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ttimeout-fail', [], {
      budget: { max_turns: 1, timeout_ms: 5 },
      retry: { max_attempts: 1 },
    }));
    const executor = new FakeExecutor({ 'Ttimeout-fail': [{ status: 'pending' }] });
    let now = 0;
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => now });
    scheduler.tick();
    now = 6;
    const events = scheduler.tick();
    assert.deepEqual(events.map((event) => event.type), ['timeout', 'task_failed']);
    assert.equal(graph.getTask('Ttimeout-fail')?.state, 'FAILED');
    assert.equal(graph.getTask('Ttimeout-fail')?.attempts[0]?.status, 'CANCELLED');
  });

  it('reports stuck work once without killing or changing task state', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tstuck'));
    const executor = new FakeExecutor({ Tstuck: [{ status: 'pending' }] });
    let now = 0;
    const scheduler = new Scheduler(graph, executor, {
      concurrency: 1,
      clock: () => now,
      stallTimeoutMs: 5,
    });

    scheduler.tick();
    now = 6;
    assert.deepEqual(scheduler.tick().map((event) => event.type), ['stuck']);
    assert.equal(graph.getTask('Tstuck')?.state, 'RUNNING');
    assert.deepEqual(executor.cancelCalls, []);
    now = 7;
    assert.deepEqual(scheduler.tick(), []);
  });

  it('cancels an in-flight attempt and blocks dependents without cascading cancellation', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', ['Ta']));
    const executor = new FakeExecutor({ Ta: [{ status: 'pending' }] });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });

    scheduler.tick();
    const result = scheduler.cancelTask('Ta', 'operator request');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.events.map((event) => event.type), ['attempt_cancelled', 'task_cancelled', 'task_blocked']);
    assert.deepEqual(executor.cancelCalls, [{ taskId: 'Ta', attemptId: 'Ta:attempt-1', reason: 'operator request' }]);
    assert.deepEqual(executor.closeCalls, ['Ta:attempt-1']);
    assert.equal(graph.getTask('Ta')?.state, 'CANCELLED');
    assert.equal(graph.getTask('Ta')?.attempts[0]?.status, 'CANCELLED');
    assert.equal(graph.getTask('Tb')?.state, 'BLOCKED');
  });

  it('fails after retry exhaustion and never schedules another attempt', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tfail', [], { retry: { max_attempts: 0 } }));
    const executor = new FakeExecutor({ Tfail: [{ status: 'settled', outcome: 'bad result' }] });
    const scheduler = new Scheduler(graph, executor, { concurrency: 1, clock: () => 0 });

    scheduler.tick();
    const result = scheduler.submitVerdict('Tfail', 'rejected');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.events.map((event) => event.type), ['verdict_recorded', 'task_failed']);
    assert.equal(graph.getTask('Tfail')?.state, 'FAILED');
    assert.equal(executor.startCalls.length, 1);
    assert.deepEqual(scheduler.tick(), []);
  });

  it('validates scheduler options exactly and defaults undefined options', () => {
    const graph = new TaskGraph();
    add(graph, contract('Toptions'));
    const defaults = new Scheduler(graph, new FakeExecutor(), undefined);
    assert.deepEqual(defaults.tick().map((event) => event.type), ['task_started', 'attempt_settled']);

    for (const value of [null, 42, [], new Date()]) {
      assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), value), (error: SchedulerConfigError) => {
        assert.equal(error.code, 'INVALID_SCHEDULER_OPTIONS');
        assert.equal(error.path, 'options');
        return true;
      });
    }
    const unknown = { concurrency: 1, clock: () => 0, extra: true } as Record<string, unknown>;
    assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), unknown), (error: SchedulerConfigError) => {
      assert.equal(error.path, 'options');
      assert.match(error.message, /extra/);
      assert.deepEqual(error.available, ['concurrency', 'clock', 'rng', 'backoff', 'stallTimeoutMs', 'maxStartFailures']);
      return true;
    });
    const symbol = Symbol('unexpected');
    const withSymbol: Record<PropertyKey, unknown> = { concurrency: 1, clock: () => 0 };
    Object.defineProperty(withSymbol, symbol, { value: true, enumerable: false });
    assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), withSymbol), SchedulerConfigError);
    const withHidden: Record<string, unknown> = { concurrency: 1, clock: () => 0 };
    Object.defineProperty(withHidden, 'hidden', { value: true, enumerable: false });
    assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), withHidden), SchedulerConfigError);
    assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), {
      concurrency: 1,
      clock: () => 0,
      backoff: {},
    }), (error: SchedulerConfigError) => {
      assert.equal(error.path, 'options.backoff.baseMs');
      assert.match(error.message, /explicitly provided/);
      return true;
    });
    assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), {
      concurrency: 1,
      clock: () => 0,
      backoff: { jitterMs: 1 },
    }), (error: SchedulerConfigError) => error.path === 'options.backoff.baseMs');
    assert.doesNotThrow(() => new Scheduler(new TaskGraph(), new FakeExecutor(), {
      concurrency: 1,
      clock: () => 0,
      backoff: { baseMs: 1, jitterMs: 0, maxMs: 5 },
    }));
    assert.throws(() => new Scheduler(new TaskGraph(), new FakeExecutor(), {
      concurrency: 1,
      clock: () => 0,
      backoff: { baseMs: 0 },
    }), (error: SchedulerConfigError) => error.path === 'options.backoff.baseMs');
  });

  it('fails closed on invalid clocks and random samples', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tclock'));
    const scheduler = new Scheduler(graph, new FakeExecutor(), { concurrency: 1, clock: () => Number.NaN });
    const tick = scheduler.tick();
    assert.deepEqual(tick.map((event) => event.type), ['scheduler_error']);
    if (tick[0]?.type === 'scheduler_error') {
      assert.equal(tick[0].code, 'INVALID_CLOCK');
      assert.equal(tick[0].path, 'clock');
    }
    const verdict = scheduler.submitVerdict('Tclock', 'passed');
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.error.code, 'INVALID_CLOCK');
    const cancel = scheduler.cancelTask('Tclock');
    assert.equal(cancel.ok, false);
    if (!cancel.ok) assert.equal(cancel.error.code, 'INVALID_CLOCK');

    const rngGraph = new TaskGraph();
    add(rngGraph, contract('Trng-bad', [], { retry: { max_attempts: 2 } }));
    const rngScheduler = new Scheduler(rngGraph, new FakeExecutor(), {
      concurrency: 1,
      clock: () => 0,
      rng: () => 2,
      backoff: { baseMs: 1, jitterMs: 1 },
    });
    rngScheduler.tick();
    const rejected = rngScheduler.submitVerdict('Trng-bad', 'rejected');
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'INVALID_RNG');
      assert.equal(rejected.error.path, 'rng');
    }
    assert.equal(rngGraph.getTask('Trng-bad')?.state, 'VERIFYING');
  });

  it('rejects non-string task IDs structurally at scheduler command boundaries', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tid'));
    const scheduler = new Scheduler(graph, new FakeExecutor(), { concurrency: 1, clock: () => 0 });
    const unknown = scheduler.submitVerdict('Tmissing', 'passed');
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'UNKNOWN_TASK');
    for (const value of [null, 42, {}, '']) {
      assert.doesNotThrow(() => {
        const verdict = scheduler.submitVerdict(value, 'passed');
        assert.equal(verdict.ok, false);
        if (!verdict.ok) assert.equal(verdict.error.code, 'INVALID_TASK_ID');
        const cancelled = scheduler.cancelTask(value);
        assert.equal(cancelled.ok, false);
        if (!cancelled.ok) assert.equal(cancelled.error.code, 'INVALID_TASK_ID');
      });
    }
  });

  it('keeps event data frozen and orders start, settle, verdict, and pass events', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tevent'));
    const scheduler = new Scheduler(graph, new FakeExecutor(), { concurrency: 1, clock: () => 3 });

    const started = scheduler.tick();
    assert.deepEqual(started.map((event) => event.type), ['task_started', 'attempt_settled']);
    assert.equal(Object.isFrozen(started), true);
    assert.equal(Object.isFrozen(started[0]), true);
    const verdict = scheduler.submitVerdict('Tevent', 'passed');
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.deepEqual(verdict.events.map((event) => event.type), ['verdict_recorded', 'task_passed']);
  });

  it('produces the same jittered backoff with the same injected RNG sequence', () => {
    function run(seed: number): number {
      let value = seed;
      const rng = () => {
        value = (value * 17 + 11) % 101;
        return value / 100;
      };
      const graph = new TaskGraph();
      add(graph, contract('Trng', [], { retry: { max_attempts: 2 } }));
      const scheduler = new Scheduler(graph, new FakeExecutor(), {
        concurrency: 1,
        clock: () => 0,
        rng,
        backoff: { baseMs: 10, jitterMs: 10 },
      });
      scheduler.tick();
      const result = scheduler.submitVerdict('Trng', 'rejected');
      assert.equal(result.ok, true);
      if (!result.ok) return -1;
      const event = result.events.find((entry) => entry.type === 'retry_scheduled');
      assert.equal(event?.type, 'retry_scheduled');
      return event?.type === 'retry_scheduled' ? event.delayMs : -1;
    }
    assert.equal(run(7), run(7));
    assert.notEqual(run(7), run(8));
  });

  it('runs a six-task mixed dependency and retry scenario to completion', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', [], { retry: { max_attempts: 2 } }));
    add(graph, contract('Tc'));
    add(graph, contract('Td', ['Ta']));
    add(graph, contract('Te', ['Tb', 'Tc']));
    add(graph, contract('Tf', ['Td', 'Te']));
    const executor = new FakeExecutor((request) => {
      if (request.taskId === 'Tb' && request.attemptId.endsWith('attempt-1')) {
        return [{ status: 'settled', outcome: 'first try' }];
      }
      return [{ status: 'settled', outcome: 'completed' }];
    });
    const scheduler = new Scheduler(graph, executor, { concurrency: 3, clock: () => 0 });

    scheduler.tick();
    pass(scheduler, 'Ta');
    assert.equal(scheduler.submitVerdict('Tb', 'rejected').ok, true);
    pass(scheduler, 'Tc');
    scheduler.tick();
    pass(scheduler, 'Td');
    pass(scheduler, 'Tb');
    scheduler.tick();
    pass(scheduler, 'Te');
    scheduler.tick();
    pass(scheduler, 'Tf');

    assert.deepEqual(graph.snapshot().tasks.map((task) => [task.id, task.state]), [
      ['Ta', 'PASSED'], ['Tb', 'PASSED'], ['Tc', 'PASSED'],
      ['Td', 'PASSED'], ['Te', 'PASSED'], ['Tf', 'PASSED'],
    ]);
    assert.equal(executor.startCalls.length, 7);
    assert.equal(scheduler.events().filter((event) => event.type === 'task_passed').length, 6);
  });
});
