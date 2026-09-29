/**
 * Human-authored configuration for the main-session orchestration tools.
 *
 * The verification allowlist and repository roots come only from this file,
 * never from the model: a main agent cannot authorize its own commands.
 * Unknown fields, relative paths, and credential-shaped keys fail closed.
 */
import { isAbsolute, normalize, relative } from 'node:path';
import { hasExactFields, isPlainObject, ownValue } from '../core/validate.ts';
import { pierPipeProblem } from '../host/pier-ledger.ts';

/** Longest compact worktree directory name (`<task≤12>-a<n>-<hash>`) budgeted for. */
const WORKTREE_LEAF_ALLOWANCE = 24;

export interface OrchestrationConfig {
  readonly version: 1;
  /** Absolute path of the target git repository (main checkout; never modified). */
  readonly repoRoot: string;
  /** Absolute directory for task worktrees; must be outside repoRoot. */
  readonly workspaceRoot: string;
  /** Exact command strings the host may run for verification. */
  readonly verificationAllowlist: readonly string[];
  readonly verificationTimeoutMs: number;
  /** Pier role used for reviewers; must be read-only (checked before each dispatch). */
  readonly reviewerRole: string;
  /** Mechanical check failures tolerated within one attempt before it is failed. */
  readonly maxChecksPerAttempt: number;
  /** Default attempt budget when a task omits retry.max_attempts. */
  readonly defaultMaxAttempts: number;
  /** Optional override of Pier's role directories (default: Pier's lookup order). */
  readonly roleDirs?: readonly string[];
  /** Optional override of Pier's history roots (default: Pier's storage layout). */
  /**
   * Paths parallel tasks may both change, written by a human. The main agent
   * can only reference these in planned_overlap; it cannot add new ones.
   * In the file, an entry is a path or `{ "path": ..., "merge": "union" }`.
   */
  readonly sharedPaths: readonly string[];
  /**
   * The shared files (a subset of sharedPaths) that integration merges with
   * Git's union driver, keeping every task's added lines. Tasks may only add
   * lines to them.
   */
  readonly unionMergePaths: readonly string[];
  /** Most agents (workers and reviewers) running at once, counted by the host; unset means no cap. */
  readonly maxParallelAgents?: number;
  /**
   * Reject new assert( calls in C/C++ test sources. For repositories whose
   * verification builds tests with -DNDEBUG, where assert() is compiled out.
   */
  readonly rejectTestAsserts: boolean;
  readonly pierHistoryRoots?: readonly string[];
}

const FIELDS = ['version', 'repoRoot', 'workspaceRoot', 'verificationAllowlist', 'verificationTimeoutMs', 'reviewerRole', 'maxChecksPerAttempt', 'defaultMaxAttempts', 'roleDirs', 'pierHistoryRoots', 'sharedPaths', 'rejectTestAsserts', 'maxParallelAgents'] as const;
const CREDENTIAL_KEY = /^(credentials?|token|password|api[_-]?key|secret|auth)$/i;

export class OrchestrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationConfigError';
  }
}

function fail(message: string): never {
  throw new OrchestrationConfigError(message);
}

function absolute(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) fail(`${path} must be an absolute path`);
  return normalize(value).replace(/\/+$/, '') || '/';
}

function positiveInteger(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(`${path} must be a positive integer`);
  return value;
}

function absoluteList(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) fail(`${path} must be a non-empty array`);
  return Object.freeze(value.map((entry, index) => absolute(entry, `${path}[${index}]`)));
}

function flag(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(`${path} must be true or false`);
  return value;
}

/** Repository-relative paths (trailing slash = directory), as in files_in_scope. */
function repoPaths(value: unknown, path: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.includes('\0') || entry.startsWith('/') || entry.split('/').includes('..'))) {
    fail(`${path} must be an array of repository-relative paths`);
  }
  return Object.freeze([...new Set(value as string[])]);
}

/** Plain file paths only, so they can be written to a Git attributes file as they are. */
const UNION_PATH = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

