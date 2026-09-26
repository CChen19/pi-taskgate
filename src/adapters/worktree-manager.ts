/** S8 worktree boundary. This module never calls git or the filesystem. */
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { deepFreeze, hasExactFields, isPlainObject, ownValue, truncateForMessage } from '../core/validate.ts';
import { MAX_ARTIFACT_REVISION_LENGTH } from '../core/verification.ts';
import { MAX_ATTEMPT_ID_LENGTH } from '../core/verification.ts';
import { MAX_TASK_ID_LENGTH } from '../core/task-contract.ts';
import { validateChangedPaths } from '../core/scope.ts';

export const WORKTREE_MARKER_PREFIX = 'agent-orchestrator:s8:';
export const MAX_WORKTREE_TOKEN_LENGTH = 128;
export const MAX_BRANCH_LENGTH = 256;

export interface WorktreeCreateRequest {
  readonly repoRoot: string;
  /** Included so a host ledger can persist identity before session binding. */
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly baseRevision: string;
  readonly ownershipToken: string;
}

export interface WorktreeCreateResult {
  readonly workspacePath: string;
  readonly branch: string;
  readonly ownershipToken: string;
  readonly managedMarker: string;
  readonly baseRevision: string;
}

export interface WorktreeInspectRequest {
  readonly workspacePath: string;
  readonly branch: string;
  readonly ownershipToken: string;
  readonly managedMarker: string;
}

export interface WorktreeInspectResult {
  readonly changedPaths: readonly string[];
  readonly artifactRevision: string;
  readonly diffRef?: string;
  readonly clean?: boolean;
  readonly commitsAhead?: number;
}

export interface WorktreeRemoveRequest {
  readonly workspacePath: string;
  readonly branch: string;
  readonly ownershipToken: string;
  readonly managedMarker: string;
}

export interface WorktreeSessionBinding extends WorktreeRemoveRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly roleId: string;
  readonly modelProfileId: string;
  readonly filesInScope: readonly string[];
  readonly baseRevision: string;
}

export interface WorktreeVerifyRequest extends WorktreeSessionBinding {}

export interface WorktreeVerifyResult extends WorktreeSessionBinding {
  readonly owned: boolean;
}

/** Host supplied fakeable port. A production host may back it with git later. */
export interface WorktreePort {
  create(request: WorktreeCreateRequest): unknown;
  bindSession(request: WorktreeSessionBinding): unknown;
  inspectChangedPaths(request: WorktreeInspectRequest): unknown;
  verifyOwnership(request: WorktreeVerifyRequest): unknown;
  remove(request: WorktreeRemoveRequest): unknown;
}

export interface WorkspaceLease {
  readonly taskId: string;
  readonly attemptId: string;
  readonly baseRevision: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly ownershipToken: string;
  readonly managedMarker: string;
}

export interface WorktreeManagerOptions {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly idSource: () => string;
  /**
   * `compact` keeps directory names short (`t1-a1-<hash>`) so paths derived
   * from the worktree cwd (e.g. Pier's Unix-socket pipe names) stay within OS
   * limits. Default `legacy` preserves the original descriptive names.
   */
  readonly naming?: 'legacy' | 'compact';
}

export interface WorkspaceInspection extends WorktreeInspectResult {}

export interface WorktreeCleanupResult {
  readonly ok: true;
  readonly lease: WorkspaceLease;
}

export interface WorktreeCleanupFailure {
  readonly ok: false;
  readonly error: WorktreeErrorData;
}

export type WorktreeCleanup = WorktreeCleanupResult | WorktreeCleanupFailure;

export type WorktreeErrorCode =
  | 'INVALID_WORKTREE'
  | 'PATH_CONTAINMENT'
  | 'OWNERSHIP_MISMATCH'
  | 'PORT_FAILURE'
  | 'INVALID_PORT_RESULT'
  | 'COLLISION';

export interface WorktreeErrorData {
  readonly code: WorktreeErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
}

export class WorktreeManagerError extends Error implements WorktreeErrorData {
  readonly code: WorktreeErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(data: WorktreeErrorData) {
    super(truncateForMessage(data.message));
    this.name = 'WorktreeManagerError';
    this.code = data.code;
    this.path = data.path;
    this.available = Object.freeze([...data.available]);
  }
}

