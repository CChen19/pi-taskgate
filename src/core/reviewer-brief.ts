/**
 * S5 fresh-context reviewer contract.
 *
 * A brief is deliberately narrower than a worker session: spec, an
 * artifact-revision-bound diff reference, and bounded mechanical evidence are
 * the complete input. No transcript, prompt history, or complete log can be
 * smuggled into the reviewer context.
 */

import type { FreshReviewDecision } from './gate.ts';
import {
  MAX_ARTIFACT_REVISION_LENGTH,
  validateEvidenceBundle,
  validateVerificationVerdict,
  type EvidenceBundle,
  type VerificationCommand,
  type VerificationOutcome,
  type VerificationVerdict,
} from './verification.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export interface ReviewerSpec {
  readonly objective: string;
  readonly acceptance_criteria: readonly string[];
  readonly files_in_scope: readonly string[];
}

export const MAX_REVIEW_DIFF_LENGTH = 32 * 1024;
const REVIEW_DIFF_MARKER = '\n...[diff truncated at 32 KiB]';

export interface ReviewerDiff {
  readonly artifactRevision: string;
  /** Bounded actual patch text; absent only for legacy pure-core callers. */
  readonly patch?: string;
}

export function boundReviewerDiff(value: string, truncated = false): string {
  if (!truncated && value.length <= MAX_REVIEW_DIFF_LENGTH) return value;
  const limit = MAX_REVIEW_DIFF_LENGTH - REVIEW_DIFF_MARKER.length;
  return `${value.slice(0, Math.max(0, limit))}${REVIEW_DIFF_MARKER}`;
}

export interface ReviewerEvidence {
  readonly taskId: string;
  readonly attemptId: string;
  readonly artifactRevision: string;
  readonly commands: EvidenceBundle['commands'];
  readonly outcomes: readonly VerificationOutcome[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface ReviewBrief {
  readonly spec: ReviewerSpec;
  readonly diff: ReviewerDiff;
  readonly evidence: ReviewerEvidence;
}

export interface ReviewerBriefInput {
  readonly spec: ReviewerSpec;
  /** Canonical form keeps the revision at the input root. */
  readonly artifactRevision?: string;
  /** Accepts patch text or the output-shaped `{ artifactRevision, patch }` reference. */
  readonly diff?: string | ReviewerDiff;
  readonly evidence: EvidenceBundle;
}

export interface ReviewVerdict {
  readonly outcome: 'passed' | 'rejected';
  readonly reasons: readonly string[];
  readonly artifactRevision: string;
}

export type ReviewerBriefErrorCode =
  | 'INVALID_REVIEW_BRIEF'
  | 'INVALID_REVIEW_VERDICT'
  | 'INVALID_FINAL_DECISION'
  | 'ARTIFACT_REVISION_MISMATCH';

/** Structured, fail-closed reviewer input/decision error. */
export class ReviewerBriefError extends Error {
  readonly code: ReviewerBriefErrorCode;
  readonly path: string;
  readonly available: readonly string[];

  constructor(
    code: ReviewerBriefErrorCode,
    path: string,
    message: string,
    available: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ReviewerBriefError';
    this.code = code;
    this.path = path;
    this.available = Object.freeze([...available]);
  }
}

const INPUT_FIELDS = ['spec', 'artifactRevision', 'diff', 'evidence'] as const;
const SPEC_FIELDS = ['objective', 'acceptance_criteria', 'files_in_scope'] as const;
const DIFF_FIELDS = ['artifactRevision', 'patch'] as const;
const REVIEW_VERDICT_FIELDS = ['outcome', 'reasons', 'artifactRevision'] as const;
const REVIEW_REQUIRED_FIELDS = ['required', 'reason'] as const;
const ARRAY_METHOD_FIELDS = ['map', 'forEach', 'every', 'filter'] as const;

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && allowed.includes(key)) continue;
    result.push(typeof key === 'symbol' ? key.toString() : key);
  }
  return result;
}

function fail(
  code: ReviewerBriefErrorCode,
  path: string,
  message: string,
  available: readonly string[] = [],
): never {
  throw new ReviewerBriefError(code, path, message, available);
}

