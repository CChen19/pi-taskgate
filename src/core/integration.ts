/**
 * S6 mechanical integration core.
 *
 * This module is deliberately an adapter seam, not a git or model adapter.
 * Planning is pure; execution receives fakeable git and command runners. The
 * default path is rebase -> merge -> verification -> conflict check. An
 * integration-agent brief is only a typed, pure-data escalation contract.
 */

import {
  MAX_ARTIFACT_REVISION_LENGTH,
  decideVerdict,
  validateEvidenceBundle,
  validateVerificationVerdict,
  type EvidenceBundle,
  type VerificationCommand,
  type VerificationOutcome,
  type VerificationVerdict,
  type VerificationRunnerResult,
} from './verification.ts';
import { MAX_TASK_ID_LENGTH } from './task-contract.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export const INTEGRATION_STEP_NAMES = [
  'rebase',
  'merge',
  'verification',
  'conflict-check',
  'status',
] as const;
export type IntegrationStepName = (typeof INTEGRATION_STEP_NAMES)[number];

export const INTEGRATION_OUTCOMES = [
  'merged',
  'conflict',
  'verification_failed',
  'runner_error',
] as const;
export type IntegrationOutcome = (typeof INTEGRATION_OUTCOMES)[number];

export interface IntegrationUnit {
  readonly taskId: string;
  readonly branch: string;
  readonly revision: string;
  /** S5 artifact-bound verdict for this unit. Only passed units are mergeable. */
  readonly verification: VerificationVerdict;
}

export interface IntegrationDependency {
  readonly taskId: string;
  readonly dependsOn: readonly string[];
}

export interface IntegrationPlanOptions {
  readonly baseRevision: string;
  /** Used as the stable tie-breaker for topological ordering. */
  readonly order?: readonly string[];
  /** When present, dependencies take precedence over the input/order sequence. */
  readonly dependencies?: readonly IntegrationDependency[];
  readonly verificationCommands?: readonly string[];
}

export interface MergePlan {
  readonly baseRevision: string;
  readonly units: readonly IntegrationUnit[];
  readonly verificationCommands: readonly string[];
}

export interface IntegrationStep {
  readonly name: IntegrationStepName;
  readonly ok: boolean;
  /** Bounded diagnostic detail; complete adapter logs stay outside the core. */
  readonly details: string;
}

export interface IntegrationFinalVerification {
  /** Reuses the S5 evidence shape and its artifact-bound verdict. */
  readonly evidence: EvidenceBundle;
  readonly verdict: VerificationVerdict;
}

export interface IntegrationErrorData {
  readonly code: IntegrationErrorCode;
  readonly message: string;
  readonly path: string;
  readonly available: readonly string[];
}

export interface IntegrationReport {
  readonly steps: readonly IntegrationStep[];
  readonly conflicts: readonly string[];
  readonly finalVerification?: IntegrationFinalVerification;
  readonly outcome: IntegrationOutcome;
  /** Present only when an injected adapter violates or throws through its port. */
  readonly error?: IntegrationErrorData;
}

export type IntegrationErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_OPTIONS'
  | 'INVALID_CONTEXT'
  | 'INVALID_RUNNER'
  | 'RUNNER_FAILED'
  | 'INVALID_RUNNER_RESULT'
  | 'INVALID_REPORT'
  | 'INVALID_INTEGRATION_REPORT'
  | 'INVALID_AGENT_BRIEF';

const INTEGRATION_ERROR_CODES: readonly IntegrationErrorCode[] = [
  'INVALID_PLAN',
  'INVALID_OPTIONS',
  'INVALID_CONTEXT',
  'INVALID_RUNNER',
  'RUNNER_FAILED',
  'INVALID_RUNNER_RESULT',
  'INVALID_REPORT',
  'INVALID_INTEGRATION_REPORT',
  'INVALID_AGENT_BRIEF',
];

export class IntegrationError extends Error implements IntegrationErrorData {
  readonly code: IntegrationErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(data: IntegrationErrorData) {
    super(truncateForMessage(data.message));
    this.name = 'IntegrationError';
    this.code = data.code;
    this.path = data.path;
    this.available = Object.freeze([...data.available]);
  }
}

export interface IntegrationGitOps {
  rebase(baseRevision: string, unit: IntegrationUnit): unknown;
  merge(unit: IntegrationUnit): unknown;
  conflicts(): unknown;
  status(): unknown;
}

export interface IntegrationCommandRunner {
  run(command: VerificationCommand): unknown;
}

export interface IntegrationRunner {
  readonly gitOps: IntegrationGitOps;
  readonly commandRunner: IntegrationCommandRunner;
}

export interface IntegrationRunContext {
  readonly clock: () => number;
}

export interface IntegrationDiffSummary {
  readonly taskId: string;
  readonly summary: string;
}

export interface IntegrationAgentBrief {
  readonly conflictFiles: readonly string[];
  readonly baseRevision: string;
  readonly revisions: readonly Pick<IntegrationUnit, 'taskId' | 'branch' | 'revision'>[];
  readonly diffSummaries: readonly IntegrationDiffSummary[];
}

const UNIT_FIELDS = ['taskId', 'branch', 'revision', 'verification'] as const;
const PLAN_FIELDS = ['baseRevision', 'units', 'verificationCommands'] as const;
const OPTIONS_FIELDS = ['baseRevision', 'order', 'dependencies', 'verificationCommands'] as const;
const DEPENDENCY_FIELDS = ['taskId', 'dependsOn'] as const;
const STEP_FIELDS = ['name', 'ok', 'details'] as const;
const REPORT_FIELDS = ['steps', 'conflicts', 'finalVerification', 'outcome', 'error'] as const;
const FINAL_VERIFICATION_FIELDS = ['evidence', 'verdict'] as const;
const ERROR_FIELDS = ['code', 'message', 'path', 'available'] as const;
const DIFF_SUMMARY_FIELDS = ['taskId', 'summary'] as const;
const MAX_BRANCH_LENGTH = MAX_ARTIFACT_REVISION_LENGTH;
const MAX_PATH_LENGTH = MAX_ARTIFACT_REVISION_LENGTH;
const MAX_COMMAND_LENGTH = MAX_ARTIFACT_REVISION_LENGTH;
const MAX_UNITS = 128;
const MAX_COMMANDS = 128;
const MAX_CONFLICTS = 256;

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && allowed.includes(key)) continue;
    result.push(typeof key === 'symbol' ? key.toString() : key);
  }
  return result;
}

