/**
 * S7 durable state pure core.
 *
 * The log is the only authority.  Snapshots contain a checked projection and
 * an integrity marker only to accelerate recovery; they never replace the
 * append-only log.  This module defines synchronous ports and an in-memory
 * fake.  It does not open files, databases, processes, or network connections.
 */

import { MAX_TASK_ID_LENGTH, validateTaskContract, type TaskContract } from './task-contract.ts';
import { checkStateTransition, TASK_STATES, type AttemptStatus, type TaskState } from './task-state.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export const DURABLE_SCHEMA_VERSION = 1 as const;
export const MAX_RUN_ID_LENGTH = 128;
export const MAX_DURABLE_TASK_ID_LENGTH = MAX_TASK_ID_LENGTH;
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_REFERENCE_LENGTH = 256;
export const MAX_SUMMARY_LENGTH = 160;
export const MAX_EVENT_REASONS = 16;
export const MAX_PROJECTION_TASKS = 4096;
export const MAX_PROJECTION_EVENTS = 100_000;

export const DURABLE_EVENT_KINDS = [
  'scheduler',
  'task',
  'evidence',
  'verdict',
  'integration',
  'recovery',
] as const;
export type DurableEventKind = (typeof DURABLE_EVENT_KINDS)[number];

export type DurableErrorCode =
  | 'INVALID_EVENT'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_PROJECTION'
  | 'UNKNOWN_SCHEMA_VERSION'
  | 'SEQUENCE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SNAPSHOT_CONFLICT'
  | 'RUN_ID_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'SEQUENCE_ORDER'
  | 'EVENT_CONFLICT'
  | 'STORE_ERROR';

export interface DurableErrorData {
  readonly code: DurableErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
}

export class DurableStateError extends Error implements DurableErrorData {
  readonly code: DurableErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(data: DurableErrorData) {
    super(truncateForMessage(data.message));
    this.name = 'DurableStateError';
    this.code = data.code;
    this.path = data.path;
    this.available = Object.freeze([...data.available]);
  }
}

export interface DurableReference {
  readonly reference: string;
  readonly kind: 'evidence' | 'integration' | 'diagnostic';
}

export interface SchedulerDurablePayload {
  readonly eventType: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly at?: number;
  readonly outcome?: string;
  readonly verdict?: 'passed' | 'rejected';
  readonly reason?: string;
  readonly summary?: string;
  readonly reference?: DurableReference;
}

export type TaskLifecycleChange =
  | 'created'
  | 'state_changed'
  | 'dependency_added'
  | 'subtask_added';

export interface TaskLifecyclePayload {
  readonly change: TaskLifecycleChange;
  readonly taskId: string;
  readonly state?: TaskState;
  readonly from?: TaskState;
  readonly to?: TaskState;
  readonly contract?: TaskContract;
  readonly attempts?: readonly DurableAttempt[];
  readonly blocker?: string;
  readonly reason?: string;
  readonly dependencyFrom?: string;
  readonly dependencyTo?: string;
  readonly parentTaskId?: string;
}

export interface EvidenceDurablePayload {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly evidenceRef: string;
  readonly summary: string;
}

export interface VerdictDurablePayload {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly verdict: 'passed' | 'rejected';
  readonly reasons: readonly string[];
  readonly reviewRef?: string;
}

export interface IntegrationDurablePayload {
  readonly outcome: 'merged' | 'conflict' | 'verification_failed' | 'runner_error';
  readonly artifactRevision?: string;
  readonly reportRef: string;
  readonly summary: string;
}

export interface RecoveryDurablePayload {
  readonly action: RecoveryActionName;
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly reason: string;
  readonly observedStatus?: ObservedExecutorStatus;
  readonly outcome?: string;
  readonly resultRef?: string;
  readonly reference?: DurableReference;
}

export type DurablePayload =
  | SchedulerDurablePayload
  | TaskLifecyclePayload
  | EvidenceDurablePayload
  | VerdictDurablePayload
  | IntegrationDurablePayload
  | RecoveryDurablePayload;

export interface DurableEvent {
  readonly schemaVersion: typeof DURABLE_SCHEMA_VERSION;
  readonly runId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: number;
  readonly kind: DurableEventKind;
  readonly payload: DurablePayload;
}

/** A draft is made with injected clock/id sources; the store assigns sequence. */
export type DurableEventDraft = Omit<DurableEvent, 'sequence'>;
export type DurableEventInput = DurableEvent | DurableEventDraft;

export interface DurableEventFactoryDependencies {
  readonly clock: () => number;
  readonly idSource: () => string;
}

export interface DurableAttempt {
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly outcome?: string;
  readonly artifactRevision?: string;
}

export interface DurableTaskProjection {
  readonly id: string;
  readonly contract: TaskContract;
  readonly state: TaskState;
  readonly attempts: readonly DurableAttempt[];
  readonly blocker?: string;
  readonly reason?: string;
}

export interface DurableDependencyProjection {
  readonly from: string;
  readonly to: string;
}

export interface DurableSubtaskProjection {
  readonly parent: string;
  readonly child: string;
}

export interface DurableEvidenceProjection {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly evidenceRef: string;
  readonly summary: string;
}

export interface DurableVerdictProjection {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly verdict: 'passed' | 'rejected';
  readonly reasons: readonly string[];
  readonly reviewRef?: string;
}

export interface DurableIntegrationProjection {
  readonly outcome: IntegrationDurablePayload['outcome'];
  readonly artifactRevision?: string;
  readonly reportRef: string;
  readonly summary: string;
}

interface EventIndexEntry {
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly fingerprint: string;
}

export interface DurableProjectionState {
  readonly tasks: readonly DurableTaskProjection[];
  readonly dependencies: readonly DurableDependencyProjection[];
  readonly subtasks: readonly DurableSubtaskProjection[];
  readonly evidence: readonly DurableEvidenceProjection[];
  readonly verdicts: readonly DurableVerdictProjection[];
  readonly integrations: readonly DurableIntegrationProjection[];
  /** Audit metadata makes snapshot+tail idempotency equivalent to full replay. */
  readonly eventIndex: readonly EventIndexEntry[];
}

export interface DurableProjection {
  readonly runId: string;
  readonly lastSequence: number;
  readonly state: DurableProjectionState;
}

export interface DurableSnapshot {
  readonly schemaVersion: typeof DURABLE_SCHEMA_VERSION;
  readonly runId: string;
  readonly lastSequence: number;
  readonly state: DurableProjectionState;
  readonly integrity: string;
}

export interface RecoveryResult {
  readonly projection: DurableProjection;
  readonly ignoredDuplicateEventIds: readonly string[];
}

export interface EventStoreAppendSuccess {
  readonly ok: true;
  readonly appended: readonly DurableEvent[];
  readonly lastSequence: number;
}

export interface EventStoreAppendFailure {
  readonly ok: false;
  readonly error: DurableErrorData;
}

export type EventStoreAppendResult = EventStoreAppendSuccess | EventStoreAppendFailure;

export interface EventStorePort {
  /** Atomic all-or-nothing CAS append. The log remains append-only. */
  append(runId: string, expectedSequence: number, events: readonly DurableEventInput[]): EventStoreAppendResult;
  read(runId: string, afterSequence?: number): readonly DurableEvent[];
  currentSequence(runId: string): number;
}

export interface SnapshotStorePort {
  loadSnapshot(runId: string): DurableSnapshot | undefined;
  /** expectedSchemaVersion is optional for source compatibility, but checked when supplied. */
  saveSnapshot(
    runId: string,
    expectedSequence: number,
    snapshot: DurableSnapshot,
    expectedSchemaVersion?: number,
  ): EventStoreAppendResult;
}

export interface DurableStore extends EventStorePort, SnapshotStorePort {}

const EVENT_FIELDS = ['schemaVersion', 'runId', 'sequence', 'eventId', 'idempotencyKey', 'occurredAt', 'kind', 'payload'] as const;
const DRAFT_FIELDS = ['schemaVersion', 'runId', 'eventId', 'idempotencyKey', 'occurredAt', 'kind', 'payload'] as const;
const FACTORY_FIELDS = ['runId', 'eventId', 'idempotencyKey', 'occurredAt', 'kind', 'payload'] as const;
const REFERENCE_FIELDS = ['reference', 'kind'] as const;
const SCHEDULER_FIELDS = ['eventType', 'taskId', 'attemptId', 'at', 'outcome', 'verdict', 'reason', 'summary', 'reference'] as const;
const TASK_FIELDS = ['change', 'taskId', 'state', 'from', 'to', 'contract', 'attempts', 'blocker', 'reason', 'dependencyFrom', 'dependencyTo', 'parentTaskId'] as const;
const ATTEMPT_FIELDS = ['attemptId', 'status', 'outcome', 'artifactRevision'] as const;
const EVIDENCE_FIELDS = ['taskId', 'attemptId', 'artifactRevision', 'evidenceRef', 'summary'] as const;
const VERDICT_FIELDS = ['taskId', 'attemptId', 'artifactRevision', 'verdict', 'reasons', 'reviewRef'] as const;
const INTEGRATION_FIELDS = ['outcome', 'artifactRevision', 'reportRef', 'summary'] as const;
const RECOVERY_FIELDS = ['action', 'taskId', 'attemptId', 'artifactRevision', 'reason', 'observedStatus', 'outcome', 'resultRef', 'reference'] as const;
const STATE_FIELDS = ['tasks', 'dependencies', 'subtasks', 'evidence', 'verdicts', 'integrations', 'eventIndex'] as const;
const SNAPSHOT_FIELDS = ['schemaVersion', 'runId', 'lastSequence', 'state', 'integrity'] as const;
const PROJECTION_FIELDS = ['runId', 'lastSequence', 'state'] as const;
const DEPENDENCY_FIELDS = ['from', 'to'] as const;
const SUBTASK_FIELDS = ['parent', 'child'] as const;
const EVIDENCE_PROJECTION_FIELDS = ['taskId', 'attemptId', 'artifactRevision', 'evidenceRef', 'summary'] as const;
const VERDICT_PROJECTION_FIELDS = ['taskId', 'attemptId', 'artifactRevision', 'verdict', 'reasons', 'reviewRef'] as const;
const INTEGRATION_PROJECTION_FIELDS = ['outcome', 'artifactRevision', 'reportRef', 'summary'] as const;
const EVENT_INDEX_FIELDS = ['eventId', 'idempotencyKey', 'sequence', 'fingerprint'] as const;
const TASK_PROJECTION_FIELDS = ['id', 'contract', 'state', 'attempts', 'blocker', 'reason'] as const;
const INTEGRITY_LENGTH = 16;
const ATTEMPT_STATUSES = ['RUNNING', 'SETTLED', 'PASSED', 'REJECTED', 'BLOCKED', 'CANCELLED', 'FAILED'] as const;
const OBSERVED_STATUSES = ['running', 'terminal', 'missing', 'orphan'] as const;

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && allowed.includes(key)) continue;
    result.push(typeof key === 'symbol' ? key.toString() : key);
  }
  return result;
}

