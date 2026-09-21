/**
 * S7 crash-recovery reconciliation.
 *
 * This is a deterministic planner only.  It never starts, retries, cancels,
 * or attaches an executor.  A caller may persist the returned action as a
 * durable `recovery` event and let S3's attempt budget decide what follows.
 */

import { MAX_EVENT_ID_LENGTH, MAX_REFERENCE_LENGTH, MAX_SUMMARY_LENGTH, type RecoveryActionName } from './durable-state.ts';
import { TASK_STATES, type AttemptStatus, type TaskState } from './task-state.ts';
import { MAX_TASK_ID_LENGTH } from './task-contract.ts';
import { asNonEmptyString, deepFreeze, hasExactFields, isPlainObject, ownValue, truncateForMessage } from './validate.ts';

export const RECOVERY_ACTIONS = [
  'reattach',
  'settle',
  'mark-lost',
  'retry-scheduler',
  'cancel-orphan',
  'cancel-stale',
  'human',
] as const satisfies readonly RecoveryActionName[];

export const RECOVERY_OBSERVED_STATUSES = ['running', 'terminal', 'missing', 'orphan'] as const;
export type RecoveryObservedStatus = (typeof RECOVERY_OBSERVED_STATUSES)[number];

export type RecoveryErrorCode =
  | 'INVALID_RECOVERY_INPUT'
  | 'DUPLICATE_ATTEMPT'
  | 'REVISION_MISMATCH'
  | 'INVALID_BINDING'
  | 'BOUNDARY_ERROR';

export interface RecoveryErrorData {
  readonly code: RecoveryErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
}

export class RecoveryError extends Error implements RecoveryErrorData {
  readonly code: RecoveryErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(data: RecoveryErrorData) {
    super(truncateForMessage(data.message));
    this.name = 'RecoveryError';
    this.code = data.code;
    this.path = data.path;
    this.available = Object.freeze([...data.available]);
  }
}

export interface PersistedAttempt {
  readonly taskId: string;
  readonly attemptId: string;
  readonly taskState: TaskState;
  readonly attemptStatus: AttemptStatus;
  readonly artifactRevision: string;
}

export interface ObservedExecutorState {
  readonly taskId: string;
  readonly attemptId: string;
  readonly status: RecoveryObservedStatus;
  readonly artifactRevision: string;
  readonly outcome?: string;
  readonly resultRef?: string;
}

export interface RecoveryInput {
  readonly persisted: readonly PersistedAttempt[];
  readonly observed: readonly ObservedExecutorState[];
}

export interface RecoveryOptions {
  /** S3 owns the final attempt budget. This choice only records the plan. */
  readonly onMissing?: 'mark-lost' | 'retry-scheduler';
}

export interface RecoveryAction {
  readonly action: RecoveryActionName;
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly reason: string;
  readonly observedStatus?: RecoveryObservedStatus;
  readonly outcome?: string;
  readonly resultRef?: string;
}

export interface RecoveryPlan {
  readonly actions: readonly RecoveryAction[];
}

const INPUT_FIELDS = ['persisted', 'observed'] as const;
const OPTIONS_FIELDS = ['onMissing'] as const;
const PERSISTED_FIELDS = ['taskId', 'attemptId', 'taskState', 'attemptStatus', 'artifactRevision'] as const;
const OBSERVED_FIELDS = ['taskId', 'attemptId', 'status', 'artifactRevision', 'outcome', 'resultRef'] as const;
const ACTION_FIELDS = ['action', 'taskId', 'attemptId', 'artifactRevision', 'reason', 'observedStatus', 'outcome', 'resultRef'] as const;

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && allowed.includes(key)) continue;
    result.push(typeof key === 'symbol' ? key.toString() : key);
  }
  return result;
}

function fail(code: RecoveryErrorCode, path: string, message: string, available: readonly string[] = []): never {
  throw new RecoveryError({ code, path, message: truncateForMessage(message), available });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail('INVALID_RECOVERY_INPUT', path, `${path} must be a plain object`);
  return value;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (!hasExactFields(value, allowed)) fail('INVALID_RECOVERY_INPUT', path, `${path} has unknown field(s): ${truncateForMessage(unknownFields(value, allowed).join(', '))}`, allowed);
}

function stringValue(value: unknown, path: string, maximum: number): string {
  if (asNonEmptyString(value) === undefined) fail('INVALID_RECOVERY_INPUT', path, `${path} must be a non-empty string`);
  const result = value as string;
  if (result.length > maximum) fail('INVALID_RECOVERY_INPUT', path, `${path} must be at most ${maximum} UTF-16 code units`);
  return result;
}