function fail(
  code: IntegrationErrorCode,
  path: string,
  message: string,
  available: readonly string[] = [],
): never {
  throw new IntegrationError({ code, path, message, available });
}

function requireObject(value: unknown, path: string, code: IntegrationErrorCode): Record<string, unknown> {
  if (!isPlainObject(value)) fail(code, path, `${path} must be a plain object`);
  return value;
}

function requireExact(value: Record<string, unknown>, allowed: readonly string[], path: string, code: IntegrationErrorCode): void {
  if (!hasExactFields(value, allowed)) {
    fail(code, path, `${path} has unknown field(s): ${truncateForMessage(unknownFields(value, allowed).join(', '))}`, allowed);
  }
}

function requireString(value: unknown, path: string, code: IntegrationErrorCode, maxLength?: number): string {
  if (asNonEmptyString(value) === undefined) fail(code, path, `${path} must be a non-empty string`);
  const result = value as string;
  if (maxLength !== undefined && result.length > maxLength) {
    fail(code, path, `${path} must be at most ${maxLength} characters`);
  }
  return result;
}

function isArrayIndexKey(key: string): boolean {
  if (key === '') return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function rejectArrayProperties(value: readonly unknown[], path: string, code: IntegrationErrorCode): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && isArrayIndexKey(key)) continue;
    const label = typeof key === 'symbol' ? key.toString() : key;
    fail(code, path, `${path} has unknown array property ${truncateForMessage(label)}`);
  }
}

function stringArray(
  value: unknown,
  path: string,
  code: IntegrationErrorCode,
  maximum: number,
  itemMaximum?: number,
): readonly string[] {
  if (!Array.isArray(value)) fail(code, path, `${path} must be an array of non-empty strings`);
  rejectArrayProperties(value, path, code);
  if (value.length > maximum) fail(code, path, `${path} must contain at most ${maximum} item(s)`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(code, `${path}[${index}]`, `${path}[${index}] must be present; sparse arrays are not accepted`);
    result.push(requireString(value[index], `${path}[${index}]`, code, itemMaximum));
  }
  return result;
}

function revision(value: unknown, path: string, code: IntegrationErrorCode = 'INVALID_PLAN'): string {
  return requireString(value, path, code, MAX_ARTIFACT_REVISION_LENGTH);
}

function validateUnit(value: unknown, path: string): IntegrationUnit {
  const raw = requireObject(value, path, 'INVALID_PLAN');
  requireExact(raw, UNIT_FIELDS, path, 'INVALID_PLAN');
  const verificationValue = ownValue(raw, 'verification');
  let verification: VerificationVerdict;
  try {
    verification = validateVerificationVerdict(verificationValue);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'verification is invalid';
    fail('INVALID_PLAN', `${path}.verification`, `verification is invalid: ${truncateForMessage(detail)}`, ['passed']);
  }
  const unit: IntegrationUnit = {
    taskId: requireString(ownValue(raw, 'taskId'), `${path}.taskId`, 'INVALID_PLAN', MAX_TASK_ID_LENGTH),
    branch: requireString(ownValue(raw, 'branch'), `${path}.branch`, 'INVALID_PLAN', MAX_BRANCH_LENGTH),
    revision: revision(ownValue(raw, 'revision'), `${path}.revision`),
    verification,
  };
  if (unit.verification.verdict !== 'passed') {
    fail('INVALID_PLAN', `${path}.verification.verdict`, 'only passed verification verdicts can enter integration', ['passed']);
  }
  if (unit.verification.artifactRevision !== unit.revision) {
    fail('INVALID_PLAN', `${path}.verification.artifactRevision`, 'verification artifactRevision must match unit revision', [unit.revision]);
  }
  return unit;
}

function validateUnits(value: unknown): readonly IntegrationUnit[] {
  if (!Array.isArray(value)) fail('INVALID_PLAN', 'units', 'units must be an array');
  rejectArrayProperties(value, 'units', 'INVALID_PLAN');
  if (value.length === 0) fail('INVALID_PLAN', 'units', 'units must not be empty');
  if (value.length > MAX_UNITS) fail('INVALID_PLAN', 'units', `units must contain at most ${MAX_UNITS} item(s)`);
  const result: IntegrationUnit[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail('INVALID_PLAN', `units[${index}]`, `units[${index}] must be present; sparse arrays are not accepted`);
    const unit = validateUnit(value[index], `units[${index}]`);
    if (seen.has(unit.taskId)) fail('INVALID_PLAN', `units[${index}].taskId`, `duplicate taskId "${truncateForMessage(unit.taskId)}"`);
    seen.add(unit.taskId);
    result.push(unit);
  }
  return result;
}

function validateCommands(value: unknown, path: string, code: IntegrationErrorCode): readonly string[] {
  return stringArray(value, path, code, MAX_COMMANDS, MAX_COMMAND_LENGTH);
}