const CREATE_FIELDS = ['workspacePath', 'branch', 'ownershipToken', 'managedMarker', 'baseRevision'] as const;
const INSPECT_FIELDS = ['changedPaths', 'artifactRevision', 'diffRef', 'clean', 'commitsAhead'] as const;
const BINDING_FIELDS = ['taskId', 'attemptId', 'sessionId', 'roleId', 'modelProfileId', 'filesInScope', 'baseRevision', 'workspacePath', 'branch', 'ownershipToken', 'managedMarker'] as const;
const VERIFY_FIELDS = ['owned', ...BINDING_FIELDS] as const;
const LEASE_FIELDS = ['taskId', 'attemptId', 'baseRevision', 'workspacePath', 'branch', 'ownershipToken', 'managedMarker'] as const;
const OPTIONS_FIELDS = ['repoRoot', 'workspaceRoot', 'idSource', 'naming'] as const;

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || 'port threw an Error';
  } catch {
    return 'port threw an uninspectable Error';
  }
  return 'port threw a non-Error value';
}

function fail(code: WorktreeErrorCode, path: string, message: string, available: readonly string[] = []): never {
  throw new WorktreeManagerError({ code, path, message, available });
}

function safeObject(value: unknown, path: string): Record<string, unknown> {
  try {
    if (!isPlainObject(value)) fail('INVALID_PORT_RESULT', path, `${path} must be a plain object`);
    return value;
  } catch (error) {
    if (error instanceof WorktreeManagerError) throw error;
    fail('INVALID_PORT_RESULT', path, `${path} could not be inspected`);
  }
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  try {
    if (!hasExactFields(value, fields)) fail('INVALID_PORT_RESULT', path, `${path} has unknown fields`, fields);
  } catch (error) {
    if (error instanceof WorktreeManagerError) throw error;
    fail('INVALID_PORT_RESULT', path, `${path} could not be inspected`);
  }
}

function stringValue(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) fail('INVALID_PORT_RESULT', path, `${path} must be a bounded non-empty string`);
  return value;
}

function absolutePath(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || !isAbsolute(value)) {
    fail('INVALID_WORKTREE', path, `${path} must be an absolute normalized path`);
  }
  return normalize(resolve(value));
}

function contained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder !== '' && !remainder.startsWith('..') && !isAbsolute(remainder);
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function hasGitSegment(value: string): boolean {
  return value.split('/').some((segment) => asciiLower(segment) === '.git');
}

function safeWorkspacePath(root: string, repoRoot: string, candidate: unknown): string {
  const path = absolutePath(candidate, 'workspacePath');
  if (!contained(root, path) || path === repoRoot || hasGitSegment(path) || path === resolve(repoRoot, '.git')) {
    fail('PATH_CONTAINMENT', 'workspacePath', 'workspace path is outside the managed workspace or protected root');
  }
  return path;
}

function safeBranch(value: unknown): string {
  const branch = stringValue(value, 'branch', MAX_BRANCH_LENGTH);
  if (branch.includes('..') || branch.includes('\\') || branch.startsWith('/') || branch.endsWith('/') || hasGitSegment(branch)) fail('INVALID_PORT_RESULT', 'branch', 'branch contains a forbidden path form');
  return branch;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  return `${cleaned}-${hash(value)}`;
}

function key(taskId: string, attemptId: string): string {
  return `${taskId}\u0000${attemptId}`;
}

function compactName(taskId: string, attemptId: string, source: string): string {
  const task = taskId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'task';
  const ordinal = /attempt-(\d+)$/.exec(attemptId)?.[1];
  const attempt = ordinal === undefined ? `x${hash(attemptId)}` : `a${ordinal}`;
  return `${task}-${attempt}-${hash(`${taskId}\0${attemptId}\0${source}`)}`;
}

