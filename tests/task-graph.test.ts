import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TaskGraph, type TaskGraphResult } from '../src/core/task-graph.ts';
import type { TaskContract } from '../src/core/task-contract.ts';

function contract(id: string, depends_on: readonly string[] = [], extra: Record<string, unknown> = {}): TaskContract {
  return {
    id,
    objective: `Objective for ${id}`,
    depends_on: [...depends_on],
    acceptance_criteria: [`${id} is accepted`],
    verification: [],
    ...extra,
  } as TaskContract;
}

function ok(result: TaskGraphResult) {
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot;
}

function add(graph: TaskGraph, task: TaskContract): void {
  ok(graph.addTask(task));
}

function pass(graph: TaskGraph, taskId: string, attemptId: string): void {
  ok(graph.transitionTask(taskId, { type: 'start', attemptId }));
  ok(graph.transitionTask(taskId, { type: 'settle', attemptId, outcome: 'completed' }));
  ok(graph.transitionTask(taskId, { type: 'verdict', verdict: 'passed' }));
}

describe('TaskGraph', () => {
  it('rejects an addTask with an unknown prerequisite and leaves the graph unchanged', () => {
    const graph = new TaskGraph();
    const result = graph.addTask(contract('Tb', ['Tmissing']));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'UNKNOWN_DEPENDENCY');
      assert.equal(result.error.path, 'contract.depends_on[0]');
      assert.deepEqual(result.error.available, []);
    }
    assert.deepEqual(graph.snapshot().tasks, []);
  });

  it('adds explicit edges, rejects duplicate edges and reports a cycle path', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', ['Ta']));
    const duplicate = graph.addDependency('Ta', 'Tb');
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, 'DUPLICATE_DEPENDENCY');

    const cycle = graph.addDependency('Tb', 'Ta');
    assert.equal(cycle.ok, false);
    if (!cycle.ok) {
      assert.equal(cycle.error.code, 'CYCLE_DETECTED');
      assert.deepEqual(cycle.error.cycle, ['Tb', 'Ta', 'Tb']);
      assert.match(cycle.error.message, /Tb -> Ta -> Tb/);
    }
  });

  it('tracks readiness and direct dependents as prerequisites pass', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', ['Ta']));
    add(graph, contract('Tc', ['Ta', 'Tb']));
    assert.deepEqual(graph.readySet(), ['Ta']);
    assert.deepEqual(graph.dependentsOf('Ta'), ['Tb', 'Tc']);
    assert.deepEqual(graph.blockedTasks(), []);

    pass(graph, 'Ta', 'a-1');
    assert.deepEqual(graph.readySet(), ['Tb']);
    pass(graph, 'Tb', 'b-1');
    assert.deepEqual(graph.readySet(), ['Tc']);
  });

  it('dynamically inserts a subtask and reblocks dependents until both gates pass', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tb'));
    add(graph, contract('Td', ['Tb']));
    ok(graph.transitionTask('Tb', { type: 'start', attemptId: 'b-1' }));
    assert.deepEqual(graph.readySet(), []);

    const inserted = graph.insertSubtask('Tb', contract('Tb-1'), { reblockDependents: true });
    ok(inserted);
    assert.deepEqual(graph.blockedTasks(), ['Td']);
    assert.equal(graph.getTask('Td')?.blocker, 'Tb-1');
    assert.equal(graph.getTask('Tb-1')?.state, 'READY');

    pass(graph, 'Tb-1', 'b1-1');
    assert.equal(graph.getTask('Td')?.state, 'BLOCKED');
    ok(graph.transitionTask('Tb', { type: 'settle', attemptId: 'b-1', outcome: 'completed' }));
    ok(graph.transitionTask('Tb', { type: 'verdict', verdict: 'passed' }));
    assert.equal(graph.getTask('Td')?.state, 'READY');
    assert.deepEqual(graph.readySet(), ['Td']);
    assert.deepEqual(graph.snapshot().subtasks, [{ parent: 'Tb', child: 'Tb-1' }]);
  });

  it('can insert a discovered task without immediately reblocking existing dependents', () => {
    const graph = new TaskGraph();
    add(graph, contract('Tb'));
    add(graph, contract('Td', ['Tb']));
    const result = graph.insertSubtask('Tb', contract('Tb-1'), { reblockDependents: false });
    ok(result);
    assert.equal(graph.getTask('Td')?.state, 'PENDING');
    assert.deepEqual(graph.readySet(), ['Tb', 'Tb-1']);
  });

  it('does not bypass a zero-attempt budget through graph unblock', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta', [], { retry: { max_attempts: 0 } }));
    ok(graph.transitionTask('Ta', { type: 'start', attemptId: 'a-1' }));
    ok(graph.transitionTask('Ta', { type: 'block', blocker: 'dependency' }));
    assert.equal(graph.getTask('Ta')?.state, 'FAILED');
    assert.match(graph.getTask('Ta')?.reason ?? '', /retry budget exhausted/);
    const unblocked = graph.transitionTask('Ta', { type: 'ready' });
    assert.equal(unblocked.ok, false);
    if (!unblocked.ok) assert.equal(unblocked.error.code, 'INVALID_STATE_TRANSITION');
  });

  it('blocks dependents when a retry budget is exhausted', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta', [], { retry: { max_attempts: 2 } }));
    add(graph, contract('Tb', ['Ta']));

    ok(graph.transitionTask('Ta', { type: 'start', attemptId: 'a-1' }));
    ok(graph.transitionTask('Ta', { type: 'settle', attemptId: 'a-1', outcome: 'failed' }));
    ok(graph.transitionTask('Ta', { type: 'verdict', verdict: 'rejected' }));
    assert.equal(graph.getTask('Ta')?.state, 'RETRYING');
    ok(graph.transitionTask('Ta', { type: 'ready' }));
    ok(graph.transitionTask('Ta', { type: 'start', attemptId: 'a-2' }));
    ok(graph.transitionTask('Ta', { type: 'settle', attemptId: 'a-2', outcome: 'failed again' }));
    ok(graph.transitionTask('Ta', { type: 'verdict', verdict: 'rejected' }));

    assert.equal(graph.getTask('Ta')?.state, 'FAILED');
    assert.equal(graph.getTask('Tb')?.state, 'BLOCKED');
    assert.equal(graph.getTask('Tb')?.blocker, 'Ta');
  });

  it('cancellation blocks descendants but does not cascade cancellation', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', ['Ta']));
    add(graph, contract('Tc', ['Tb']));
    const result = graph.cancelTask('Ta');
    ok(result);
    assert.equal(graph.getTask('Ta')?.state, 'CANCELLED');
    assert.equal(graph.getTask('Tb')?.state, 'BLOCKED');
    assert.equal(graph.getTask('Tc')?.state, 'BLOCKED');
    assert.equal(graph.getTask('Tb')?.blocker, 'Ta');
    assert.equal(graph.getTask('Tc')?.state, 'BLOCKED');
    assert.notEqual(graph.getTask('Tb')?.state, 'CANCELLED');
    assert.notEqual(graph.getTask('Tc')?.state, 'CANCELLED');
  });

  it('supports a multi-task parallel-ready end-to-end state walk', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));
    add(graph, contract('Tb', ['Ta']));
    add(graph, contract('Tc'));
    add(graph, contract('Td', ['Tb', 'Tc']));
    assert.deepEqual(graph.readySet(), ['Ta', 'Tc']);

    pass(graph, 'Ta', 'a-1');
    assert.deepEqual(graph.readySet(), ['Tb', 'Tc']);
    ok(graph.transitionTask('Tb', { type: 'start', attemptId: 'b-1' }));
    ok(graph.transitionTask('Tc', { type: 'start', attemptId: 'c-1' }));
    ok(graph.transitionTask('Tb', { type: 'settle', attemptId: 'b-1', outcome: 'done' }));
    ok(graph.transitionTask('Tc', { type: 'settle', attemptId: 'c-1', outcome: 'done' }));
    ok(graph.transitionTask('Tb', { type: 'verdict', verdict: 'passed' }));
    ok(graph.transitionTask('Tc', { type: 'verdict', verdict: 'passed' }));
    assert.deepEqual(graph.readySet(), ['Td']);
  });

  it('passes structured state errors, including from/to and event availability, through the graph', () => {
    const graph = new TaskGraph();
    add(graph, contract('Ta'));

    const unknown = graph.transitionTask('Ta', { type: 'bogus' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.error.code, 'INVALID_TRANSITION_EVENT');
      assert.deepEqual(unknown.error.available, ['ready', 'start', 'settle', 'verdict', 'block', 'cancel']);
      assert.equal(unknown.error.from, 'READY');
    }

    const illegal = graph.transitionTask('Ta', { type: 'settle', attemptId: 42, outcome: 'done' });
    assert.equal(illegal.ok, false);
    if (!illegal.ok) {
      assert.equal(illegal.error.code, 'INVALID_STATE_TRANSITION');
      assert.equal(illegal.error.from, 'READY');
      assert.equal(illegal.error.to, 'VERIFYING');
    }

    const invalidAttempt = graph.transitionTask('Ta', { type: 'start', attemptId: 42 });
    assert.equal(invalidAttempt.ok, false);
    if (!invalidAttempt.ok) assert.equal(invalidAttempt.error.code, 'INVALID_TRANSITION_INPUT');
  });

  it('returns frozen snapshots and does not alias caller-owned contract arrays', () => {
    const input = contract('Ta', []);
    const dependencies = input.depends_on as string[];
    const graph = new TaskGraph();
    add(graph, input);
    dependencies.push('Tcaller-mutation');
    const snapshot = graph.snapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.tasks), true);
    assert.equal(Object.isFrozen(snapshot.tasks[0]), true);
    assert.equal(Object.isFrozen(snapshot.tasks[0]?.contract), true);
    assert.deepEqual(snapshot.tasks[0]?.contract.depends_on, []);
    assert.throws(() => {
      (snapshot.tasks[0] as { state: string }).state = 'FAILED';
    }, TypeError);
  });
});