function enumValue<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail('INVALID_RECOVERY_INPUT', path, `${path} is unknown`, values);
  return value as T;
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) fail('INVALID_RECOVERY_INPUT', path, `${path} must be an array`);
  if (value.length > maximum) fail('INVALID_RECOVERY_INPUT', path, `${path} contains too many entries`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && isArrayIndexKey(key)) continue;
    fail('INVALID_RECOVERY_INPUT', path, `${path} has unknown array property ${truncateForMessage(typeof key === 'symbol' ? key.toString() : key)}`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail('INVALID_RECOVERY_INPUT', `${path}[${index}]`, `${path}[${index}] must be present; sparse arrays are not accepted`);
    result.push(value[index]);
  }
  return result;
}

function isArrayIndexKey(key: string): boolean {
  if (key === '') return false;
  const number = Number(key);
  return Number.isInteger(number) && number >= 0 && number < 2 ** 32 - 1 && String(number) === key;
}

function normalizePersisted(value: unknown, path: string): PersistedAttempt {
  const raw = object(value, path);
  exact(raw, PERSISTED_FIELDS, path);
  const taskState = enumValue(ownValue(raw, 'taskState'), `${path}.taskState`, TASK_STATES);
  const attemptStatus = enumValue(ownValue(raw, 'attemptStatus'), `${path}.attemptStatus`, ['RUNNING', 'SETTLED', 'PASSED', 'REJECTED', 'BLOCKED', 'CANCELLED', 'FAILED'] as const);
  if (attemptStatus === 'RUNNING' && taskState !== 'RUNNING') fail('INVALID_BINDING', `${path}.attemptStatus`, 'a RUNNING attempt must belong to a RUNNING task');
  return deepFreeze({
    taskId: stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, MAX_TASK_ID_LENGTH),
    attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, MAX_EVENT_ID_LENGTH),
    taskState,
    attemptStatus,
    artifactRevision: stringValue(ownValue(raw, 'artifactRevision'), `${path}.artifactRevision`, MAX_REFERENCE_LENGTH),
  });
}

function normalizeObserved(value: unknown, path: string): ObservedExecutorState {
  const raw = object(value, path);
  exact(raw, OBSERVED_FIELDS, path);
  const status = enumValue(ownValue(raw, 'status'), `${path}.status`, RECOVERY_OBSERVED_STATUSES);
  const outcomeValue = ownValue(raw, 'outcome');
  const resultRefValue = ownValue(raw, 'resultRef');
  const outcome = outcomeValue === undefined ? undefined : stringValue(outcomeValue, `${path}.outcome`, MAX_SUMMARY_LENGTH);
  const resultRef = resultRefValue === undefined ? undefined : stringValue(resultRefValue, `${path}.resultRef`, MAX_REFERENCE_LENGTH);
  if (status === 'terminal' && outcome === undefined && resultRef === undefined) fail('INVALID_BINDING', path, 'terminal executor state must preserve an outcome or resultRef');
  return deepFreeze({
    taskId: stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, MAX_TASK_ID_LENGTH),
    attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, MAX_EVENT_ID_LENGTH),
    status,
    artifactRevision: stringValue(ownValue(raw, 'artifactRevision'), `${path}.artifactRevision`, MAX_REFERENCE_LENGTH),
    ...(outcome === undefined ? {} : { outcome }),
    ...(resultRef === undefined ? {} : { resultRef }),
  });
}

function normalizeInput(input: unknown): { readonly persisted: readonly PersistedAttempt[]; readonly observed: readonly ObservedExecutorState[] } {
  const root = object(input, 'recovery');
  exact(root, INPUT_FIELDS, 'recovery');
  const persistedRaw = array(ownValue(root, 'persisted'), 'recovery.persisted', 4096);
  const observedRaw = array(ownValue(root, 'observed'), 'recovery.observed', 4096);
  const persisted: PersistedAttempt[] = [];
  const observed: ObservedExecutorState[] = [];
  const persistedKeys = new Set<string>();
  const observedKeys = new Set<string>();
  for (let index = 0; index < persistedRaw.length; index++) {
    const entry = normalizePersisted(persistedRaw[index], `recovery.persisted[${index}]`);
    const key = `${entry.taskId}\u0000${entry.attemptId}`;
    if (persistedKeys.has(key)) fail('DUPLICATE_ATTEMPT', `recovery.persisted[${index}]`, 'persisted attempts must be unique');
    persistedKeys.add(key);
    persisted.push(entry);
  }
  for (let index = 0; index < observedRaw.length; index++) {
    const entry = normalizeObserved(observedRaw[index], `recovery.observed[${index}]`);
    const key = `${entry.taskId}\u0000${entry.attemptId}`;
    if (observedKeys.has(key)) fail('DUPLICATE_ATTEMPT', `recovery.observed[${index}]`, 'observed attempts must be unique');
    observedKeys.add(key);
    observed.push(entry);
  }
  return { persisted, observed };
}