function validateOptions(options: WorktreeManagerOptions): { repoRoot: string; workspaceRoot: string; idSource: () => string; naming: 'legacy' | 'compact' } {
  try {
    const raw = options as unknown as Record<string, unknown>;
    if (!isPlainObject(raw) || !hasExactFields(raw, OPTIONS_FIELDS)) fail('INVALID_WORKTREE', 'options', 'worktree options are invalid', OPTIONS_FIELDS);
    if (typeof ownValue(raw, 'idSource') !== 'function') fail('INVALID_WORKTREE', 'options.idSource', 'idSource must be a function');
    const repoRoot = absolutePath(ownValue(raw, 'repoRoot'), 'options.repoRoot');
    const workspaceRoot = absolutePath(ownValue(raw, 'workspaceRoot'), 'options.workspaceRoot');
    if (hasGitSegment(repoRoot)) fail('PATH_CONTAINMENT', 'options.repoRoot', 'repoRoot contains a protected .git path segment');
    if (hasGitSegment(workspaceRoot)) fail('PATH_CONTAINMENT', 'options.workspaceRoot', 'workspaceRoot contains a protected .git path segment');
    const naming = ownValue(raw, 'naming');
    if (naming !== undefined && naming !== 'legacy' && naming !== 'compact') fail('INVALID_WORKTREE', 'options.naming', 'naming must be legacy or compact');
    return { repoRoot, workspaceRoot, idSource: ownValue(raw, 'idSource') as () => string, naming: naming === 'compact' ? 'compact' : 'legacy' };
  } catch (error) {
    if (error instanceof WorktreeManagerError) throw error;
    fail('INVALID_WORKTREE', 'options', 'worktree options could not be inspected');
  }
}

function optionalPortString(raw: Record<string, unknown>, field: string, fallback: string, maximum: number): string {
  const value = ownValue(raw, field);
  return value === undefined ? fallback : stringValue(value, `worktree.create.return.${field}`, maximum);
}

function normalizeCreateResult(value: unknown, expected: WorktreeCreateRequest, workspaceRoot: string, repoRoot: string): WorktreeCreateResult {
  const raw = safeObject(value, 'worktree.create.return');
  exact(raw, CREATE_FIELDS, 'worktree.create.return');
  const result = {
    workspacePath: safeWorkspacePath(workspaceRoot, repoRoot, optionalPortString(raw, 'workspacePath', expected.workspacePath, MAX_ARTIFACT_REVISION_LENGTH)),
    branch: safeBranch(optionalPortString(raw, 'branch', expected.branch, MAX_BRANCH_LENGTH)),
    ownershipToken: optionalPortString(raw, 'ownershipToken', expected.ownershipToken, MAX_WORKTREE_TOKEN_LENGTH),
    managedMarker: stringValue(ownValue(raw, 'managedMarker'), 'worktree.create.return.managedMarker', MAX_WORKTREE_TOKEN_LENGTH + WORKTREE_MARKER_PREFIX.length),
    baseRevision: optionalPortString(raw, 'baseRevision', expected.baseRevision, MAX_ARTIFACT_REVISION_LENGTH),
  };
  if (result.workspacePath !== expected.workspacePath || result.branch !== expected.branch || result.ownershipToken !== expected.ownershipToken || result.baseRevision !== expected.baseRevision || result.managedMarker !== `${WORKTREE_MARKER_PREFIX}${expected.ownershipToken}`) {
    fail('OWNERSHIP_MISMATCH', 'worktree.create.return', 'worktree port returned a lease that does not match the requested ownership');
  }
  return result;
}

function validateRemoveResult(value: unknown): void {
  if (value === undefined || value === true) return;
  if (value === false) fail('PORT_FAILURE', 'worktree.remove.return', 'worktree remove reported failure');
  const raw = safeObject(value, 'worktree.remove.return');
  exact(raw, ['ok', 'message'], 'worktree.remove.return');
  if (ownValue(raw, 'ok') !== true) {
    const message = ownValue(raw, 'message');
    fail('PORT_FAILURE', 'worktree.remove.return', typeof message === 'string' && message.length > 0 ? message : 'worktree remove reported failure');
  }
}

function normalizedScope(value: unknown, path: string): readonly string[] {
  try {
    return validateChangedPaths([], value).filesInScope;
  } catch {
    fail('INVALID_PORT_RESULT', path, `${path} is not a safe filesInScope array`);
  }
}

