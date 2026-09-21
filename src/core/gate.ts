/**
 * S4 orchestration gate.
 *
 * This is a deterministic, explainable rule engine. It estimates whether a
 * validated Task Contract should stay with one worker or enter a plan/DAG
 * route. It never calls a model, runs verification, creates a graph, or
 * changes Scheduler behavior.
 */

import {
  validateTaskContract,
  type ContractIssue,
  type TaskContract,
} from './task-contract.ts';
import {
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export type GateMode = 'auto' | 'force-single' | 'force-plan';
export type ReviewerStrategy = 'auto' | 'always' | 'never';
export type GateComplexity = 'simple' | 'medium' | 'complex';
export type RouteMode = 'single' | 'plan';

/** Optional overrides. Omitted fields use the documented defaults below. */
export interface GateThresholds {
  readonly filesInScopeMedium?: number;
  readonly filesInScopeComplex?: number;
  readonly acceptanceCriteriaMedium?: number;
  readonly acceptanceCriteriaComplex?: number;
  readonly verificationCommandsComplex?: number;
  readonly contractCharsMedium?: number;
  readonly contractCharsComplex?: number;
  readonly dependencyCountMedium?: number;
  readonly dependencyCountComplex?: number;
  /** Number of medium signals needed to promote the estimate to complex. */
  readonly complexScore?: number;
  readonly mediumExpectedTaskCount?: number;
  readonly complexExpectedTaskCount?: number;
  readonly mediumMaxConcurrency?: number;
  readonly complexMaxConcurrency?: number;
}

/**
 * Gate controls are policy data, not an execution sandbox.
 *
 * Defaults:
 * - files: medium at 2, complex at 5
 * - acceptance criteria: medium at 3, complex at 6
 * - verification commands: no command is medium; complex at 4 commands
 * - contract size: medium at 500 and complex at 2,000 UTF-16 characters
 * - dependencies: medium at 1, complex at 3
 * - three medium-weight signals promote to complex
 * - medium plans estimate 2 tasks / concurrency 1
 * - complex plans estimate 4 tasks / concurrency 2
 */
export interface GateConfig {
  readonly mode?: GateMode;
  /** `always` and `never` are the S9 reviewer ablation switches. */
  readonly reviewer?: ReviewerStrategy;
  readonly thresholds?: GateThresholds;
}

export interface RouteSignal {
  readonly name:
    | 'files_in_scope'
    | 'acceptance_criteria'
    | 'verification_commands'
    | 'contract_chars'
    | 'dependencies';
  readonly value: number;
  readonly level: GateComplexity;
  readonly hit: boolean;
  readonly reason: string;
}

export interface MechanicalVerificationPlan {
  /** Always true: the eventual verifier must run the declared mechanical checks. */
  readonly required: true;
  readonly commands: readonly string[];
}

/** Side-effect-free route proposal for future TaskGraph/Scheduler consumption. */
export interface RoutePlan {
  /** Rule-estimated complexity, retained even when a route is forced. */
  readonly complexity: GateComplexity;
  readonly mode: RouteMode;
  /** True when mode was selected by an explicit force-* ablation switch. */
  readonly forced: boolean;
  readonly forcedMode?: Exclude<GateMode, 'auto'>;
  /** Threshold used by the pure signal aggregation; retained for revalidation. */
  readonly complexScore: number;
  readonly score: number;
  readonly signals: readonly RouteSignal[];
  /** One reason per hit complexity signal; empty means no signal crossed a threshold. */
  readonly reasons: readonly string[];
  /** Route/force explanation kept separate from signal reasons. */
  readonly decisionReasons: readonly string[];
  /** Suggested Scheduler concurrency; this gate does not apply it. */
  readonly maxConcurrency: number;
  /** Estimated number of TaskGraph nodes; this gate does not create them. */
  readonly expectedTaskCount: number;
  readonly reviewerStrategy: ReviewerStrategy;
  readonly mechanicalVerification: MechanicalVerificationPlan;
}

export interface VerificationSummary {
  readonly status: 'passed' | 'failed' | 'uncertain';
}

export interface FreshReviewDecision {
  readonly required: boolean;
  readonly reason: string;
}

export type GateErrorCode =
  | 'INVALID_GATE_OPTIONS'
  | 'INVALID_CONTRACT'
  | 'INVALID_ROUTE_PLAN'
  | 'INVALID_VERIFICATION_SUMMARY';

/** Structured Gate input/configuration failure; no malformed input reaches the estimator. */
export class GateConfigError extends Error {
  readonly code: GateErrorCode;
  readonly path: string;
  readonly available: readonly string[];
  readonly issues?: readonly ContractIssue[];

  constructor(
    code: GateErrorCode,
    path: string,
    message: string,
    available: readonly string[] = [],
    issues?: readonly ContractIssue[],
  ) {
    super(message);
    this.name = 'GateConfigError';
    this.code = code;
    this.path = path;
    this.available = Object.freeze([...available]);
    if (issues !== undefined) this.issues = Object.freeze(issues.map((entry) => Object.freeze({ ...entry })));
  }
}

const GATE_FIELDS = ['mode', 'reviewer', 'thresholds'] as const;
const THRESHOLD_FIELDS = [
  'filesInScopeMedium',
  'filesInScopeComplex',
  'acceptanceCriteriaMedium',
  'acceptanceCriteriaComplex',
  'verificationCommandsComplex',
  'contractCharsMedium',
  'contractCharsComplex',
  'dependencyCountMedium',
  'dependencyCountComplex',
  'complexScore',
  'mediumExpectedTaskCount',
  'complexExpectedTaskCount',
  'mediumMaxConcurrency',
  'complexMaxConcurrency',
] as const;
const ROUTE_PLAN_FIELDS = [
  'complexity',
  'mode',
  'forced',
  'forcedMode',
  'complexScore',
  'score',
  'signals',
  'reasons',
  'decisionReasons',
  'maxConcurrency',
  'expectedTaskCount',
  'reviewerStrategy',
  'mechanicalVerification',
] as const;
const ROUTE_SIGNAL_FIELDS = ['name', 'value', 'level', 'hit', 'reason'] as const;
const ROUTE_SIGNAL_NAMES = [
  'files_in_scope',
  'acceptance_criteria',
  'verification_commands',
  'contract_chars',
  'dependencies',
] as const;
const COMPLEXITIES = ['simple', 'medium', 'complex'] as const;
const ROUTE_MODES = ['single', 'plan'] as const;
const REVIEWER_STRATEGIES = ['auto', 'always', 'never'] as const;
const FORCE_MODES = ['force-single', 'force-plan'] as const;

const DEFAULTS = {
  filesInScopeMedium: 2,
  filesInScopeComplex: 5,
  acceptanceCriteriaMedium: 3,
  acceptanceCriteriaComplex: 6,
  verificationCommandsComplex: 4,
  contractCharsMedium: 500,
  contractCharsComplex: 2_000,
  dependencyCountMedium: 1,
  dependencyCountComplex: 3,
  complexScore: 3,
  mediumExpectedTaskCount: 2,
  complexExpectedTaskCount: 4,
  mediumMaxConcurrency: 1,
  complexMaxConcurrency: 2,
} as const;

interface NormalizedThresholds {
  readonly filesInScopeMedium: number;
  readonly filesInScopeComplex: number;
  readonly acceptanceCriteriaMedium: number;
  readonly acceptanceCriteriaComplex: number;
  readonly verificationCommandsComplex: number;
  readonly contractCharsMedium: number;
  readonly contractCharsComplex: number;
  readonly dependencyCountMedium: number;
  readonly dependencyCountComplex: number;
  readonly complexScore: number;
  readonly mediumExpectedTaskCount: number;
  readonly complexExpectedTaskCount: number;
  readonly mediumMaxConcurrency: number;
  readonly complexMaxConcurrency: number;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Reflect.ownKeys(value)
    .filter((key) => typeof key !== 'string' || !allowed.includes(key))
    .map((key) => (typeof key === 'symbol' ? key.toString() : key));
}

function fail(path: string, message: string, available: readonly string[] = []): never {
  throw new GateConfigError('INVALID_GATE_OPTIONS', path, message, available);
}

function requireEnum<T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    fail(path, `${path} must be one of: ${choices.join(', ')}`, choices);
  }
  return value as T;
}