function requirePlainObject(value: unknown, path: string, code: ReviewerBriefErrorCode = 'INVALID_REVIEW_BRIEF'): Record<string, unknown> {
  if (!isPlainObject(value)) fail(code, path, `${path} must be a plain object`);
  return value;
}

function requireString(value: unknown, path: string, code: ReviewerBriefErrorCode): string {
  if (asNonEmptyString(value) === undefined) fail(code, path, `${path} must be a non-empty string`);
  return value as string;
}

function rejectArrayMethodOverrides(value: readonly unknown[], path: string): void {
  for (const method of ARRAY_METHOD_FIELDS) {
    if (Object.hasOwn(value, method)) fail('INVALID_REVIEW_BRIEF', path, `${path} must not override array method ${method}`);
  }
}

function stringArray(value: unknown, path: string, minimum: number): readonly string[] {
  if (!Array.isArray(value)) fail('INVALID_REVIEW_BRIEF', path, `${path} must be an array of non-empty strings`);
  rejectArrayMethodOverrides(value, path);
  if (value.length < minimum) fail('INVALID_REVIEW_BRIEF', path, `${path} must contain at least ${minimum} item(s)`);
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail('INVALID_REVIEW_BRIEF', `${path}[${index}]`, `${path}[${index}] must be present; sparse arrays are not accepted`);
    normalized.push(requireString(value[index], `${path}[${index}]`, 'INVALID_REVIEW_BRIEF'));
  }
  return normalized;
}

function revision(value: unknown, path: string, code: ReviewerBriefErrorCode = 'INVALID_REVIEW_BRIEF'): string {
  const result = requireString(value, path, code);
  if (result.length > MAX_ARTIFACT_REVISION_LENGTH) fail(code, path, `${path} must be at most ${MAX_ARTIFACT_REVISION_LENGTH} characters`);
  return result;
}

function validateBriefInput(input: unknown): {
  readonly spec: ReviewerSpec;
  readonly artifactRevision: string;
  readonly diff?: string;
  readonly evidence: EvidenceBundle;
} {
  const root = requirePlainObject(input, 'input');
  if (!hasExactFields(root, INPUT_FIELDS)) {
    fail('INVALID_REVIEW_BRIEF', 'input', `input has unknown field(s): ${truncateForMessage(unknownFields(root, INPUT_FIELDS).join(', '))}`, INPUT_FIELDS);
  }
  const rawSpec = requirePlainObject(ownValue(root, 'spec'), 'input.spec');
  if (!hasExactFields(rawSpec, SPEC_FIELDS)) {
    fail('INVALID_REVIEW_BRIEF', 'input.spec', `input.spec has unknown field(s): ${truncateForMessage(unknownFields(rawSpec, SPEC_FIELDS).join(', '))}`, SPEC_FIELDS);
  }
  const spec: ReviewerSpec = {
    objective: requireString(ownValue(rawSpec, 'objective'), 'input.spec.objective', 'INVALID_REVIEW_BRIEF'),
    acceptance_criteria: stringArray(ownValue(rawSpec, 'acceptance_criteria'), 'input.spec.acceptance_criteria', 1),
    files_in_scope: stringArray(ownValue(rawSpec, 'files_in_scope'), 'input.spec.files_in_scope', 0),
  };
  const rawRootRevision = ownValue(root, 'artifactRevision');
  if (rawRootRevision !== undefined && asNonEmptyString(rawRootRevision) === undefined) fail('INVALID_REVIEW_BRIEF', 'input.artifactRevision', 'input.artifactRevision must be a non-empty string');
  const diffValue = ownValue(root, 'diff');
  let patch: string | undefined;
  let diffRevision: string | undefined;
  if (typeof diffValue === 'string') {
    patch = diffValue;
  } else if (diffValue !== undefined) {
    const diff = requirePlainObject(diffValue, 'input.diff');
    if (!hasExactFields(diff, DIFF_FIELDS)) {
      fail('INVALID_REVIEW_BRIEF', 'input.diff', `input.diff has unknown field(s): ${truncateForMessage(unknownFields(diff, DIFF_FIELDS).join(', '))}`, DIFF_FIELDS);
    }
    diffRevision = revision(ownValue(diff, 'artifactRevision'), 'input.diff.artifactRevision');
    const rawPatch = ownValue(diff, 'patch');
    if (rawPatch !== undefined && typeof rawPatch !== 'string') fail('INVALID_REVIEW_BRIEF', 'input.diff.patch', 'input.diff.patch must be a string when provided');
    patch = rawPatch as string | undefined;
  }
  const artifactRevision = revision(rawRootRevision ?? diffRevision, 'input.artifactRevision');
  if (diffRevision !== undefined && diffRevision !== artifactRevision) {
    fail('ARTIFACT_REVISION_MISMATCH', 'input.diff.artifactRevision', 'input.diff.artifactRevision must match input.artifactRevision', [artifactRevision]);
  }
  let evidence: EvidenceBundle;
  try {
    evidence = validateEvidenceBundle(ownValue(root, 'evidence'));
  } catch (error) {
    if (error instanceof ReviewerBriefError) throw error;
    const detail = error instanceof Error ? error.message : 'evidence is invalid';
    fail('INVALID_REVIEW_BRIEF', 'input.evidence', `input.evidence is invalid: ${truncateForMessage(detail)}`);
  }
  if (evidence.artifactRevision !== artifactRevision) {
    fail('ARTIFACT_REVISION_MISMATCH', 'input.artifactRevision', 'input.artifactRevision must match input.evidence.artifactRevision', [evidence.artifactRevision]);
  }
  return {
    spec,
    artifactRevision,
    ...(patch === undefined ? {} : { diff: patch }),
    evidence,
  };
}

