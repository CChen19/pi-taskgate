/**
 * Pure in-memory dynamic task graph.
 *
 * `addTask` uses strict prerequisite semantics: every `depends_on` reference
 * must already exist. There is no same-batch declaration API in this slice;
 * callers add prerequisites first, which keeps graph mutation deterministic.
 *
 * A discovered subtask is a gate for the parent's existing dependents. It is
 * not made to depend on a currently-running parent: discovery is allowed while
 * the parent is running, and the parent may finish independently. A dependent
 * becomes eligible only after both its direct parent and all discovered
 * subtasks under that parent have PASSED.
 */

import type {
  ContractIssue,
  ContractValidationError,
  TaskContract,
} from './task-contract.ts';
import { validateTaskContract } from './task-contract.ts';
import {
  transitionTaskState,
  type StateTransitionError,
  type TaskAttempt,
  type TaskRuntime,
  type TaskState,
} from './task-state.ts';
import { asNonEmptyString, deepFreeze, isPlainObject, ownValue, truncateForMessage } from './validate.ts';

export interface TaskSnapshot {
  readonly id: string;
  readonly contract: TaskContract;
  readonly state: TaskState;
  readonly attempts: readonly TaskAttempt[];
  readonly blocker?: string;
  readonly reason?: string;
}

export interface TaskDependency {
  /** `from` must pass before `to` can become ready. */
  readonly from: string;
  readonly to: string;
}

export interface TaskSubtask {
  readonly parent: string;
  readonly child: string;
}

export interface TaskGraphSnapshot {
  readonly tasks: readonly TaskSnapshot[];
  readonly dependencies: readonly TaskDependency[];
  readonly subtasks: readonly TaskSubtask[];
}

export type TaskGraphErrorCode =
  | 'INVALID_CONTRACT'
  | 'TASK_ALREADY_EXISTS'
  | 'UNKNOWN_TASK'
  | 'INVALID_TASK_ID'
  | 'UNKNOWN_DEPENDENCY'
  | 'DUPLICATE_DEPENDENCY'
  | 'CYCLE_DETECTED'
  | 'INVALID_GRAPH_OPERATION'
  | 'INVALID_STATE_TRANSITION'
  | 'INVALID_TRANSITION_EVENT'
  | 'INVALID_TRANSITION_INPUT';

export interface TaskGraphError {
  readonly code: TaskGraphErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
  readonly from?: TaskState;
  readonly to?: TaskState;
  readonly cycle?: readonly string[];
  readonly issues?: readonly ContractIssue[];
}

export type TaskGraphResult =
  | { readonly ok: true; readonly snapshot: TaskGraphSnapshot }
  | { readonly ok: false; readonly error: TaskGraphError };

interface TaskRecord {
  readonly contract: TaskContract;
  runtime: TaskRuntime;
}

function graphError(
  code: TaskGraphErrorCode,
  message: string,
  path: string,
  available: readonly string[],
  extra: {
    readonly from?: TaskState;
    readonly to?: TaskState;
    readonly cycle?: readonly string[];
    readonly issues?: readonly ContractIssue[];
  } = {},
): TaskGraphResult {
  return {
    ok: false,
    error: deepFreeze({
      code,
      message,
      path,
      available: [...available],
      ...extra,
    }),
  };
}

function stateError(error: StateTransitionError): TaskGraphResult {
  return graphError(error.code, error.message, error.path, error.available, {
    from: error.from,
    ...(error.to === undefined ? {} : { to: error.to }),
  });
}

function runtimeFor(contract: TaskContract): TaskRuntime {
  return { state: 'PENDING', attempts: [], maxAttempts: contract.retry?.max_attempts ?? 0 };
}

/**
 * Mutable graph state with immutable snapshots. Mutation is limited to this
 * pure-core data structure; no filesystem, process, network, or scheduler API
 * is involved.
 */
export class TaskGraph {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly prerequisites = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly subtasks = new Map<string, Set<string>>();