function requirePositiveInteger(value: unknown, path: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(path, `${path} must be a positive integer`);
  }
  return value;
}

function normalizeThresholds(value: unknown): NormalizedThresholds {
  if (value === undefined) return DEFAULTS;
  if (!isPlainObject(value)) fail('options.thresholds', 'options.thresholds must be a plain object');
  if (!hasExactFields(value, THRESHOLD_FIELDS)) {
    fail(
      'options.thresholds',
      `options.thresholds has unknown field(s): ${truncateForMessage(unknownKeys(value, THRESHOLD_FIELDS).join(', '))}`,
      THRESHOLD_FIELDS,
    );
  }

  const result = {
    filesInScopeMedium: requirePositiveInteger(ownValue(value, 'filesInScopeMedium'), 'options.thresholds.filesInScopeMedium', DEFAULTS.filesInScopeMedium),
    filesInScopeComplex: requirePositiveInteger(ownValue(value, 'filesInScopeComplex'), 'options.thresholds.filesInScopeComplex', DEFAULTS.filesInScopeComplex),
    acceptanceCriteriaMedium: requirePositiveInteger(ownValue(value, 'acceptanceCriteriaMedium'), 'options.thresholds.acceptanceCriteriaMedium', DEFAULTS.acceptanceCriteriaMedium),
    acceptanceCriteriaComplex: requirePositiveInteger(ownValue(value, 'acceptanceCriteriaComplex'), 'options.thresholds.acceptanceCriteriaComplex', DEFAULTS.acceptanceCriteriaComplex),
    verificationCommandsComplex: requirePositiveInteger(ownValue(value, 'verificationCommandsComplex'), 'options.thresholds.verificationCommandsComplex', DEFAULTS.verificationCommandsComplex),
    contractCharsMedium: requirePositiveInteger(ownValue(value, 'contractCharsMedium'), 'options.thresholds.contractCharsMedium', DEFAULTS.contractCharsMedium),
    contractCharsComplex: requirePositiveInteger(ownValue(value, 'contractCharsComplex'), 'options.thresholds.contractCharsComplex', DEFAULTS.contractCharsComplex),
    dependencyCountMedium: requirePositiveInteger(ownValue(value, 'dependencyCountMedium'), 'options.thresholds.dependencyCountMedium', DEFAULTS.dependencyCountMedium),
    dependencyCountComplex: requirePositiveInteger(ownValue(value, 'dependencyCountComplex'), 'options.thresholds.dependencyCountComplex', DEFAULTS.dependencyCountComplex),
    complexScore: requirePositiveInteger(ownValue(value, 'complexScore'), 'options.thresholds.complexScore', DEFAULTS.complexScore),
    mediumExpectedTaskCount: requirePositiveInteger(ownValue(value, 'mediumExpectedTaskCount'), 'options.thresholds.mediumExpectedTaskCount', DEFAULTS.mediumExpectedTaskCount),
    complexExpectedTaskCount: requirePositiveInteger(ownValue(value, 'complexExpectedTaskCount'), 'options.thresholds.complexExpectedTaskCount', DEFAULTS.complexExpectedTaskCount),
    mediumMaxConcurrency: requirePositiveInteger(ownValue(value, 'mediumMaxConcurrency'), 'options.thresholds.mediumMaxConcurrency', DEFAULTS.mediumMaxConcurrency),
    complexMaxConcurrency: requirePositiveInteger(ownValue(value, 'complexMaxConcurrency'), 'options.thresholds.complexMaxConcurrency', DEFAULTS.complexMaxConcurrency),
  };
  const orderedPairs: readonly [keyof NormalizedThresholds, keyof NormalizedThresholds][] = [
    ['filesInScopeMedium', 'filesInScopeComplex'],
    ['acceptanceCriteriaMedium', 'acceptanceCriteriaComplex'],
    ['contractCharsMedium', 'contractCharsComplex'],
    ['dependencyCountMedium', 'dependencyCountComplex'],
  ];
  for (const [medium, complex] of orderedPairs) {
    if (result[complex] <= result[medium]) {
      fail(
        `options.thresholds.${complex}`,
        `options.thresholds.${complex} must be greater than options.thresholds.${medium}`,
      );
    }
  }
  if (result.complexScore < 2) fail('options.thresholds.complexScore', 'options.thresholds.complexScore must be at least 2');
  return result;
}

