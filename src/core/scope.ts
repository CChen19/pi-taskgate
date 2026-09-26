/**
 * Path scope checks: are the paths a candidate changed inside its task's
 * files_in_scope? Directory scopes use a trailing slash (`src/`); file scopes
 * are exact, which avoids the src/a versus src/ab prefix-confusion class of
 * bugs. Pure: no I/O.
 */
import { deepFreeze } from './validate.ts';

const MAX_PATH_LENGTH = 256;
const MAX_SCOPE_ITEMS = 64;
const MAX_CHANGED_PATHS = 256;
const ARRAY_METHODS = ['map', 'forEach', 'every', 'filter', 'slice'] as const;

export type ScopeErrorCode = 'INVALID_INPUT' | 'LIMIT_EXCEEDED' | 'PATH_POLICY';

export class ScopeError extends Error {
  readonly code: ScopeErrorCode;
  readonly path: string;

  constructor(code: ScopeErrorCode, path: string, message: string) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
    this.path = path;
  }
}

export interface ScopeValidationResult {
  readonly ok: boolean;
  readonly allowed: boolean;
  readonly changedPaths: readonly string[];
  readonly filesInScope: readonly string[];
  readonly violations: readonly string[];
}

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    // Do not echo a hostile getter/proxy value or a secret-bearing exception.
    throw new ScopeError('INVALID_INPUT', 'scope', 'scope inspection failed');
  }
}

/** A real, dense array with no extra own properties, copied element by element. */
function arrayValue(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new ScopeError('INVALID_INPUT', path, `${path} must be an array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1) continue;
    throw new ScopeError('INVALID_INPUT', path, `${path} has an unknown array property`);
  }
  for (const method of ARRAY_METHODS) {
    if (Object.hasOwn(value, method)) throw new ScopeError('INVALID_INPUT', path, `${path} must not override array method ${method}`);
  }
  if (value.length > maximum) throw new ScopeError('LIMIT_EXCEEDED', path, `${path} has too many items`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new ScopeError('INVALID_INPUT', `${path}[${index}]`, 'sparse arrays are not accepted');
    result.push(value[index]);
  }
  return result;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

/** Normalized repository-relative path; rejects absolute, drive, `..` and `.git` segments. */
function pathValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new ScopeError('PATH_POLICY', path, `${path} is not a safe relative path`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new ScopeError('PATH_POLICY', path, `${path} must be relative`);
  const normalized: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || asciiLower(part) === '.git') throw new ScopeError('PATH_POLICY', path, `${path} contains a forbidden segment`);
    normalized.push(part);
  }
  if (normalized.length === 0) throw new ScopeError('PATH_POLICY', path, `${path} is empty`);
  const result = normalized.join('/');
  if (result.length > MAX_PATH_LENGTH) throw new ScopeError('LIMIT_EXCEEDED', path, `${path} is too long`);
  return result;
}

export function validateChangedPaths(changedPathsInput: unknown, filesInScopeInput: unknown): ScopeValidationResult {
  return boundary(() => {
    const changedPaths = arrayValue(changedPathsInput, 'changedPaths', MAX_CHANGED_PATHS).map((entry, index) => pathValue(entry, `changedPaths[${index}]`));
    const filesInScope = arrayValue(filesInScopeInput, 'filesInScope', MAX_SCOPE_ITEMS).map((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) throw new ScopeError('PATH_POLICY', `filesInScope[${index}]`, 'scope must be a non-empty path');
      const normalized = pathValue(entry, `filesInScope[${index}]`);
      return entry.endsWith('/') ? `${normalized}/` : normalized;
    });
    const violations = changedPaths.filter((changed) => !filesInScope.some((scope) => (scope.endsWith('/') ? changed.startsWith(scope) : changed === scope)));
    return deepFreeze({ ok: true, allowed: violations.length === 0, changedPaths, filesInScope, violations });
  });
}
