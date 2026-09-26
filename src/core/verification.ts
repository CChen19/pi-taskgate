/**
 * S5 mechanical verification pure core.
 *
 * The verifier owns no process, shell, filesystem, clock, or network access.
 * It invokes only the injected runner and clock, then returns immutable,
 * artifact-revision-bound evidence. A runner adapter is the future execution
 * boundary; tests use an in-memory fake.
 */

import { MAX_TASK_ID_LENGTH } from './task-contract.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export interface VerificationCommand {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface VerificationRunnerResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly output?: string;
  readonly outputRef?: string;
}

export interface VerificationOutcome {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Bounded output summary; complete logs never enter the core evidence. */
  readonly output?: string;
  /** Bounded external reference to output retained by an adapter. */
  readonly outputRef?: string;
}

export interface EvidenceBundle {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly commands: readonly VerificationCommand[];
  readonly outcomes: readonly VerificationOutcome[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface VerificationExpectations {
  /** Fail the verdict when fewer than this many commands were declared/run. */
  readonly minimumCommands?: number;
}

export interface VerificationVerdict {
  readonly verdict: 'passed' | 'rejected';
  readonly artifactRevision: string;
  readonly reasons: readonly string[];
}

export type VerificationErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_CONTEXT'
  | 'INVALID_RUNNER'
  | 'RUNNER_FAILED'
  | 'INVALID_RUNNER_RESULT'
  | 'INVALID_EVIDENCE'
  | 'INVALID_EXPECTATIONS'
  | 'MISSING_ARTIFACT_REVISION';

/** Structured, fail-closed S5 input/runner error. */
export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(
    code: VerificationErrorCode,
    path: string,
    message: string,
    available: readonly string[] = [],
  ) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    this.path = path;
    this.available = Object.freeze([...available]);
  }
}

const COMMAND_FIELDS = ['command', 'cwd', 'timeoutMs'] as const;
const EVIDENCE_FIELDS = ['taskId', 'attemptId', 'artifactRevision', 'commands', 'outcomes', 'startedAt', 'endedAt'] as const;
const OUTCOME_FIELDS = ['exitCode', 'durationMs', 'timedOut', 'output', 'outputRef'] as const;
const EXPECTATION_FIELDS = ['minimumCommands'] as const;
const VERDICT_FIELDS = ['verdict', 'artifactRevision', 'reasons'] as const;
const ARRAY_METHOD_FIELDS = ['map', 'forEach', 'every', 'filter'] as const;
/** 64-char task ID plus S3's `:attempt-` prefix and a generous counter. */
export const MAX_ATTEMPT_ID_LENGTH = 128;
/** Accommodates commit/diff hashes and adapter-qualified revision references. */
export const MAX_ARTIFACT_REVISION_LENGTH = 256;

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && allowed.includes(key)) continue;
    result.push(typeof key === 'symbol' ? key.toString() : key);
  }
  return result;
}

function fail(
  code: VerificationErrorCode,
  path: string,
  message: string,
  available: readonly string[] = [],
): never {
  throw new VerificationError(code, path, message, available);
}

function requireNonEmpty(value: unknown, path: string, code: VerificationErrorCode, maximumLength?: number): string {
  if (asNonEmptyString(value) === undefined) fail(code, path, `${path} must be a non-empty string`);
  const string = value as string;
  if (maximumLength !== undefined && string.length > maximumLength) {
    fail(code, path, `${path} must be at most ${maximumLength} characters`);
  }
  return string;
}

function requireFiniteNumber(value: unknown, path: string, code: VerificationErrorCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, path, `${path} must be a finite number`);
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string, code: VerificationErrorCode): number {
  const number = requireFiniteNumber(value, path, code);
  if (number < 0) fail(code, path, `${path} must be non-negative`);
  return number;
}

