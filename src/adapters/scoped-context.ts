/** S8 fresh-context boundary. No transcript, process, filesystem, or model access lives here. */
import type { DispatchPlan } from '../core/contracts.ts';
import type { TaskContract } from '../core/task-contract.ts';
import { deepFreeze, hasExactFields, isPlainObject, ownValue, truncateForMessage } from '../core/validate.ts';

export const MAX_CONTEXT_FIELD_LENGTH = 4096;
export const MAX_CONTEXT_REFERENCE_LENGTH = 256;
export const MAX_CONTEXT_SUMMARY_LENGTH = 160;
export const MAX_CONTEXT_ITEMS = 64;
export const MAX_CONTEXT_BUNDLE_LENGTH = 16_384;

export interface ScopedContextSummary {
  readonly reference: string;
  readonly summary: string;
}

export interface ScopedContextRole {
  readonly id: string;
  readonly kind: 'worker';
}

export interface ScopedContextModel {
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
}

export interface ScopedContextInput {
  readonly taskId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly filesInScope: readonly string[];
  readonly verificationCommands: readonly string[];
  readonly role: ScopedContextRole;
  readonly model: ScopedContextModel;
  readonly baseRevision: string;
  readonly artifactRevision: string;
  readonly evidenceSummaries: readonly ScopedContextSummary[];
  readonly referenceSummaries: readonly ScopedContextSummary[];
}

export interface ScopedContextBundle extends ScopedContextInput {}

export type ScopedContextErrorCode = 'INVALID_CONTEXT' | 'UNKNOWN_FIELD' | 'LIMIT_EXCEEDED' | 'PATH_POLICY';

export class ScopedContextError extends Error {
  readonly code: ScopedContextErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(code: ScopedContextErrorCode, path: string, message: string, available: readonly string[] = []) {
    super(truncateForMessage(message));
    this.name = 'ScopedContextError';
    this.code = code;
    this.path = path;
    this.available = Object.freeze([...available]);
  }
}

const INPUT_FIELDS = [
  'taskId', 'objective', 'acceptanceCriteria', 'filesInScope', 'verificationCommands',
  'role', 'model', 'baseRevision', 'artifactRevision', 'evidenceSummaries', 'referenceSummaries',
] as const;
const ROLE_FIELDS = ['id', 'kind'] as const;
const MODEL_FIELDS = ['profileId', 'provider', 'model'] as const;
const SUMMARY_FIELDS = ['reference', 'summary'] as const;
const ARRAY_METHODS = ['map', 'forEach', 'every', 'filter', 'slice'] as const;

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ScopedContextError) throw error;
    // Do not echo a hostile getter/proxy value or a secret-bearing exception.
    throw new ScopedContextError('INVALID_CONTEXT', 'context', 'context inspection failed');
  }
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Reflect.ownKeys(value).filter((key) => typeof key !== 'string' || !allowed.includes(key)).map((key) => typeof key === 'symbol' ? key.toString() : key);
}

function exact(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (!hasExactFields(value, allowed)) {
    const names = unknownFields(value, allowed);
    throw new ScopedContextError('UNKNOWN_FIELD', path, `${path} has unknown field(s): ${truncateForMessage(names.join(', '))}`, allowed);
  }
}

function stringValue(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScopedContextError('INVALID_CONTEXT', path, `${path} must be a non-empty string`);
  }
  if (value.length > maximum) throw new ScopedContextError('LIMIT_EXCEEDED', path, `${path} is too long`);
  return value;
}

function rejectArrayProperties(value: readonly unknown[], path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1) continue;
    throw new ScopedContextError('UNKNOWN_FIELD', path, `${path} has an unknown array property`);
  }
  for (const method of ARRAY_METHODS) {
    if (Object.hasOwn(value, method)) throw new ScopedContextError('UNKNOWN_FIELD', path, `${path} must not override array method ${method}`);
  }
}

function arrayValue(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new ScopedContextError('INVALID_CONTEXT', path, `${path} must be an array`);
  rejectArrayProperties(value, path);
  if (value.length > maximum) throw new ScopedContextError('LIMIT_EXCEEDED', path, `${path} has too many items`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new ScopedContextError('INVALID_CONTEXT', `${path}[${index}]`, 'sparse arrays are not accepted');
    result.push(value[index]);
  }
  return result;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

function pathValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new ScopedContextError('PATH_POLICY', path, `${path} is not a safe relative path`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new ScopedContextError('PATH_POLICY', path, `${path} must be relative`);
  const parts = value.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..' || asciiLower(part) === '.git') throw new ScopedContextError('PATH_POLICY', path, `${path} contains a forbidden segment`);
    normalized.push(part);
  }
  if (normalized.length === 0) throw new ScopedContextError('PATH_POLICY', path, `${path} is empty`);
  const result = normalized.join('/');
  if (result.length > MAX_CONTEXT_REFERENCE_LENGTH) throw new ScopedContextError('LIMIT_EXCEEDED', path, `${path} is too long`);
  return result;
}