/** Assemble an immutable brief with strict context isolation. */
export function assembleReviewerBrief(input: unknown): ReviewBrief {
  const normalized = validateBriefInput(input);
  const diff: ReviewerDiff = {
    artifactRevision: normalized.artifactRevision,
    ...(normalized.diff === undefined ? {} : { patch: boundReviewerDiff(normalized.diff) }),
  };
  const copiedCommands: VerificationCommand[] = [];
  for (let index = 0; index < normalized.evidence.commands.length; index++) {
    copiedCommands.push({ ...normalized.evidence.commands[index]! });
  }
  const copiedOutcomes: VerificationOutcome[] = [];
  for (let index = 0; index < normalized.evidence.outcomes.length; index++) {
    copiedOutcomes.push({ ...normalized.evidence.outcomes[index]! });
  }
  const evidence: ReviewerEvidence = {
    taskId: normalized.evidence.taskId,
    attemptId: normalized.evidence.attemptId,
    artifactRevision: normalized.evidence.artifactRevision,
    commands: copiedCommands,
    outcomes: copiedOutcomes,
    startedAt: normalized.evidence.startedAt,
    endedAt: normalized.evidence.endedAt,
  };
  return deepFreeze({
    spec: {
      objective: normalized.spec.objective,
      acceptance_criteria: [...normalized.spec.acceptance_criteria],
      files_in_scope: [...normalized.spec.files_in_scope],
    },
    diff,
    evidence,
  });
}