function normalizeConfig(input: unknown): {
  readonly mode: GateMode;
  readonly reviewer: ReviewerStrategy;
  readonly thresholds: NormalizedThresholds;
} {
  if (input === undefined) return { mode: 'auto', reviewer: 'auto', thresholds: DEFAULTS };
  if (!isPlainObject(input)) fail('options', 'options must be a plain object or undefined');
  if (!hasExactFields(input, GATE_FIELDS)) {
    fail(
      'options',
      `options has unknown field(s): ${truncateForMessage(unknownKeys(input, GATE_FIELDS).join(', '))}`,
      GATE_FIELDS,
    );
  }
  return {
    mode: requireEnum(ownValue(input, 'mode'), 'options.mode', ['auto', 'force-single', 'force-plan'], 'auto'),
    reviewer: requireEnum(ownValue(input, 'reviewer'), 'options.reviewer', ['auto', 'always', 'never'], 'auto'),
    thresholds: normalizeThresholds(ownValue(input, 'thresholds')),
  };
}

function invalidContract(error: {
  readonly code: 'INVALID_CONTRACT';
  readonly message: string;
  readonly path: 'contract';
  readonly issues: readonly ContractIssue[];
}): never {
  throw new GateConfigError('INVALID_CONTRACT', error.path, error.message, [], error.issues);
}