function requirePositiveInteger(value: unknown, path: string, code: VerificationErrorCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(code, path, `${path} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string, code: VerificationErrorCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(code, path, `${path} must be a non-negative integer`);
  }
  return value;
}

function validateCommand(value: unknown, path: string, code: VerificationErrorCode): VerificationCommand {
  if (!isPlainObject(value)) fail(code, path, `${path} must be a plain object`);
  if (!hasExactFields(value, COMMAND_FIELDS)) {
    fail(code, path, `${path} has unknown field(s): ${truncateForMessage(unknownFields(value, COMMAND_FIELDS).join(', '))}`, COMMAND_FIELDS);
  }
  const command = requireNonEmpty(ownValue(value, 'command'), `${path}.command`, code);
  const cwdValue = ownValue(value, 'cwd');
  const timeoutValue = ownValue(value, 'timeoutMs');
  const result: { command: string; cwd?: string; timeoutMs?: number } = { command };
  if (cwdValue !== undefined) result.cwd = requireNonEmpty(cwdValue, `${path}.cwd`, code);
  if (timeoutValue !== undefined) result.timeoutMs = requirePositiveInteger(timeoutValue, `${path}.timeoutMs`, code);
  return result;
}

function rejectArrayMethodOverrides(value: readonly unknown[], path: string, code: VerificationErrorCode): void {
  for (const method of ARRAY_METHOD_FIELDS) {
    if (Object.hasOwn(value, method)) fail(code, path, `${path} must not override array method ${method}`);
  }
}

function validateCommands(value: unknown, path: string, code: VerificationErrorCode): readonly VerificationCommand[] {
  if (!Array.isArray(value)) fail(code, path, `${path} must be an array`, ['command']);
  rejectArrayMethodOverrides(value, path, code);
  const normalized: VerificationCommand[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(code, `${path}[${index}]`, `${path}[${index}] must be present; sparse arrays are not accepted`);
    normalized.push(validateCommand(value[index], `${path}[${index}]`, code));
  }
  return normalized;
}



function requireRevision(value: unknown, path: string): string {
  return requireNonEmpty(value, path, 'MISSING_ARTIFACT_REVISION', MAX_ARTIFACT_REVISION_LENGTH);
}

function requireTaskId(value: unknown, path: string, code: VerificationErrorCode): string {
  return requireNonEmpty(value, path, code, MAX_TASK_ID_LENGTH);
}

function requireAttemptId(value: unknown, path: string, code: VerificationErrorCode): string {
  return requireNonEmpty(value, path, code, MAX_ATTEMPT_ID_LENGTH);
}




function validateOutcome(value: unknown, path: string): VerificationOutcome {
  if (!isPlainObject(value)) fail('INVALID_EVIDENCE', path, `${path} must be a plain object`);
  if (!hasExactFields(value, OUTCOME_FIELDS)) {
    fail('INVALID_EVIDENCE', path, `${path} has unknown field(s): ${truncateForMessage(unknownFields(value, OUTCOME_FIELDS).join(', '))}`, OUTCOME_FIELDS);
  }
  const exitCode = ownValue(value, 'exitCode');
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0) fail('INVALID_EVIDENCE', `${path}.exitCode`, `${path}.exitCode must be a non-negative integer`);
  const durationMs = requireNonNegativeNumber(ownValue(value, 'durationMs'), `${path}.durationMs`, 'INVALID_EVIDENCE');
  const timedOut = ownValue(value, 'timedOut');
  if (typeof timedOut !== 'boolean') fail('INVALID_EVIDENCE', `${path}.timedOut`, `${path}.timedOut must be boolean`, ['true', 'false']);
  const output = ownValue(value, 'output');
  const outputRef = ownValue(value, 'outputRef');
  if (output !== undefined && typeof output !== 'string') fail('INVALID_EVIDENCE', `${path}.output`, `${path}.output must be a string`);
  if (outputRef !== undefined && asNonEmptyString(outputRef) === undefined) fail('INVALID_EVIDENCE', `${path}.outputRef`, `${path}.outputRef must be a non-empty string`);
  return {
    exitCode,
    durationMs,
    timedOut,
    ...(output === undefined ? {} : { output: truncateForMessage(output as string) }),
    ...(outputRef === undefined ? {} : { outputRef: truncateForMessage(outputRef as string) }),
  };
}

/** Runtime validation used by the reviewer brief without executing anything. */
export function validateEvidenceBundle(input: unknown): EvidenceBundle {
  if (!isPlainObject(input)) fail('INVALID_EVIDENCE', 'bundle', 'bundle must be a plain object');
  if (!hasExactFields(input, EVIDENCE_FIELDS)) {
    fail('INVALID_EVIDENCE', 'bundle', `bundle has unknown field(s): ${truncateForMessage(unknownFields(input, EVIDENCE_FIELDS).join(', '))}`, EVIDENCE_FIELDS);
  }
  const commands = validateCommands(ownValue(input, 'commands'), 'bundle.commands', 'INVALID_EVIDENCE');
  const rawOutcomes = ownValue(input, 'outcomes');
  if (!Array.isArray(rawOutcomes)) fail('INVALID_EVIDENCE', 'bundle.outcomes', 'bundle.outcomes must be an array');
  rejectArrayMethodOverrides(rawOutcomes, 'bundle.outcomes', 'INVALID_EVIDENCE');
  if (rawOutcomes.length !== commands.length) fail('INVALID_EVIDENCE', 'bundle.outcomes', 'bundle.outcomes must align one-to-one with bundle.commands');
  const outcomes: VerificationOutcome[] = [];
  for (let index = 0; index < rawOutcomes.length; index++) {
    if (!Object.hasOwn(rawOutcomes, index)) fail('INVALID_EVIDENCE', `bundle.outcomes[${index}]`, `bundle.outcomes[${index}] must be present; sparse arrays are not accepted`);
    outcomes.push(validateOutcome(rawOutcomes[index], `bundle.outcomes[${index}]`));
  }
  const startedAt = requireFiniteNumber(ownValue(input, 'startedAt'), 'bundle.startedAt', 'INVALID_EVIDENCE');
  const endedAt = requireFiniteNumber(ownValue(input, 'endedAt'), 'bundle.endedAt', 'INVALID_EVIDENCE');
  if (endedAt < startedAt) fail('INVALID_EVIDENCE', 'bundle.endedAt', 'bundle.endedAt must not precede bundle.startedAt');
  return deepFreeze({
    taskId: requireTaskId(ownValue(input, 'taskId'), 'bundle.taskId', 'INVALID_EVIDENCE'),
    attemptId: requireAttemptId(ownValue(input, 'attemptId'), 'bundle.attemptId', 'INVALID_EVIDENCE'),
    artifactRevision: requireRevision(ownValue(input, 'artifactRevision'), 'bundle.artifactRevision'),
    commands,
    outcomes,
    startedAt,
    endedAt,
  });
}

function validateExpectations(input: unknown): VerificationExpectations {
  if (input === undefined) return {};
  if (!isPlainObject(input)) fail('INVALID_EXPECTATIONS', 'expectations', 'expectations must be a plain object or undefined');
  if (!hasExactFields(input, EXPECTATION_FIELDS)) {
    fail('INVALID_EXPECTATIONS', 'expectations', `expectations has unknown field(s): ${truncateForMessage(unknownFields(input, EXPECTATION_FIELDS).join(', '))}`, EXPECTATION_FIELDS);
  }
  const minimumCommands = ownValue(input, 'minimumCommands');
  if (minimumCommands === undefined) return {};
  return { minimumCommands: requireNonNegativeInteger(minimumCommands, 'expectations.minimumCommands', 'INVALID_EXPECTATIONS') };
}

function validateVerdictInput(input: unknown): VerificationVerdict {
  if (!isPlainObject(input)) fail('INVALID_EVIDENCE', 'verification', 'verification verdict must be a plain object');
  if (!hasExactFields(input, VERDICT_FIELDS)) {
    fail('INVALID_EVIDENCE', 'verification', `verification verdict has unknown field(s): ${truncateForMessage(unknownFields(input, VERDICT_FIELDS).join(', '))}`, VERDICT_FIELDS);
  }
  const verdict = ownValue(input, 'verdict');
  if (verdict !== 'passed' && verdict !== 'rejected') fail('INVALID_EVIDENCE', 'verification.verdict', 'verification.verdict must be passed or rejected', ['passed', 'rejected']);
  const rawReasons = ownValue(input, 'reasons');
  if (!Array.isArray(rawReasons)) fail('INVALID_EVIDENCE', 'verification.reasons', 'verification.reasons must be an array');
  rejectArrayMethodOverrides(rawReasons, 'verification.reasons', 'INVALID_EVIDENCE');
  const reasons: string[] = [];
  for (let index = 0; index < rawReasons.length; index++) {
    if (!Object.hasOwn(rawReasons, index)) fail('INVALID_EVIDENCE', `verification.reasons[${index}]`, `verification.reasons[${index}] must be present; sparse arrays are not accepted`);
    reasons.push(requireNonEmpty(rawReasons[index], `verification.reasons[${index}]`, 'INVALID_EVIDENCE'));
  }
  return deepFreeze({
    verdict,
    artifactRevision: requireRevision(ownValue(input, 'artifactRevision'), 'verification.artifactRevision'),
    reasons,
  });
}

/** Validate an artifact-bound mechanical verdict for downstream S2 mapping. */
export function validateVerificationVerdict(input: unknown): VerificationVerdict {
  return validateVerdictInput(input);
}

/**
 * Decide the mechanical verdict. Invalid evidence is a structured fail-closed
 * error; an expectation miss is a normal artifact-bound `rejected` verdict.
 */
export function decideVerdict(
  bundle: unknown,
  expectations: unknown = undefined,
): VerificationVerdict {
  const normalized = validateEvidenceBundle(bundle);
  const expected = validateExpectations(expectations);
  const reasons: string[] = [];
  if (expected.minimumCommands !== undefined && normalized.commands.length < expected.minimumCommands) {
    reasons.push(`expected at least ${expected.minimumCommands} command(s), received ${normalized.commands.length}`);
  }
  for (let index = 0; index < normalized.outcomes.length; index++) {
    const outcome = normalized.outcomes[index]!;
    if (outcome.timedOut) reasons.push(`command ${index + 1} timed out`);
    if (outcome.exitCode !== 0) reasons.push(`command ${index + 1} exited with code ${outcome.exitCode}`);
  }
  return deepFreeze({
    verdict: reasons.length === 0 ? 'passed' : 'rejected',
    artifactRevision: normalized.artifactRevision,
    reasons,
  });
}