function fail(
  code: DurableErrorCode,
  path: string,
  message: string,
  available: readonly string[] = [],
): never {
  throw new DurableStateError({ code, path, message: truncateForMessage(message), available });
}

function object(value: unknown, path: string, code: DurableErrorCode = 'INVALID_EVENT'): Record<string, unknown> {
  if (!isPlainObject(value)) fail(code, path, `${path} must be a plain object`);
  return value;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], path: string, code: DurableErrorCode): void {
  if (!hasExactFields(value, allowed)) {
    fail(code, path, `${path} has unknown field(s): ${truncateForMessage(unknownFields(value, allowed).join(', '))}`, allowed);
  }
}

function stringValue(value: unknown, path: string, code: DurableErrorCode, maximum: number): string {
  if (asNonEmptyString(value) === undefined) fail(code, path, `${path} must be a non-empty string`);
  const result = value as string;
  if (result.length > maximum) fail(code, path, `${path} must be at most ${maximum} UTF-16 code units`);
  return result;
}

function positiveInteger(value: unknown, path: string, code: DurableErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code, path, `${path} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string, code: DurableErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code, path, `${path} must be a non-negative safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string, code: DurableErrorCode): number {
  return nonNegativeInteger(value, path, code);
}

function optionalString(value: Record<string, unknown>, field: string, path: string, code: DurableErrorCode, maximum: number): string | undefined {
  const raw = ownValue(value, field);
  return raw === undefined ? undefined : stringValue(raw, `${path}.${field}`, code, maximum);
}

function array(value: unknown, path: string, code: DurableErrorCode, maximum = MAX_PROJECTION_EVENTS): readonly unknown[] {
  if (!Array.isArray(value)) fail(code, path, `${path} must be an array`);
  if (value.length > maximum) fail(code, path, `${path} must contain at most ${maximum} item(s)`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && isArrayIndexKey(key)) continue;
    fail(code, path, `${path} has unknown array property ${truncateForMessage(typeof key === 'symbol' ? key.toString() : key)}`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(code, `${path}[${index}]`, `${path}[${index}] must be present; sparse arrays are not accepted`);
    result.push(value[index]);
  }
  return result;
}

function isArrayIndexKey(key: string): boolean {
  if (key === '') return false;
  const number = Number(key);
  return Number.isInteger(number) && number >= 0 && number < 2 ** 32 - 1 && String(number) === key;
}

function enumValue<T extends string>(value: unknown, path: string, values: readonly T[], code: DurableErrorCode): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(code, path, `${path} is unknown`, values);
  return value as T;
}

function reference(value: unknown, path: string, code: DurableErrorCode): DurableReference {
  const raw = object(value, path, code);
  exact(raw, REFERENCE_FIELDS, path, code);
  return deepFreeze({
    reference: stringValue(ownValue(raw, 'reference'), `${path}.reference`, code, MAX_REFERENCE_LENGTH),
    kind: enumValue(ownValue(raw, 'kind'), `${path}.kind`, ['evidence', 'integration', 'diagnostic'], code),
  });
}

function reasons(value: unknown, path: string, code: DurableErrorCode): readonly string[] {
  const raw = array(value, path, code, MAX_EVENT_REASONS);
  const result: string[] = [];
  for (let index = 0; index < raw.length; index++) result.push(stringValue(raw[index], `${path}[${index}]`, code, MAX_SUMMARY_LENGTH));
  return result;
}

function attempt(value: unknown, path: string, code: DurableErrorCode): DurableAttempt {
  const raw = object(value, path, code);
  exact(raw, ATTEMPT_FIELDS, path, code);
  const outcome = optionalString(raw, 'outcome', path, code, MAX_SUMMARY_LENGTH);
  const artifactRevision = optionalString(raw, 'artifactRevision', path, code, MAX_REFERENCE_LENGTH);
  return deepFreeze({
    attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, code, MAX_EVENT_ID_LENGTH),
    status: enumValue(ownValue(raw, 'status'), `${path}.status`, ATTEMPT_STATUSES, code),
    ...(outcome === undefined ? {} : { outcome }),
    ...(artifactRevision === undefined ? {} : { artifactRevision }),
  });
}

function normalizeTaskContract(value: unknown, path: string): TaskContract {
  if (isPlainObject(value)) {
    const raw = value;
    for (const field of ['depends_on', 'context', 'files_in_scope', 'acceptance_criteria', 'verification'] as const) {
      const candidate = ownValue(raw, field);
      if (Array.isArray(candidate)) array(candidate, `${path}.${field}`, 'INVALID_EVENT', MAX_PROJECTION_EVENTS);
    }
  }
  const result = validateTaskContract(value);
  if (!result.ok) fail('INVALID_EVENT', path, result.error.message, []);
  return result.contract;
}

