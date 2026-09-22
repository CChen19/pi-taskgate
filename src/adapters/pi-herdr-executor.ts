/**
 * Production-shaped, side-effect-free-in-tests Pi/herdr adapter.
 * The actual host supplies both ports; this module never starts a process.
 */
import { isAbsolute, normalize } from 'node:path';
import type { DispatchPlan, PreflightResult } from '../core/contracts.ts';
import type { AttemptArtifact, AttemptHandle, AttemptPollResult, AttemptSettlement, ExecutorPort, ExecutorStartRequest, SettlementFailureCode } from '../core/executor-port.ts';
import { MAX_ATTEMPT_ID_LENGTH, MAX_ARTIFACT_REVISION_LENGTH } from '../core/verification.ts';
import { MAX_TASK_ID_LENGTH, validateTaskContract, type TaskContract } from '../core/task-contract.ts';
import { deepFreeze, hasExactFields, isPlainObject, ownValue, truncateForMessage } from '../core/validate.ts';
import {
  assembleScopedContext,
  renderScopedPrompt,
  validateChangedPaths,
  type ScopedContextBundle,
} from './scoped-context.ts';
import {
  type WorktreePort,
  type WorkspaceInspection,
  type WorkspaceLease,
  type WorktreeCleanup,
  type WorktreeSessionBinding,
  WorktreeManagerError,
  WORKTREE_MARKER_PREFIX,
} from './worktree-manager.ts';

export interface HerdrSpawnRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly cwd: string;
  readonly roleId: string;
  readonly modelProfileId: string;
  readonly provider: string;
  readonly model: string;
  readonly contract: TaskContract;
  readonly scopedContext: ScopedContextBundle;
  readonly prompt: string;
  readonly baseRevision: string;
}

export interface HerdrSubagentPort {
  spawn(request: HerdrSpawnRequest): unknown;
  poll(sessionId: string): unknown;
  /** Structured-result seam; implemented by the real Herdr CLI port. */
  readonly readFinalAssistant?: (sessionId: string) => string;
  interrupt(sessionId: string, reason: string): unknown;
  close(sessionId: string): unknown;
}

export interface WorkspaceManagerPort {
  acquire(port: WorktreePort, taskId: string, attemptId: string, baseRevision: string): WorkspaceLease;
  inspect(port: WorktreePort, lease: WorkspaceLease): WorkspaceInspection;
  bindSession(port: WorktreePort, lease: WorkspaceLease, binding: WorktreeSessionBinding): WorktreeSessionBinding;
  cleanup(port: WorktreePort, lease: WorkspaceLease): WorktreeCleanup;
  adoptLease(port: WorktreePort, lease: WorkspaceLease, binding: WorktreeSessionBinding): WorkspaceLease;
}

export type DispatchResolver = (request: unknown) => PreflightResult;

export interface PiHerdrExecutorOptions {
  readonly herdr: HerdrSubagentPort;
  readonly workspace: WorkspaceManagerPort;
  readonly worktreePort: WorktreePort;
  readonly dispatchResolver: DispatchResolver;
  readonly roleId: string;
  readonly modelProfileId?: string;
  readonly baseRevision: string;
  readonly clock: () => number;
  /** Preserve interrupted workspaces for audit until explicit finalization. */
  readonly retainCancelledArtifacts?: boolean;
}

export interface PiHerdrTerminalResult {
  readonly taskId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly artifactRevision: string;
  readonly diffRef?: string;
  readonly changedPaths: readonly string[];
  readonly scopeAllowed: boolean;
  readonly outcome: string;
  readonly settlement: AttemptSettlement;
}

export interface SerializedExecutorHandle {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly roleId: string;
  readonly modelProfileId: string;
  readonly filesInScope: readonly string[];
  readonly workspacePath: string;
  readonly branch: string;
  readonly ownershipToken: string;
  readonly managedMarker: string;
  readonly baseRevision: string;
}

export type ExecutorErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_BINDING'
  | 'INVALID_TRANSPORT_RESULT'
  | 'TRANSPORT_FAILURE'
  | 'WORKSPACE_FAILURE'
  | 'SCOPE_VIOLATION'
  | 'CLEANUP_FAILURE'
  | 'UNKNOWN_HANDLE';

export interface ExecutorErrorData {
  readonly code: ExecutorErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly leaseRef?: string;
}

export class ExecutorAdapterError extends Error implements ExecutorErrorData {
  readonly code: ExecutorErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  readonly taskId?: string;
  readonly attemptId?: string;
  readonly leaseRef?: string;

  constructor(data: ExecutorErrorData) {
    super(truncateForMessage(data.message));
    this.name = 'ExecutorAdapterError';
    this.code = data.code;
    this.path = data.path;
    this.available = Object.freeze([...data.available]);
    if (data.taskId !== undefined) this.taskId = data.taskId;
    if (data.attemptId !== undefined) this.attemptId = data.attemptId;
    if (data.leaseRef !== undefined) this.leaseRef = data.leaseRef;
  }
}