function normalizeBindingFields(raw: Record<string, unknown>, path: string, workspaceRoot: string, repoRoot: string): WorktreeSessionBinding {
  return deepFreeze({
    taskId: stringValue(ownValue(raw, 'taskId'), `${path}.taskId`, MAX_TASK_ID_LENGTH),
    attemptId: stringValue(ownValue(raw, 'attemptId'), `${path}.attemptId`, MAX_ATTEMPT_ID_LENGTH),
    sessionId: stringValue(ownValue(raw, 'sessionId'), `${path}.sessionId`, MAX_ATTEMPT_ID_LENGTH),
    roleId: stringValue(ownValue(raw, 'roleId'), `${path}.roleId`, MAX_BRANCH_LENGTH),
    modelProfileId: stringValue(ownValue(raw, 'modelProfileId'), `${path}.modelProfileId`, MAX_BRANCH_LENGTH),
    filesInScope: normalizedScope(ownValue(raw, 'filesInScope'), `${path}.filesInScope`),
    baseRevision: stringValue(ownValue(raw, 'baseRevision'), `${path}.baseRevision`, MAX_ARTIFACT_REVISION_LENGTH),
    workspacePath: safeWorkspacePath(workspaceRoot, repoRoot, ownValue(raw, 'workspacePath')),
    branch: safeBranch(ownValue(raw, 'branch')),
    ownershipToken: stringValue(ownValue(raw, 'ownershipToken'), `${path}.ownershipToken`, MAX_WORKTREE_TOKEN_LENGTH),
    managedMarker: stringValue(ownValue(raw, 'managedMarker'), `${path}.managedMarker`, MAX_WORKTREE_TOKEN_LENGTH + WORKTREE_MARKER_PREFIX.length),
  });
}

function sameBinding(actual: WorktreeSessionBinding, expected: WorktreeSessionBinding): boolean {
  return actual.taskId === expected.taskId && actual.attemptId === expected.attemptId && actual.sessionId === expected.sessionId && actual.roleId === expected.roleId && actual.modelProfileId === expected.modelProfileId && actual.baseRevision === expected.baseRevision && actual.workspacePath === expected.workspacePath && actual.branch === expected.branch && actual.ownershipToken === expected.ownershipToken && actual.managedMarker === expected.managedMarker && actual.filesInScope.length === expected.filesInScope.length && actual.filesInScope.every((entry, index) => entry === expected.filesInScope[index]);
}

function normalizeVerifyResult(value: unknown, expected: WorktreeSessionBinding, workspaceRoot: string, repoRoot: string): WorktreeSessionBinding {
  const raw = safeObject(value, 'worktree.verifyOwnership.return');
  exact(raw, VERIFY_FIELDS, 'worktree.verifyOwnership.return');
  if (ownValue(raw, 'owned') !== true) fail('OWNERSHIP_MISMATCH', 'worktree.verifyOwnership.return.owned', 'host did not verify the session ownership');
  const result = normalizeBindingFields(raw, 'worktree.verifyOwnership.return', workspaceRoot, repoRoot);
  if (!sameBinding(result, expected)) fail('OWNERSHIP_MISMATCH', 'worktree.verifyOwnership.return', 'host binding does not match the persisted recovery binding');
  return result;
}

function normalizeInspectResult(value: unknown): WorkspaceInspection {
  const raw = safeObject(value, 'worktree.inspectChangedPaths.return');
  exact(raw, INSPECT_FIELDS, 'worktree.inspectChangedPaths.return');
  const changed = ownValue(raw, 'changedPaths');
  if (!Array.isArray(changed)) fail('INVALID_PORT_RESULT', 'worktree.inspectChangedPaths.return.changedPaths', 'changedPaths must be an array');
  const checked = validateChangedPaths(changed, changed);
  if (!checked.ok) fail('INVALID_PORT_RESULT', 'worktree.inspectChangedPaths.return.changedPaths', 'changed paths were rejected');
  const artifactRevision = stringValue(ownValue(raw, 'artifactRevision'), 'worktree.inspectChangedPaths.return.artifactRevision', MAX_ARTIFACT_REVISION_LENGTH);
  const diffRefValue = ownValue(raw, 'diffRef');
  if (diffRefValue !== undefined && (typeof diffRefValue !== 'string' || diffRefValue.length === 0 || diffRefValue.length > MAX_ARTIFACT_REVISION_LENGTH)) fail('INVALID_PORT_RESULT', 'worktree.inspectChangedPaths.return.diffRef', 'diffRef must be bounded when present');
  const cleanValue = ownValue(raw, 'clean');
  if (cleanValue !== undefined && typeof cleanValue !== 'boolean') fail('INVALID_PORT_RESULT', 'worktree.inspectChangedPaths.return.clean', 'clean must be boolean');
  const commitsAheadValue = ownValue(raw, 'commitsAhead');
  if (commitsAheadValue !== undefined && (typeof commitsAheadValue !== 'number' || !Number.isInteger(commitsAheadValue) || commitsAheadValue < 0)) fail('INVALID_PORT_RESULT', 'worktree.inspectChangedPaths.return.commitsAhead', 'commitsAhead must be a non-negative integer');
  return deepFreeze({ changedPaths: checked.changedPaths, artifactRevision, ...(diffRefValue === undefined ? {} : { diffRef: diffRefValue as string }), ...(cleanValue === undefined ? {} : { clean: cleanValue }), ...(commitsAheadValue === undefined ? {} : { commitsAhead: commitsAheadValue }) });
}

