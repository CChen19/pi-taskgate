/**
 * Task Contract — the declarative, side-effect-free shape of a task.
 *
 * This module validates unknown input only. Dependency existence belongs to the
 * task-graph layer; verification commands are stored, never executed here.
 */

import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

/** Stable task ID format: `T` followed by lowercase alphanumeric segments. */
export const TASK_ID_PATTERN = /^T[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Bounds event keys and graph error paths while leaving payloads untruncated. */
export const MAX_TASK_ID_LENGTH = 64;

export interface TaskContract {
  readonly id: string;
  readonly objective: string;
  /** Shape-only dependency references; graph existence is checked elsewhere. */
  readonly depends_on: readonly string[];
  /** Optional path/document references. */
  readonly context?: readonly string[];
  /** Optional path scope declaration. */
  readonly files_in_scope?: readonly string[];
  /** At least one acceptance criterion. */
  readonly acceptance_criteria: readonly string[];
  /** Stored only; this slice never executes verification commands. */
  readonly verification: readonly string[];
  readonly budget?: {
    readonly max_turns: number;
    readonly timeout_ms: number;
  };
  /** Normalized to `{ max_attempts: 0 }` when omitted. */
  readonly retry?: {
    readonly max_attempts: number;
  };
}

export type ContractIssueCode = 'UNKNOWN_FIELD' | 'MISSING_FIELD' | 'INVALID_FIELD';

export interface ContractIssue {
  readonly code: ContractIssueCode;
  readonly path: string;
  readonly message: string;
}

/** Structured, aggregated contract validation failure. */
export interface ContractValidationError {
  readonly code: 'INVALID_CONTRACT';
  readonly message: string;
  readonly path: 'contract';
  readonly issues: readonly ContractIssue[];
}

export type ContractValidationResult =
  | { readonly ok: true; readonly contract: TaskContract }
  | { readonly ok: false; readonly error: ContractValidationError };

const CONTRACT_FIELDS = [
  'id',
  'objective',
  'depends_on',
  'context',
  'files_in_scope',
  'acceptance_criteria',
  'verification',
  'budget',
  'retry',
] as const;
const BUDGET_FIELDS = ['max_turns', 'timeout_ms'] as const;
const RETRY_FIELDS = ['max_attempts'] as const;
const REQUIRED_FIELDS = ['id', 'objective', 'depends_on', 'acceptance_criteria', 'verification'] as const;

type MutableContract = {
  id: string;
  objective: string;
  depends_on: string[];
  context?: string[];
  files_in_scope?: string[];
  acceptance_criteria: string[];
  verification: string[];
  budget?: { max_turns: number; timeout_ms: number };
  retry: { max_attempts: number };
};

function issue(
  issues: ContractIssue[],
  code: ContractIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const MAX_ISSUES_IN_MESSAGE = 10;

function summarizeIssues(issues: readonly ContractIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUES_IN_MESSAGE).map((entry) =>
    truncateForMessage(`${entry.path}: ${entry.message}`),
  );
  const remaining = issues.length - shown.length;
  if (remaining > 0) shown.push(`${remaining} more issues`);
  return shown.join('; ');
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ContractIssue[],
  minimumLength: number,
): string[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, 'INVALID_FIELD', path, `${path} must be an array of non-empty strings`);
    return undefined;
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = asNonEmptyString(value[index]);
    if (entry === undefined) {
      issue(issues, 'INVALID_FIELD', `${path}[${index}]`, `${path}[${index}] must be a non-empty string`);
    } else {
      result.push(entry);
    }
  }
  if (value.length < minimumLength) {
    issue(issues, 'INVALID_FIELD', path, `${path} must contain at least ${minimumLength} item(s)`);
  }
  return issues.some((entry) => entry.path === path || entry.path.startsWith(`${path}[`))
    ? undefined
    : result;
}

function validateOptionalStringArray(
  raw: Record<string, unknown>,
  field: 'context' | 'files_in_scope',
  issues: ContractIssue[],
): string[] | undefined {
  if (!Object.hasOwn(raw, field)) return undefined;
  return validateStringArray(ownValue(raw, field), `contract.${field}`, issues, 0);
}

function unknownFieldNames(raw: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Reflect.ownKeys(raw)
    .filter((key) => typeof key !== 'string' || !allowed.includes(key))
    .map((key) => (typeof key === 'symbol' ? key.toString() : key));
}

function validateNestedExactFields(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ContractIssue[],
): void {
  if (!hasExactFields(raw, allowed)) {
    const unknown = unknownFieldNames(raw, allowed);
    issue(
      issues,
      'UNKNOWN_FIELD',
      path,
      `${path} has unknown field(s): ${truncateForMessage(unknown.join(', '))}`,
    );
  }
}

/**
 * Validates an unknown value as a TaskContract.
 *
 * All structural problems are aggregated into one INVALID_CONTRACT result.
 * Successful results are normalized and deeply frozen; caller-owned objects
 * and arrays are copied and never mutated or frozen.
 */