const REQUEST_FIELDS = ['taskId', 'attemptId', 'contract', 'startedAt'] as const;
const OPTIONS_FIELDS = ['herdr', 'workspace', 'worktreePort', 'dispatchResolver', 'roleId', 'modelProfileId', 'baseRevision', 'clock', 'retainCancelledArtifacts'] as const;
const SPAWN_FIELDS = ['sessionId'] as const;
const TRANSPORT_FIELDS = ['status', 'activity', 'outcome', 'resultRef'] as const;
const HANDLE_FIELDS = ['schemaVersion', 'taskId', 'attemptId', 'sessionId', 'roleId', 'modelProfileId', 'filesInScope', 'workspacePath', 'branch', 'ownershipToken', 'managedMarker', 'baseRevision'] as const;
const STATUS_VALUES = ['running', 'idle', 'settled', 'failed', 'cancelled', 'lost'] as const;

function fail(code: ExecutorErrorCode, path: string, message: string, available: readonly string[] = []): never {
  throw new ExecutorAdapterError({ code, path, message, available });
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || 'operation threw an Error';
  } catch {
    return 'operation threw an uninspectable Error';
  }
  return 'operation threw a non-Error value';
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  try {
    if (!hasExactFields(value, fields)) fail('INVALID_TRANSPORT_RESULT', path, `${path} has unknown fields`, fields);
  } catch (error) {
    if (error instanceof ExecutorAdapterError) throw error;
    fail('INVALID_TRANSPORT_RESULT', path, `${path} could not be inspected`);
  }
}

function boundedString(value: unknown, path: string, maximum: number, code: ExecutorErrorCode = 'INVALID_REQUEST'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail(code, path, `${path} must be a bounded non-empty string`);
  return value;
}

function validateTransportObject(value: unknown, path: string): Record<string, unknown> {
  try {
    if (!isPlainObject(value)) fail('INVALID_TRANSPORT_RESULT', path, `${path} must be a plain object`);
    exact(value, TRANSPORT_FIELDS, path);
    return value;
  } catch (error) {
    if (error instanceof ExecutorAdapterError) throw error;
    fail('INVALID_TRANSPORT_RESULT', path, `${path} could not be inspected`);
  }
}

function normalizeTransportPoll(value: unknown):
  | { readonly kind: 'pending'; readonly activity?: boolean }
  | { readonly kind: 'settled'; readonly outcome: string; readonly failureCode?: SettlementFailureCode; readonly reason?: string } {
  const raw = validateTransportObject(value, 'herdr.poll.return');
  const status = ownValue(raw, 'status');
  if (typeof status !== 'string' || !STATUS_VALUES.includes(status as (typeof STATUS_VALUES)[number])) fail('INVALID_TRANSPORT_RESULT', 'herdr.poll.return.status', 'transport status is unknown', STATUS_VALUES);
  const activityValue = ownValue(raw, 'activity');
  if (activityValue !== undefined && typeof activityValue !== 'boolean') fail('INVALID_TRANSPORT_RESULT', 'herdr.poll.return.activity', 'activity must be boolean');
  const outcomeValue = ownValue(raw, 'outcome');
  const resultRef = ownValue(raw, 'resultRef');
  if (resultRef !== undefined) boundedString(resultRef, 'herdr.poll.return.resultRef', MAX_ARTIFACT_REVISION_LENGTH, 'INVALID_TRANSPORT_RESULT');
  if (status === 'running' || status === 'idle') {
    if (outcomeValue !== undefined || resultRef !== undefined) fail('INVALID_TRANSPORT_RESULT', 'herdr.poll.return', 'running or idle result cannot carry a terminal result');
    return activityValue === undefined ? { kind: 'pending' } : { kind: 'pending', activity: activityValue };
  }
  if (status === 'settled') return { kind: 'settled', outcome: boundedString(outcomeValue, 'herdr.poll.return.outcome', 160, 'INVALID_TRANSPORT_RESULT') };
  const failureCode: SettlementFailureCode = status === 'failed' ? 'WORKER_FAILED' : status === 'cancelled' ? 'WORKER_CANCELLED' : 'SESSION_LOST';
  const reason = typeof outcomeValue === 'string' && outcomeValue.length > 0 ? truncateForMessage(outcomeValue) : status === 'failed' ? 'worker reported failed' : status === 'cancelled' ? 'worker reported cancelled' : 'worker session was lost';
  return { kind: 'settled', outcome: reason, failureCode, reason };
}

function bindingExact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  try {
    if (!hasExactFields(value, fields)) fail('INVALID_BINDING', path, `${path} has unknown fields`, fields);
  } catch (error) {
    if (error instanceof ExecutorAdapterError) throw error;
    fail('INVALID_BINDING', path, `${path} could not be inspected`);
  }
}