function invalidRoutePlan(path: string, message: string, available: readonly string[] = []): never {
  throw new GateConfigError('INVALID_ROUTE_PLAN', path, message, available);
}

function nonEmptyStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) invalidRoutePlan(path, `${path} must be an array of non-empty strings`);
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      invalidRoutePlan(`${path}[${index}]`, `${path}[${index}] must be a non-empty string`);
    }
  }
  return value;
}

function positiveInteger(value: unknown, path: string): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalidRoutePlan(path, `${path} must be a positive integer`);
  }
  return true;
}

function nonNegativeInteger(value: unknown, path: string): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalidRoutePlan(path, `${path} must be a non-negative integer`);
  }
  return true;
}

function validateRoutePlan(input: unknown): RoutePlan {
  if (!isPlainObject(input)) invalidRoutePlan('routePlan', 'routePlan must be a plain object');
  if (!hasExactFields(input, ROUTE_PLAN_FIELDS)) {
    invalidRoutePlan(
      'routePlan',
      `routePlan has unknown field(s): ${truncateForMessage(unknownKeys(input, ROUTE_PLAN_FIELDS).join(', '))}`,
      ROUTE_PLAN_FIELDS,
    );
  }

  const complexity = ownValue(input, 'complexity');
  if (typeof complexity !== 'string' || !COMPLEXITIES.includes(complexity as GateComplexity)) {
    invalidRoutePlan('routePlan.complexity', 'routePlan.complexity must be simple, medium, or complex', COMPLEXITIES);
  }
  const mode = ownValue(input, 'mode');
  if (typeof mode !== 'string' || !ROUTE_MODES.includes(mode as RouteMode)) {
    invalidRoutePlan('routePlan.mode', 'routePlan.mode must be single or plan', ROUTE_MODES);
  }
  const forced = ownValue(input, 'forced');
  if (typeof forced !== 'boolean') invalidRoutePlan('routePlan.forced', 'routePlan.forced must be boolean', ['true', 'false']);
  const forcedMode = ownValue(input, 'forcedMode');
  if (forcedMode !== undefined && (typeof forcedMode !== 'string' || !FORCE_MODES.includes(forcedMode as Exclude<GateMode, 'auto'>))) {
    invalidRoutePlan('routePlan.forcedMode', 'routePlan.forcedMode must be force-single or force-plan', FORCE_MODES);
  }
  if (forced === true && forcedMode === undefined) {
    invalidRoutePlan('routePlan.forcedMode', 'forced route plans must record forcedMode', FORCE_MODES);
  }
  if (forced === false && forcedMode !== undefined) {
    invalidRoutePlan('routePlan.forcedMode', 'unforced route plans must not record forcedMode', []);
  }
  if (forcedMode === 'force-single' && mode !== 'single') {
    invalidRoutePlan('routePlan.mode', 'force-single route plans must use single mode', ['single']);
  }
  if (forcedMode === 'force-plan' && mode !== 'plan') {
    invalidRoutePlan('routePlan.mode', 'force-plan route plans must use plan mode', ['plan']);
  }
  if (forced === false && ((complexity === 'simple') !== (mode === 'single'))) {
    invalidRoutePlan('routePlan.mode', 'auto route mode must match estimated complexity', ROUTE_MODES);
  }

  const complexScore = ownValue(input, 'complexScore');
  positiveInteger(complexScore, 'routePlan.complexScore');
  if ((complexScore as number) < 2) {
    invalidRoutePlan('routePlan.complexScore', 'routePlan.complexScore must be at least 2');
  }
  const score = ownValue(input, 'score');
  nonNegativeInteger(score, 'routePlan.score');
  const rawSignals = ownValue(input, 'signals');
  if (!Array.isArray(rawSignals)) invalidRoutePlan('routePlan.signals', 'routePlan.signals must be an array');
  const signals: RouteSignal[] = [];
  for (const [index, rawSignal] of rawSignals.entries()) {
    const path = `routePlan.signals[${index}]`;
    if (!isPlainObject(rawSignal)) invalidRoutePlan(path, `${path} must be a plain object`);
    if (!hasExactFields(rawSignal, ROUTE_SIGNAL_FIELDS)) {
      invalidRoutePlan(path, `${path} has unknown field(s)`, ROUTE_SIGNAL_FIELDS);
    }
    const name = ownValue(rawSignal, 'name');
    if (typeof name !== 'string' || !ROUTE_SIGNAL_NAMES.includes(name as RouteSignal['name'])) {
      invalidRoutePlan(`${path}.name`, `${path}.name is not a known route signal`, ROUTE_SIGNAL_NAMES);
    }
    const value = ownValue(rawSignal, 'value');
    nonNegativeInteger(value, `${path}.value`);
    const level = ownValue(rawSignal, 'level');
    if (typeof level !== 'string' || !COMPLEXITIES.includes(level as GateComplexity)) {
      invalidRoutePlan(`${path}.level`, `${path}.level must be simple, medium, or complex`, COMPLEXITIES);
    }
    const hit = ownValue(rawSignal, 'hit');
    if (typeof hit !== 'boolean') invalidRoutePlan(`${path}.hit`, `${path}.hit must be boolean`, ['true', 'false']);
    if (hit !== (level !== 'simple')) {
      invalidRoutePlan(`${path}.hit`, `${path}.hit must match whether the signal level is non-simple`, ['true', 'false']);
    }
    const reason = ownValue(rawSignal, 'reason');
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      invalidRoutePlan(`${path}.reason`, `${path}.reason must be a non-empty string`);
    }
    signals.push(rawSignal as unknown as RouteSignal);
  }
  if (signals.length !== ROUTE_SIGNAL_NAMES.length) {
    invalidRoutePlan('routePlan.signals', `routePlan.signals must contain exactly ${ROUTE_SIGNAL_NAMES.length} signals`, ROUTE_SIGNAL_NAMES);
  }
  const signalNames = new Set(signals.map((entry) => entry.name));
  if (signalNames.size !== ROUTE_SIGNAL_NAMES.length || ROUTE_SIGNAL_NAMES.some((name) => !signalNames.has(name))) {
    invalidRoutePlan('routePlan.signals', 'routePlan.signals must contain each known signal exactly once', ROUTE_SIGNAL_NAMES);
  }
  const aggregate = aggregateComplexity(signals, complexScore as number);
  if (score !== aggregate.score) {
    invalidRoutePlan('routePlan.score', 'routePlan.score must equal the sum of signal levels', [String(aggregate.score)]);
  }
  if (complexity !== aggregate.complexity) {
    invalidRoutePlan('routePlan.complexity', 'routePlan.complexity must match the aggregated signal complexity', [aggregate.complexity]);
  }
  const expectedMode = deriveRouteMode(
    aggregate.complexity,
    forced as boolean,
    forcedMode as Exclude<GateMode, 'auto'> | undefined,
  );
  if (mode !== expectedMode) {
    invalidRoutePlan('routePlan.mode', 'routePlan.mode must match the aggregated complexity and force mode', [expectedMode]);
  }

  const reasons = nonEmptyStringArray(ownValue(input, 'reasons'), 'routePlan.reasons');
  const hitReasons = signals.filter((entry) => entry.hit).map((entry) => entry.reason);
  if (reasons.length !== hitReasons.length || reasons.some((reason, index) => reason !== hitReasons[index])) {
    invalidRoutePlan('routePlan.reasons', 'routePlan.reasons must contain exactly one reason for each hit signal', hitReasons);
  }
  const decisionReasons = nonEmptyStringArray(ownValue(input, 'decisionReasons'), 'routePlan.decisionReasons');
  if (decisionReasons.length === 0) invalidRoutePlan('routePlan.decisionReasons', 'routePlan.decisionReasons must not be empty');

  const maxConcurrency = ownValue(input, 'maxConcurrency');
  positiveInteger(maxConcurrency, 'routePlan.maxConcurrency');
  const expectedTaskCount = ownValue(input, 'expectedTaskCount');
  positiveInteger(expectedTaskCount, 'routePlan.expectedTaskCount');
  const reviewerStrategy = ownValue(input, 'reviewerStrategy');
  if (typeof reviewerStrategy !== 'string' || !REVIEWER_STRATEGIES.includes(reviewerStrategy as ReviewerStrategy)) {
    invalidRoutePlan('routePlan.reviewerStrategy', 'routePlan.reviewerStrategy must be auto, always, or never', REVIEWER_STRATEGIES);
  }

  const mechanicalVerification = ownValue(input, 'mechanicalVerification');
  if (!isPlainObject(mechanicalVerification)) {
    invalidRoutePlan('routePlan.mechanicalVerification', 'routePlan.mechanicalVerification must be a plain object');
  }
  if (!hasExactFields(mechanicalVerification, ['required', 'commands'])) {
    invalidRoutePlan('routePlan.mechanicalVerification', 'routePlan.mechanicalVerification has unknown field(s)', ['required', 'commands']);
  }
  if (ownValue(mechanicalVerification, 'required') !== true) {
    invalidRoutePlan('routePlan.mechanicalVerification.required', 'routePlan.mechanicalVerification.required must be true', ['true']);
  }
  const commands = nonEmptyStringArray(ownValue(mechanicalVerification, 'commands'), 'routePlan.mechanicalVerification.commands');

  const normalized: {
    complexity: GateComplexity;
    mode: RouteMode;
    forced: boolean;
    forcedMode?: Exclude<GateMode, 'auto'>;
    complexScore: number;
    score: number;
    signals: readonly RouteSignal[];
    reasons: readonly string[];
    decisionReasons: readonly string[];
    maxConcurrency: number;
    expectedTaskCount: number;
    reviewerStrategy: ReviewerStrategy;
    mechanicalVerification: MechanicalVerificationPlan;
  } = {
    complexity: complexity as GateComplexity,
    mode: mode as RouteMode,
    forced: forced as boolean,
    complexScore: complexScore as number,
    score: score as number,
    signals: signals.map((entry) => ({ ...entry })),
    reasons: [...reasons],
    decisionReasons: [...decisionReasons],
    maxConcurrency: maxConcurrency as number,
    expectedTaskCount: expectedTaskCount as number,
    reviewerStrategy: reviewerStrategy as ReviewerStrategy,
    mechanicalVerification: { required: true, commands: [...commands] },
  };
  if (forcedMode !== undefined) normalized.forcedMode = forcedMode as Exclude<GateMode, 'auto'>;
  return normalized;
}