export function validateTaskContract(input: unknown): ContractValidationResult {
  const issues: ContractIssue[] = [];
  if (!isPlainObject(input)) {
    issue(issues, 'INVALID_FIELD', 'contract', 'contract must be an object');
    return {
      ok: false,
      error: {
        code: 'INVALID_CONTRACT',
        path: 'contract',
        message: 'contract is invalid: contract must be an object',
        issues: deepFreeze(issues),
      },
    };
  }

  const raw = input;
  if (!hasExactFields(raw, CONTRACT_FIELDS)) {
    const unknown = unknownFieldNames(raw, CONTRACT_FIELDS);
    issue(
      issues,
      'UNKNOWN_FIELD',
      'contract',
      `contract has unknown field(s): ${truncateForMessage(unknown.join(', '))}`,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(raw, field)) {
      issue(issues, 'MISSING_FIELD', `contract.${field}`, `contract.${field} is required`);
    }
  }

  const idValue = ownValue(raw, 'id');
  const id = asNonEmptyString(idValue);
  if (id === undefined) {
    if (Object.hasOwn(raw, 'id')) {
      issue(issues, 'INVALID_FIELD', 'contract.id', 'contract.id must be a non-empty string');
    }
  } else if (id.length > MAX_TASK_ID_LENGTH) {
    issue(
      issues,
      'INVALID_FIELD',
      'contract.id',
      `contract.id must be at most ${MAX_TASK_ID_LENGTH} characters`,
    );
  } else if (!TASK_ID_PATTERN.test(id)) {
    issue(
      issues,
      'INVALID_FIELD',
      'contract.id',
      'contract.id must match T followed by lowercase alphanumeric segments (for example, Tauth-login)',
    );
  }

  const objective = asNonEmptyString(ownValue(raw, 'objective'));
  if (objective === undefined && Object.hasOwn(raw, 'objective')) {
    issue(issues, 'INVALID_FIELD', 'contract.objective', 'contract.objective must be a non-empty string');
  }

  const rawDependsOn = ownValue(raw, 'depends_on');
  const dependsOn = validateStringArray(rawDependsOn, 'contract.depends_on', issues, 0);
  if (dependsOn !== undefined && id !== undefined) {
    const seen = new Set<string>();
    for (const [index, dependency] of dependsOn.entries()) {
      if (seen.has(dependency)) {
        issue(
          issues,
          'INVALID_FIELD',
          `contract.depends_on[${index}]`,
          `contract.depends_on contains duplicate reference "${truncateForMessage(dependency)}"`,
        );
      }
      seen.add(dependency);
      if (dependency === id) {
        issue(issues, 'INVALID_FIELD', `contract.depends_on[${index}]`, 'contract.depends_on cannot reference its own id');
      }
    }
  }

  const context = validateOptionalStringArray(raw, 'context', issues);
  const filesInScope = validateOptionalStringArray(raw, 'files_in_scope', issues);
  const acceptanceCriteria = validateStringArray(
    ownValue(raw, 'acceptance_criteria'),
    'contract.acceptance_criteria',
    issues,
    1,
  );
  const verification = validateStringArray(
    ownValue(raw, 'verification'),
    'contract.verification',
    issues,
    0,
  );

  let budget: MutableContract['budget'];
  if (Object.hasOwn(raw, 'budget')) {
    const rawBudget = ownValue(raw, 'budget');
    if (!isPlainObject(rawBudget)) {
      issue(issues, 'INVALID_FIELD', 'contract.budget', 'contract.budget must be an object');
    } else {
      validateNestedExactFields(rawBudget, BUDGET_FIELDS, 'contract.budget', issues);
      const maxTurns = ownValue(rawBudget, 'max_turns');
      const timeoutMs = ownValue(rawBudget, 'timeout_ms');
      if (!isPositiveInteger(maxTurns)) {
        issue(issues, 'INVALID_FIELD', 'contract.budget.max_turns', 'contract.budget.max_turns must be a positive integer');
      }
      if (!isPositiveInteger(timeoutMs)) {
        issue(issues, 'INVALID_FIELD', 'contract.budget.timeout_ms', 'contract.budget.timeout_ms must be a positive integer');
      }
      if (isPositiveInteger(maxTurns) && isPositiveInteger(timeoutMs)) {
        budget = { max_turns: maxTurns, timeout_ms: timeoutMs };
      }
    }
  }

  let maxAttempts = 0;
  if (Object.hasOwn(raw, 'retry')) {
    const rawRetry = ownValue(raw, 'retry');
    if (!isPlainObject(rawRetry)) {
      issue(issues, 'INVALID_FIELD', 'contract.retry', 'contract.retry must be an object');
    } else {
      validateNestedExactFields(rawRetry, RETRY_FIELDS, 'contract.retry', issues);
      const value = ownValue(rawRetry, 'max_attempts');
      if (!isNonNegativeInteger(value)) {
        issue(issues, 'INVALID_FIELD', 'contract.retry.max_attempts', 'contract.retry.max_attempts must be a non-negative integer');
      } else {
        maxAttempts = value;
      }
    }
  }

  if (
    issues.length > 0 ||
    id === undefined ||
    objective === undefined ||
    dependsOn === undefined ||
    acceptanceCriteria === undefined ||
    verification === undefined
  ) {
    return {
      ok: false,
      error: deepFreeze({
        code: 'INVALID_CONTRACT' as const,
        path: 'contract' as const,
        message: `contract is invalid: ${summarizeIssues(issues)}`,
        issues,
      }),
    };
  }

  const contract: MutableContract = {
    id,
    objective,
    depends_on: dependsOn,
    acceptance_criteria: acceptanceCriteria,
    verification,
    retry: { max_attempts: maxAttempts },
  };
  if (context !== undefined) contract.context = context;
  if (filesInScope !== undefined) contract.files_in_scope = filesInScope;
  if (budget !== undefined) contract.budget = budget;
  return { ok: true, contract: deepFreeze(contract) };
}