/** Per-attempt deterministic ownership manager over an injected WorktreePort. */
export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly workspaceRoot: string;
  private readonly idSource: () => string;
  private readonly naming: 'legacy' | 'compact';
  private readonly active = new Map<string, WorkspaceLease>();
  private readonly paths = new Set<string>();
  private readonly branches = new Set<string>();
  private readonly released = new Map<string, WorkspaceLease>();

  constructor(options: WorktreeManagerOptions) {
    const normalized = validateOptions(options);
    this.repoRoot = normalized.repoRoot;
    this.workspaceRoot = normalized.workspaceRoot;
    this.idSource = normalized.idSource;
    this.naming = normalized.naming;
  }

  acquire(port: WorktreePort, taskId: string, attemptId: string, baseRevision: string): WorkspaceLease {
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH) fail('INVALID_WORKTREE', 'taskId', 'taskId is invalid');
    if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > MAX_ATTEMPT_ID_LENGTH) fail('INVALID_WORKTREE', 'attemptId', 'attemptId is invalid');
    if (typeof baseRevision !== 'string' || baseRevision.length === 0 || baseRevision.length > MAX_ARTIFACT_REVISION_LENGTH) fail('INVALID_WORKTREE', 'baseRevision', 'baseRevision is invalid');
    const ownershipKey = key(taskId, attemptId);
    if (this.active.has(ownershipKey)) fail('COLLISION', 'attemptId', 'attempt already owns a workspace');
    this.released.delete(ownershipKey);
    let source: unknown;
    try { source = this.idSource(); } catch { fail('INVALID_WORKTREE', 'idSource', 'idSource failed'); }
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_WORKTREE_TOKEN_LENGTH) fail('INVALID_WORKTREE', 'idSource.return', 'idSource must return a bounded non-empty string');
    const token = `${slug(source)}-${hash(`${taskId}\0${attemptId}\0${source}`)}`.slice(0, MAX_WORKTREE_TOKEN_LENGTH);
    const baseName = this.naming === 'compact' ? compactName(taskId, attemptId, source) : `${slug(taskId)}--${slug(attemptId)}--${token}`;
    const branchPrefix = this.naming === 'compact' ? 'ao' : 'orchestrator';
    let suffix = 0;
    let workspacePath = resolve(this.workspaceRoot, baseName);
    let branch = `${branchPrefix}/${baseName}`;
    while (this.paths.has(workspacePath) || this.branches.has(branch)) {
      suffix++;
      workspacePath = resolve(this.workspaceRoot, `${baseName}-${suffix}`);
      branch = `${branchPrefix}/${baseName}-${suffix}`;
    }
    safeWorkspacePath(this.workspaceRoot, this.repoRoot, workspacePath);
    const expected: WorktreeCreateRequest = { repoRoot: this.repoRoot, taskId, attemptId, workspacePath, branch, baseRevision, ownershipToken: token };
    try {
      const created = normalizeCreateResult(port.create(deepFreeze({ ...expected })), expected, this.workspaceRoot, this.repoRoot);
      const lease = deepFreeze({ taskId, attemptId, baseRevision, workspacePath: created.workspacePath, branch: created.branch, ownershipToken: created.ownershipToken, managedMarker: created.managedMarker });
      this.active.set(ownershipKey, lease); this.paths.add(lease.workspacePath); this.branches.add(lease.branch);
      return lease;
    } catch (error) {
      // A create implementation may have created a resource before throwing; only the
      // exact intended marker/token is eligible for best-effort removal.
      try { port.remove(deepFreeze({ workspacePath, branch, ownershipToken: token, managedMarker: `${WORKTREE_MARKER_PREFIX}${token}` })); } catch { /* preserve the primary structured error */ }
      if (error instanceof WorktreeManagerError) throw error;
      fail('PORT_FAILURE', 'worktree.create', `worktree create failed: ${errorMessage(error)}`);
    }
  }

  inspect(port: WorktreePort, leaseInput: unknown): WorkspaceInspection {
    try {
      const lease = this.ownedLease(leaseInput);
      return normalizeInspectResult(port.inspectChangedPaths(deepFreeze({ workspacePath: lease.workspacePath, branch: lease.branch, ownershipToken: lease.ownershipToken, managedMarker: lease.managedMarker })));
    } catch (error) {
      if (error instanceof WorktreeManagerError) throw error;
      fail('PORT_FAILURE', 'worktree.inspectChangedPaths', `worktree inspection failed: ${errorMessage(error)}`);
    }
  }

  cleanup(port: WorktreePort, leaseInput: unknown): WorktreeCleanup {
    try {
      if (isPlainObject(leaseInput)) {
        const taskId = ownValue(leaseInput, 'taskId');
        const attemptId = ownValue(leaseInput, 'attemptId');
        if (typeof taskId === 'string' && typeof attemptId === 'string') {
          const released = this.released.get(key(taskId, attemptId));
          if (released !== undefined && (leaseInput as unknown) === released) return deepFreeze({ ok: true, lease: released });
        }
      }
      const lease = this.ownedLease(leaseInput);
      try {
        validateRemoveResult(port.remove(deepFreeze({ workspacePath: lease.workspacePath, branch: lease.branch, ownershipToken: lease.ownershipToken, managedMarker: lease.managedMarker })));
      } catch (error) {
        return deepFreeze({ ok: false, error: { code: 'PORT_FAILURE', message: truncateForMessage(`worktree remove failed: ${errorMessage(error)}`), path: 'worktree.remove', available: [] } });
      }
      this.active.delete(key(lease.taskId, lease.attemptId)); this.paths.delete(lease.workspacePath); this.branches.delete(lease.branch);
      this.released.set(key(lease.taskId, lease.attemptId), lease);
      return deepFreeze({ ok: true, lease });
    } catch (error) {
      if (error instanceof WorktreeManagerError) return deepFreeze({ ok: false, error: { code: error.code, message: error.message, path: error.path, available: [...error.available] } });
      return deepFreeze({ ok: false, error: { code: 'PORT_FAILURE', message: 'worktree cleanup failed', path: 'worktree.remove', available: [] } });
    }
  }

  private ownedLease(value: unknown): WorkspaceLease {
    if (!isPlainObject(value)) fail('OWNERSHIP_MISMATCH', 'lease', 'lease is not a plain object');
    const taskId = ownValue(value, 'taskId'); const attemptId = ownValue(value, 'attemptId');
    if (typeof taskId !== 'string' || typeof attemptId !== 'string') fail('OWNERSHIP_MISMATCH', 'lease', 'lease identity is invalid');
    const owned = this.active.get(key(taskId, attemptId));
    if (owned === undefined || (value as unknown) !== owned) fail('OWNERSHIP_MISMATCH', 'lease', 'lease is not owned by this manager');
    if (ownValue(value, 'ownershipToken') !== owned.ownershipToken || ownValue(value, 'managedMarker') !== owned.managedMarker) fail('OWNERSHIP_MISMATCH', 'lease', 'ownership token or marker does not match');
    return owned;
  }

  /** Bind a live session in the host ledger after spawn. */
  bindSession(port: WorktreePort, leaseInput: WorkspaceLease, bindingInput: WorktreeSessionBinding): WorktreeSessionBinding {
    try {
      const lease = this.ownedLease(leaseInput);
      if (!isPlainObject(bindingInput) || !hasExactFields(bindingInput, BINDING_FIELDS)) fail('OWNERSHIP_MISMATCH', 'binding', 'session binding has unknown or missing fields', BINDING_FIELDS);
      const expected = normalizeBindingFields(bindingInput, 'binding', this.workspaceRoot, this.repoRoot);
      if (expected.taskId !== lease.taskId || expected.attemptId !== lease.attemptId || expected.baseRevision !== lease.baseRevision || expected.workspacePath !== lease.workspacePath || expected.branch !== lease.branch || expected.ownershipToken !== lease.ownershipToken || expected.managedMarker !== lease.managedMarker) fail('OWNERSHIP_MISMATCH', 'binding', 'session binding does not match the lease');
      return normalizeVerifyResult(port.bindSession(deepFreeze(expected)), expected, this.workspaceRoot, this.repoRoot);
    } catch (error) {
      if (error instanceof WorktreeManagerError) throw error;
      fail('PORT_FAILURE', 'worktree.bindSession', `worktree session binding failed: ${errorMessage(error)}`);
    }
  }

  /** Verify a persisted lease and complete session binding before registering it for recovery. */
  adoptLease(port: WorktreePort, input: WorkspaceLease, bindingInput: WorktreeSessionBinding): WorkspaceLease {
    try {
      if (!isPlainObject(input) || !hasExactFields(input, LEASE_FIELDS)) fail('OWNERSHIP_MISMATCH', 'lease', 'lease has unknown or missing fields', LEASE_FIELDS);
      const taskId = stringValue(ownValue(input, 'taskId'), 'lease.taskId', MAX_TASK_ID_LENGTH);
      const attemptId = stringValue(ownValue(input, 'attemptId'), 'lease.attemptId', MAX_ATTEMPT_ID_LENGTH);
      const baseRevision = stringValue(ownValue(input, 'baseRevision'), 'lease.baseRevision', MAX_ARTIFACT_REVISION_LENGTH);
      const workspacePath = safeWorkspacePath(this.workspaceRoot, this.repoRoot, ownValue(input, 'workspacePath'));
      const branch = safeBranch(ownValue(input, 'branch'));
      const ownershipToken = stringValue(ownValue(input, 'ownershipToken'), 'lease.ownershipToken', MAX_WORKTREE_TOKEN_LENGTH);
      const managedMarker = stringValue(ownValue(input, 'managedMarker'), 'lease.managedMarker', MAX_WORKTREE_TOKEN_LENGTH + WORKTREE_MARKER_PREFIX.length);
      if (managedMarker !== `${WORKTREE_MARKER_PREFIX}${ownershipToken}`) fail('OWNERSHIP_MISMATCH', 'lease.managedMarker', 'managed marker does not match ownership token');
      if (!isPlainObject(bindingInput) || !hasExactFields(bindingInput, BINDING_FIELDS)) fail('OWNERSHIP_MISMATCH', 'binding', 'session binding has unknown or missing fields', BINDING_FIELDS);
      const expected = normalizeBindingFields(bindingInput, 'binding', this.workspaceRoot, this.repoRoot);
      const leaseBinding = deepFreeze({ taskId, attemptId, sessionId: expected.sessionId, roleId: expected.roleId, modelProfileId: expected.modelProfileId, filesInScope: expected.filesInScope, baseRevision, workspacePath, branch, ownershipToken, managedMarker });
      if (!sameBinding(expected, leaseBinding)) fail('OWNERSHIP_MISMATCH', 'binding', 'session binding does not match the persisted lease');
      const verified = normalizeVerifyResult(port.verifyOwnership(deepFreeze(leaseBinding)), leaseBinding, this.workspaceRoot, this.repoRoot);
      const ownershipKey = key(taskId, attemptId);
      if (this.active.has(ownershipKey) || this.paths.has(workspacePath) || this.branches.has(branch)) fail('COLLISION', 'lease', 'persisted lease collides with an active lease');
      const lease = deepFreeze({ taskId, attemptId, baseRevision, workspacePath: verified.workspacePath, branch: verified.branch, ownershipToken: verified.ownershipToken, managedMarker: verified.managedMarker });
      this.active.set(ownershipKey, lease); this.paths.add(workspacePath); this.branches.add(branch);
      return lease;
    } catch (error) {
      if (error instanceof WorktreeManagerError) throw error;
      fail('PORT_FAILURE', 'worktree.verifyOwnership', `worktree ownership verification failed: ${errorMessage(error)}`);
    }
  }

  /** Exposed for recovery codecs without revealing mutable manager state. */
  hasLease(lease: WorkspaceLease): boolean {
    try {
      return this.active.get(key(lease.taskId, lease.attemptId)) === lease;
    } catch {
      fail('OWNERSHIP_MISMATCH', 'lease', 'lease could not be inspected');
    }
  }
}