  /** Add a validated task whose dependency IDs are already in this graph. */
  addTask(input: TaskContract): TaskGraphResult {
    const validated = validateTaskContract(input);
    if (!validated.ok) return this.invalidContract(validated.error);
    const contract = validated.contract;
    if (this.tasks.has(contract.id)) {
      return graphError(
        'TASK_ALREADY_EXISTS',
        `task "${truncateForMessage(contract.id)}" already exists`,
        `tasks.${contract.id}`,
        this.taskIds(),
      );
    }
    for (const [index, dependency] of contract.depends_on.entries()) {
      if (!this.tasks.has(dependency)) {
        return graphError(
          'UNKNOWN_DEPENDENCY',
          `task "${truncateForMessage(contract.id)}" references unknown dependency "${truncateForMessage(dependency)}"`,
          `contract.depends_on[${index}]`,
          this.taskIds(),
        );
      }
    }

    this.tasks.set(contract.id, { contract, runtime: runtimeFor(contract) });
    this.prerequisites.set(contract.id, new Set(contract.depends_on));
    this.dependents.set(contract.id, new Set());
    this.subtasks.set(contract.id, new Set());
    for (const dependency of contract.depends_on) this.dependents.get(dependency)!.add(contract.id);

    this.refreshReadyStates();
    return { ok: true, snapshot: this.snapshot() };
  }

  /** Add `from -> to`, meaning from must pass before to can become ready. */
  addDependency(from: string, to: string): TaskGraphResult {
    const validFrom = this.validateTaskId(from, 'dependency.from');
    if (!validFrom.ok) return validFrom;
    const validTo = this.validateTaskId(to, 'dependency.to');
    if (!validTo.ok) return validTo;
    const fromRecord = this.tasks.get(from);
    const toRecord = this.tasks.get(to);
    if (fromRecord === undefined || toRecord === undefined) {
      const missing = fromRecord === undefined ? from : to;
      return graphError(
        'UNKNOWN_TASK',
        `unknown task "${truncateForMessage(missing)}" in dependency`,
        'dependency',
        this.taskIds(),
      );
    }
    if (from === to) return this.cycleError([from, from]);
    if (this.prerequisites.get(to)!.has(from)) {
      return graphError(
        'DUPLICATE_DEPENDENCY',
        `dependency "${from} -> ${to}" already exists`,
        'dependency',
        this.taskIds(),
      );
    }
    const pathBack = this.findPath(to, from);
    if (pathBack !== undefined) return this.cycleError([from, ...pathBack]);
    if (toRecord.runtime.state === 'PASSED' || toRecord.runtime.state === 'FAILED' || toRecord.runtime.state === 'CANCELLED') {
      return graphError(
        'INVALID_GRAPH_OPERATION',
        `cannot add a dependency to terminal task "${truncateForMessage(to)}"`,
        `tasks.${to}.state`,
        this.taskIds(),
      );
    }

    this.prerequisites.get(to)!.add(from);
    this.dependents.get(from)!.add(to);
    if (toRecord.runtime.state !== 'PENDING' && toRecord.runtime.state !== 'BLOCKED' && fromRecord.runtime.state !== 'PASSED') {
      const blocked = transitionTaskState(toRecord.runtime, { type: 'block', blocker: from });
      if (!blocked.ok) return stateError(blocked.error);
      toRecord.runtime = blocked.runtime;
    }
    this.refreshReadyStates();
    return { ok: true, snapshot: this.snapshot() };
  }