function complexityFor(value: number, medium: number, complex: number): GateComplexity {
  if (value >= complex) return 'complex';
  if (value >= medium) return 'medium';
  return 'simple';
}

function contractChars(contract: TaskContract): number {
  const arrays = [
    contract.context ?? [],
    contract.files_in_scope ?? [],
    contract.acceptance_criteria,
    contract.verification,
    contract.depends_on,
  ];
  return contract.objective.length + arrays.flat().reduce((total, value) => total + value.length, 0);
}

function signal(
  name: RouteSignal['name'],
  value: number,
  level: GateComplexity,
  reason: string,
): RouteSignal {
  return { name, value, level, hit: level !== 'simple', reason };
}

function estimateSignals(contract: TaskContract, thresholds: NormalizedThresholds): readonly RouteSignal[] {
  const files = contract.files_in_scope?.length ?? 0;
  const criteria = contract.acceptance_criteria.length;
  const verification = contract.verification.length;
  const size = contractChars(contract);
  const dependencies = contract.depends_on.length;
  return [
    signal(
      'files_in_scope',
      files,
      complexityFor(files, thresholds.filesInScopeMedium, thresholds.filesInScopeComplex),
      files >= thresholds.filesInScopeComplex
        ? `files_in_scope has ${files} paths (complex threshold ${thresholds.filesInScopeComplex})`
        : files >= thresholds.filesInScopeMedium
          ? `files_in_scope has ${files} paths (medium threshold ${thresholds.filesInScopeMedium})`
          : `files_in_scope has ${files} path(s), below the medium threshold`,
    ),
    signal(
      'acceptance_criteria',
      criteria,
      complexityFor(criteria, thresholds.acceptanceCriteriaMedium, thresholds.acceptanceCriteriaComplex),
      criteria >= thresholds.acceptanceCriteriaComplex
        ? `acceptance_criteria has ${criteria} items (complex threshold ${thresholds.acceptanceCriteriaComplex})`
        : criteria >= thresholds.acceptanceCriteriaMedium
          ? `acceptance_criteria has ${criteria} items (medium threshold ${thresholds.acceptanceCriteriaMedium})`
          : `acceptance_criteria has ${criteria} item(s), below the medium threshold`,
    ),
    signal(
      'verification_commands',
      verification,
      verification === 0
        ? 'medium'
        : complexityFor(verification, thresholds.verificationCommandsComplex, thresholds.verificationCommandsComplex),
      verification === 0
        ? 'verification declares no command; mechanical verification is uncertain'
        : verification >= thresholds.verificationCommandsComplex
          ? `verification declares ${verification} commands (complex threshold ${thresholds.verificationCommandsComplex})`
          : `verification declares ${verification} command(s)`,
    ),
    signal(
      'contract_chars',
      size,
      complexityFor(size, thresholds.contractCharsMedium, thresholds.contractCharsComplex),
      size >= thresholds.contractCharsComplex
        ? `contract text volume is ${size} UTF-16 characters (complex threshold ${thresholds.contractCharsComplex})`
        : size >= thresholds.contractCharsMedium
          ? `contract text volume is ${size} UTF-16 characters (medium threshold ${thresholds.contractCharsMedium})`
          : `contract text volume is ${size} UTF-16 characters, below the medium threshold`,
    ),
    signal(
      'dependencies',
      dependencies,
      complexityFor(dependencies, thresholds.dependencyCountMedium, thresholds.dependencyCountComplex),
      dependencies >= thresholds.dependencyCountComplex
        ? `depends_on has ${dependencies} prerequisites (complex threshold ${thresholds.dependencyCountComplex})`
        : dependencies >= thresholds.dependencyCountMedium
          ? `depends_on has ${dependencies} prerequisite(s) (medium threshold ${thresholds.dependencyCountMedium})`
          : 'depends_on has no prerequisites',
    ),
  ];
}