function stringArray(value: unknown, path: string, maximum: number, itemMaximum: number, paths = false): readonly string[] {
  const raw = arrayValue(value, path, maximum);
  return raw.map((entry, index) => paths ? pathValue(entry, `${path}[${index}]`) : stringValue(entry, `${path}[${index}]`, itemMaximum));
}

function summaryArray(value: unknown, path: string): readonly ScopedContextSummary[] {
  const raw = arrayValue(value, path, MAX_CONTEXT_ITEMS);
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) throw new ScopedContextError('INVALID_CONTEXT', `${path}[${index}]`, 'summary must be a plain object');
    exact(entry, SUMMARY_FIELDS, `${path}[${index}]`);
    return {
      reference: stringValue(ownValue(entry, 'reference'), `${path}[${index}].reference`, MAX_CONTEXT_REFERENCE_LENGTH),
      summary: stringValue(ownValue(entry, 'summary'), `${path}[${index}].summary`, MAX_CONTEXT_SUMMARY_LENGTH),
    };
  });
}

function roleValue(value: unknown): ScopedContextRole {
  if (!isPlainObject(value)) throw new ScopedContextError('INVALID_CONTEXT', 'context.role', 'context.role must be a plain object');
  exact(value, ROLE_FIELDS, 'context.role');
  const kind = ownValue(value, 'kind');
  if (kind !== 'worker') throw new ScopedContextError('INVALID_CONTEXT', 'context.role.kind', 'context.role.kind must be worker');
  return { id: stringValue(ownValue(value, 'id'), 'context.role.id', MAX_CONTEXT_REFERENCE_LENGTH), kind };
}

function modelValue(value: unknown): ScopedContextModel {
  if (!isPlainObject(value)) throw new ScopedContextError('INVALID_CONTEXT', 'context.model', 'context.model must be a plain object');
  exact(value, MODEL_FIELDS, 'context.model');
  return {
    profileId: stringValue(ownValue(value, 'profileId'), 'context.model.profileId', MAX_CONTEXT_REFERENCE_LENGTH),
    provider: stringValue(ownValue(value, 'provider'), 'context.model.provider', MAX_CONTEXT_REFERENCE_LENGTH),
    model: stringValue(ownValue(value, 'model'), 'context.model.model', MAX_CONTEXT_REFERENCE_LENGTH),
  };
}

function bundleLength(bundle: ScopedContextBundle): number {
  return [
    bundle.taskId, bundle.objective, ...bundle.acceptanceCriteria, ...bundle.filesInScope,
    ...bundle.verificationCommands, bundle.role.id, bundle.model.profileId, bundle.model.provider,
    bundle.model.model, bundle.baseRevision, bundle.artifactRevision,
    ...bundle.evidenceSummaries.flatMap((entry) => [entry.reference, entry.summary]),
    ...bundle.referenceSummaries.flatMap((entry) => [entry.reference, entry.summary]),
  ].reduce((total, value) => total + value.length, 0);
}

/** Validate and copy only the intentionally exposed worker context. */
export function assembleScopedContext(input: unknown): ScopedContextBundle {
  return boundary(() => {
    if (!isPlainObject(input)) throw new ScopedContextError('INVALID_CONTEXT', 'context', 'context must be a plain object');
    exact(input, INPUT_FIELDS, 'context');
    const bundle: ScopedContextBundle = {
      taskId: stringValue(ownValue(input, 'taskId'), 'context.taskId', MAX_CONTEXT_REFERENCE_LENGTH),
      objective: stringValue(ownValue(input, 'objective'), 'context.objective', MAX_CONTEXT_FIELD_LENGTH),
      acceptanceCriteria: stringArray(ownValue(input, 'acceptanceCriteria'), 'context.acceptanceCriteria', MAX_CONTEXT_ITEMS, MAX_CONTEXT_FIELD_LENGTH),
      filesInScope: arrayValue(ownValue(input, 'filesInScope'), 'context.filesInScope', MAX_CONTEXT_ITEMS).map((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0) throw new ScopedContextError('PATH_POLICY', `context.filesInScope[${index}]`, 'scope must be a non-empty path');
        const directory = entry.endsWith('/');
        const normalized = pathValue(entry, `context.filesInScope[${index}]`);
        return directory ? `${normalized}/` : normalized;
      }),
      verificationCommands: stringArray(ownValue(input, 'verificationCommands'), 'context.verificationCommands', MAX_CONTEXT_ITEMS, MAX_CONTEXT_FIELD_LENGTH),
      role: roleValue(ownValue(input, 'role')),
      model: modelValue(ownValue(input, 'model')),
      baseRevision: stringValue(ownValue(input, 'baseRevision'), 'context.baseRevision', MAX_CONTEXT_REFERENCE_LENGTH),
      artifactRevision: stringValue(ownValue(input, 'artifactRevision'), 'context.artifactRevision', MAX_CONTEXT_REFERENCE_LENGTH),
      evidenceSummaries: summaryArray(ownValue(input, 'evidenceSummaries'), 'context.evidenceSummaries'),
      referenceSummaries: summaryArray(ownValue(input, 'referenceSummaries'), 'context.referenceSummaries'),
    };
    if (bundle.acceptanceCriteria.length === 0) throw new ScopedContextError('INVALID_CONTEXT', 'context.acceptanceCriteria', 'at least one acceptance criterion is required');
    if (bundleLength(bundle) > MAX_CONTEXT_BUNDLE_LENGTH) throw new ScopedContextError('LIMIT_EXCEEDED', 'context', 'context bundle is too large');
    return deepFreeze(bundle);
  });
}