  /**
   * Insert a task discovered under a running or existing parent. The child is
   * added independently, then gates current dependents of the parent when
   * `reblockDependents` is true (default).
   */
  insertSubtask(
    parentTaskId: string,
    input: TaskContract,
    options: { readonly reblockDependents?: boolean } = {},
  ): TaskGraphResult {
    const validParent = this.validateTaskId(parentTaskId, 'parentTaskId');
    if (!validParent.ok) return validParent;
    if (!this.tasks.has(parentTaskId)) {
      return graphError('UNKNOWN_TASK', `unknown parent task "${truncateForMessage(parentTaskId)}"`, 'parentTaskId', this.taskIds());
    }
    const dependentsBefore = [...this.dependents.get(parentTaskId)!];
    const added = this.addTask(input);
    if (!added.ok) return added;
    const childId = input.id;
    this.subtasks.get(parentTaskId)!.add(childId);

    if (options.reblockDependents !== false) {
      for (const dependentId of dependentsBefore) {
        const dependent = this.tasks.get(dependentId)!;
        if (dependent.runtime.state === 'PASSED' || dependent.runtime.state === 'FAILED' || dependent.runtime.state === 'CANCELLED') continue;
        if (dependent.runtime.state === 'BLOCKED') continue;
        const blocked = transitionTaskState(dependent.runtime, { type: 'block', blocker: childId });
        if (!blocked.ok) return stateError(blocked.error);
        dependent.runtime = blocked.runtime;
      }
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  /** Apply one state-machine event and refresh graph-derived dependents. */
  transitionTask(taskId: string, transition: unknown): TaskGraphResult {
    const validTask = this.validateTaskId(taskId, 'taskId');
    if (!validTask.ok) return validTask;
    if (isPlainObject(transition) && ownValue(transition, 'type') === 'cancel') return this.cancelTask(taskId);
    const record = this.tasks.get(taskId);
    if (record === undefined) {
      return graphError('UNKNOWN_TASK', `unknown task "${truncateForMessage(taskId)}"`, 'taskId', this.taskIds());
    }
    if (isPlainObject(transition) && ownValue(transition, 'type') === 'ready' && this.blockersFor(taskId).length > 0) {
      return graphError(
        'INVALID_GRAPH_OPERATION',
        `task "${truncateForMessage(taskId)}" is not ready; dependencies remain unresolved`,
        `tasks.${taskId}.state`,
        this.blockersFor(taskId),
      );
    }
    const result = transitionTaskState(record.runtime, transition);
    if (!result.ok) return stateError(result.error);
    record.runtime = result.runtime;
    this.refreshReadyStates();
    return { ok: true, snapshot: this.snapshot() };
  }

  /** Cancel one task and block its descendants; never auto-cancels them. */
  cancelTask(taskId: string): TaskGraphResult {
    const validTask = this.validateTaskId(taskId, 'taskId');
    if (!validTask.ok) return validTask;
    const record = this.tasks.get(taskId);
    if (record === undefined) {
      return graphError('UNKNOWN_TASK', `unknown task "${truncateForMessage(taskId)}"`, 'taskId', this.taskIds());
    }
    const cancelled = transitionTaskState(record.runtime, { type: 'cancel', reason: taskId });
    if (!cancelled.ok) return stateError(cancelled.error);
    record.runtime = cancelled.runtime;

    const queue = [taskId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const source = queue.shift()!;
      if (seen.has(source)) continue;
      seen.add(source);
      for (const dependentId of this.dependents.get(source) ?? []) {
        const dependent = this.tasks.get(dependentId)!;
        if (dependent.runtime.state !== 'PASSED' && dependent.runtime.state !== 'FAILED' && dependent.runtime.state !== 'CANCELLED' && dependent.runtime.state !== 'BLOCKED') {
          const blocked = transitionTaskState(dependent.runtime, { type: 'block', blocker: source });
          if (!blocked.ok) return stateError(blocked.error);
          dependent.runtime = blocked.runtime;
        }
        queue.push(dependentId);
      }
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  /** IDs whose state is READY and whose effective prerequisites have passed. */
  readySet(): readonly string[] {
    return Object.freeze(this.taskIds().filter((id) => {
      const record = this.tasks.get(id)!;
      return record.runtime.state === 'READY' && this.blockersFor(id).length === 0;
    }));
  }

  /** IDs currently in BLOCKED, with blocker details available through snapshot(). */
  blockedTasks(): readonly string[] {
    return Object.freeze(this.taskIds().filter((id) => this.tasks.get(id)!.runtime.state === 'BLOCKED'));
  }

  /** Direct dependents, in insertion order. */
  dependentsOf(taskId: string): readonly string[] {
    return Object.freeze([...(this.dependents.get(taskId) ?? [])]);
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    const record = this.tasks.get(taskId);
    return record === undefined ? undefined : this.taskSnapshot(taskId, record);
  }

  snapshot(): TaskGraphSnapshot {
    const dependencies: TaskDependency[] = [];
    for (const [to, prerequisites] of this.prerequisites) {
      for (const from of prerequisites) dependencies.push({ from, to });
    }
    const subtasks: TaskSubtask[] = [];
    for (const [parent, children] of this.subtasks) {
      for (const child of children) subtasks.push({ parent, child });
    }
    return deepFreeze({
      tasks: this.taskIds().map((id) => this.taskSnapshot(id, this.tasks.get(id)!)),
      dependencies,
      subtasks,
    });
  }

  private invalidContract(error: ContractValidationError): TaskGraphResult {
    return graphError('INVALID_CONTRACT', error.message, error.path, this.taskIds(), { issues: error.issues });
  }

  private validateTaskId(taskId: unknown, path: string): { readonly ok: true } | { readonly ok: false; readonly error: TaskGraphError } {
    if (asNonEmptyString(taskId) !== undefined) return { ok: true };
    return {
      ok: false,
      error: deepFreeze({
        code: 'INVALID_TASK_ID' as const,
        message: `${path} must be a non-empty string`,
        path,
        available: this.taskIds(),
      }),
    };
  }

  private taskIds(): string[] {
    return [...this.tasks.keys()];
  }

  private taskSnapshot(id: string, record: TaskRecord): TaskSnapshot {
    const snapshot: {
      id: string;
      contract: TaskContract;
      state: TaskState;
      attempts: readonly TaskAttempt[];
      blocker?: string;
      reason?: string;
    } = {
      id,
      contract: record.contract,
      state: record.runtime.state,
      attempts: [...record.runtime.attempts],
    };
    if (record.runtime.blocker !== undefined) snapshot.blocker = record.runtime.blocker;
    if (record.runtime.reason !== undefined) snapshot.reason = record.runtime.reason;
    return deepFreeze(snapshot);
  }

  private cycleError(cycle: readonly string[]): TaskGraphResult {
    return graphError(
      'CYCLE_DETECTED',
      `dependency would create a cycle: ${cycle.map((id) => truncateForMessage(id)).join(' -> ')}`,
      'dependency',
      this.taskIds(),
      { cycle: [...cycle] },
    );
  }

  /** Returns a path start -> ... -> goal over explicit dependency edges. */
  private findPath(start: string, goal: string): string[] | undefined {
    const queue: string[][] = [[start]];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const path = queue.shift()!;
      const current = path[path.length - 1]!;
      if (current === goal) return path;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of this.dependents.get(current) ?? []) queue.push([...path, next]);
    }
    return undefined;
  }

  /** All explicit prerequisites plus discovered descendants of each prerequisite. */
  private effectivePrerequisites(taskId: string): string[] {
    const result: string[] = [];
    const visitSubtasks = (parent: string): void => {
      for (const child of this.subtasks.get(parent) ?? []) {
        result.push(child);
        visitSubtasks(child);
      }
    };
    for (const prerequisite of this.prerequisites.get(taskId) ?? []) {
      result.push(prerequisite);
      visitSubtasks(prerequisite);
    }
    return result;
  }

  private blockersFor(taskId: string): string[] {
    return this.effectivePrerequisites(taskId).filter((dependency) => this.tasks.get(dependency)?.runtime.state !== 'PASSED');
  }

  /** Refresh only graph-derived readiness and dependency-failure blocking. */
  private refreshReadyStates(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of this.taskIds()) {
        const record = this.tasks.get(id)!;
        const state = record.runtime.state;
        if (state === 'PASSED' || state === 'FAILED' || state === 'CANCELLED') continue;
        const blockers = this.blockersFor(id);
        const failedBlocker = blockers.find((blocker) => {
          const blockerState = this.tasks.get(blocker)!.runtime.state;
          return blockerState === 'FAILED' || blockerState === 'CANCELLED';
        });
        if (failedBlocker !== undefined && state !== 'BLOCKED') {
          const blocked = transitionTaskState(record.runtime, { type: 'block', blocker: failedBlocker });
          if (blocked.ok) {
            record.runtime = blocked.runtime;
            changed = true;
          }
          continue;
        }
        if (blockers.length === 0 && (state === 'PENDING' || state === 'BLOCKED')) {
          const ready = transitionTaskState(record.runtime, { type: 'ready' });
          if (ready.ok) {
            record.runtime = ready.runtime;
            changed = true;
          }
        }
      }
    }
  }
}