export interface ComplexityAggregate {
  readonly complexity: GateComplexity;
  readonly score: number;
}

/** Shared, deterministic signal aggregation used by planning and revalidation. */
export function aggregateComplexity(
  signals: readonly RouteSignal[],
  complexScore: number = DEFAULTS.complexScore,
): ComplexityAggregate {
  const score = signals.reduce((total, entry) => total + (entry.level === 'complex' ? 2 : entry.level === 'medium' ? 1 : 0), 0);
  if (signals.some((entry) => entry.level === 'complex') || score >= complexScore) {
    return { complexity: 'complex', score };
  }
  if (score > 0) return { complexity: 'medium', score };
  return { complexity: 'simple', score };
}

/** Shared route-mode derivation used by planning and RoutePlan validation. */
export function deriveRouteMode(
  complexity: GateComplexity,
  forced: boolean,
  forcedMode?: Exclude<GateMode, 'auto'>,
): RouteMode {
  if (forced) {
    if (forcedMode === 'force-single') return 'single';
    if (forcedMode === 'force-plan') return 'plan';
  }
  return complexity === 'simple' ? 'single' : 'plan';
}

/**
 * Build a deterministic route proposal without executing anything.
 * `taskContract` is unknown at runtime and must be a valid S2 Task Contract;
 * invalid input throws GateConfigError with the original validation issues.
 */