function validateDependencies(
  value: unknown,
  units: readonly IntegrationUnit[],
): readonly IntegrationDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('INVALID_OPTIONS', 'options.dependencies', 'options.dependencies must be an array');
  rejectArrayProperties(value, 'options.dependencies', 'INVALID_OPTIONS');
  const unitIds = new Set(units.map((unit) => unit.taskId));
  const result: IntegrationDependency[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail('INVALID_OPTIONS', `options.dependencies[${index}]`, `options.dependencies[${index}] must be present; sparse arrays are not accepted`);
    const raw = requireObject(value[index], `options.dependencies[${index}]`, 'INVALID_OPTIONS');
    requireExact(raw, DEPENDENCY_FIELDS, `options.dependencies[${index}]`, 'INVALID_OPTIONS');
    const taskId = requireString(ownValue(raw, 'taskId'), `options.dependencies[${index}].taskId`, 'INVALID_OPTIONS', MAX_TASK_ID_LENGTH);
    if (!unitIds.has(taskId)) fail('INVALID_OPTIONS', `options.dependencies[${index}].taskId`, `unknown integration unit "${truncateForMessage(taskId)}"`, [...unitIds]);
    const dependsOn = stringArray(ownValue(raw, 'dependsOn'), `options.dependencies[${index}].dependsOn`, 'INVALID_OPTIONS', MAX_UNITS);
    const seen = new Set<string>();
    for (let dependencyIndex = 0; dependencyIndex < dependsOn.length; dependencyIndex++) {
      const dependency = dependsOn[dependencyIndex]!;
      if (!unitIds.has(dependency)) fail('INVALID_OPTIONS', `options.dependencies[${index}].dependsOn[${dependencyIndex}]`, `unknown integration unit "${truncateForMessage(dependency)}"`, [...unitIds]);
      if (dependency === taskId) fail('INVALID_OPTIONS', `options.dependencies[${index}].dependsOn[${dependencyIndex}]`, 'a unit cannot depend on itself');
      if (seen.has(dependency)) fail('INVALID_OPTIONS', `options.dependencies[${index}].dependsOn[${dependencyIndex}]`, 'duplicate dependency');
      seen.add(dependency);
    }
    result.push({ taskId, dependsOn });
  }
  return result;
}

function validateOrder(value: unknown, units: readonly IntegrationUnit[]): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const order = stringArray(value, 'options.order', 'INVALID_OPTIONS', MAX_UNITS);
  if (order.length !== units.length) fail('INVALID_OPTIONS', 'options.order', 'options.order must list every unit exactly once', units.map((unit) => unit.taskId));
  const known = new Set(units.map((unit) => unit.taskId));
  const seen = new Set<string>();
  for (let index = 0; index < order.length; index++) {
    const taskId = order[index]!;
    if (!known.has(taskId)) fail('INVALID_OPTIONS', `options.order[${index}]`, `unknown integration unit "${truncateForMessage(taskId)}"`, [...known]);
    if (seen.has(taskId)) fail('INVALID_OPTIONS', `options.order[${index}]`, 'options.order must not contain duplicates');
    seen.add(taskId);
  }
  return order;
}

function topologicalOrder(
  units: readonly IntegrationUnit[],
  dependencies: readonly IntegrationDependency[],
  requestedOrder: readonly string[] | undefined,
): readonly IntegrationUnit[] {
  const byId = new Map(units.map((unit) => [unit.taskId, unit]));
  const tieOrder = requestedOrder ?? units.map((unit) => unit.taskId);
  const rank = new Map(tieOrder.map((taskId, index) => [taskId, index]));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const unit of units) {
    incoming.set(unit.taskId, new Set());
    outgoing.set(unit.taskId, new Set());
  }
  for (const dependency of dependencies) {
    const targets = incoming.get(dependency.taskId)!;
    for (const prerequisite of dependency.dependsOn) {
      targets.add(prerequisite);
      outgoing.get(prerequisite)!.add(dependency.taskId);
    }
  }
  const ready: string[] = tieOrder.filter((taskId) => incoming.get(taskId)!.size === 0);
  const result: IntegrationUnit[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => rank.get(left)! - rank.get(right)!);
    const next = ready.shift()!;
    result.push(byId.get(next)!);
    for (const dependent of outgoing.get(next)!) {
      const remaining = incoming.get(dependent)!;
      remaining.delete(next);
      if (remaining.size === 0) ready.push(dependent);
    }
  }
  if (result.length !== units.length) {
    fail('INVALID_OPTIONS', 'options.dependencies', 'integration dependencies contain a cycle', units.map((unit) => unit.taskId));
  }
  return result;
}

function validatePlan(input: unknown): MergePlan {
  const raw = requireObject(input, 'plan', 'INVALID_PLAN');
  requireExact(raw, PLAN_FIELDS, 'plan', 'INVALID_PLAN');
  const units = validateUnits(ownValue(raw, 'units'));
  return deepFreeze({
    baseRevision: revision(ownValue(raw, 'baseRevision'), 'plan.baseRevision'),
    units,
    verificationCommands: validateCommands(ownValue(raw, 'verificationCommands'), 'plan.verificationCommands', 'INVALID_PLAN'),
  });
}

/**
 * Build a stable plan. Without dependencies, input order (or `options.order`)
 * is used. With dependencies, Kahn's topological order is used and `order` is
 * only the stable tie-breaker; dependency edges always win.
 */
export function planIntegration(unitsInput: unknown, optionsInput: unknown): MergePlan {
  if (!Array.isArray(unitsInput)) fail('INVALID_PLAN', 'units', 'units must be an array');
  const units = validateUnits(unitsInput);
  const options = requireObject(optionsInput, 'options', 'INVALID_OPTIONS');
  requireExact(options, OPTIONS_FIELDS, 'options', 'INVALID_OPTIONS');
  const baseRevision = revision(ownValue(options, 'baseRevision'), 'options.baseRevision', 'INVALID_OPTIONS');
  const order = validateOrder(ownValue(options, 'order'), units);
  const dependencies = validateDependencies(ownValue(options, 'dependencies'), units);
  const ordered = topologicalOrder(units, dependencies, order);
  const verificationCommands = ownValue(options, 'verificationCommands') === undefined
    ? []
    : validateCommands(ownValue(options, 'verificationCommands'), 'options.verificationCommands', 'INVALID_OPTIONS');
  return deepFreeze({ baseRevision, units: ordered, verificationCommands });
}

interface NormalizedGitResult {
  readonly ok: boolean;
  readonly revision?: string;
  readonly details?: string;
}