function normalizePayload(kind: DurableEventKind, value: unknown): DurablePayload {
  const path = `payload.${kind}`;
  const raw = object(value, path, 'INVALID_EVENT');
  if (kind === 'scheduler') {
    exact(raw, SCHEDULER_FIELDS, path, 'INVALID_EVENT');
    const taskId = optionalString(raw, 'taskId', path, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH);
    const attemptId = optionalString(raw, 'attemptId', path, 'INVALID_EVENT', MAX_EVENT_ID_LENGTH);
    const reason = optionalString(raw, 'reason', path, 'INVALID_EVENT', MAX_SUMMARY_LENGTH);
    const outcome = optionalString(raw, 'outcome', path, 'INVALID_EVENT', MAX_SUMMARY_LENGTH);
    const summary = optionalString(raw, 'summary', path, 'INVALID_EVENT', MAX_SUMMARY_LENGTH);
    const rawAt = ownValue(raw, 'at');
    const at = rawAt === undefined ? undefined : nonNegativeSafeInteger(rawAt, `${path}.at`, 'INVALID_EVENT');
    const verdictValue = ownValue(raw, 'verdict');
    const verdict = verdictValue === undefined ? undefined : enumValue(verdictValue, `${path}.verdict`, ['passed', 'rejected'], 'INVALID_EVENT');
    const rawReference = ownValue(raw, 'reference');
    return deepFreeze({
      eventType: stringValue(ownValue(raw, 'eventType'), `${path}.eventType`, 'INVALID_EVENT', MAX_REFERENCE_LENGTH),
      ...(taskId === undefined ? {} : { taskId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(at === undefined ? {} : { at }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(verdict === undefined ? {} : { verdict }),
      ...(reason === undefined ? {} : { reason }),
      ...(summary === undefined ? {} : { summary }),
      ...(rawReference === undefined ? {} : { reference: reference(rawReference, `${path}.reference`, 'INVALID_EVENT') }),
    });
  }
  if (kind === 'task') {
    exact(raw, TASK_FIELDS, path, 'INVALID_EVENT');
    const change = enumValue(ownValue(raw, 'change'), `${path}.change`, ['created', 'state_changed', 'dependency_added', 'subtask_added'], 'INVALID_EVENT');
    const taskId = stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH);
    const stateValue = ownValue(raw, 'state');
    const state = stateValue === undefined ? undefined : enumValue(stateValue, `${path}.state`, TASK_STATES, 'INVALID_EVENT');
    const fromValue = ownValue(raw, 'from');
    const from = fromValue === undefined ? undefined : enumValue(fromValue, `${path}.from`, TASK_STATES, 'INVALID_EVENT');
    const toValue = ownValue(raw, 'to');
    const to = toValue === undefined ? undefined : enumValue(toValue, `${path}.to`, TASK_STATES, 'INVALID_EVENT');
    const contract = ownValue(raw, 'contract') === undefined ? undefined : normalizeTaskContract(ownValue(raw, 'contract'), `${path}.contract`);
    const rawAttempts = ownValue(raw, 'attempts');
    let attempts: readonly DurableAttempt[] | undefined;
    if (rawAttempts !== undefined) {
      const entries = array(rawAttempts, `${path}.attempts`, 'INVALID_EVENT', 256);
      const normalized: DurableAttempt[] = [];
      for (let index = 0; index < entries.length; index++) normalized.push(attempt(entries[index], `${path}.attempts[${index}]`, 'INVALID_EVENT'));
      attempts = normalized;
    }
    const blocker = optionalString(raw, 'blocker', path, 'INVALID_EVENT', MAX_SUMMARY_LENGTH);
    const reason = optionalString(raw, 'reason', path, 'INVALID_EVENT', MAX_SUMMARY_LENGTH);
    const dependencyFrom = optionalString(raw, 'dependencyFrom', path, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH);
    const dependencyTo = optionalString(raw, 'dependencyTo', path, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH);
    const parentTaskId = optionalString(raw, 'parentTaskId', path, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH);
    if (change === 'created' && contract === undefined) fail('INVALID_EVENT', `${path}.contract`, 'created task events require a contract');
    if (change === 'state_changed' && (state !== undefined || from === undefined || to === undefined)) fail('INVALID_EVENT', path, 'state_changed requires strict from and to fields and does not accept state');
    if (change === 'dependency_added' && (dependencyFrom === undefined || dependencyTo === undefined)) fail('INVALID_EVENT', path, 'dependency_added requires dependencyFrom and dependencyTo');
    if (change === 'subtask_added' && parentTaskId === undefined) fail('INVALID_EVENT', `${path}.parentTaskId`, 'subtask_added requires parentTaskId');
    return deepFreeze({
      change,
      taskId,
      ...(state === undefined ? {} : { state }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(contract === undefined ? {} : { contract }),
      ...(attempts === undefined ? {} : { attempts }),
      ...(blocker === undefined ? {} : { blocker }),
      ...(reason === undefined ? {} : { reason }),
      ...(dependencyFrom === undefined ? {} : { dependencyFrom }),
      ...(dependencyTo === undefined ? {} : { dependencyTo }),
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
    });
  }
  if (kind === 'evidence') {
    exact(raw, EVIDENCE_FIELDS, path, 'INVALID_EVENT');
    return deepFreeze({
      taskId: stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH),
      attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, 'INVALID_EVENT', MAX_EVENT_ID_LENGTH),
      artifactRevision: stringValue(ownValue(raw, 'artifactRevision'), `${path}.artifactRevision`, 'INVALID_EVENT', MAX_REFERENCE_LENGTH),
      evidenceRef: stringValue(ownValue(raw, 'evidenceRef'), `${path}.evidenceRef`, 'INVALID_EVENT', MAX_REFERENCE_LENGTH),
      summary: stringValue(ownValue(raw, 'summary'), `${path}.summary`, 'INVALID_EVENT', MAX_SUMMARY_LENGTH),
    });
  }
  if (kind === 'verdict') {
    exact(raw, VERDICT_FIELDS, path, 'INVALID_EVENT');
    const reviewRef = optionalString(raw, 'reviewRef', path, 'INVALID_EVENT', MAX_REFERENCE_LENGTH);
    return deepFreeze({
      taskId: stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH),
      attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, 'INVALID_EVENT', MAX_EVENT_ID_LENGTH),
      artifactRevision: stringValue(ownValue(raw, 'artifactRevision'), `${path}.artifactRevision`, 'INVALID_EVENT', MAX_REFERENCE_LENGTH),
      verdict: enumValue(ownValue(raw, 'verdict'), `${path}.verdict`, ['passed', 'rejected'], 'INVALID_EVENT'),
      reasons: reasons(ownValue(raw, 'reasons'), `${path}.reasons`, 'INVALID_EVENT'),
      ...(reviewRef === undefined ? {} : { reviewRef }),
    });
  }
  if (kind === 'integration') {
    exact(raw, INTEGRATION_FIELDS, path, 'INVALID_EVENT');
    const artifactRevision = optionalString(raw, 'artifactRevision', path, 'INVALID_EVENT', MAX_REFERENCE_LENGTH);
    return deepFreeze({
      outcome: enumValue(ownValue(raw, 'outcome'), `${path}.outcome`, ['merged', 'conflict', 'verification_failed', 'runner_error'], 'INVALID_EVENT'),
      ...(artifactRevision === undefined ? {} : { artifactRevision }),
      reportRef: stringValue(ownValue(raw, 'reportRef'), `${path}.reportRef`, 'INVALID_EVENT', MAX_REFERENCE_LENGTH),
      summary: stringValue(ownValue(raw, 'summary'), `${path}.summary`, 'INVALID_EVENT', MAX_SUMMARY_LENGTH),
    });
  }
  exact(raw, RECOVERY_FIELDS, path, 'INVALID_EVENT');
  const observedStatusValue = ownValue(raw, 'observedStatus');
  const observedStatus = observedStatusValue === undefined ? undefined : enumValue(observedStatusValue, `${path}.observedStatus`, OBSERVED_STATUSES, 'INVALID_EVENT');
  const rawReference = ownValue(raw, 'reference');
  const outcome = optionalString(raw, 'outcome', path, 'INVALID_EVENT', MAX_SUMMARY_LENGTH);
  const resultRef = optionalString(raw, 'resultRef', path, 'INVALID_EVENT', MAX_REFERENCE_LENGTH);
  return deepFreeze({
    action: enumValue(ownValue(raw, 'action'), `${path}.action`, ['reattach', 'settle', 'mark-lost', 'retry-scheduler', 'cancel-orphan', 'cancel-stale', 'human'], 'INVALID_EVENT') as RecoveryActionName,
    taskId: stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, 'INVALID_EVENT', MAX_DURABLE_TASK_ID_LENGTH),
    attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, 'INVALID_EVENT', MAX_EVENT_ID_LENGTH),
    artifactRevision: stringValue(ownValue(raw, 'artifactRevision'), `${path}.artifactRevision`, 'INVALID_EVENT', MAX_REFERENCE_LENGTH),
    reason: stringValue(ownValue(raw, 'reason'), `${path}.reason`, 'INVALID_EVENT', MAX_SUMMARY_LENGTH),
    ...(observedStatus === undefined ? {} : { observedStatus }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(resultRef === undefined ? {} : { resultRef }),
    ...(rawReference === undefined ? {} : { reference: reference(rawReference, `${path}.reference`, 'INVALID_EVENT') }),
  });
}

function normalizeEvent(value: unknown, assignedSequence?: number): DurableEvent {
  const raw = object(value, 'event', 'INVALID_EVENT');
  const hasSequence = Object.hasOwn(raw, 'sequence');
  exact(raw, hasSequence ? EVENT_FIELDS : DRAFT_FIELDS, 'event', 'INVALID_EVENT');
  const rawSchema = ownValue(raw, 'schemaVersion');
  if (rawSchema !== DURABLE_SCHEMA_VERSION) {
    if (typeof rawSchema === 'number' && rawSchema > DURABLE_SCHEMA_VERSION) fail('UNKNOWN_SCHEMA_VERSION', 'event.schemaVersion', `unsupported future schemaVersion ${rawSchema}`, [String(DURABLE_SCHEMA_VERSION)]);
    fail('INVALID_EVENT', 'event.schemaVersion', `event.schemaVersion must be ${DURABLE_SCHEMA_VERSION}`, [String(DURABLE_SCHEMA_VERSION)]);
  }
  const sequence = hasSequence ? positiveInteger(ownValue(raw, 'sequence'), 'event.sequence', 'INVALID_EVENT') : positiveInteger(assignedSequence, 'event.sequence', 'INVALID_EVENT');
  const runId = stringValue(ownValue(raw, 'runId'), 'event.runId', 'INVALID_EVENT', MAX_RUN_ID_LENGTH);
  const eventId = stringValue(ownValue(raw, 'eventId'), 'event.eventId', 'INVALID_EVENT', MAX_EVENT_ID_LENGTH);
  const idempotencyKey = stringValue(ownValue(raw, 'idempotencyKey'), 'event.idempotencyKey', 'INVALID_EVENT', MAX_IDEMPOTENCY_KEY_LENGTH);
  const occurredAt = nonNegativeSafeInteger(ownValue(raw, 'occurredAt'), 'event.occurredAt', 'INVALID_EVENT');
  const kind = enumValue(ownValue(raw, 'kind'), 'event.kind', DURABLE_EVENT_KINDS, 'INVALID_EVENT');
  return deepFreeze({
    schemaVersion: DURABLE_SCHEMA_VERSION,
    runId,
    sequence,
    eventId,
    idempotencyKey,
    occurredAt,
    kind,
    payload: normalizePayload(kind, ownValue(raw, 'payload')),
  });
}