export function planRoute(taskContract: unknown, gateOptions?: GateConfig): RoutePlan {
  const validated = validateTaskContract(taskContract);
  if (!validated.ok) invalidContract(validated.error);
  const contract = validated.contract;
  const config = normalizeConfig(gateOptions);
  const signals = estimateSignals(contract, config.thresholds);
  const estimate = aggregateComplexity(signals, config.thresholds.complexScore);
  const forced = config.mode !== 'auto';
  const forcedMode = config.mode === 'auto' ? undefined : config.mode;
  const mode = deriveRouteMode(estimate.complexity, forced, forcedMode);
  const routeShape: GateComplexity = config.mode === 'force-plan' ? 'complex' : mode === 'single' ? 'simple' : estimate.complexity;
  const reasons = signals.filter((entry) => entry.hit).map((entry) => entry.reason);
  const decisionReasons = [
    reasons.length === 0 ? 'no complexity signal crossed a configured threshold' : `hit ${reasons.length} complexity signal(s)`,
    `rule estimate is ${estimate.complexity} (score ${estimate.score})`,
    ...(config.mode === 'force-single' ? ['force-single selected: bypassed route selection and kept one worker'] : []),
    ...(config.mode === 'force-plan' ? ['force-plan selected: bypassed route selection and reserved a full plan shape'] : []),
    mode === 'single' ? 'single route uses one worker and mechanical verification' : 'plan route leaves DAG decomposition to a later coordinator',
  ];

  const expectedTaskCount = routeShape === 'complex'
    ? config.thresholds.complexExpectedTaskCount
    : routeShape === 'medium'
      ? config.thresholds.mediumExpectedTaskCount
      : 1;
  const maxConcurrency = routeShape === 'complex'
    ? config.thresholds.complexMaxConcurrency
    : routeShape === 'medium'
      ? config.thresholds.mediumMaxConcurrency
      : 1;

  const result: RoutePlan = {
    complexity: estimate.complexity,
    mode,
    forced,
    ...(forcedMode === undefined ? {} : { forcedMode }),
    complexScore: config.thresholds.complexScore,
    score: estimate.score,
    signals,
    reasons,
    maxConcurrency,
    expectedTaskCount,
    reviewerStrategy: config.reviewer,
    mechanicalVerification: { required: true, commands: [...contract.verification] },
    decisionReasons,
  };
  return deepFreeze(result);
}