/** `sharedPaths` entries: a repository-relative path, or `{ path, merge: "union" }` for a file. */
function sharedPaths(value: unknown, path: string): { readonly all: readonly string[]; readonly union: readonly string[] } {
  if (value === undefined) return { all: Object.freeze([]), union: Object.freeze([]) };
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  const plain: unknown[] = [];
  const union: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) { plain.push(entry); continue; }
    if (!hasExactFields(entry, ['path', 'merge'])) fail(`${path}[${index}] may only have the fields path and merge`);
    const file = ownValue(entry, 'path');
    if (ownValue(entry, 'merge') !== 'union') fail(`${path}[${index}].merge must be "union"`);
    if (typeof file !== 'string' || !UNION_PATH.test(file) || file.split('/').some((segment) => segment === '.' || segment === '..')) fail(`${path}[${index}].path must be a plain repository-relative file path (letters, digits, . _ + - and /)`);
    union.push(file);
  }
  const all = repoPaths([...plain, ...union], path);
  return { all, union: Object.freeze([...new Set(union)]) };
}

function rejectCredentials(value: unknown, path: string): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => rejectCredentials(entry, `${path}[${index}]`)); return; }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) fail(`${path}.${key} must not contain credentials`);
    rejectCredentials(entry, `${path}.${key}`);
  }
}

export function parseOrchestrationConfig(input: unknown): OrchestrationConfig {
  rejectCredentials(input, 'config');
  if (!isPlainObject(input)) fail('config must be a JSON object');
  if (!hasExactFields(input, FIELDS)) fail(`config has unknown fields; allowed: ${FIELDS.join(', ')}`);
  if (ownValue(input, 'version') !== 1) fail('config.version must be 1');
  const repoRoot = absolute(ownValue(input, 'repoRoot'), 'config.repoRoot');
  const workspaceRoot = absolute(ownValue(input, 'workspaceRoot'), 'config.workspaceRoot');
  const inside = relative(repoRoot, workspaceRoot);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) fail('config.workspaceRoot must be outside config.repoRoot');
  if (workspaceRoot.split('/').some((segment) => segment.toLowerCase() === '.git')) fail('config.workspaceRoot must not contain a .git segment');
  const pipe = pierPipeProblem(`${workspaceRoot}/${'x'.repeat(WORKTREE_LEAF_ALLOWANCE)}`);
  if (pipe !== undefined) fail(`config.workspaceRoot is too long for Pier subagents: ${pipe}`);
  const allowlist = ownValue(input, 'verificationAllowlist');
  if (!Array.isArray(allowlist) || allowlist.length === 0 || allowlist.some((entry) => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 1024)) {
    fail('config.verificationAllowlist must be a non-empty array of command strings');
  }
  const reviewerRole = ownValue(input, 'reviewerRole');
  if (typeof reviewerRole !== 'string' || !/^[a-z0-9-]+$/.test(reviewerRole)) fail('config.reviewerRole must be a Pier role name ([a-z0-9-]+)');
  const roleDirs = absoluteList(ownValue(input, 'roleDirs'), 'config.roleDirs');
  const pierHistoryRoots = absoluteList(ownValue(input, 'pierHistoryRoots'), 'config.pierHistoryRoots');
  const shared = sharedPaths(ownValue(input, 'sharedPaths'), 'config.sharedPaths');
  const maxParallelAgents = ownValue(input, 'maxParallelAgents') === undefined ? undefined : positiveInteger(ownValue(input, 'maxParallelAgents'), 'config.maxParallelAgents', 1);
  return Object.freeze({
    version: 1,
    repoRoot,
    workspaceRoot,
    verificationAllowlist: Object.freeze([...new Set(allowlist as string[])]),
    verificationTimeoutMs: positiveInteger(ownValue(input, 'verificationTimeoutMs'), 'config.verificationTimeoutMs', 600_000),
    reviewerRole,
    maxChecksPerAttempt: positiveInteger(ownValue(input, 'maxChecksPerAttempt'), 'config.maxChecksPerAttempt', 5),
    defaultMaxAttempts: positiveInteger(ownValue(input, 'defaultMaxAttempts'), 'config.defaultMaxAttempts', 3),
    ...(roleDirs === undefined ? {} : { roleDirs }),
    ...(pierHistoryRoots === undefined ? {} : { pierHistoryRoots }),
    sharedPaths: shared.all,
    unionMergePaths: shared.union,
    rejectTestAsserts: flag(ownValue(input, 'rejectTestAsserts'), 'config.rejectTestAsserts'),
    ...(maxParallelAgents === undefined ? {} : { maxParallelAgents }),
  });
}