function normalizePlan(value: PreflightResult): DispatchPlan {
  try {
    if (!isPlainObject(value)) fail('INVALID_BINDING', 'dispatchResolver.return', 'dispatch resolver result must be a plain object');
    bindingExact(value, ['ok', 'plan'], 'dispatchResolver.return');
    if (ownValue(value, 'ok') !== true || !isPlainObject(ownValue(value, 'plan'))) fail('INVALID_BINDING', 'dispatchResolver.return', 'dispatch resolver did not return a successful preflight plan');
    const plan = ownValue(value, 'plan') as Record<string, unknown>;
    bindingExact(plan, ['task', 'role', 'model', 'routingReason'], 'dispatchResolver.return.plan');
    if (!isPlainObject(ownValue(plan, 'task')) || !isPlainObject(ownValue(plan, 'role')) || !isPlainObject(ownValue(plan, 'model'))) fail('INVALID_BINDING', 'dispatchResolver.return.plan', 'dispatch plan is incomplete');
    const task = ownValue(plan, 'task') as Record<string, unknown>;
    const role = ownValue(plan, 'role') as Record<string, unknown>;
    const model = ownValue(plan, 'model') as Record<string, unknown>;
    bindingExact(task, ['description', 'instructions', 'roleId', 'modelProfileId'], 'dispatchResolver.return.plan.task');
    bindingExact(role, ['id', 'description', 'kind', 'tools'], 'dispatchResolver.return.plan.role');
    bindingExact(model, ['id', 'provider', 'model'], 'dispatchResolver.return.plan.model');
    if (ownValue(plan, 'routingReason') !== 'role-default' && ownValue(plan, 'routingReason') !== 'task-override') fail('INVALID_BINDING', 'dispatchResolver.return.plan.routingReason', 'routing reason is unknown');
    if (ownValue(role, 'kind') !== 'worker') fail('INVALID_BINDING', 'dispatchResolver.return.plan.role.kind', 'dispatch binding must select a worker role');
    const roleId = boundedString(ownValue(role, 'id'), 'dispatchResolver.return.plan.role.id', 256, 'INVALID_BINDING');
    const modelId = boundedString(ownValue(model, 'id'), 'dispatchResolver.return.plan.model.id', 256, 'INVALID_BINDING');
    const taskRoleId = boundedString(ownValue(task, 'roleId'), 'dispatchResolver.return.plan.task.roleId', 256, 'INVALID_BINDING');
    if (taskRoleId !== roleId) fail('INVALID_BINDING', 'dispatchResolver.return.plan.task.roleId', 'dispatch plan task.roleId does not match role.id');
    const taskModelProfile = ownValue(task, 'modelProfileId');
    if (taskModelProfile !== undefined && (typeof taskModelProfile !== 'string' || taskModelProfile !== modelId)) fail('INVALID_BINDING', 'dispatchResolver.return.plan.task.modelProfileId', 'dispatch plan task.modelProfileId does not match model.id');
    const provider = boundedString(ownValue(model, 'provider'), 'dispatchResolver.return.plan.model.provider', 256, 'INVALID_BINDING');
    const modelName = boundedString(ownValue(model, 'model'), 'dispatchResolver.return.plan.model.model', 256, 'INVALID_BINDING');
    return deepFreeze({ role: { id: roleId, kind: 'worker', description: '', tools: [] }, model: { id: modelId, provider, model: modelName }, task: { description: '', instructions: '', roleId }, routingReason: 'role-default' });
  } catch (error) {
    if (error instanceof ExecutorAdapterError) throw error;
    fail('INVALID_BINDING', 'dispatchResolver.return', 'dispatch binding could not be inspected');
  }
}

function validateStartRequest(input: ExecutorStartRequest): { taskId: string; attemptId: string; contract: TaskContract; startedAt: number } {
  try {
    const raw = input as unknown as Record<string, unknown>;
    if (!isPlainObject(raw)) fail('INVALID_REQUEST', 'request', 'executor request must be a plain object');
    if (!hasExactFields(raw, REQUEST_FIELDS)) fail('INVALID_REQUEST', 'request', 'executor request has unknown fields', REQUEST_FIELDS);
    const contractResult = validateTaskContract(ownValue(raw, 'contract'));
    if (!contractResult.ok) fail('INVALID_REQUEST', 'request.contract', contractResult.error.message);
    const taskId = boundedString(ownValue(raw, 'taskId'), 'request.taskId', MAX_TASK_ID_LENGTH);
    const attemptId = boundedString(ownValue(raw, 'attemptId'), 'request.attemptId', MAX_ATTEMPT_ID_LENGTH);
    if (taskId !== contractResult.contract.id) fail('INVALID_REQUEST', 'request.taskId', 'taskId must equal contract.id');
    const startedAt = ownValue(raw, 'startedAt');
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) fail('INVALID_REQUEST', 'request.startedAt', 'startedAt must be finite');
    return { taskId, attemptId, contract: contractResult.contract, startedAt };
  } catch (error) {
    if (error instanceof ExecutorAdapterError) throw error;
    fail('INVALID_REQUEST', 'request', 'executor request could not be inspected');
  }
}