function validateGitResult(value: unknown, path: string): NormalizedGitResult {
  const raw = requireObject(value, path, 'INVALID_RUNNER_RESULT');
  requireExact(raw, ['ok', 'revision', 'details'], path, 'INVALID_RUNNER_RESULT');
  const ok = ownValue(raw, 'ok');
  if (typeof ok !== 'boolean') fail('INVALID_RUNNER_RESULT', `${path}.ok`, `${path}.ok must be boolean`, ['true', 'false']);
  const rawRevision = ownValue(raw, 'revision');
  const rawDetails = ownValue(raw, 'details');
  if (rawRevision !== undefined) revision(rawRevision, `${path}.revision`, 'INVALID_RUNNER_RESULT');
  if (rawDetails !== undefined && typeof rawDetails !== 'string') fail('INVALID_RUNNER_RESULT', `${path}.details`, `${path}.details must be a string`);
  if (!ok && asNonEmptyString(rawDetails) === undefined) fail('INVALID_RUNNER_RESULT', `${path}.details`, `${path}.details is required when ok is false`);
  if (ok && asNonEmptyString(rawRevision) === undefined) fail('INVALID_RUNNER_RESULT', `${path}.revision`, `${path}.revision is required when ok is true`);
  return {
    ok,
    ...(rawRevision === undefined ? {} : { revision: rawRevision as string }),
    ...(rawDetails === undefined ? {} : { details: rawDetails as string }),
  };
}

function validateConflictFiles(value: unknown, path: string, code: IntegrationErrorCode = 'INVALID_RUNNER_RESULT'): readonly string[] {
  return stringArray(value, path, code, MAX_CONFLICTS, MAX_PATH_LENGTH);
}

function validateConflictQuery(value: unknown): readonly string[] {
  const raw = requireObject(value, 'gitOps.conflicts.return', 'INVALID_RUNNER_RESULT');
  requireExact(raw, ['conflicts'], 'gitOps.conflicts.return', 'INVALID_RUNNER_RESULT');
  return validateConflictFiles(ownValue(raw, 'conflicts'), 'gitOps.conflicts.return.conflicts');
}

function validateEvidenceCommandBounds(evidence: EvidenceBundle): void {
  for (let index = 0; index < evidence.commands.length; index++) {
    const command = evidence.commands[index]!;
    requireString(command.command, `report.finalVerification.evidence.commands[${index}].command`, 'INVALID_INTEGRATION_REPORT', MAX_COMMAND_LENGTH);
    if (command.cwd !== undefined) {
      requireString(command.cwd, `report.finalVerification.evidence.commands[${index}].cwd`, 'INVALID_INTEGRATION_REPORT', MAX_PATH_LENGTH);
    }
  }
}

function validateStatus(value: unknown): { readonly revision: string; readonly clean: boolean; readonly details?: string } {
  const raw = requireObject(value, 'gitOps.status.return', 'INVALID_RUNNER_RESULT');
  requireExact(raw, ['revision', 'clean', 'details'], 'gitOps.status.return', 'INVALID_RUNNER_RESULT');
  const clean = ownValue(raw, 'clean');
  if (typeof clean !== 'boolean') fail('INVALID_RUNNER_RESULT', 'gitOps.status.return.clean', 'gitOps.status.return.clean must be boolean', ['true', 'false']);
  const details = ownValue(raw, 'details');
  if (details !== undefined && typeof details !== 'string') fail('INVALID_RUNNER_RESULT', 'gitOps.status.return.details', 'gitOps.status.return.details must be a string');
  return {
    revision: revision(ownValue(raw, 'revision'), 'gitOps.status.return.revision', 'INVALID_RUNNER_RESULT'),
    clean,
    ...(details === undefined ? {} : { details }),
  };
}

function validateContext(input: unknown): IntegrationRunContext {
  const raw = requireObject(input, 'ctx', 'INVALID_CONTEXT');
  requireExact(raw, ['clock'], 'ctx', 'INVALID_CONTEXT');
  if (typeof ownValue(raw, 'clock') !== 'function') fail('INVALID_CONTEXT', 'ctx.clock', 'ctx.clock must be a function');
  return { clock: ownValue(raw, 'clock') as () => number };
}

function validateRunner(input: unknown): IntegrationRunner {
  const raw = requireObject(input, 'runner', 'INVALID_RUNNER');
  requireExact(raw, ['gitOps', 'commandRunner'], 'runner', 'INVALID_RUNNER');
  const gitOps = requireObject(ownValue(raw, 'gitOps'), 'runner.gitOps', 'INVALID_RUNNER');
  requireExact(gitOps, ['rebase', 'merge', 'conflicts', 'status'], 'runner.gitOps', 'INVALID_RUNNER');
  const commandRunner = requireObject(ownValue(raw, 'commandRunner'), 'runner.commandRunner', 'INVALID_RUNNER');
  requireExact(commandRunner, ['run'], 'runner.commandRunner', 'INVALID_RUNNER');
  for (const [path, value] of [
    ['runner.gitOps.rebase', ownValue(gitOps, 'rebase')],
    ['runner.gitOps.merge', ownValue(gitOps, 'merge')],
    ['runner.gitOps.conflicts', ownValue(gitOps, 'conflicts')],
    ['runner.gitOps.status', ownValue(gitOps, 'status')],
    ['runner.commandRunner.run', ownValue(commandRunner, 'run')],
  ] as const) {
    if (typeof value !== 'function') fail('INVALID_RUNNER', path, `${path} must be a function`);
  }
  return { gitOps: gitOps as unknown as IntegrationGitOps, commandRunner: commandRunner as unknown as IntegrationCommandRunner };
}