function normalizeOptions(input: unknown): { readonly onMissing: 'mark-lost' | 'retry-scheduler' } {
  if (input === undefined) return { onMissing: 'mark-lost' };
  const raw = object(input, 'options');
  exact(raw, OPTIONS_FIELDS, 'options');
  return { onMissing: enumValue(ownValue(raw, 'onMissing') ?? 'mark-lost', 'options.onMissing', ['mark-lost', 'retry-scheduler'] as const) };
}

function key(taskId: string, attemptId: string): string {
  return `${taskId}\u0000${attemptId}`;
}

function compare(left: { readonly taskId: string; readonly attemptId: string }, right: { readonly taskId: string; readonly attemptId: string }): number {
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0;
}

function action(
  actionName: RecoveryActionName,
  persisted: PersistedAttempt,
  reason: string,
  observed?: ObservedExecutorState,
): RecoveryAction {
  if (observed !== undefined && observed.artifactRevision !== persisted.artifactRevision) fail('REVISION_MISMATCH', 'recovery.observed.artifactRevision', 'executor observation does not match the persisted artifact revision', [persisted.artifactRevision]);
  return deepFreeze({
    action: actionName,
    taskId: persisted.taskId,
    attemptId: persisted.attemptId,
    artifactRevision: persisted.artifactRevision,
    reason,
    ...(observed === undefined ? {} : { observedStatus: observed.status, ...(observed.outcome === undefined ? {} : { outcome: observed.outcome }), ...(observed.resultRef === undefined ? {} : { resultRef: observed.resultRef }) }),
  });
}

function orphanAction(observed: ObservedExecutorState): RecoveryAction {
  return deepFreeze({
    action: 'cancel-orphan',
    taskId: observed.taskId,
    attemptId: observed.attemptId,
    artifactRevision: observed.artifactRevision,
    reason: 'executor attempt has no matching persisted attempt; cancel without restarting',
    observedStatus: observed.status,
    ...(observed.outcome === undefined ? {} : { outcome: observed.outcome }),
    ...(observed.resultRef === undefined ? {} : { resultRef: observed.resultRef }),
  });
}

function buildPlan(input: RecoveryInput, options: RecoveryOptions['onMissing']): RecoveryPlan {
  const persisted = [...input.persisted].sort(compare);
  const observed = [...input.observed].sort(compare);
  const byObserved = new Map(observed.map((entry) => [key(entry.taskId, entry.attemptId), entry]));
  const persistedByTask = new Map<string, PersistedAttempt[]>();
  for (const entry of persisted) persistedByTask.set(entry.taskId, [...(persistedByTask.get(entry.taskId) ?? []), entry]);
  const consumed = new Set<string>();
  const actions: RecoveryAction[] = [];
  for (let index = 0; index < persisted.length; index++) {
    const record = persisted[index]!;
    const recordKey = key(record.taskId, record.attemptId);
    const current = byObserved.get(recordKey);
    if (current !== undefined) {
      consumed.add(recordKey);
      if (current.artifactRevision !== record.artifactRevision) fail('REVISION_MISMATCH', 'recovery.observed.artifactRevision', 'executor observation does not match the persisted artifact revision', [record.artifactRevision]);
    } else {
      const sameTask = observed.find((entry) => entry.taskId === record.taskId);
      if (sameTask !== undefined && sameTask.artifactRevision !== record.artifactRevision) fail('REVISION_MISMATCH', 'recovery.observed.artifactRevision', 'executor observation does not match the persisted task artifact revision', [record.artifactRevision]);
    }
    if (record.attemptStatus === 'RUNNING') {
      if (current === undefined || current.status === 'missing') actions.push(action(options === 'retry-scheduler' ? 'retry-scheduler' : 'mark-lost', record, current === undefined ? 'persisted start/attempt was not observed; mark lost and let S3 budget policy decide' : 'executor reports the persisted attempt missing; do not restart blindly', current));
      else if (current.status === 'running') actions.push(action('reattach', record, 'persisted RUNNING attempt is still observed running', current));
      else if (current.status === 'terminal') actions.push(action('settle', record, 'executor is terminal; settle the persisted attempt with its observed result', current));
      else actions.push(action('cancel-orphan', record, 'executor observation is not a valid continuation of the persisted attempt', current));
    } else if (current?.status === 'running') {
      actions.push(action('cancel-stale', record, 'persisted attempt is terminal but executor is still running', current));
    }
  }
  for (let index = 0; index < observed.length; index++) {
    const entry = observed[index]!;
    if (!consumed.has(key(entry.taskId, entry.attemptId))) {
      const sameTask = persistedByTask.get(entry.taskId);
      if (sameTask !== undefined && sameTask.some((record) => record.artifactRevision !== entry.artifactRevision)) fail('REVISION_MISMATCH', 'recovery.observed.artifactRevision', 'orphan observation does not match the persisted task artifact revision', sameTask.map((record) => record.artifactRevision));
      actions.push(orphanAction(entry));
    }
  }
  actions.sort((left, right) => compare(left, right) || left.action.localeCompare(right.action));
  return deepFreeze({ actions });
}