/** Validate a fresh reviewer response without calling a model. */
export function validateReviewVerdict(input: unknown): ReviewVerdict {
  const root = requirePlainObject(input, 'reviewVerdict', 'INVALID_REVIEW_VERDICT');
  if (!hasExactFields(root, REVIEW_VERDICT_FIELDS)) {
    fail('INVALID_REVIEW_VERDICT', 'reviewVerdict', `reviewVerdict has unknown field(s): ${truncateForMessage(unknownFields(root, REVIEW_VERDICT_FIELDS).join(', '))}`, REVIEW_VERDICT_FIELDS);
  }
  const outcome = ownValue(root, 'outcome');
  if (outcome !== 'passed' && outcome !== 'rejected') fail('INVALID_REVIEW_VERDICT', 'reviewVerdict.outcome', 'reviewVerdict.outcome must be passed or rejected', ['passed', 'rejected']);
  const rawReasons = ownValue(root, 'reasons');
  if (!Array.isArray(rawReasons) || rawReasons.length === 0) fail('INVALID_REVIEW_VERDICT', 'reviewVerdict.reasons', 'reviewVerdict.reasons must be a non-empty array', ['reason']);
  rejectArrayMethodOverrides(rawReasons, 'reviewVerdict.reasons');
  const reasons: string[] = [];
  for (let index = 0; index < rawReasons.length; index++) {
    if (!Object.hasOwn(rawReasons, index)) fail('INVALID_REVIEW_VERDICT', `reviewVerdict.reasons[${index}]`, `reviewVerdict.reasons[${index}] must be present; sparse arrays are not accepted`);
    reasons.push(requireString(rawReasons[index], `reviewVerdict.reasons[${index}]`, 'INVALID_REVIEW_VERDICT'));
  }
  return deepFreeze({
    outcome,
    reasons,
    artifactRevision: revision(ownValue(root, 'artifactRevision'), 'reviewVerdict.artifactRevision', 'INVALID_REVIEW_VERDICT'),
  });
}

function normalizeReviewRequired(input: boolean | FreshReviewDecision): boolean {
  if (typeof input === 'boolean') return input;
  const root = requirePlainObject(input, 'reviewRequired', 'INVALID_FINAL_DECISION');
  if (!hasExactFields(root, REVIEW_REQUIRED_FIELDS)) {
    fail('INVALID_FINAL_DECISION', 'reviewRequired', `reviewRequired has unknown field(s): ${truncateForMessage(unknownFields(root, REVIEW_REQUIRED_FIELDS).join(', '))}`, REVIEW_REQUIRED_FIELDS);
  }
  if (typeof ownValue(root, 'required') !== 'boolean') fail('INVALID_FINAL_DECISION', 'reviewRequired.required', 'reviewRequired.required must be boolean', ['true', 'false']);
  if (typeof ownValue(root, 'reason') !== 'string' || asNonEmptyString(ownValue(root, 'reason')) === undefined) fail('INVALID_FINAL_DECISION', 'reviewRequired.reason', 'reviewRequired.reason must be a non-empty string');
  return ownValue(root, 'required') as boolean;
}

/**
 * Combine mechanical verification with the S4 fresh-review gate.
 * A rejected mechanical verdict always rejects. A passed verdict waits for a
 * required review, and a rejected review always rejects.
 */
export function decideFinalVerdict(
  verification: unknown,
  review?: unknown,
  reviewRequired: boolean | FreshReviewDecision = false,
): 'passed' | 'rejected' | 'needs_review' {
  let mechanical: VerificationVerdict;
  try {
    mechanical = validateVerificationVerdict(verification);
  } catch (error) {
    if (error instanceof ReviewerBriefError) throw error;
    const detail = error instanceof Error ? error.message : 'verification verdict is invalid';
    fail('INVALID_FINAL_DECISION', 'verification', truncateForMessage(detail));
  }
  const requiresReview = normalizeReviewRequired(reviewRequired);
  const normalizedReview = review === undefined ? undefined : validateReviewVerdict(review);
  if (mechanical.verdict === 'rejected') return 'rejected';
  if (normalizedReview !== undefined) {
    if (normalizedReview.artifactRevision !== mechanical.artifactRevision) {
      fail('ARTIFACT_REVISION_MISMATCH', 'review.artifactRevision', 'review.artifactRevision must match verification.artifactRevision', [mechanical.artifactRevision]);
    }
    return normalizedReview.outcome === 'rejected' ? 'rejected' : 'passed';
  }
  return requiresReview ? 'needs_review' : 'passed';
}

/**
 * Runtime-checked S2 bridge: only the state-machine verdict vocabulary crosses
 * this boundary; review reasons and prose never become lifecycle state.
 */
export function s2VerdictInput(finalVerdict: unknown): 'passed' | 'rejected' {
  if (finalVerdict !== 'passed' && finalVerdict !== 'rejected') {
    fail('INVALID_FINAL_DECISION', 'finalVerdict', 'finalVerdict must be passed or rejected', ['passed', 'rejected']);
  }
  return finalVerdict;
}