function readClock(clock: () => number, path = 'ctx.clock'): number {
  let value: unknown;
  try {
    value = clock();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'clock threw a non-Error value';
    fail('INVALID_CONTEXT', path, `${path} threw: ${truncateForMessage(detail)}`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_CONTEXT', path, `${path} must return a finite number`);
  return value;
}

function errorData(error: unknown, fallback: IntegrationErrorData): IntegrationErrorData {
  if (error instanceof IntegrationError) {
    return { code: error.code, message: truncateForMessage(error.message), path: error.path, available: [...error.available] };
  }
  const detail = error instanceof Error ? error.message : 'runner threw a non-Error value';
  return { ...fallback, message: truncateForMessage(`${fallback.message}: ${detail}`) };
}

function step(name: IntegrationStepName, ok: boolean, details: string): IntegrationStep {
  return { name, ok, details: truncateForMessage(details) };
}

function report(
  steps: readonly IntegrationStep[],
  conflicts: readonly string[],
  outcome: IntegrationOutcome,
  finalVerification?: IntegrationFinalVerification,
  error?: IntegrationErrorData,
): IntegrationReport {
  return deepFreeze({
    steps: steps.map((entry) => ({ ...entry })),
    conflicts: [...conflicts],
    ...(finalVerification === undefined ? {} : { finalVerification }),
    outcome,
    ...(error === undefined ? {} : { error }),
  });
}

function runnerFailureReport(
  steps: readonly IntegrationStep[],
  conflicts: readonly string[],
  error: IntegrationErrorData,
): IntegrationReport {
  return report(steps, conflicts, 'runner_error', undefined, error);
}

function conflictAfterFailure(
  steps: IntegrationStep[],
  runner: IntegrationRunner,
  conflictPath: string,
  failureDetail: string,
): IntegrationReport {
  try {
    const conflicts = validateConflictQuery(runner.gitOps.conflicts());
    if (conflicts.length > 0) {
      steps.push(step('conflict-check', true, `${conflictPath}: ${conflicts.join(', ')}`));
      return report(steps, conflicts, 'conflict');
    }
    const data: IntegrationErrorData = {
      code: 'RUNNER_FAILED',
      message: truncateForMessage(failureDetail),
      path: conflictPath,
      available: [],
    };
    return runnerFailureReport(steps, [], data);
  } catch (error) {
    const data = errorData(error, {
      code: 'INVALID_RUNNER_RESULT',
      message: 'conflict query failed',
      path: 'gitOps.conflicts',
      available: ['conflicts'],
    });
    return runnerFailureReport(steps, [], data);
  }
}

function makeEvidence(
  commands: readonly VerificationCommand[],
  outcomes: readonly VerificationOutcome[],
  startedAt: number,
  endedAt: number,
  artifactRevision: string,
): EvidenceBundle {
  return deepFreeze({
    taskId: 'Tintegration',
    attemptId: 'Tintegration:attempt-1',
    artifactRevision,
    commands: commands.map((command) => ({ ...command })),
    outcomes: outcomes.map((outcome) => ({ ...outcome })),
    startedAt,
    endedAt,
  });
}

function commandResult(value: unknown, path: string): VerificationRunnerResult {
  const raw = requireObject(value, path, 'INVALID_RUNNER_RESULT');
  requireExact(raw, ['exitCode', 'timedOut', 'output', 'outputRef'], path, 'INVALID_RUNNER_RESULT');
  const exitCode = ownValue(raw, 'exitCode');
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0) fail('INVALID_RUNNER_RESULT', `${path}.exitCode`, `${path}.exitCode must be a non-negative integer`);
  const timedOut = ownValue(raw, 'timedOut');
  if (typeof timedOut !== 'boolean') fail('INVALID_RUNNER_RESULT', `${path}.timedOut`, `${path}.timedOut must be boolean`, ['true', 'false']);
  const output = ownValue(raw, 'output');
  const outputRef = ownValue(raw, 'outputRef');
  if (output !== undefined && typeof output !== 'string') fail('INVALID_RUNNER_RESULT', `${path}.output`, `${path}.output must be a string`);
  if (outputRef !== undefined && asNonEmptyString(outputRef) === undefined) fail('INVALID_RUNNER_RESULT', `${path}.outputRef`, `${path}.outputRef must be a non-empty string`);
  return {
    exitCode,
    timedOut,
    ...(output === undefined ? {} : { output }),
    ...(outputRef === undefined ? {} : { outputRef: outputRef as string }),
  };
}

function runVerification(
  plan: MergePlan,
  runner: IntegrationRunner,
  clock: () => number,
  steps: IntegrationStep[],
  artifactRevision: string,
): IntegrationReport | { readonly finalVerification: IntegrationFinalVerification; readonly startedAt: number; readonly endedAt: number } {
  try {
    const startedAt = readClock(clock);
    const commands: VerificationCommand[] = [];
    const outcomes: VerificationOutcome[] = [];
    for (let index = 0; index < plan.verificationCommands.length; index++) {
      const commandText = plan.verificationCommands[index]!;
      const command: VerificationCommand = { command: commandText };
      const commandStartedAt = readClock(clock);
      let rawResult: unknown;
      try {
        rawResult = runner.commandRunner.run(command);
      } catch (error) {
        const data = errorData(error, {
          code: 'RUNNER_FAILED',
          message: 'command runner failed',
          path: `commandRunner.run[${index}]`,
          available: [],
        });
        steps.push(step('verification', false, data.message));
        return runnerFailureReport(steps, [], data);
      }
      const normalized = commandResult(rawResult, `commandRunner.run[${index}].return`);
      const commandEndedAt = readClock(clock);
      if (commandEndedAt < commandStartedAt) fail('INVALID_CONTEXT', 'ctx.clock', 'ctx.clock returned decreasing time');
      const outcome: VerificationOutcome = {
        exitCode: normalized.exitCode,
        durationMs: commandEndedAt - commandStartedAt,
        timedOut: normalized.timedOut,
        output: normalized.output === undefined ? '' : truncateForMessage(normalized.output),
        ...(normalized.outputRef === undefined ? {} : { outputRef: truncateForMessage(normalized.outputRef) }),
      };
      commands.push(command);
      outcomes.push(outcome);
    }
    const endedAt = readClock(clock);
    if (endedAt < startedAt) fail('INVALID_CONTEXT', 'ctx.clock', 'ctx.clock returned decreasing time');
    const evidence = makeEvidence(commands, outcomes, startedAt, endedAt, artifactRevision);
    // S5 remains the single verdict rule: integration only supplies evidence.
    const verdict = decideVerdict(evidence);
    const finalVerification: IntegrationFinalVerification = deepFreeze({ evidence, verdict });
    steps.push(step('verification', verdict.verdict === 'passed', verdict.reasons.join('; ') || 'all verification commands passed'));
    if (verdict.verdict !== 'passed') return { finalVerification, startedAt, endedAt };
    return { finalVerification, startedAt, endedAt };
  } catch (error) {
    const data = errorData(error, {
      code: 'INVALID_RUNNER_RESULT',
      message: 'verification runner returned an invalid result',
      path: 'commandRunner.run',
      available: ['exitCode', 'timedOut', 'output', 'outputRef'],
    });
    steps.push(step('verification', false, data.message));
    return runnerFailureReport(steps, [], data);
  }
}

/** Execute the mechanical integration sequence using only injected ports. */
export function runIntegration(planInput: unknown, runnerInput: unknown, ctxInput: unknown): IntegrationReport {
  const plan = validatePlan(planInput);
  const runner = validateRunner(runnerInput);
  const ctx = validateContext(ctxInput);
  const steps: IntegrationStep[] = [];
  let currentRevision = plan.baseRevision;

  for (let index = 0; index < plan.units.length; index++) {
    const unit = plan.units[index]!;
    let raw: unknown;
    try {
      raw = runner.gitOps.rebase(plan.baseRevision, unit);
      const result = validateGitResult(raw, `gitOps.rebase[${index}].return`);
      steps.push(step('rebase', result.ok, `${unit.taskId}: ${result.details ?? (result.ok ? 'rebased' : 'rebase failed')}`));
      if (!result.ok) return conflictAfterFailure(steps, runner, `gitOps.rebase[${index}]`, result.details ?? 'rebase failed');
      currentRevision = result.revision ?? currentRevision;
    } catch (error) {
      const data = errorData(error, { code: 'RUNNER_FAILED', message: 'git rebase failed', path: `gitOps.rebase[${index}]`, available: [] });
      steps.push(step('rebase', false, data.message));
      return runnerFailureReport(steps, [], data);
    }

    try {
      raw = runner.gitOps.merge(unit);
      const result = validateGitResult(raw, `gitOps.merge[${index}].return`);
      steps.push(step('merge', result.ok, `${unit.taskId}: ${result.details ?? (result.ok ? 'merged' : 'merge failed')}`));
      if (!result.ok) return conflictAfterFailure(steps, runner, `gitOps.merge[${index}]`, result.details ?? 'merge failed');
      currentRevision = result.revision ?? currentRevision;
    } catch (error) {
      const data = errorData(error, { code: 'RUNNER_FAILED', message: 'git merge failed', path: `gitOps.merge[${index}]`, available: [] });
      steps.push(step('merge', false, data.message));
      return runnerFailureReport(steps, [], data);
    }
  }

  const verification = runVerification(plan, runner, ctx.clock, steps, currentRevision);
  if ('outcome' in verification) return verification;
  if (verification.finalVerification.verdict.verdict !== 'passed') {
    return report(steps, [], 'verification_failed', verification.finalVerification);
  }

  let conflicts: readonly string[];
  try {
    conflicts = validateConflictQuery(runner.gitOps.conflicts());
  } catch (error) {
    const data = errorData(error, { code: 'INVALID_RUNNER_RESULT', message: 'conflict query returned an invalid result', path: 'gitOps.conflicts.return', available: ['conflicts'] });
    steps.push(step('conflict-check', false, data.message));
    return runnerFailureReport(steps, [], data);
  }
  if (conflicts.length > 0) {
    steps.push(step('conflict-check', false, `conflicts: ${conflicts.join(', ')}`));
    return report(steps, conflicts, 'conflict', verification.finalVerification);
  }
  steps.push(step('conflict-check', true, 'no conflicts reported'));

  try {
    const status = validateStatus(runner.gitOps.status());
    if (!status.clean) {
      const files = ['<working-tree>'];
      steps.push(step('status', false, status.details ?? 'working tree is not clean'));
      return report(steps, files, 'conflict', verification.finalVerification);
    }
    if (status.revision !== verification.finalVerification.evidence.artifactRevision) {
      const data: IntegrationErrorData = {
        code: 'RUNNER_FAILED',
        message: 'git status revision does not match the verified artifact revision',
        path: 'gitOps.status.return.revision',
        available: [verification.finalVerification.evidence.artifactRevision],
      };
      steps.push(step('status', false, data.message));
      return runnerFailureReport(steps, [], data);
    }
    steps.push(step('status', true, status.details ?? `clean at ${status.revision}`));
    return report(steps, [], 'merged', verification.finalVerification);
  } catch (error) {
    const data = errorData(error, { code: 'INVALID_RUNNER_RESULT', message: 'git status returned an invalid result', path: 'gitOps.status.return', available: ['revision', 'clean', 'details'] });
    steps.push(step('status', false, data.message));
    return runnerFailureReport(steps, [], data);
  }
}

function validateStep(value: unknown, path: string): IntegrationStep {
  const raw = requireObject(value, path, 'INVALID_REPORT');
  requireExact(raw, STEP_FIELDS, path, 'INVALID_REPORT');
  const name = ownValue(raw, 'name');
  if (typeof name !== 'string' || !INTEGRATION_STEP_NAMES.includes(name as IntegrationStepName)) fail('INVALID_REPORT', `${path}.name`, `${path}.name is not a known integration step`, INTEGRATION_STEP_NAMES);
  const ok = ownValue(raw, 'ok');
  if (typeof ok !== 'boolean') fail('INVALID_REPORT', `${path}.ok`, `${path}.ok must be boolean`, ['true', 'false']);
  const details = ownValue(raw, 'details');
  if (typeof details !== 'string' || details.length > 160) fail('INVALID_REPORT', `${path}.details`, `${path}.details must be a bounded string`);
  return { name: name as IntegrationStepName, ok, details };
}

type PipelineStage =
  | 'early-failure'
  | 'merge-conflict'
  | 'verification-failure'
  | 'conflict-check-failure'
  | 'status-failure'
  | 'complete';

function pipelineStage(steps: readonly IntegrationStep[]): PipelineStage | undefined {
  if (steps.length === 0) return undefined;
  let index = 0;
  let pairs = 0;
  while (index < steps.length && steps[index]?.name === 'rebase') {
    const rebase = steps[index]!;
    index++;
    // A real rebase failure ends the mechanical path before a merge step.
    if (!rebase.ok) {
      if (index === steps.length) return 'early-failure';
      if (index + 1 === steps.length && steps[index]?.name === 'conflict-check' && steps[index]?.ok === true) return 'merge-conflict';
      return undefined;
    }
    if (index >= steps.length || steps[index]?.name !== 'merge') return undefined;
    const merge = steps[index]!;
    index++;
    pairs++;
    if (!merge.ok) {
      if (index === steps.length) return 'early-failure';
      if (index + 1 === steps.length && steps[index]?.name === 'conflict-check' && steps[index]?.ok === true) return 'merge-conflict';
      return undefined;
    }
  }
  if (pairs === 0 || index >= steps.length || steps[index]?.name !== 'verification') return undefined;
  const verification = steps[index]!;
  index++;
  if (!verification.ok) return index === steps.length ? 'verification-failure' : undefined;
  if (index >= steps.length || steps[index]?.name !== 'conflict-check') return undefined;
  const conflictCheck = steps[index]!;
  index++;
  if (!conflictCheck.ok) return index === steps.length ? 'conflict-check-failure' : undefined;
  if (index >= steps.length || steps[index]?.name !== 'status') return undefined;
  const status = steps[index]!;
  index++;
  if (index !== steps.length) return undefined;
  return status.ok ? 'complete' : 'status-failure';
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateReport(input: unknown): IntegrationReport {
  const raw = requireObject(input, 'report', 'INVALID_REPORT');
  requireExact(raw, REPORT_FIELDS, 'report', 'INVALID_REPORT');
  const rawSteps = ownValue(raw, 'steps');
  if (!Array.isArray(rawSteps)) fail('INVALID_REPORT', 'report.steps', 'report.steps must be an array');
  if (rawSteps.length > MAX_UNITS * 2 + 3) fail('INVALID_REPORT', 'report.steps', 'report.steps is too long');
  rejectArrayProperties(rawSteps, 'report.steps', 'INVALID_REPORT');
  const steps: IntegrationStep[] = [];
  for (let index = 0; index < rawSteps.length; index++) {
    if (!Object.hasOwn(rawSteps, index)) fail('INVALID_REPORT', `report.steps[${index}]`, 'sparse arrays are not accepted');
    steps.push(validateStep(rawSteps[index], `report.steps[${index}]`));
  }
  const conflicts = validateConflictFiles(ownValue(raw, 'conflicts'), 'report.conflicts', 'INVALID_REPORT');
  const outcome = ownValue(raw, 'outcome');
  if (typeof outcome !== 'string' || !INTEGRATION_OUTCOMES.includes(outcome as IntegrationOutcome)) fail('INVALID_REPORT', 'report.outcome', 'report.outcome is unknown', INTEGRATION_OUTCOMES);
  const rawFinal = ownValue(raw, 'finalVerification');
  let finalVerification: IntegrationFinalVerification | undefined;
  if (rawFinal !== undefined) {
    const final = requireObject(rawFinal, 'report.finalVerification', 'INVALID_REPORT');
    requireExact(final, FINAL_VERIFICATION_FIELDS, 'report.finalVerification', 'INVALID_REPORT');
    let evidence: EvidenceBundle;
    try {
      evidence = validateEvidenceBundle(ownValue(final, 'evidence'));
    } catch (error) {
      fail('INVALID_REPORT', 'report.finalVerification.evidence', `invalid evidence: ${truncateForMessage(error instanceof Error ? error.message : 'invalid evidence')}`);
    }
    validateEvidenceCommandBounds(evidence);
    let verdict: VerificationVerdict;
    try {
      verdict = validateVerificationVerdict(ownValue(final, 'verdict'));
    } catch (error) {
      fail('INVALID_REPORT', 'report.finalVerification.verdict', `invalid verdict: ${truncateForMessage(error instanceof Error ? error.message : 'invalid verdict')}`);
    }
    if (evidence.artifactRevision !== verdict.artifactRevision) fail('INVALID_REPORT', 'report.finalVerification', 'evidence and verdict revisions must match', [evidence.artifactRevision]);
    const expectedVerdict = decideVerdict(evidence);
    if (
      expectedVerdict.verdict !== verdict.verdict
      || expectedVerdict.artifactRevision !== verdict.artifactRevision
      || !sameStrings(expectedVerdict.reasons, verdict.reasons)
    ) {
      fail('INVALID_INTEGRATION_REPORT', 'report.finalVerification.verdict', 'final verification verdict does not match the S5 verdict recomputed from evidence', [expectedVerdict.verdict]);
    }
    finalVerification = { evidence, verdict };
  }
  const rawError = ownValue(raw, 'error');
  let errorDataValue: IntegrationErrorData | undefined;
  if (rawError !== undefined) {
    const error = requireObject(rawError, 'report.error', 'INVALID_REPORT');
    requireExact(error, ERROR_FIELDS, 'report.error', 'INVALID_REPORT');
    const code = ownValue(error, 'code');
    if (typeof code !== 'string' || !INTEGRATION_ERROR_CODES.includes(code as IntegrationErrorCode)) fail('INVALID_REPORT', 'report.error.code', 'report.error.code is unknown', INTEGRATION_ERROR_CODES);
    errorDataValue = {
      code: code as IntegrationErrorCode,
      message: requireString(ownValue(error, 'message'), 'report.error.message', 'INVALID_REPORT', 160),
      path: requireString(ownValue(error, 'path'), 'report.error.path', 'INVALID_REPORT', 160),
      available: validateConflictFiles(ownValue(error, 'available'), 'report.error.available', 'INVALID_REPORT'),
    };
  }
  const normalized: IntegrationReport = {
    steps,
    conflicts,
    ...(finalVerification === undefined ? {} : { finalVerification }),
    outcome: outcome as IntegrationOutcome,
    ...(errorDataValue === undefined ? {} : { error: errorDataValue }),
  };
  const stage = pipelineStage(steps);
  if (stage === undefined) fail('INVALID_INTEGRATION_REPORT', 'report.steps', 'steps must follow the rebase -> merge -> verification -> conflict-check -> status pipeline without duplicates or reordering');
  if (normalized.outcome === 'merged') {
    if (stage !== 'complete' || conflicts.length !== 0 || finalVerification?.verdict.verdict !== 'passed') fail('INVALID_INTEGRATION_REPORT', 'report', 'merged report is inconsistent with the complete integration pipeline');
  } else if (normalized.outcome === 'verification_failed') {
    if (stage !== 'verification-failure' || conflicts.length !== 0 || finalVerification?.verdict.verdict !== 'rejected') fail('INVALID_INTEGRATION_REPORT', 'report', 'verification_failed must stop after successful rebase/merge and a failed verification');
  } else if (normalized.outcome === 'conflict') {
    if ((stage !== 'merge-conflict' && stage !== 'conflict-check-failure' && stage !== 'status-failure') || conflicts.length === 0) fail('INVALID_INTEGRATION_REPORT', 'report', 'conflict report must stop at a conflict in the ordered integration pipeline');
  } else if (stage === 'complete' || errorDataValue === undefined) {
    fail('INVALID_INTEGRATION_REPORT', 'report', 'runner_error report must contain a failed pipeline step and structured error data');
  }
  return deepFreeze(normalized);
}

export interface EscalationOptions {
  readonly mechanicalRetries?: number;
  readonly attempts?: number;
}

function validateEscalationOptions(input: unknown): { readonly mechanicalRetries: number; readonly attempts: number } {
  if (input === undefined) return { mechanicalRetries: 1, attempts: 0 };
  const raw = requireObject(input, 'options', 'INVALID_REPORT');
  requireExact(raw, ['mechanicalRetries', 'attempts'], 'options', 'INVALID_REPORT');
  const mechanicalRetries = ownValue(raw, 'mechanicalRetries') === undefined ? 1 : ownValue(raw, 'mechanicalRetries');
  const attempts = ownValue(raw, 'attempts') === undefined ? 0 : ownValue(raw, 'attempts');
  if (typeof mechanicalRetries !== 'number' || !Number.isInteger(mechanicalRetries) || mechanicalRetries < 0) fail('INVALID_REPORT', 'options.mechanicalRetries', 'options.mechanicalRetries must be a non-negative integer');
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) fail('INVALID_REPORT', 'options.attempts', 'options.attempts must be a non-negative integer');
  return { mechanicalRetries, attempts };
}

/** Revalidate report provenance by recomputing outcome invariants before escalating. */
export function decideEscalation(
  reportInput: unknown,
  optionsInput: unknown = undefined,
): { readonly action: 'none' | 'mechanical-retry' | 'integration-agent' | 'human'; readonly reason: string } {
  const report = validateReport(reportInput);
  const options = validateEscalationOptions(optionsInput);
  if (report.outcome === 'merged') return deepFreeze({ action: 'none', reason: 'mechanical integration and final verification passed' });
  if (report.outcome === 'verification_failed') {
    const remaining = Math.max(0, options.mechanicalRetries - options.attempts);
    return deepFreeze({ action: 'mechanical-retry', reason: `final verification failed; ${remaining} mechanical retry slot(s) remain` });
  }
  if (report.outcome === 'conflict') return deepFreeze({ action: 'integration-agent', reason: 'merge conflict requires the integration-agent contract with conflict files and revision-bound diffs' });
  return deepFreeze({ action: 'human', reason: 'runner or integration structure failed validation; human inspection is required' });
}

/** Assemble the LLM escalation input without invoking a model. */
export function assembleIntegrationAgentBrief(
  planInput: unknown,
  reportInput: unknown,
  diffSummariesInput: unknown,
): IntegrationAgentBrief {
  const plan = validatePlan(planInput);
  const report = validateReport(reportInput);
  if (report.outcome !== 'conflict' || report.conflicts.length === 0) fail('INVALID_AGENT_BRIEF', 'report', 'integration-agent brief requires a conflict report', ['conflict']);
  if (!Array.isArray(diffSummariesInput)) fail('INVALID_AGENT_BRIEF', 'diffSummaries', 'diffSummaries must be an array');
  rejectArrayProperties(diffSummariesInput, 'diffSummaries', 'INVALID_AGENT_BRIEF');
  const summaries: IntegrationDiffSummary[] = [];
  if (diffSummariesInput.length !== plan.units.length) fail('INVALID_AGENT_BRIEF', 'diffSummaries', 'diffSummaries must contain one summary per integration unit', plan.units.map((unit) => unit.taskId));
  const unitIds = new Set(plan.units.map((unit) => unit.taskId));
  const summaryIds = new Set<string>();
  for (let index = 0; index < diffSummariesInput.length; index++) {
    if (!Object.hasOwn(diffSummariesInput, index)) fail('INVALID_AGENT_BRIEF', `diffSummaries[${index}]`, 'sparse arrays are not accepted');
    const raw = requireObject(diffSummariesInput[index], `diffSummaries[${index}]`, 'INVALID_AGENT_BRIEF');
    requireExact(raw, DIFF_SUMMARY_FIELDS, `diffSummaries[${index}]`, 'INVALID_AGENT_BRIEF');
    const taskId = requireString(ownValue(raw, 'taskId'), `diffSummaries[${index}].taskId`, 'INVALID_AGENT_BRIEF', MAX_TASK_ID_LENGTH);
    if (!unitIds.has(taskId)) fail('INVALID_AGENT_BRIEF', `diffSummaries[${index}].taskId`, 'diff summary references an unknown unit', [...unitIds]);
    if (summaryIds.has(taskId)) fail('INVALID_AGENT_BRIEF', `diffSummaries[${index}].taskId`, 'diff summaries must not contain duplicates');
    summaryIds.add(taskId);
    summaries.push({ taskId, summary: truncateForMessage(requireString(ownValue(raw, 'summary'), `diffSummaries[${index}].summary`, 'INVALID_AGENT_BRIEF')) });
  }
  return deepFreeze({
    conflictFiles: [...report.conflicts],
    baseRevision: plan.baseRevision,
    revisions: plan.units.map((unit) => ({ taskId: unit.taskId, branch: unit.branch, revision: unit.revision })),
    diffSummaries: summaries,
  });
}