function eventIdentity(event: DurableEvent): Record<string, unknown> {
  return {
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    sequence: event.sequence,
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    kind: event.kind,
    payload: event.payload,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  let hash = 2166136261;
  const text = json(value);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(INTEGRITY_LENGTH, '0');
}

function eventFingerprint(event: DurableEvent): string {
  return fingerprint(eventIdentity(event));
}

function sameContent(left: DurableEvent, right: DurableEvent): boolean {
  return json(eventIdentity(left)) === json(eventIdentity(right));
}

function normalizeDraft(value: unknown, dependencies: DurableEventFactoryDependencies): DurableEventDraft {
  const raw = object(value, 'eventDraft', 'INVALID_EVENT');
  exact(raw, FACTORY_FIELDS, 'eventDraft', 'INVALID_EVENT');
  let eventId = optionalString(raw, 'eventId', 'eventDraft', 'INVALID_EVENT', MAX_EVENT_ID_LENGTH);
  if (eventId === undefined) {
    let generated: unknown;
    try { generated = dependencies.idSource(); } catch (error) { fail('INVALID_EVENT', 'idSource', `idSource threw: ${errorMessage(error)}`); }
    eventId = stringValue(generated, 'idSource.return', 'INVALID_EVENT', MAX_EVENT_ID_LENGTH);
  }
  let occurredAt = ownValue(raw, 'occurredAt');
  if (occurredAt === undefined) {
    try { occurredAt = dependencies.clock(); } catch (error) { fail('INVALID_EVENT', 'clock', `clock threw: ${errorMessage(error)}`); }
  }
  const draft = {
    schemaVersion: DURABLE_SCHEMA_VERSION,
    runId: ownValue(raw, 'runId'),
    sequence: 1,
    eventId,
    idempotencyKey: ownValue(raw, 'idempotencyKey'),
    occurredAt,
    kind: ownValue(raw, 'kind'),
    payload: ownValue(raw, 'payload'),
  };
  return normalizeEvent(draft);
}

/** Validates a draft and fills clock/id values only through injected dependencies. */
export function createDurableEvent(input: unknown, dependencies: DurableEventFactoryDependencies): DurableEventDraft {
  try {
    if (!isPlainObject(dependencies)) fail('INVALID_EVENT', 'dependencies', 'dependencies must be a plain object');
    exact(dependencies, ['clock', 'idSource'], 'dependencies', 'INVALID_EVENT');
    if (typeof ownValue(dependencies, 'clock') !== 'function') fail('INVALID_EVENT', 'dependencies.clock', 'dependencies.clock must be a function');
    if (typeof ownValue(dependencies, 'idSource') !== 'function') fail('INVALID_EVENT', 'dependencies.idSource', 'dependencies.idSource must be a function');
    const normalized = normalizeDraft(input, dependencies as unknown as DurableEventFactoryDependencies);
    return deepFreeze({
      schemaVersion: normalized.schemaVersion,
      runId: normalized.runId,
      eventId: normalized.eventId,
      idempotencyKey: normalized.idempotencyKey,
      occurredAt: normalized.occurredAt,
      kind: normalized.kind,
      payload: normalized.payload,
    });
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
    throw new DurableStateError({ code: 'INVALID_EVENT', message: truncateForMessage(errorMessage(error)), path: 'event', available: [] });
  }
}

interface MutableAttempt {
  attemptId: string;
  status: AttemptStatus;
  outcome?: string;
  artifactRevision?: string;
}

interface MutableTask {
  id: string;
  contract: TaskContract;
  state: TaskState;
  attempts: MutableAttempt[];
  blocker?: string;
  reason?: string;
}

interface MutableState {
  readonly tasks: MutableTask[];
  readonly taskById: Map<string, MutableTask>;
  readonly dependencies: DurableDependencyProjection[];
  readonly dependencyKeys: Set<string>;
  readonly subtasks: DurableSubtaskProjection[];
  readonly subtaskKeys: Set<string>;
  readonly evidence: DurableEvidenceProjection[];
  readonly evidenceByAttempt: Map<string, DurableEvidenceProjection>;
  readonly verdicts: DurableVerdictProjection[];
  readonly verdictByAttempt: Map<string, DurableVerdictProjection>;
  readonly integrations: DurableIntegrationProjection[];
  readonly eventIndex: EventIndexEntry[];
  readonly eventById: Map<string, EventIndexEntry>;
  readonly eventByKey: Map<string, EventIndexEntry>;
}

function emptyMutableState(): MutableState {
  return {
    tasks: [], taskById: new Map(), dependencies: [], dependencyKeys: new Set(), subtasks: [], subtaskKeys: new Set(),
    evidence: [], evidenceByAttempt: new Map(), verdicts: [], verdictByAttempt: new Map(), integrations: [],
    eventIndex: [], eventById: new Map(), eventByKey: new Map(),
  };
}

function emptyState(): DurableProjectionState {
  return stateFromMutable(emptyMutableState());
}

function attemptKey(taskId: string, attemptId: string): string { return `${taskId}\u0000${attemptId}`; }

function mutableFromState(state: DurableProjectionState): MutableState {
  const mutable = emptyMutableState();
  for (let index = 0; index < state.tasks.length; index++) {
    const source = state.tasks[index]!;
    const task: MutableTask = { ...source, attempts: source.attempts.map((entry) => ({ ...entry })) };
    mutable.tasks.push(task); mutable.taskById.set(task.id, task);
  }
  for (let index = 0; index < state.dependencies.length; index++) {
    const entry = { ...state.dependencies[index]! }; mutable.dependencies.push(entry); mutable.dependencyKeys.add(`${entry.from}\u0000${entry.to}`);
  }
  for (let index = 0; index < state.subtasks.length; index++) {
    const entry = { ...state.subtasks[index]! }; mutable.subtasks.push(entry); mutable.subtaskKeys.add(`${entry.parent}\u0000${entry.child}`);
  }
  for (let index = 0; index < state.evidence.length; index++) {
    const entry = { ...state.evidence[index]! }; mutable.evidence.push(entry); mutable.evidenceByAttempt.set(attemptKey(entry.taskId, entry.attemptId), entry);
  }
  for (let index = 0; index < state.verdicts.length; index++) {
    const entry = { ...state.verdicts[index]!, reasons: [...state.verdicts[index]!.reasons] }; mutable.verdicts.push(entry); mutable.verdictByAttempt.set(attemptKey(entry.taskId, entry.attemptId), entry);
  }
  for (let index = 0; index < state.integrations.length; index++) mutable.integrations.push({ ...state.integrations[index]! });
  for (let index = 0; index < state.eventIndex.length; index++) {
    const entry = { ...state.eventIndex[index]! }; mutable.eventIndex.push(entry); mutable.eventById.set(entry.eventId, entry); mutable.eventByKey.set(entry.idempotencyKey, entry);
  }
  return mutable;
}

function stateFromMutable(state: MutableState): DurableProjectionState {
  return deepFreeze({
    tasks: state.tasks.map((task) => ({ ...task, attempts: task.attempts.map((entry) => ({ ...entry })) })),
    dependencies: state.dependencies.map((entry) => ({ ...entry })),
    subtasks: state.subtasks.map((entry) => ({ ...entry })),
    evidence: state.evidence.map((entry) => ({ ...entry })),
    verdicts: state.verdicts.map((entry) => ({ ...entry, reasons: [...entry.reasons] })),
    integrations: state.integrations.map((entry) => ({ ...entry })),
    eventIndex: state.eventIndex.map((entry) => ({ ...entry })),
  });
}

function taskFromPayload(payload: TaskLifecyclePayload): MutableTask {
  if (payload.contract === undefined) fail('INVALID_PROJECTION', 'payload.contract', 'created task events require a contract');
  if (payload.contract.id !== payload.taskId) fail('INVALID_PROJECTION', 'payload.contract.id', 'contract.id must equal payload.taskId');
  const state = payload.state ?? 'PENDING';
  if (state !== 'PENDING' && state !== 'READY' && state !== 'RUNNING') fail('INVALID_PROJECTION', 'payload.state', 'task registration may only start in PENDING, READY, or RUNNING');
  const attempts = payload.attempts === undefined ? [] : payload.attempts.map((entry) => ({ ...entry }));
  if (state === 'RUNNING' && (attempts.length !== 1 || attempts[0]?.status !== 'RUNNING')) fail('INVALID_PROJECTION', 'payload.attempts', 'RUNNING registration requires exactly one RUNNING attempt');
  if (state !== 'RUNNING' && attempts.some((entry) => entry.status === 'RUNNING')) fail('INVALID_PROJECTION', 'payload.attempts', 'non-RUNNING registration cannot contain an active attempt');
  return { id: payload.taskId, contract: payload.contract, state, attempts, ...(payload.blocker === undefined ? {} : { blocker: payload.blocker }), ...(payload.reason === undefined ? {} : { reason: payload.reason }) };
}

function taskAttempt(state: MutableState, taskId: string, attemptId: string, path: string): { task: MutableTask; index: number; attempt: MutableAttempt } {
  const task = state.taskById.get(taskId);
  if (task === undefined) fail('INVALID_PROJECTION', `${path}.taskId`, 'attempt references an unknown task');
  for (let index = 0; index < task.attempts.length; index++) if (task.attempts[index]?.attemptId === attemptId) return { task, index, attempt: task.attempts[index]! };
  fail('INVALID_PROJECTION', `${path}.attemptId`, 'attempt references an unknown attempt');
}

function normalizedAttempts(payload: readonly DurableAttempt[], path: string): MutableAttempt[] {
  const result: MutableAttempt[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < payload.length; index++) {
    const entry = payload[index]!;
    if (seen.has(entry.attemptId)) fail('EVENT_CONFLICT', `${path}[${index}].attemptId`, 'attempt IDs must be unique');
    seen.add(entry.attemptId); result.push({ ...entry });
  }
  if (result.filter((entry) => entry.status === 'RUNNING').length > 1) fail('EVENT_CONFLICT', path, 'a task cannot have multiple active attempts');
  return result;
}

function applyTaskPayload(state: MutableState, payload: TaskLifecyclePayload): void {
  if (payload.change === 'created') {
    if (state.taskById.has(payload.taskId)) fail('EVENT_CONFLICT', 'payload.taskId', 'task was registered twice');
    if (state.tasks.length >= MAX_PROJECTION_TASKS) fail('INVALID_PROJECTION', 'tasks', 'projection task limit exceeded');
    const task = taskFromPayload(payload); state.tasks.push(task); state.taskById.set(task.id, task); return;
  }
  if (payload.change === 'dependency_added') {
    const from = payload.dependencyFrom!; const to = payload.dependencyTo!;
    if (!state.taskById.has(from) || !state.taskById.has(to)) fail('INVALID_PROJECTION', 'payload', 'dependency references an unknown task');
    const dependencyKey = `${from}\u0000${to}`;
    if (state.dependencyKeys.has(dependencyKey)) fail('EVENT_CONFLICT', 'payload', 'dependency was added twice');
    state.dependencyKeys.add(dependencyKey); state.dependencies.push({ from, to }); return;
  }
  if (payload.change === 'subtask_added') {
    if (!state.taskById.has(payload.taskId) || !state.taskById.has(payload.parentTaskId!)) fail('INVALID_PROJECTION', 'payload', 'subtask references an unknown task');
    const subtaskKey = `${payload.parentTaskId}\u0000${payload.taskId}`;
    if (state.subtaskKeys.has(subtaskKey)) fail('EVENT_CONFLICT', 'payload', 'subtask was added twice');
    state.subtaskKeys.add(subtaskKey); state.subtasks.push({ parent: payload.parentTaskId!, child: payload.taskId }); return;
  }
  const task = state.taskById.get(payload.taskId);
  if (task === undefined) fail('INVALID_PROJECTION', 'payload.taskId', 'state_changed references an unknown task');
  if (payload.from === undefined || payload.to === undefined) fail('INVALID_PROJECTION', 'payload', 'state_changed requires from and to');
  if (payload.from !== task.state) fail('EVENT_CONFLICT', 'payload.from', 'task state transition has the wrong source state');
  if (payload.from === payload.to) fail('EVENT_CONFLICT', 'payload.to', 'same-state transitions are not canonical changes');
  const legal = checkStateTransition(payload.from, payload.to);
  if (!legal.ok) fail('INVALID_PROJECTION', 'payload.to', legal.error.message);
  const nextAttempts = payload.attempts === undefined ? undefined : normalizedAttempts(payload.attempts, 'payload.attempts');
  const currentAttempts = task.attempts;
  if (payload.to === 'RUNNING') {
    if (nextAttempts === undefined || nextAttempts.length !== currentAttempts.length + 1 || nextAttempts.slice(0, -1).some((entry, index) => json(entry) !== json(currentAttempts[index]))) fail('INVALID_PROJECTION', 'payload.attempts', 'start must append one new attempt');
    const started = nextAttempts[nextAttempts.length - 1]!;
    if (started.status !== 'RUNNING' || currentAttempts.some((entry) => entry.status === 'RUNNING')) fail('INVALID_PROJECTION', 'payload.attempts', 'start must create one active attempt');
  }
  if (payload.to === 'VERIFYING') {
    if (task.state !== 'RUNNING' || nextAttempts === undefined || nextAttempts.length !== currentAttempts.length) fail('INVALID_PROJECTION', 'payload.attempts', 'settle must close the current RUNNING attempt');
    const current = currentAttempts[currentAttempts.length - 1]; const next = nextAttempts[nextAttempts.length - 1];
    if (current?.status !== 'RUNNING' || next?.attemptId !== current.attemptId || next.status !== 'SETTLED' || asNonEmptyString(next.outcome) === undefined) fail('INVALID_PROJECTION', 'payload.attempts', 'settle must close the current attempt with an outcome');
    for (let index = 0; index < currentAttempts.length - 1; index++) if (json(currentAttempts[index]) !== json(nextAttempts[index])) fail('EVENT_CONFLICT', 'payload.attempts', 'settle cannot rewrite an earlier attempt');
  }
  if (payload.to === 'PASSED') {
    if (task.state !== 'VERIFYING' || nextAttempts === undefined || nextAttempts.length !== currentAttempts.length) fail('INVALID_PROJECTION', 'payload.attempts', 'passed requires a settled attempt');
    const current = currentAttempts[currentAttempts.length - 1]; const next = nextAttempts[nextAttempts.length - 1];
    if (current?.status !== 'SETTLED' || next?.attemptId !== current.attemptId || next.status !== 'PASSED' || state.verdictByAttempt.get(attemptKey(task.id, current.attemptId))?.verdict !== 'passed') fail('INVALID_PROJECTION', 'payload.attempts', 'passed requires a matching passed verdict');
    for (let index = 0; index < currentAttempts.length - 1; index++) if (json(currentAttempts[index]) !== json(nextAttempts[index])) fail('EVENT_CONFLICT', 'payload.attempts', 'passed cannot rewrite an earlier attempt');
  }
  if ((payload.from === 'RUNNING' || payload.from === 'VERIFYING') && (payload.to === 'RETRYING' || payload.to === 'FAILED' || payload.to === 'BLOCKED' || payload.to === 'CANCELLED')) {
    if (nextAttempts === undefined || nextAttempts.length !== currentAttempts.length) fail('INVALID_PROJECTION', 'payload.attempts', 'error transition must close exactly the current attempt');
    const current = currentAttempts[currentAttempts.length - 1]; const next = nextAttempts[nextAttempts.length - 1];
    if (current === undefined || next === undefined || current.status === next.status || next.attemptId !== current.attemptId || next.status === 'RUNNING') fail('INVALID_PROJECTION', 'payload.attempts', 'error transition must close the current attempt');
    for (let index = 0; index < currentAttempts.length - 1; index++) if (json(currentAttempts[index]) !== json(nextAttempts[index])) fail('EVENT_CONFLICT', 'payload.attempts', 'error transition cannot rewrite an earlier attempt');
  }
  if (nextAttempts !== undefined) {
    for (let index = 0; index < nextAttempts.length; index++) {
      const previous = currentAttempts.find((entry) => entry.attemptId === nextAttempts[index]!.attemptId);
      if (previous !== undefined && nextAttempts[index]!.artifactRevision === undefined && previous.artifactRevision !== undefined) nextAttempts[index]!.artifactRevision = previous.artifactRevision;
    }
  }
  if (nextAttempts !== undefined) task.attempts = nextAttempts;
  task.state = payload.to;
  if (payload.blocker !== undefined) task.blocker = payload.blocker;
  if (payload.reason !== undefined) task.reason = payload.reason;
}

function bindAttemptRevision(attempt: MutableAttempt, revision: string, path: string): void {
  if (attempt.artifactRevision !== undefined && attempt.artifactRevision !== revision) fail('EVENT_CONFLICT', path, 'artifactRevision does not match the attempt binding');
  if (attempt.artifactRevision === undefined) attempt.artifactRevision = revision;
}

function applyEvidence(state: MutableState, payload: EvidenceDurablePayload): void {
  const binding = taskAttempt(state, payload.taskId, payload.attemptId, 'payload');
  bindAttemptRevision(binding.attempt, payload.artifactRevision, 'payload.artifactRevision');
  const key = attemptKey(payload.taskId, payload.attemptId);
  if (state.evidenceByAttempt.has(key)) fail('EVENT_CONFLICT', 'payload', 'evidence was recorded twice for the same attempt');
  const value = { ...payload }; state.evidence.push(value); state.evidenceByAttempt.set(key, value);
}

function applyVerdict(state: MutableState, payload: VerdictDurablePayload): void {
  const binding = taskAttempt(state, payload.taskId, payload.attemptId, 'payload');
  if (binding.attempt.status !== 'SETTLED' && binding.attempt.status !== 'PASSED') fail('INVALID_PROJECTION', 'payload.attemptId', 'verdict requires a settled attempt');
  bindAttemptRevision(binding.attempt, payload.artifactRevision, 'payload.artifactRevision');
  const key = attemptKey(payload.taskId, payload.attemptId);
  if (state.verdictByAttempt.has(key)) fail('EVENT_CONFLICT', 'payload', 'verdict was recorded twice for the same attempt');
  const value = { ...payload, reasons: [...payload.reasons] }; state.verdicts.push(value); state.verdictByAttempt.set(key, value);
}

function applyEvent(state: MutableState, event: DurableEvent): void {
  if (event.kind === 'task') applyTaskPayload(state, event.payload as TaskLifecyclePayload);
  else if (event.kind === 'evidence') applyEvidence(state, event.payload as EvidenceDurablePayload);
  else if (event.kind === 'verdict') applyVerdict(state, event.payload as VerdictDurablePayload);
  else if (event.kind === 'integration') state.integrations.push({ ...(event.payload as IntegrationDurablePayload) });
  // Scheduler and recovery events are audit-only. They never bypass the task
  // lifecycle/evidence/verdict canonical invariant helpers above.
}

function addIndex(state: MutableState, event: DurableEvent): void {
  const entry = { eventId: event.eventId, idempotencyKey: event.idempotencyKey, sequence: event.sequence, fingerprint: eventFingerprint(event) };
  state.eventIndex.push(entry); state.eventById.set(entry.eventId, entry); state.eventByKey.set(entry.idempotencyKey, entry);
}

function validateState(input: unknown): DurableProjectionState {
  const raw = object(input, 'state', 'INVALID_PROJECTION');
  exact(raw, STATE_FIELDS, 'state', 'INVALID_PROJECTION');
  const rawTasks = array(ownValue(raw, 'tasks'), 'state.tasks', 'INVALID_PROJECTION', MAX_PROJECTION_TASKS);
  const tasks: DurableTaskProjection[] = [];
  for (let index = 0; index < rawTasks.length; index++) {
    const taskRaw = object(rawTasks[index], `state.tasks[${index}]`, 'INVALID_PROJECTION');
    exact(taskRaw, TASK_PROJECTION_FIELDS, `state.tasks[${index}]`, 'INVALID_PROJECTION');
    const attemptsRaw = array(ownValue(taskRaw, 'attempts'), `state.tasks[${index}].attempts`, 'INVALID_PROJECTION', 256);
    const attempts: DurableAttempt[] = [];
    for (let attemptIndex = 0; attemptIndex < attemptsRaw.length; attemptIndex++) attempts.push(attempt(attemptsRaw[attemptIndex], `state.tasks[${index}].attempts[${attemptIndex}]`, 'INVALID_PROJECTION'));
    const blocker = optionalString(taskRaw, 'blocker', `state.tasks[${index}]`, 'INVALID_PROJECTION', MAX_SUMMARY_LENGTH);
    const reason = optionalString(taskRaw, 'reason', `state.tasks[${index}]`, 'INVALID_PROJECTION', MAX_SUMMARY_LENGTH);
    const task: DurableTaskProjection = {
      id: stringValue(ownValue(taskRaw, 'id'), `state.tasks[${index}].id`, 'INVALID_PROJECTION', MAX_DURABLE_TASK_ID_LENGTH),
      contract: normalizeTaskContract(ownValue(taskRaw, 'contract'), `state.tasks[${index}].contract`),
      state: enumValue(ownValue(taskRaw, 'state'), `state.tasks[${index}].state`, TASK_STATES, 'INVALID_PROJECTION'),
      attempts,
      ...(blocker === undefined ? {} : { blocker }),
      ...(reason === undefined ? {} : { reason }),
    };
    if (tasks.some((entry) => entry.id === task.id)) fail('INVALID_PROJECTION', `state.tasks[${index}].id`, 'duplicate task ID');
    tasks.push(task);
  }
  const dependencies = pairArray<DurableDependencyProjection>(ownValue(raw, 'dependencies'), 'state.dependencies', DEPENDENCY_FIELDS, 'from', 'to', MAX_PROJECTION_TASKS);
  const subtasks = pairArray<DurableSubtaskProjection>(ownValue(raw, 'subtasks'), 'state.subtasks', SUBTASK_FIELDS, 'parent', 'child', MAX_PROJECTION_TASKS);
  const evidence = projectionEvidence(ownValue(raw, 'evidence'));
  const verdicts = projectionVerdicts(ownValue(raw, 'verdicts'));
  const integrations = projectionIntegrations(ownValue(raw, 'integrations'));
  const indexRaw = array(ownValue(raw, 'eventIndex'), 'state.eventIndex', 'INVALID_PROJECTION', MAX_PROJECTION_EVENTS);
  const eventIndex: EventIndexEntry[] = [];
  for (let index = 0; index < indexRaw.length; index++) {
    const entry = object(indexRaw[index], `state.eventIndex[${index}]`, 'INVALID_PROJECTION');
    exact(entry, EVENT_INDEX_FIELDS, `state.eventIndex[${index}]`, 'INVALID_PROJECTION');
    eventIndex.push({
      eventId: stringValue(ownValue(entry, 'eventId'), `state.eventIndex[${index}].eventId`, 'INVALID_PROJECTION', MAX_EVENT_ID_LENGTH),
      idempotencyKey: stringValue(ownValue(entry, 'idempotencyKey'), `state.eventIndex[${index}].idempotencyKey`, 'INVALID_PROJECTION', MAX_IDEMPOTENCY_KEY_LENGTH),
      sequence: positiveInteger(ownValue(entry, 'sequence'), `state.eventIndex[${index}].sequence`, 'INVALID_PROJECTION'),
      fingerprint: stringValue(ownValue(entry, 'fingerprint'), `state.eventIndex[${index}].fingerprint`, 'INVALID_PROJECTION', INTEGRITY_LENGTH),
    });
  }
  validateCanonicalState({ tasks, dependencies, subtasks, evidence, verdicts, integrations, eventIndex });
  return deepFreeze({ tasks, dependencies, subtasks, evidence, verdicts, integrations, eventIndex });
}

function validateCanonicalState(state: DurableProjectionState): void {
  const tasks = new Map<string, DurableTaskProjection>();
  for (let index = 0; index < state.tasks.length; index++) {
    const task = state.tasks[index]!;
    if (task.contract.id !== task.id) fail('INVALID_PROJECTION', `state.tasks[${index}].contract.id`, 'contract.id must equal task.id');
    if (tasks.has(task.id)) fail('INVALID_PROJECTION', `state.tasks[${index}].id`, 'duplicate task ID');
    tasks.set(task.id, task);
    const attemptIds = new Set<string>(); let active = 0;
    for (let attemptIndex = 0; attemptIndex < task.attempts.length; attemptIndex++) {
      const current = task.attempts[attemptIndex]!;
      if (attemptIds.has(current.attemptId)) fail('INVALID_PROJECTION', `state.tasks[${index}].attempts[${attemptIndex}].attemptId`, 'duplicate attempt ID');
      attemptIds.add(current.attemptId); if (current.status === 'RUNNING') active++;
    }
    const latest = task.attempts[task.attempts.length - 1];
    if (active > 1 || (task.state === 'RUNNING' && (active !== 1 || latest?.status !== 'RUNNING')) || (task.state !== 'RUNNING' && active !== 0) || (task.state === 'VERIFYING' && latest?.status !== 'SETTLED')) fail('INVALID_PROJECTION', `state.tasks[${index}]`, 'task state and attempt status do not agree');
  }
  const pairKeys = new Set<string>();
  for (let index = 0; index < state.dependencies.length; index++) {
    const entry = state.dependencies[index]!; const key = `${entry.from}\u0000${entry.to}`;
    if (!tasks.has(entry.from) || !tasks.has(entry.to)) fail('INVALID_PROJECTION', `state.dependencies[${index}]`, 'dependency references an unknown task');
    if (pairKeys.has(key)) fail('INVALID_PROJECTION', `state.dependencies[${index}]`, 'duplicate dependency'); pairKeys.add(key);
  }
  pairKeys.clear();
  for (let index = 0; index < state.subtasks.length; index++) {
    const entry = state.subtasks[index]!; const key = `${entry.parent}\u0000${entry.child}`;
    if (!tasks.has(entry.parent) || !tasks.has(entry.child)) fail('INVALID_PROJECTION', `state.subtasks[${index}]`, 'subtask references an unknown task');
    if (pairKeys.has(key)) fail('INVALID_PROJECTION', `state.subtasks[${index}]`, 'duplicate subtask'); pairKeys.add(key);
  }
  const attempts = new Map<string, DurableAttempt>();
  for (const task of state.tasks) for (const current of task.attempts) attempts.set(attemptKey(task.id, current.attemptId), current);
  const evidenceKeys = new Set<string>();
  for (let index = 0; index < state.evidence.length; index++) {
    const entry = state.evidence[index]!; const key = attemptKey(entry.taskId, entry.attemptId); const current = attempts.get(key);
    if (current === undefined) fail('INVALID_PROJECTION', `state.evidence[${index}]`, 'evidence references an unknown attempt');
    if (current.artifactRevision !== entry.artifactRevision) fail('INVALID_PROJECTION', `state.evidence[${index}].artifactRevision`, 'evidence artifactRevision is not bound to the attempt');
    if (evidenceKeys.has(key)) fail('INVALID_PROJECTION', `state.evidence[${index}]`, 'duplicate evidence binding'); evidenceKeys.add(key);
  }
  const verdictKeys = new Set<string>();
  for (let index = 0; index < state.verdicts.length; index++) {
    const entry = state.verdicts[index]!; const key = attemptKey(entry.taskId, entry.attemptId); const current = attempts.get(key);
    if (current === undefined) fail('INVALID_PROJECTION', `state.verdicts[${index}]`, 'verdict references an unknown attempt');
    if (current.artifactRevision !== entry.artifactRevision) fail('INVALID_PROJECTION', `state.verdicts[${index}].artifactRevision`, 'verdict artifactRevision is not bound to the attempt');
    if (current.status !== 'SETTLED' && current.status !== 'PASSED') fail('INVALID_PROJECTION', `state.verdicts[${index}]`, 'verdict references an unsettled attempt');
    if (verdictKeys.has(key)) fail('INVALID_PROJECTION', `state.verdicts[${index}]`, 'duplicate verdict binding'); verdictKeys.add(key);
  }
  for (const task of state.tasks) if (task.state === 'PASSED') {
    const current = task.attempts[task.attempts.length - 1];
    const verdict = current === undefined ? undefined : state.verdicts.find((entry) => entry.taskId === task.id && entry.attemptId === current.attemptId);
    if (current === undefined || current.status !== 'PASSED' || verdict?.verdict !== 'passed' || verdict.artifactRevision !== current.artifactRevision) fail('INVALID_PROJECTION', `state.tasks.${task.id}`, 'PASSED task requires a matching passed verdict and no active attempt');
  }
  const eventIds = new Set<string>(); const idempotencyKeys = new Set<string>(); const sequences = new Set<number>();
  for (let index = 0; index < state.eventIndex.length; index++) {
    const entry = state.eventIndex[index]!;
    if (eventIds.has(entry.eventId) || idempotencyKeys.has(entry.idempotencyKey) || sequences.has(entry.sequence)) fail('INVALID_PROJECTION', `state.eventIndex[${index}]`, 'event index identities and sequences must be unique');
    eventIds.add(entry.eventId); idempotencyKeys.add(entry.idempotencyKey); sequences.add(entry.sequence);
  }
}

function pairArray<T extends DurableDependencyProjection | DurableSubtaskProjection>(value: unknown, path: string, fields: readonly string[], left: string, right: string, maximum: number): readonly T[] {
  const raw = array(value, path, 'INVALID_PROJECTION', maximum);
  const result: T[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = object(raw[index], `${path}[${index}]`, 'INVALID_PROJECTION');
    exact(entry, fields, `${path}[${index}]`, 'INVALID_PROJECTION');
    result.push({
      [left]: stringValue(ownValue(entry, left), `${path}[${index}].${left}`, 'INVALID_PROJECTION', MAX_DURABLE_TASK_ID_LENGTH),
      [right]: stringValue(ownValue(entry, right), `${path}[${index}].${right}`, 'INVALID_PROJECTION', MAX_DURABLE_TASK_ID_LENGTH),
    } as unknown as T);
  }
  return result;
}

function projectionEvidence(value: unknown): readonly DurableEvidenceProjection[] {
  const raw = array(value, 'state.evidence', 'INVALID_PROJECTION', MAX_PROJECTION_EVENTS);
  const result: DurableEvidenceProjection[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = object(raw[index], `state.evidence[${index}]`, 'INVALID_PROJECTION');
    exact(entry, EVIDENCE_PROJECTION_FIELDS, `state.evidence[${index}]`, 'INVALID_PROJECTION');
    result.push({
      taskId: stringValue(ownValue(entry, 'taskId'), `state.evidence[${index}].taskId`, 'INVALID_PROJECTION', MAX_DURABLE_TASK_ID_LENGTH),
      attemptId: stringValue(ownValue(entry, 'attemptId'), `state.evidence[${index}].attemptId`, 'INVALID_PROJECTION', MAX_EVENT_ID_LENGTH),
      artifactRevision: stringValue(ownValue(entry, 'artifactRevision'), `state.evidence[${index}].artifactRevision`, 'INVALID_PROJECTION', MAX_REFERENCE_LENGTH),
      evidenceRef: stringValue(ownValue(entry, 'evidenceRef'), `state.evidence[${index}].evidenceRef`, 'INVALID_PROJECTION', MAX_REFERENCE_LENGTH),
      summary: stringValue(ownValue(entry, 'summary'), `state.evidence[${index}].summary`, 'INVALID_PROJECTION', MAX_SUMMARY_LENGTH),
    });
  }
  return result;
}

function projectionVerdicts(value: unknown): readonly DurableVerdictProjection[] {
  const raw = array(value, 'state.verdicts', 'INVALID_PROJECTION', MAX_PROJECTION_EVENTS);
  const result: DurableVerdictProjection[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = object(raw[index], `state.verdicts[${index}]`, 'INVALID_PROJECTION');
    exact(entry, VERDICT_PROJECTION_FIELDS, `state.verdicts[${index}]`, 'INVALID_PROJECTION');
    const reviewRef = optionalString(entry, 'reviewRef', `state.verdicts[${index}]`, 'INVALID_PROJECTION', MAX_REFERENCE_LENGTH);
    result.push({
      taskId: stringValue(ownValue(entry, 'taskId'), `state.verdicts[${index}].taskId`, 'INVALID_PROJECTION', MAX_DURABLE_TASK_ID_LENGTH),
      attemptId: stringValue(ownValue(entry, 'attemptId'), `state.verdicts[${index}].attemptId`, 'INVALID_PROJECTION', MAX_EVENT_ID_LENGTH),
      artifactRevision: stringValue(ownValue(entry, 'artifactRevision'), `state.verdicts[${index}].artifactRevision`, 'INVALID_PROJECTION', MAX_REFERENCE_LENGTH),
      verdict: enumValue(ownValue(entry, 'verdict'), `state.verdicts[${index}].verdict`, ['passed', 'rejected'], 'INVALID_PROJECTION'),
      reasons: reasons(ownValue(entry, 'reasons'), `state.verdicts[${index}].reasons`, 'INVALID_PROJECTION'),
      ...(reviewRef === undefined ? {} : { reviewRef }),
    });
  }
  return result;
}

function projectionIntegrations(value: unknown): readonly DurableIntegrationProjection[] {
  const raw = array(value, 'state.integrations', 'INVALID_PROJECTION', MAX_PROJECTION_EVENTS);
  const result: DurableIntegrationProjection[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = object(raw[index], `state.integrations[${index}]`, 'INVALID_PROJECTION');
    exact(entry, INTEGRATION_PROJECTION_FIELDS, `state.integrations[${index}]`, 'INVALID_PROJECTION');
    const artifactRevision = optionalString(entry, 'artifactRevision', `state.integrations[${index}]`, 'INVALID_PROJECTION', MAX_REFERENCE_LENGTH);
    result.push({
      outcome: enumValue(ownValue(entry, 'outcome'), `state.integrations[${index}].outcome`, ['merged', 'conflict', 'verification_failed', 'runner_error'], 'INVALID_PROJECTION'),
      ...(artifactRevision === undefined ? {} : { artifactRevision }),
      reportRef: stringValue(ownValue(entry, 'reportRef'), `state.integrations[${index}].reportRef`, 'INVALID_PROJECTION', MAX_REFERENCE_LENGTH),
      summary: stringValue(ownValue(entry, 'summary'), `state.integrations[${index}].summary`, 'INVALID_PROJECTION', MAX_SUMMARY_LENGTH),
    });
  }
  return result;
}

function validateSnapshot(input: unknown): DurableSnapshot {
  const raw = object(input, 'snapshot', 'INVALID_SNAPSHOT');
  exact(raw, SNAPSHOT_FIELDS, 'snapshot', 'INVALID_SNAPSHOT');
  const schemaVersion = ownValue(raw, 'schemaVersion');
  if (schemaVersion !== DURABLE_SCHEMA_VERSION) {
    if (typeof schemaVersion === 'number' && schemaVersion > DURABLE_SCHEMA_VERSION) fail('UNKNOWN_SCHEMA_VERSION', 'snapshot.schemaVersion', `unsupported future schemaVersion ${schemaVersion}`, [String(DURABLE_SCHEMA_VERSION)]);
    fail('INVALID_SNAPSHOT', 'snapshot.schemaVersion', `snapshot.schemaVersion must be ${DURABLE_SCHEMA_VERSION}`, [String(DURABLE_SCHEMA_VERSION)]);
  }
  let state: DurableProjectionState;
  try {
    state = validateState(ownValue(raw, 'state'));
  } catch (error) {
    if (error instanceof DurableStateError && error.code === 'INVALID_PROJECTION') throw new DurableStateError({ code: 'INVALID_SNAPSHOT', message: error.message, path: error.path, available: error.available });
    throw error;
  }
  const snapshot: DurableSnapshot = deepFreeze({
    schemaVersion: DURABLE_SCHEMA_VERSION,
    runId: stringValue(ownValue(raw, 'runId'), 'snapshot.runId', 'INVALID_SNAPSHOT', MAX_RUN_ID_LENGTH),
    lastSequence: nonNegativeInteger(ownValue(raw, 'lastSequence'), 'snapshot.lastSequence', 'INVALID_SNAPSHOT'),
    state,
    integrity: stringValue(ownValue(raw, 'integrity'), 'snapshot.integrity', 'INVALID_SNAPSHOT', INTEGRITY_LENGTH),
  });
  if (snapshot.integrity !== fingerprint({ schemaVersion: snapshot.schemaVersion, runId: snapshot.runId, lastSequence: snapshot.lastSequence, state: snapshot.state })) {
    fail('INVALID_SNAPSHOT', 'snapshot.integrity', 'snapshot integrity does not match its state');
  }
  if (snapshot.lastSequence > MAX_PROJECTION_EVENTS) fail('INVALID_SNAPSHOT', 'snapshot.lastSequence', 'snapshot sequence limit exceeded');
  if (snapshot.state.eventIndex.length > snapshot.lastSequence) fail('INVALID_SNAPSHOT', 'snapshot.state.eventIndex', 'snapshot event index exceeds lastSequence');
  for (const entry of snapshot.state.eventIndex) if (entry.sequence > snapshot.lastSequence) fail('INVALID_SNAPSHOT', 'snapshot.state.eventIndex.sequence', 'snapshot event index sequence exceeds lastSequence');
  return snapshot;
}

function validateProjection(input: unknown): DurableProjection {
  const raw = object(input, 'projection', 'INVALID_PROJECTION');
  exact(raw, PROJECTION_FIELDS, 'projection', 'INVALID_PROJECTION');
  const projection: DurableProjection = deepFreeze({
    runId: stringValue(ownValue(raw, 'runId'), 'projection.runId', 'INVALID_PROJECTION', MAX_RUN_ID_LENGTH),
    lastSequence: nonNegativeInteger(ownValue(raw, 'lastSequence'), 'projection.lastSequence', 'INVALID_PROJECTION'),
    state: validateState(ownValue(raw, 'state')),
  });
  if (projection.lastSequence > MAX_PROJECTION_EVENTS) fail('INVALID_PROJECTION', 'projection.lastSequence', 'projection sequence limit exceeded');
  if (projection.state.eventIndex.length > projection.lastSequence) fail('INVALID_PROJECTION', 'projection.state.eventIndex', 'projection event index exceeds lastSequence');
  for (const entry of projection.state.eventIndex) if (entry.sequence > projection.lastSequence) fail('INVALID_PROJECTION', 'projection.state.eventIndex.sequence', 'projection event index sequence exceeds lastSequence');
  return projection;
}

function existingEvent(state: MutableState, event: DurableEvent): EventIndexEntry | undefined {
  const byId = state.eventById.get(event.eventId);
  const byKey = state.eventByKey.get(event.idempotencyKey);
  if (byId !== undefined && byKey !== undefined && byId !== byKey) fail('EVENT_CONFLICT', 'event', 'eventId and idempotencyKey identify different existing events');
  return byId ?? byKey;
}

function applyEventWithIndex(state: MutableState, event: DurableEvent): boolean {
  const existing = existingEvent(state, event);
  if (existing !== undefined) {
    if (existing.sequence !== event.sequence || existing.fingerprint !== eventFingerprint(event)) {
      fail(existing.eventId === event.eventId ? 'EVENT_CONFLICT' : 'IDEMPOTENCY_CONFLICT', 'event', 'event identity was reused with different content or sequence');
    }
    return true;
  }
  applyEvent(state, event);
  addIndex(state, event);
  return false;
}

/** Replay a checked snapshot plus its tail, never starting or re-running an executor. */
export function recoverRun(snapshotInput: unknown, tailEventsInput: unknown = [], runIdInput?: unknown): RecoveryResult {
  try {
    const snapshot = snapshotInput === undefined ? undefined : validateSnapshot(snapshotInput);
    const tailRaw = array(tailEventsInput, 'tailEvents', 'INVALID_EVENT', MAX_PROJECTION_EVENTS);
    const requestedRunId = runIdInput === undefined ? undefined : stringValue(runIdInput, 'runId', 'RUN_ID_MISMATCH', MAX_RUN_ID_LENGTH);
    if (snapshot !== undefined && requestedRunId !== undefined && snapshot.runId !== requestedRunId) fail('RUN_ID_MISMATCH', 'runId', 'snapshot runId does not match requested runId');
    if ((snapshot?.lastSequence ?? 0) + tailRaw.length > MAX_PROJECTION_EVENTS) fail('INVALID_PROJECTION', 'tailEvents', 'snapshot plus tail event limit exceeded');
    let runId = snapshot?.runId ?? requestedRunId;
    const state = mutableFromState(snapshot?.state ?? emptyState());
    let expectedSequence = (snapshot?.lastSequence ?? 0) + 1;
    const ignoredDuplicateEventIds: string[] = [];
    for (let index = 0; index < tailRaw.length; index++) {
      const event = normalizeEvent(tailRaw[index]);
      if (runId === undefined) runId = event.runId;
      if (event.runId !== runId) fail('RUN_ID_MISMATCH', `tailEvents[${index}].runId`, 'event runId does not match the recovery run');
      const known = existingEvent(state, event);
      if (known !== undefined) {
        const duplicate = applyEventWithIndex(state, event);
        if (event.sequence > expectedSequence) fail('SEQUENCE_GAP', `tailEvents[${index}].sequence`, `event sequence expected ${expectedSequence} but received ${event.sequence}`);
        if (duplicate) ignoredDuplicateEventIds.push(event.eventId);
        continue;
      }
      if (event.sequence !== expectedSequence) {
        if (event.sequence < expectedSequence) fail('SEQUENCE_ORDER', `tailEvents[${index}].sequence`, 'event sequence is out of order or duplicated');
        fail('SEQUENCE_GAP', `tailEvents[${index}].sequence`, `event sequence expected ${expectedSequence} but received ${event.sequence}`);
      }
      applyEventWithIndex(state, event);
      expectedSequence++;
    }
    if (runId === undefined) fail('RUN_ID_MISMATCH', 'runId', 'an empty recovery needs an explicit runId');
    const projection = deepFreeze({ runId, lastSequence: expectedSequence - 1, state: stateFromMutable(state) });
    return deepFreeze({ projection, ignoredDuplicateEventIds: [...ignoredDuplicateEventIds] });
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
    throw new DurableStateError({ code: 'STORE_ERROR', message: truncateForMessage(errorMessage(error)), path: 'recoverRun', available: [] });
  }
}

/** Build a checked cache snapshot from a full log or an already checked projection. */
export function buildSnapshot(source: unknown, runIdInput?: unknown): DurableSnapshot {
  try {
    let projection: DurableProjection;
    if (Array.isArray(source)) {
      projection = recoverRun(undefined, source, runIdInput).projection;
    } else {
      projection = validateProjection(source);
      if (runIdInput !== undefined && projection.runId !== stringValue(runIdInput, 'runId', 'RUN_ID_MISMATCH', MAX_RUN_ID_LENGTH)) fail('RUN_ID_MISMATCH', 'runId', 'projection runId does not match requested run');
    }
    return deepFreeze({
      schemaVersion: DURABLE_SCHEMA_VERSION,
      runId: projection.runId,
      lastSequence: projection.lastSequence,
      state: projection.state,
      integrity: fingerprint({ schemaVersion: DURABLE_SCHEMA_VERSION, runId: projection.runId, lastSequence: projection.lastSequence, state: projection.state }),
    });
  } catch (error) {
    if (error instanceof DurableStateError) throw error;
    throw new DurableStateError({ code: 'STORE_ERROR', message: truncateForMessage(errorMessage(error)), path: 'buildSnapshot', available: [] });
  }
}

function errorData(error: unknown): DurableErrorData {
  if (error instanceof DurableStateError) return deepFreeze({ code: error.code, message: error.message, path: error.path, available: [...error.available] });
  return deepFreeze({ code: 'STORE_ERROR', message: truncateForMessage(errorMessage(error)), path: 'store', available: [] });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || 'operation threw an Error';
  if (typeof error === 'string') return error;
  return 'operation threw a non-Error value';
}

function conflict(code: DurableErrorCode, path: string, message: string, available: readonly string[] = []): EventStoreAppendFailure {
  return deepFreeze({ ok: false, error: deepFreeze({ code, message: truncateForMessage(message), path, available: [...available] }) });
}

/** Synchronous in-memory fake for port tests; returned values never alias its log. */
export class InMemoryDurableStore implements DurableStore {
  private readonly logs = new Map<string, DurableEvent[]>();
  private readonly snapshots = new Map<string, DurableSnapshot>();

  append(runIdInput: string, expectedSequenceInput: number, eventsInput: readonly DurableEventInput[]): EventStoreAppendResult {
    try {
      const runId = stringValue(runIdInput, 'runId', 'INVALID_EVENT', MAX_RUN_ID_LENGTH);
      const expectedSequence = nonNegativeInteger(expectedSequenceInput, 'expectedSequence', 'INVALID_EVENT');
      const rawEvents = array(eventsInput, 'events', 'INVALID_EVENT', MAX_PROJECTION_EVENTS);
      const current = this.logs.get(runId) ?? [];
      const currentSequence = current.length === 0 ? 0 : current[current.length - 1]!.sequence;
      const normalized: DurableEvent[] = [];
      for (let index = 0; index < rawEvents.length; index++) {
        const event = normalizeEvent(rawEvents[index], currentSequence + normalized.length + 1);
        if (event.runId !== runId) return conflict('RUN_ID_MISMATCH', `events[${index}].runId`, 'event runId does not match append runId');
        normalized.push(event);
      }
      const toAppend: DurableEvent[] = [];
      const expectedMatches = expectedSequence === currentSequence;
      for (let index = 0; index < normalized.length; index++) {
        const event = normalized[index]!;
        const rawEvent = rawEvents[index];
        const hasExplicitSequence = isPlainObject(rawEvent) && Object.hasOwn(rawEvent, 'sequence');
        let duplicate = false;
        for (let existingIndex = 0; existingIndex < current.length; existingIndex++) {
          const existing = current[existingIndex]!;
          if (existing.eventId === event.eventId || existing.idempotencyKey === event.idempotencyKey) {
            if (!sameContent(existing, event)) {
              return conflict(existing.eventId === event.eventId ? 'EVENT_CONFLICT' : 'IDEMPOTENCY_CONFLICT', `events[${index}]`, 'append reused an identity key with different content');
            }
            duplicate = true;
            break;
          }
        }
        if (!duplicate) {
          for (let priorIndex = 0; priorIndex < toAppend.length; priorIndex++) {
            const prior = toAppend[priorIndex]!;
            if (prior.eventId === event.eventId || prior.idempotencyKey === event.idempotencyKey) {
              if (!sameContent(prior, event)) return conflict('IDEMPOTENCY_CONFLICT', `events[${index}]`, 'batch contains conflicting identity keys');
              duplicate = true;
              break;
            }
          }
        }
        if (!duplicate) {
          if (!expectedMatches) return conflict('SEQUENCE_CONFLICT', 'expectedSequence', `expected sequence ${expectedSequence} does not match current sequence ${currentSequence}`, [String(currentSequence)]);
          if (hasExplicitSequence && event.sequence !== currentSequence + toAppend.length + 1) {
            return conflict('SEQUENCE_ORDER', `events[${index}].sequence`, 'explicit event sequence is not the next sequence', [String(currentSequence + toAppend.length + 1)]);
          }
          toAppend.push(event);
        }
      }
      if (toAppend.length === 0) {
        if (normalized.length === 0 && expectedSequence === currentSequence) return deepFreeze({ ok: true, appended: deepFreeze([]), lastSequence: currentSequence });
        if (normalized.length > 0 && expectedSequence <= currentSequence) return deepFreeze({ ok: true, appended: deepFreeze([]), lastSequence: currentSequence });
        return conflict('SEQUENCE_CONFLICT', 'expectedSequence', `expected sequence ${expectedSequence} does not match current sequence ${currentSequence}`, [String(currentSequence)]);
      }
      if (expectedSequence !== currentSequence) return conflict('SEQUENCE_CONFLICT', 'expectedSequence', `expected sequence ${expectedSequence} does not match current sequence ${currentSequence}`, [String(currentSequence)]);
      const committed: DurableEvent[] = [];
      for (let index = 0; index < toAppend.length; index++) {
        const event = toAppend[index]!;
        const assigned = event.sequence === currentSequence + index + 1
          ? event
          : deepFreeze({ ...event, sequence: currentSequence + index + 1 });
        committed.push(assigned);
      }
      const next = current.concat(committed);
      this.logs.set(runId, next);
      return deepFreeze({ ok: true, appended: deepFreeze(committed.map((event) => normalizeEvent(event))), lastSequence: next[next.length - 1]!.sequence });
    } catch (error) {
      return deepFreeze({ ok: false, error: errorData(error) });
    }
  }

  read(runIdInput: string, afterSequenceInput = 0): readonly DurableEvent[] {
    try {
      const runId = stringValue(runIdInput, 'runId', 'INVALID_EVENT', MAX_RUN_ID_LENGTH);
      const afterSequence = nonNegativeInteger(afterSequenceInput, 'afterSequence', 'INVALID_EVENT');
      const source = this.logs.get(runId) ?? [];
      const result: DurableEvent[] = [];
      for (let index = 0; index < source.length; index++) if (source[index]!.sequence > afterSequence) result.push(normalizeEvent(source[index]));
      return deepFreeze(result);
    } catch (error) { if (error instanceof DurableStateError) throw error; throw new DurableStateError({ code: 'STORE_ERROR', message: truncateForMessage(errorMessage(error)), path: 'read', available: [] }); }
  }

  currentSequence(runIdInput: string): number {
    try {
      const runId = stringValue(runIdInput, 'runId', 'INVALID_EVENT', MAX_RUN_ID_LENGTH);
      const source = this.logs.get(runId);
      return source === undefined || source.length === 0 ? 0 : source[source.length - 1]!.sequence;
    } catch (error) { if (error instanceof DurableStateError) throw error; throw new DurableStateError({ code: 'STORE_ERROR', message: truncateForMessage(errorMessage(error)), path: 'currentSequence', available: [] }); }
  }

  loadSnapshot(runIdInput: string): DurableSnapshot | undefined {
    try {
      const runId = stringValue(runIdInput, 'runId', 'INVALID_SNAPSHOT', MAX_RUN_ID_LENGTH);
      const snapshot = this.snapshots.get(runId);
      return snapshot === undefined ? undefined : validateSnapshot(snapshot);
    } catch (error) { if (error instanceof DurableStateError) throw error; throw new DurableStateError({ code: 'STORE_ERROR', message: truncateForMessage(errorMessage(error)), path: 'loadSnapshot', available: [] }); }
  }

  saveSnapshot(runIdInput: string, expectedSequenceInput: number, snapshotInput: DurableSnapshot, expectedSchemaVersion = DURABLE_SCHEMA_VERSION): EventStoreAppendResult {
    try {
      const runId = stringValue(runIdInput, 'runId', 'INVALID_SNAPSHOT', MAX_RUN_ID_LENGTH);
      const expectedSequence = nonNegativeInteger(expectedSequenceInput, 'expectedSequence', 'INVALID_SNAPSHOT');
      if (expectedSchemaVersion !== DURABLE_SCHEMA_VERSION) return conflict('SNAPSHOT_CONFLICT', 'expectedSchemaVersion', 'snapshot schema version compare-and-set failed', [String(DURABLE_SCHEMA_VERSION)]);
      const snapshot = validateSnapshot(snapshotInput);
      if (snapshot.runId !== runId) return conflict('RUN_ID_MISMATCH', 'snapshot.runId', 'snapshot runId does not match save runId');
      if (snapshot.lastSequence !== expectedSequence) return conflict('SNAPSHOT_CONFLICT', 'snapshot.lastSequence', 'snapshot lastSequence must equal expectedSequence', [String(expectedSequence)]);
      if (this.currentSequence(runId) !== expectedSequence) return conflict('SEQUENCE_CONFLICT', 'expectedSequence', 'snapshot save observed a newer log sequence', [String(this.currentSequence(runId))]);
      this.snapshots.set(runId, snapshot);
      return deepFreeze({ ok: true, appended: deepFreeze([]), lastSequence: expectedSequence });
    } catch (error) {
      return deepFreeze({ ok: false, error: errorData(error) });
    }
  }
}

export type RecoveryActionName =
  | 'reattach'
  | 'settle'
  | 'mark-lost'
  | 'retry-scheduler'
  | 'cancel-orphan'
  | 'cancel-stale'
  | 'human';
export type ObservedExecutorStatus = (typeof OBSERVED_STATUSES)[number];