/** Plan the minimum crash matrix with stable task/attempt ordering. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || 'operation threw an Error';
  if (typeof error === 'string') return error;
  return 'operation threw a non-Error value';
}

function boundary<T>(path: string, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError({ code: 'BOUNDARY_ERROR', message: truncateForMessage(errorMessage(error)), path, available: [] });
  }
}

export function planRecovery(input: unknown, optionsInput: unknown = undefined): RecoveryPlan {
  return boundary('planRecovery', () => {
    const normalized = normalizeInput(input);
    const options = normalizeOptions(optionsInput);
    return buildPlan(normalized, options.onMissing);
  });
}

/** Named alias used by callers that describe this operation as reconciliation. */
export function reconcileRecovery(input: unknown, optionsInput: unknown = undefined): RecoveryPlan {
  return boundary('reconcileRecovery', () => planRecovery(input, optionsInput));
}

/** Validate a returned action before it is appended as an audit event. */
export function validateRecoveryAction(input: unknown): RecoveryAction {
  return boundary('validateRecoveryAction', () => {
  const raw = object(input, 'action');
  exact(raw, ACTION_FIELDS, 'action');
  const observedStatusValue = ownValue(raw, 'observedStatus');
  const outcomeValue = ownValue(raw, 'outcome');
  const resultRefValue = ownValue(raw, 'resultRef');
  const observedStatus = observedStatusValue === undefined ? undefined : enumValue(observedStatusValue, 'action.observedStatus', RECOVERY_OBSERVED_STATUSES);
  const outcome = outcomeValue === undefined ? undefined : stringValue(outcomeValue, 'action.outcome', MAX_SUMMARY_LENGTH);
  const resultRef = resultRefValue === undefined ? undefined : stringValue(resultRefValue, 'action.resultRef', MAX_REFERENCE_LENGTH);
  return deepFreeze({
    action: enumValue(ownValue(raw, 'action'), 'action.action', RECOVERY_ACTIONS),
    taskId: stringValue(ownValue(raw, 'taskId'), 'action.taskId', MAX_TASK_ID_LENGTH),
    attemptId: stringValue(ownValue(raw, 'attemptId'), 'action.attemptId', MAX_EVENT_ID_LENGTH),
    artifactRevision: stringValue(ownValue(raw, 'artifactRevision'), 'action.artifactRevision', MAX_REFERENCE_LENGTH),
    reason: stringValue(ownValue(raw, 'reason'), 'action.reason', MAX_SUMMARY_LENGTH),
    ...(observedStatus === undefined ? {} : { observedStatus }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(resultRef === undefined ? {} : { resultRef }),
  });
  });
}

/** Convert a recovery action to the controlled durable payload shape. */
export function recoveryActionPayload(input: unknown): {
  readonly action: RecoveryActionName;
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly reason: string;
  readonly observedStatus?: RecoveryObservedStatus;
  readonly outcome?: string;
  readonly resultRef?: string;
} {
  return boundary('recoveryActionPayload', () => {
    const actionValue = validateRecoveryAction(input);
    return deepFreeze({
      action: actionValue.action,
      taskId: actionValue.taskId,
      attemptId: actionValue.attemptId,
      artifactRevision: actionValue.artifactRevision,
      reason: actionValue.reason,
      ...(actionValue.observedStatus === undefined ? {} : { observedStatus: actionValue.observedStatus }),
      ...(actionValue.outcome === undefined ? {} : { outcome: actionValue.outcome }),
      ...(actionValue.resultRef === undefined ? {} : { resultRef: actionValue.resultRef }),
    });
  });
}