function normalizeSpawn(value: unknown): string {
  if (!isPlainObject(value)) fail('INVALID_TRANSPORT_RESULT', 'herdr.spawn.return', 'spawn result must be a plain object');
  exact(value, SPAWN_FIELDS, 'herdr.spawn.return');
  return boundedString(ownValue(value, 'sessionId'), 'herdr.spawn.return.sessionId', MAX_ATTEMPT_ID_LENGTH, 'INVALID_TRANSPORT_RESULT');
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function handlePath(value: unknown): string {
  const result = boundedString(value, 'handle.workspacePath', MAX_ARTIFACT_REVISION_LENGTH, 'UNKNOWN_HANDLE');
  const segments = result.split('/');
  if (!isAbsolute(result) || normalize(result) !== result || result.includes('\\') || result.includes('\0') || segments.includes('..') || segments.some((segment) => asciiLower(segment) === '.git')) fail('UNKNOWN_HANDLE', 'handle.workspacePath', 'workspacePath is not a safe absolute path');
  return result;
}

function handleBranch(value: unknown): string {
  const result = boundedString(value, 'handle.branch', MAX_ARTIFACT_REVISION_LENGTH, 'UNKNOWN_HANDLE');
  const segments = result.split('/');
  if (result.includes('\\') || result.includes('\0') || segments.includes('..') || segments.some((segment) => asciiLower(segment) === '.git') || result.startsWith('/') || result.endsWith('/')) fail('UNKNOWN_HANDLE', 'handle.branch', 'branch is not safe');
  return result;
}

function handleMarker(value: unknown, token: unknown): string {
  const marker = boundedString(value, 'handle.managedMarker', 160, 'UNKNOWN_HANDLE');
  if (typeof token !== 'string' || marker !== `${WORKTREE_MARKER_PREFIX}${token}`) fail('UNKNOWN_HANDLE', 'handle.managedMarker', 'managed marker does not match ownership token');
  return marker;
}

function handleScope(value: unknown): readonly string[] {
  try {
    return validateChangedPaths([], value).filesInScope;
  } catch {
    fail('UNKNOWN_HANDLE', 'handle.filesInScope', 'handle.filesInScope is not a safe scope array');
  }
}

function validateHandle(value: unknown): SerializedExecutorHandle {
  if (!isPlainObject(value)) fail('UNKNOWN_HANDLE', 'handle', 'handle must be a plain object');
  exact(value, HANDLE_FIELDS, 'handle');
  if (ownValue(value, 'schemaVersion') !== 1) fail('UNKNOWN_HANDLE', 'handle.schemaVersion', 'unsupported handle schema', ['1']);
  return deepFreeze({
    schemaVersion: 1,
    taskId: boundedString(ownValue(value, 'taskId'), 'handle.taskId', MAX_TASK_ID_LENGTH, 'UNKNOWN_HANDLE'),
    attemptId: boundedString(ownValue(value, 'attemptId'), 'handle.attemptId', MAX_ATTEMPT_ID_LENGTH, 'UNKNOWN_HANDLE'),
    sessionId: boundedString(ownValue(value, 'sessionId'), 'handle.sessionId', MAX_ATTEMPT_ID_LENGTH, 'UNKNOWN_HANDLE'),
    roleId: boundedString(ownValue(value, 'roleId'), 'handle.roleId', 256, 'UNKNOWN_HANDLE'),
    modelProfileId: boundedString(ownValue(value, 'modelProfileId'), 'handle.modelProfileId', 256, 'UNKNOWN_HANDLE'),
    filesInScope: handleScope(ownValue(value, 'filesInScope')),
    workspacePath: handlePath(ownValue(value, 'workspacePath')),
    branch: handleBranch(ownValue(value, 'branch')),
    ownershipToken: boundedString(ownValue(value, 'ownershipToken'), 'handle.ownershipToken', 128, 'UNKNOWN_HANDLE'),
    managedMarker: handleMarker(ownValue(value, 'managedMarker'), ownValue(value, 'ownershipToken')),
    baseRevision: boundedString(ownValue(value, 'baseRevision'), 'handle.baseRevision', MAX_ARTIFACT_REVISION_LENGTH, 'UNKNOWN_HANDLE'),
  });
}

/** Pure, non-spawning handle codec used by S7 reconciliation. */
function handleBoundary(input: unknown): SerializedExecutorHandle {
  try {
    return validateHandle(input);
  } catch (error) {
    if (error instanceof ExecutorAdapterError) throw error;
    throw new ExecutorAdapterError({ code: 'UNKNOWN_HANDLE', message: 'handle could not be inspected', path: 'handle', available: HANDLE_FIELDS });
  }
}

export function serializeHandle(input: unknown): SerializedExecutorHandle { return handleBoundary(input); }
export function restoreHandle(input: unknown): SerializedExecutorHandle { return handleBoundary(input); }

interface AdapterHandle extends AttemptHandle {
  readonly state: SerializedExecutorHandle;
  readonly terminalResult: () => PiHerdrTerminalResult | undefined;
  readonly lastError: () => ExecutorAdapterError | undefined;
}

function invokeCleanup(workspace: WorkspaceManagerPort, port: WorktreePort, lease: WorkspaceLease): WorktreeCleanup {
  try {
    return workspace.cleanup(port, lease);
  } catch (error) {
    return deepFreeze({ ok: false as const, error: { code: 'PORT_FAILURE' as const, message: `cleanup failed: ${errorMessage(error)}`, path: 'workspace.cleanup', available: [] } });
  }
}

function cleanupError(result: WorktreeCleanup, taskId?: string, attemptId?: string, leaseRef?: string): ExecutorAdapterError | undefined {
  if (result.ok) return undefined;
  return new ExecutorAdapterError({ code: 'CLEANUP_FAILURE', message: result.error.message, path: result.error.path, available: result.error.available, ...(taskId === undefined ? {} : { taskId }), ...(attemptId === undefined ? {} : { attemptId }), ...(leaseRef === undefined ? {} : { leaseRef }) });
}

function attemptKey(taskId: string, attemptId: string): string {
  return `${taskId}\u0000${attemptId}`;
}

/** Implements the existing polling ExecutorPort while keeping host transports injectable. */
export class PiHerdrExecutor implements ExecutorPort {
  private readonly options: PiHerdrExecutorOptions;
  private readonly pendingCleanup = new Map<string, WorkspaceLease>();
  private readonly retainedArtifacts = new Map<string, WorkspaceLease>();

  constructor(options: PiHerdrExecutorOptions) {
    try {
      const raw = options as unknown as Record<string, unknown>;
      if (!isPlainObject(raw) || !hasExactFields(raw, OPTIONS_FIELDS)) fail('INVALID_REQUEST', 'options', 'executor options have unknown or missing fields', OPTIONS_FIELDS);
      if (typeof ownValue(raw, 'clock') !== 'function') fail('INVALID_REQUEST', 'options.clock', 'clock must be a function');
      if (typeof ownValue(raw, 'dispatchResolver') !== 'function') fail('INVALID_REQUEST', 'options.dispatchResolver', 'dispatchResolver must be a function');
      for (const [path, port] of [['options.herdr', ownValue(raw, 'herdr')], ['options.workspace', ownValue(raw, 'workspace')], ['options.worktreePort', ownValue(raw, 'worktreePort')]] as const) {
        if (port === null || (typeof port !== 'object' && typeof port !== 'function')) fail('INVALID_REQUEST', path, `${path} must be an object`);
      }
      boundedString(ownValue(raw, 'roleId'), 'options.roleId', 256);
      boundedString(ownValue(raw, 'baseRevision'), 'options.baseRevision', MAX_ARTIFACT_REVISION_LENGTH);
      if (ownValue(raw, 'modelProfileId') !== undefined) boundedString(ownValue(raw, 'modelProfileId'), 'options.modelProfileId', 256);
      if (ownValue(raw, 'retainCancelledArtifacts') !== undefined && typeof ownValue(raw, 'retainCancelledArtifacts') !== 'boolean') fail('INVALID_REQUEST', 'options.retainCancelledArtifacts', 'retainCancelledArtifacts must be boolean');
      this.options = options;
    } catch (error) {
      if (error instanceof ExecutorAdapterError) throw error;
      fail('INVALID_REQUEST', 'options', 'executor options could not be inspected');
    }
  }

  start(input: ExecutorStartRequest): AttemptHandle {
    const request = validateStartRequest(input);
    let now: unknown;
    try { now = this.options.clock(); } catch { fail('INVALID_REQUEST', 'clock', 'clock failed'); }
    if (typeof now !== 'number' || !Number.isFinite(now)) fail('INVALID_REQUEST', 'clock', 'clock must return a finite number');
    const routeInput: Record<string, unknown> = { description: request.contract.objective, instructions: request.contract.objective, roleId: this.options.roleId };
    if (this.options.modelProfileId !== undefined) routeInput.modelProfileId = this.options.modelProfileId;
    let preflight: PreflightResult;
    try { preflight = this.options.dispatchResolver(deepFreeze(routeInput)); } catch (error) { fail('INVALID_BINDING', 'dispatchResolver', `dispatch resolver failed: ${errorMessage(error)}`); }
    const plan = normalizePlan(preflight);
    if (plan.role.id !== this.options.roleId || (this.options.modelProfileId !== undefined && plan.model.id !== this.options.modelProfileId)) fail('INVALID_BINDING', 'dispatchResolver.return.plan', 'dispatch binding does not match the requested role/model');
    const context = assembleScopedContext({
      taskId: request.taskId,
      objective: request.contract.objective,
      acceptanceCriteria: request.contract.acceptance_criteria,
      filesInScope: request.contract.files_in_scope ?? [],
      verificationCommands: request.contract.verification,
      role: { id: plan.role.id, kind: plan.role.kind },
      model: { profileId: plan.model.id, provider: plan.model.provider, model: plan.model.model },
      baseRevision: this.options.baseRevision,
      artifactRevision: this.options.baseRevision,
      evidenceSummaries: [],
      referenceSummaries: [],
    });
    let lease: WorkspaceLease;
    try { lease = this.options.workspace.acquire(this.options.worktreePort, request.taskId, request.attemptId, this.options.baseRevision); }
    catch (error) {
      if (error instanceof WorktreeManagerError) throw new ExecutorAdapterError({ code: 'WORKSPACE_FAILURE', message: error.message, path: error.path, available: error.available });
      throw new ExecutorAdapterError({ code: 'WORKSPACE_FAILURE', message: `workspace acquire failed: ${errorMessage(error)}`, path: 'workspace.acquire', available: [] });
    }
    let sessionId: string;
    try {
      const payload: HerdrSpawnRequest = deepFreeze({
        taskId: request.taskId, attemptId: request.attemptId, cwd: lease.workspacePath,
        roleId: plan.role.id, modelProfileId: plan.model.id, provider: plan.model.provider, model: plan.model.model,
        contract: request.contract, scopedContext: context, prompt: renderScopedPrompt(context), baseRevision: this.options.baseRevision,
      });
      sessionId = normalizeSpawn(this.options.herdr.spawn(payload));
      const binding: WorktreeSessionBinding = deepFreeze({
        taskId: request.taskId,
        attemptId: request.attemptId,
        sessionId,
        roleId: plan.role.id,
        modelProfileId: plan.model.id,
        filesInScope: context.filesInScope,
        baseRevision: this.options.baseRevision,
        workspacePath: lease.workspacePath,
        branch: lease.branch,
        ownershipToken: lease.ownershipToken,
        managedMarker: lease.managedMarker,
      });
      try { this.options.workspace.bindSession(this.options.worktreePort, lease, binding); }
      catch (error) {
        if (error instanceof WorktreeManagerError) throw new ExecutorAdapterError({ code: 'WORKSPACE_FAILURE', message: error.message, path: error.path, available: error.available });
        throw new ExecutorAdapterError({ code: 'WORKSPACE_FAILURE', message: `workspace session binding failed: ${errorMessage(error)}`, path: 'workspace.bindSession', available: [] });
      }
    } catch (error) {
      const cleanup = invokeCleanup(this.options.workspace, this.options.worktreePort, lease);
      const cleanupFailure = cleanupError(cleanup, request.taskId, request.attemptId, lease.workspacePath);
      if (cleanupFailure) {
        this.pendingCleanup.set(attemptKey(request.taskId, request.attemptId), lease);
        throw new ExecutorAdapterError({ code: 'CLEANUP_FAILURE', message: `spawn failed and cleanup failed: ${cleanupFailure.message}`, path: cleanupFailure.path, available: cleanupFailure.available, taskId: request.taskId, attemptId: request.attemptId, leaseRef: lease.workspacePath });
      }
      if (error instanceof ExecutorAdapterError) throw error;
      fail('TRANSPORT_FAILURE', 'herdr.spawn', `herdr spawn failed: ${errorMessage(error)}`);
    }
    const state = serializeHandle({ schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, sessionId, roleId: plan.role.id, modelProfileId: plan.model.id, filesInScope: context.filesInScope, workspacePath: lease.workspacePath, branch: lease.branch, ownershipToken: lease.ownershipToken, managedMarker: lease.managedMarker, baseRevision: lease.baseRevision });
    return this.makeHandle(state, lease, context);
  }

  /** Release a successful artifact only after verification/review/integration finish. */
  finalizeArtifact(taskId: string, attemptId: string): WorktreeCleanup {
    const key = attemptKey(boundedString(taskId, 'taskId', MAX_TASK_ID_LENGTH), boundedString(attemptId, 'attemptId', MAX_ATTEMPT_ID_LENGTH));
    const lease = this.retainedArtifacts.get(key);
    if (lease === undefined) return deepFreeze({ ok: false as const, error: { code: 'OWNERSHIP_MISMATCH' as const, message: 'no retained artifact for attempt', path: 'artifact', available: [] } });
    const result = invokeCleanup(this.options.workspace, this.options.worktreePort, lease);
    if (result.ok) {
      this.retainedArtifacts.delete(key);
      this.pendingCleanup.delete(key);
    } else this.pendingCleanup.set(key, lease);
    return result;
  }

  /** Lookup trusted host provenance for a retained artifact. */
  artifactLease(taskId: string, attemptId: string): WorkspaceLease | undefined {
    return this.retainedArtifacts.get(attemptKey(taskId, attemptId));
  }

  /** Retry only a previously failed lease cleanup; never starts a transport. */
  retryPendingCleanup(taskId: string, attemptId: string): { readonly ok: true } | { readonly ok: false; readonly error: ExecutorAdapterError } {
    const checkedTaskId = boundedString(taskId, 'taskId', MAX_TASK_ID_LENGTH);
    const checkedAttemptId = boundedString(attemptId, 'attemptId', MAX_ATTEMPT_ID_LENGTH);
    const key = attemptKey(checkedTaskId, checkedAttemptId);
    const lease = this.pendingCleanup.get(key);
    if (lease === undefined) return deepFreeze({ ok: false as const, error: new ExecutorAdapterError({ code: 'UNKNOWN_HANDLE', message: 'no pending cleanup for attempt', path: 'attempt', available: [], taskId: checkedTaskId, attemptId: checkedAttemptId }) });
    const failure = cleanupError(invokeCleanup(this.options.workspace, this.options.worktreePort, lease), checkedTaskId, checkedAttemptId, lease.workspacePath);
    if (failure) return deepFreeze({ ok: false as const, error: failure });
    this.pendingCleanup.delete(key);
    this.retainedArtifacts.delete(key);
    return deepFreeze({ ok: true as const });
  }

  /** Reattach to a persisted transport session; this never calls spawn. */
  reattach(input: unknown): AttemptHandle {
    try {
      const state = restoreHandle(input);
      if (state.baseRevision !== this.options.baseRevision) fail('INVALID_BINDING', 'handle.baseRevision', 'persisted base revision does not match executor configuration');
      if (state.roleId !== this.options.roleId) fail('INVALID_BINDING', 'handle.roleId', 'persisted role does not match executor configuration');
      if (this.options.modelProfileId !== undefined && state.modelProfileId !== this.options.modelProfileId) fail('INVALID_BINDING', 'handle.modelProfileId', 'persisted model does not match executor configuration');
      const leaseInput = deepFreeze({
        taskId: state.taskId,
        attemptId: state.attemptId,
        baseRevision: state.baseRevision,
        workspacePath: state.workspacePath,
        branch: state.branch,
        ownershipToken: state.ownershipToken,
        managedMarker: state.managedMarker,
      }) as WorkspaceLease;
      const binding: WorktreeSessionBinding = deepFreeze({
        taskId: state.taskId,
        attemptId: state.attemptId,
        sessionId: state.sessionId,
        roleId: state.roleId,
        modelProfileId: state.modelProfileId,
        filesInScope: state.filesInScope,
        baseRevision: state.baseRevision,
        workspacePath: state.workspacePath,
        branch: state.branch,
        ownershipToken: state.ownershipToken,
        managedMarker: state.managedMarker,
      });
      const lease = this.options.workspace.adoptLease(this.options.worktreePort, leaseInput, binding);
      return this.makeHandle(state, lease);
    } catch (error) {
      if (error instanceof ExecutorAdapterError) throw error;
      if (error instanceof WorktreeManagerError) fail('WORKSPACE_FAILURE', error.path, error.message, error.available);
      fail('WORKSPACE_FAILURE', 'worktree.verifyOwnership', `reattach ownership verification failed: ${errorMessage(error)}`);
    }
  }

  private makeHandle(state: SerializedExecutorHandle, lease: WorkspaceLease, _context?: ScopedContextBundle): AdapterHandle {
    let terminal: PiHerdrTerminalResult | undefined;
    let transportClosed = false;
    let interruptDone = false;
    let interrupted = false;
    let released = false;
    let boundaryError: ExecutorAdapterError | undefined;
    const setError = (error: ExecutorAdapterError): void => { boundaryError = error; };
    const closeTransport = (): boolean => {
      if (transportClosed) return true;
      try {
        this.options.herdr.close(state.sessionId);
        transportClosed = true;
        return true;
      } catch (error) {
        setError(new ExecutorAdapterError({ code: 'TRANSPORT_FAILURE', message: `herdr close failed: ${errorMessage(error)}`, path: 'herdr.close', available: [], taskId: state.taskId, attemptId: state.attemptId, leaseRef: state.workspacePath }));
        return false;
      }
    };
    const release = (): boolean => {
      if (released) return true;
      const result = invokeCleanup(this.options.workspace, this.options.worktreePort, lease);
      const cleanupFailure = cleanupError(result, state.taskId, state.attemptId, state.workspacePath);
      if (cleanupFailure) { setError(cleanupFailure); this.pendingCleanup.set(attemptKey(state.taskId, state.attemptId), lease); return false; }
      released = true;
      this.pendingCleanup.delete(attemptKey(state.taskId, state.attemptId));
      boundaryError = undefined;
      return true;
    };
    const finishTerminal = (): AttemptPollResult => {
      if (terminal === undefined) return { status: 'pending' };
      if (!closeTransport()) throw boundaryError!;
      if (terminal.settlement.acceptanceEligible) this.retainedArtifacts.set(attemptKey(state.taskId, state.attemptId), lease);
      else if (!release()) throw boundaryError!;
      return { status: 'settled', outcome: terminal.outcome, settlement: terminal.settlement };
    };
    const handle: AdapterHandle = {
      state,
      poll: () => {
        if (terminal !== undefined) return finishTerminal();
        if (transportClosed || interrupted) return { status: 'pending' };
        let raw: unknown;
        try { raw = this.options.herdr.poll(state.sessionId); }
        catch {
          const reason = 'transport poll failed';
          const settlement: AttemptSettlement = deepFreeze({ conclusion: reason, acceptanceEligible: false, artifact: deepFreeze({ artifactRevision: 'unavailable', workspacePath: state.workspacePath, branch: state.branch, changedPaths: Object.freeze([]) }), failureCode: 'TRANSPORT_FAILED', reason });
          terminal = deepFreeze({ taskId: state.taskId, attemptId: state.attemptId, sessionId: state.sessionId, workspacePath: state.workspacePath, branch: state.branch, baseRevision: state.baseRevision, artifactRevision: 'unavailable', changedPaths: Object.freeze([]), scopeAllowed: false, outcome: reason, settlement });
          return finishTerminal();
        }
        let observed: ReturnType<typeof normalizeTransportPoll>;
        try {
          observed = normalizeTransportPoll(raw);
        } catch (error) {
          const reason = 'malformed transport result';
          const settlement: AttemptSettlement = deepFreeze({ conclusion: reason, acceptanceEligible: false, artifact: deepFreeze({ artifactRevision: 'unavailable', workspacePath: state.workspacePath, branch: state.branch, changedPaths: Object.freeze([]) }), failureCode: 'MALFORMED_TRANSPORT', reason });
          terminal = deepFreeze({ taskId: state.taskId, attemptId: state.attemptId, sessionId: state.sessionId, workspacePath: state.workspacePath, branch: state.branch, baseRevision: state.baseRevision, artifactRevision: 'unavailable', changedPaths: Object.freeze([]), scopeAllowed: false, outcome: reason, settlement });
          return finishTerminal();
        }
        if (observed.kind === 'pending') return observed.activity === undefined ? { status: 'pending' } : { status: 'pending', activity: observed.activity };
        let inspection: WorkspaceInspection | undefined;
        let inspectionError: ExecutorAdapterError | undefined;
        try { inspection = this.options.workspace.inspect(this.options.worktreePort, lease); }
        catch (error) { inspectionError = new ExecutorAdapterError({ code: 'WORKSPACE_FAILURE', message: `workspace inspection failed: ${errorMessage(error)}`, path: 'workspace.inspectChangedPaths', available: [], taskId: state.taskId, attemptId: state.attemptId, leaseRef: state.workspacePath }); }
        const artifact: AttemptArtifact = inspection === undefined
          ? { artifactRevision: 'unavailable', changedPaths: [] }
          : { artifactRevision: inspection.artifactRevision, ...(inspection.diffRef === undefined ? {} : { diffRef: inspection.diffRef }), changedPaths: inspection.changedPaths, ...(inspection.clean === undefined ? {} : { clean: inspection.clean }), ...(inspection.commitsAhead === undefined ? {} : { commitsAhead: inspection.commitsAhead }) };
        const scope = inspection === undefined ? undefined : validateChangedPaths(inspection.changedPaths, state.filesInScope);
        const scopeAllowed = scope?.allowed === true;
        const artifactClean = inspection?.clean === undefined || inspection.clean;
        const artifactCommitted = inspection?.commitsAhead === undefined || inspection.commitsAhead > 0;
        const artifactFailure = !artifactClean ? 'artifact worktree is dirty' : !artifactCommitted ? 'artifact has no commits ahead of base' : undefined;
        const failureCode: SettlementFailureCode | undefined = inspectionError?.code === 'WORKSPACE_FAILURE'
          ? 'INSPECTION_FAILED'
          : observed.failureCode ?? (scopeAllowed ? (artifactFailure === undefined ? undefined : 'INSPECTION_FAILED') : 'SCOPE_VIOLATION');
        const outcome = inspectionError === undefined
          ? (scopeAllowed && artifactFailure === undefined ? observed.outcome : truncateForMessage(artifactFailure ?? `scope violation: ${scope?.violations.join(', ') ?? 'artifact inspection unavailable'}`))
          : 'artifact inspection failed';
        const eligible = inspectionError === undefined && observed.failureCode === undefined && scopeAllowed && artifactClean && artifactCommitted;
        const reason = inspectionError?.message ?? (failureCode === undefined ? undefined : (observed.reason ?? (artifactFailure ?? (failureCode === 'SCOPE_VIOLATION' ? 'changed paths exceed filesInScope' : outcome))));
        const settlement: AttemptSettlement = deepFreeze({
          conclusion: outcome,
          acceptanceEligible: eligible,
          artifact: deepFreeze({ artifactRevision: artifact.artifactRevision, workspacePath: state.workspacePath, branch: state.branch, ...(artifact.diffRef === undefined ? {} : { diffRef: artifact.diffRef }), changedPaths: Object.freeze([...artifact.changedPaths]), ...(artifact.clean === undefined ? {} : { clean: artifact.clean }), ...(artifact.commitsAhead === undefined ? {} : { commitsAhead: artifact.commitsAhead }) }),
          ...(failureCode === undefined ? {} : { failureCode }),
          ...(reason === undefined ? {} : { reason: truncateForMessage(reason) }),
        });
        terminal = deepFreeze({ taskId: state.taskId, attemptId: state.attemptId, sessionId: state.sessionId, workspacePath: state.workspacePath, branch: state.branch, baseRevision: state.baseRevision, artifactRevision: artifact.artifactRevision, ...(artifact.diffRef === undefined ? {} : { diffRef: artifact.diffRef }), changedPaths: artifact.changedPaths, scopeAllowed, outcome, settlement });
        return finishTerminal();
      },
      cancel: (reason: string) => {
        if (interruptDone || transportClosed) return;
        interrupted = true;
        try {
          this.options.herdr.interrupt(state.sessionId, boundedString(reason, 'cancel.reason', 160));
          interruptDone = true;
          boundaryError = undefined;
        } catch (error) {
          const failure = new ExecutorAdapterError({ code: 'TRANSPORT_FAILURE', message: `herdr interrupt failed: ${errorMessage(error)}`, path: 'herdr.interrupt', available: [], taskId: state.taskId, attemptId: state.attemptId, leaseRef: state.workspacePath });
          setError(failure); throw failure;
        }
      },
      close: () => {
        const closed = closeTransport();
        const shouldRelease = terminal === undefined || terminal.settlement.acceptanceEligible === false;
        const preserveInterrupted = this.options.retainCancelledArtifacts === true && interrupted && terminal === undefined;
        if (preserveInterrupted) this.retainedArtifacts.set(attemptKey(state.taskId, state.attemptId), lease);
        const cleaned = closed && (preserveInterrupted || !shouldRelease || release());
        if (!closed || !cleaned) throw boundaryError!;
      },
      terminalResult: () => terminal,
      lastError: () => boundaryError,
    };
    return handle;
  }
}