function verificationError(path: string, message: string, available: readonly string[] = []): never {
  throw new GateConfigError('INVALID_VERIFICATION_SUMMARY', path, message, available);
}

function normalizeVerificationSummary(input: unknown): VerificationSummary | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) verificationError('verificationSummary', 'verificationSummary must be a plain object');
  if (!hasExactFields(input, ['status'])) {
    verificationError('verificationSummary', 'verificationSummary has unknown field(s)', ['status']);
  }
  const status = ownValue(input, 'status');
  if (status !== 'passed' && status !== 'failed' && status !== 'uncertain') {
    verificationError('verificationSummary.status', 'verificationSummary.status must be passed, failed, or uncertain', ['passed', 'failed', 'uncertain']);
  }
  return { status };
}

/**
 * Decide whether an independent, fresh reviewer is required.
 * The caller must pass an unmodified RoutePlan produced by planRoute; this
 * function validates its runtime shape but cannot prove object provenance.
 */
export function needsFreshReview(
  routePlan: unknown,
  verificationSummary?: unknown,
): FreshReviewDecision {
  const validatedPlan = validateRoutePlan(routePlan);
  const summary = normalizeVerificationSummary(verificationSummary);
  if (validatedPlan.reviewerStrategy === 'always') {
    return deepFreeze({ required: true, reason: 'reviewer strategy is forced on' });
  }
  if (validatedPlan.reviewerStrategy === 'never') {
    return deepFreeze({ required: false, reason: 'reviewer strategy is forced off; mechanical verification remains required' });
  }
  if (validatedPlan.mode === 'plan') {
    return deepFreeze({ required: true, reason: 'plan routes require a fresh reviewer' });
  }
  if (validatedPlan.complexity === 'complex') {
    return deepFreeze({ required: true, reason: 'complex estimates require a fresh reviewer' });
  }
  if (validatedPlan.mechanicalVerification.commands.length === 0 && validatedPlan.complexity !== 'simple') {
    return deepFreeze({ required: true, reason: 'mechanical verification is uncertain because no command was declared' });
  }
  if (summary?.status === 'failed') {
    return deepFreeze({ required: true, reason: 'mechanical verification failed' });
  }
  if (summary?.status === 'uncertain') {
    return deepFreeze({ required: true, reason: 'verification result is uncertain' });
  }
  if (summary === undefined && validatedPlan.complexity !== 'simple') {
    return deepFreeze({ required: true, reason: 'verification summary is missing for a non-simple route' });
  }
  return deepFreeze({ required: false, reason: 'simple single route passed the fresh-review gate' });
}