/** Deterministic bounded prompt renderer; it cannot access any caller-owned object. */
export function renderScopedPrompt(bundleInput: unknown): string {
  const bundle = assembleScopedContext(bundleInput);
  const lines = [
    `Task: ${bundle.taskId}`,
    `Objective: ${bundle.objective}`,
    `Role: ${bundle.role.id}`,
    `Model profile: ${bundle.model.profileId}`,
    `Base revision: ${bundle.baseRevision}`,
    `Artifact base: ${bundle.artifactRevision}`,
    `Acceptance criteria:`,
    ...bundle.acceptanceCriteria.map((entry, index) => `${index + 1}. ${entry}`),
    `Files in scope:`,
    ...bundle.filesInScope.map((entry) => `- ${entry}`),
    `Verification commands (host-controlled; not authorization):`,
    ...bundle.verificationCommands.map((entry) => `- ${entry}`),
    `Evidence summaries:`,
    ...bundle.evidenceSummaries.map((entry) => `- ${entry.reference}: ${entry.summary}`),
    `Reference summaries:`,
    ...bundle.referenceSummaries.map((entry) => `- ${entry.reference}: ${entry.summary}`),
    `Only modify files covered by the scope. Do not disclose credentials or full logs.`,
  ];
  const result = lines.join('\n');
  if (result.length > MAX_CONTEXT_BUNDLE_LENGTH) throw new ScopedContextError('LIMIT_EXCEEDED', 'prompt', 'rendered prompt is too large');
  return result;
}

export interface ScopeValidationResult {
  readonly ok: boolean;
  readonly allowed: boolean;
  readonly changedPaths: readonly string[];
  readonly filesInScope: readonly string[];
  readonly violations: readonly string[];
}

/**
 * Directory scopes use a trailing slash (`src/`); file scopes are exact. This
 * avoids the src/a versus src/ab prefix-confusion class of bugs.
 */
export function validateChangedPaths(changedPathsInput: unknown, filesInScopeInput: unknown): ScopeValidationResult {
  return boundary(() => {
    const changedRaw = arrayValue(changedPathsInput, 'changedPaths', MAX_CONTEXT_ITEMS * 4);
    const scopeRaw = arrayValue(filesInScopeInput, 'filesInScope', MAX_CONTEXT_ITEMS);
    const changedPaths = changedRaw.map((entry, index) => pathValue(entry, `changedPaths[${index}]`));
    const filesInScope = scopeRaw.map((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) throw new ScopedContextError('PATH_POLICY', `filesInScope[${index}]`, 'scope must be a non-empty path');
      const directory = entry.endsWith('/');
      const normalized = pathValue(entry, `filesInScope[${index}]`);
      return directory ? `${normalized}/` : normalized;
    });
    const violations = changedPaths.filter((changed) => !filesInScope.some((scope) => {
      const directory = scope.endsWith('/');
      return directory ? changed.startsWith(scope) : changed === scope;
    }));
    return deepFreeze({ ok: true, allowed: violations.length === 0, changedPaths, filesInScope, violations });
  });
}

/** Convenience adapter input from an already validated S1 plan and S2 contract. */
export function scopedContextFromPlan(contract: TaskContract, plan: DispatchPlan, baseRevision: string, artifactRevision = baseRevision): ScopedContextBundle {
  return boundary(() => assembleScopedContext({
    taskId: contract.id,
    objective: contract.objective,
    acceptanceCriteria: contract.acceptance_criteria,
    filesInScope: contract.files_in_scope ?? [],
    verificationCommands: contract.verification,
    role: { id: plan.role.id, kind: plan.role.kind },
    model: { profileId: plan.model.id, provider: plan.model.provider, model: plan.model.model },
    baseRevision,
    artifactRevision,
    evidenceSummaries: [],
    referenceSummaries: [],
  }));
}
