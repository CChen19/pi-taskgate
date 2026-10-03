/**
 * Read-only delivery evidence and plan-coverage summary.
 *
 * A pure derivation over already-persisted board state: it takes the task
 * views and the existing `deliverable()` result and answers two questions the
 * hand-over cares about — what exactly the delivered revision is backed by
 * (verification and review evidence bound to that revision), and how much of
 * the planned work it actually contains. It never mutates anything, never
 * calls the host, and never changes which revision is delivered; repeated
 * queries over the same board return equal results.
 *
 * Coverage is deliberately conservative: a task counts as included only when
 * the deliverable integration records an input with that task id AND its
 * exact accepted revision. Dependencies, stacking, or a matching id alone
 * prove nothing; legacy or cross-session events with incomplete evidence
 * surface as notes instead of a silently complete plan.
 */
import type { AttemptRecord, IntegrationInput, TaskView } from './task-board.ts';
import type { TaskState } from '../core/task-state.ts';
import type { Deliverable } from './task-service.ts';

/** Listings in the structured result and rendered text stay bounded. */
const MAX_LISTED = 8;

export interface CommandResultSummary {
  readonly command: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface VerificationEvidence {
  /** The revision the evidence is bound to, when that is the delivered revision; undefined when nothing recorded is bound to it (missing evidence, evidence of another attempt/task/revision, or a candidate that is not the delivered one). */
  readonly revision?: string;
  /** True only when this attempt's recorded evidence bundle is bound to the exact delivered revision. */
  readonly bound: boolean;
  readonly verdict: 'passed' | 'rejected' | 'unknown';
  readonly commands: readonly CommandResultSummary[];
  readonly omittedCommands: number;
}

export interface ReviewEvidence {
  readonly required: boolean;
  /** 'not-required' is explicit review_required:false; it is never 'passed'. */
  readonly status: 'passed' | 'rejected' | 'awaiting' | 'not-required' | 'missing' | 'revision-mismatch';
  readonly reviewerAgentId?: string;
  readonly reviewId?: string;
  /** The revision the issued review was bound to. */
  readonly revision?: string;
}

export interface IntegrationInputSummary {
  readonly taskId: string;
  readonly revision: string;
  /** The earlier input's task id this input was stacked on, when its recorded base revision matches that input's revision. */
  readonly stackedOn?: string;
  /** Where the acceptance evidence came from; absent means this session. */
  readonly evidenceSource?: string;
}

export interface DeliveryEvidence {
  readonly taskId: string;
  readonly revision: string;
  readonly kind: 'task' | 'integration';
  readonly verification: VerificationEvidence;
  readonly review: ReviewEvidence;
  /** Recorded inputs of the deliverable integration; undefined for a single-task deliverable. */
  readonly inputs?: readonly IntegrationInputSummary[];
}

export interface OmittedTask {
  readonly taskId: string;
  readonly state: TaskState;
  /** Why it is not part of the deliverable: a cancellation reason, a failure reason, or a revision mismatch. */
  readonly detail?: string;
}

export interface CoverageSummary {
  /** True only when a deliverable exists and every current non-integration task is included in it. */
  readonly complete: boolean;
  /** Current non-integration tasks on the board, in every state. */
  readonly total: number;
  readonly included: readonly string[];
  readonly omitted: readonly OmittedTask[];
  readonly omittedCount: number;
}

export interface DeliverySummary {
  /** Undefined when there is no deliverable revision; coverage is still reported. */
  readonly deliverable?: DeliveryEvidence;
  readonly coverage: CoverageSummary;
  /** Conservative caveats: mismatched revisions, inputs without board tasks, cancelled tasks. Bounded. */
  readonly notes: readonly string[];
  /** Bounded human-readable block for task_status. */
  readonly text: string;
}

function short(revision: string): string {
  return revision.slice(0, 12);
}

function currentAttempt(task: TaskView): AttemptRecord | undefined {
  return task.attemptRecords[task.attemptRecords.length - 1];
}

/** The exact revision a PASSED task was accepted at; undefined for any other state. */
function acceptedRevision(task: TaskView): string | undefined {
  return task.state === 'PASSED' ? currentAttempt(task)?.candidate?.revision : undefined;
}

function verificationEvidence(taskId: string, attempt: AttemptRecord | undefined, deliveredRevision: string): VerificationEvidence {
  const candidate = attempt?.candidate;
  if (attempt === undefined || candidate === undefined) return { bound: false, verdict: 'unknown', commands: [], omittedCommands: 0 };
  const bundle = candidate.evidence;
  // Only this attempt's own bundle, bound to the exact candidate revision, counts as evidence for the
  // delivered revision; a missing or mismatched bundle stays unknown instead of showing passed.
  const evidenceBound = bundle !== undefined && bundle.taskId === taskId && bundle.attemptId === attempt.attemptId && bundle.artifactRevision === candidate.revision;
  if (!evidenceBound || candidate.revision !== deliveredRevision) {
    return {
      ...(candidate.revision === deliveredRevision ? {} : { revision: candidate.revision }),
      bound: false,
      verdict: 'unknown',
      commands: [],
      omittedCommands: 0,
    };
  }
  const verdict = candidate.verdict !== undefined && candidate.verdict.artifactRevision === candidate.revision ? candidate.verdict.verdict : 'unknown';
  const outcomes = bundle.outcomes;
  const commands = outcomes.slice(0, MAX_LISTED).map((outcome, index) => ({
    command: bundle.commands[index]?.command ?? `(command ${index + 1})`,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
  }));
  return {
    revision: candidate.revision,
    bound: true,
    verdict,
    commands,
    omittedCommands: Math.max(0, outcomes.length - commands.length),
  };
}

function reviewEvidence(task: TaskView, attempt: AttemptRecord | undefined, deliveredRevision: string): ReviewEvidence {
  if (!task.reviewRequired) return { required: false, status: 'not-required' };
  const review = attempt?.review;
  if (review === undefined) return { required: true, status: 'missing' };
  const base = {
    required: true,
    reviewId: review.reviewId,
    revision: review.revision,
    ...(review.reviewerAgentId === undefined ? {} : { reviewerAgentId: review.reviewerAgentId }),
  };
  if (review.verdict === undefined) return { ...base, status: 'awaiting' };
  if (review.revision !== deliveredRevision) return { ...base, status: 'revision-mismatch' };
  if (review.verdict.artifactRevision !== deliveredRevision) return { ...base, status: 'revision-mismatch', revision: review.verdict.artifactRevision };
  return { ...base, status: review.verdict.outcome };
}

function inputSummaries(inputs: readonly IntegrationInput[], baseRevision: string, notes: string[]): IntegrationInputSummary[] {
  return inputs.map((input) => {
    let stackedOn: string | undefined;
    if (input.baseRevision === undefined) {
      notes.push(`integration input ${input.taskId}@${short(input.revision)} has no recorded base revision, so its stacking is unknown (legacy evidence); it still counts only through its own task id and revision`);
    } else if (input.baseRevision !== baseRevision) {
      const on = inputs.find((other) => other.revision === input.baseRevision);
      if (on === undefined) notes.push(`integration input ${input.taskId}@${short(input.revision)} was built on ${short(input.baseRevision)}, which is neither the integration base nor a recorded input (legacy or cross-session evidence); treated conservatively`);
      else stackedOn = on.taskId;
    }
    return {
      taskId: input.taskId,
      revision: input.revision,
      ...(stackedOn === undefined ? {} : { stackedOn }),
      ...(input.source === 'this session' ? {} : { evidenceSource: input.source }),
    };
  });
}

function deliveryEvidence(task: TaskView | undefined, deliverable: Deliverable & { readonly revision: string }, notes: string[]): DeliveryEvidence | undefined {
  if (task === undefined) return undefined;
  const attempt = currentAttempt(task);
  const evidence: DeliveryEvidence = {
    taskId: task.id,
    revision: deliverable.revision,
    kind: task.integration === undefined ? 'task' : 'integration',
    verification: verificationEvidence(task.id, attempt, deliverable.revision),
    review: reviewEvidence(task, attempt, deliverable.revision),
  };
  if (task.integration !== undefined) {
    return { ...evidence, inputs: inputSummaries(task.integration.inputs, task.integration.baseRevision, notes) };
  }
  return evidence;
}

function renderVerification(evidence: VerificationEvidence): string {
  if (evidence.revision === undefined) return 'verification: not available (no evidence bound to the delivered revision)';
  if (!evidence.bound) return `verification: evidence refers to ${short(evidence.revision)}, not the delivered revision`;
  const commands = evidence.commands.map((command) => `\`${command.command.slice(0, 120)}\` exit ${command.exitCode}${command.timedOut ? ' (timed out)' : ` in ${command.durationMs}ms`}`);
  const listed = commands.length > 0 ? `${commands.join(', ')}${evidence.omittedCommands > 0 ? `, +${evidence.omittedCommands} more` : ''}` : 'no recorded command results';
  return `verification: ${evidence.verdict} @${short(evidence.revision)} — ${listed}`;
}

function renderReview(evidence: ReviewEvidence): string {
  switch (evidence.status) {
    case 'not-required':
      return 'review: not required';
    case 'passed':
    case 'rejected':
      return `review: ${evidence.status} (reviewer ${evidence.reviewerAgentId ?? '?'}, review ${evidence.reviewId ?? '?'}, bound to ${evidence.revision === undefined ? '?' : short(evidence.revision)})`;
    case 'awaiting':
      return `review: awaiting reviewer (review ${evidence.reviewId ?? '?'})`;
    case 'missing':
      return 'review: not available (no review recorded)';
    case 'revision-mismatch':
      return `review: evidence refers to ${evidence.revision === undefined ? '?' : short(evidence.revision)}, not the delivered revision`;
  }
}

function renderEvidence(evidence: DeliveryEvidence): string[] {
  const inputs = evidence.inputs ?? [];
  const listed = inputs.slice(0, MAX_LISTED);
  const more = inputs.length - listed.length;
  const lines = [`  deliverable ${evidence.taskId} @${short(evidence.revision)}${evidence.inputs === undefined ? '' : ` (integration of ${listed.map((input) => `${input.taskId}@${short(input.revision)}${input.stackedOn === undefined ? '' : ` stacked on ${input.stackedOn}`}`).join(', ')}${more > 0 ? `, +${more} more` : ''})`}`];
  lines.push(`  ${renderVerification(evidence.verification)}`);
  lines.push(`  ${renderReview(evidence.review)}`);
  return lines;
}

function renderCoverage(coverage: CoverageSummary, notes: readonly string[]): string[] {
  const lines: string[] = [];
  if (coverage.total === 0) {
    lines.push(`  coverage: ${coverage.complete ? 'complete — no separate planned tasks; the deliverable is the whole plan' : 'no planned tasks on the board'}`);
  } else {
    // coverage.omitted arrives bounded; the +N more comes from the full omittedCount, never the slice.
    const shown = coverage.omitted.map((task) => `${task.taskId} ${task.state}${task.detail === undefined ? '' : ` (${task.detail.slice(0, 160)})`}`);
    const more = coverage.omittedCount - shown.length;
    lines.push(`  coverage: ${coverage.complete ? 'complete' : 'partial'} — ${coverage.included.length}/${coverage.total} planned task(s) included${coverage.complete ? '' : `; omitted: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`}`);
  }
  for (const note of notes.slice(0, MAX_LISTED)) lines.push(`  note: ${note.slice(0, 240)}`);
  if (notes.length > MAX_LISTED) lines.push(`  note: +${notes.length - MAX_LISTED} more`);
  return lines;
}

/**
 * Derive the summary. Pure: reads only the given views and the existing
 * deliverable selection; writes nothing and performs no host access.
 */
export function deliverySummary(tasks: readonly TaskView[], deliverable: Deliverable): DeliverySummary {
  const notes: string[] = [];
  const nonIntegration = tasks.filter((task) => task.integration === undefined);
  const deliverableTask = deliverable.revision === undefined ? undefined : tasks.find((task) => task.id === deliverable.taskId);
  const integrationInputs = deliverableTask?.integration?.inputs;

  // Inclusion needs the deliverable integration to record this task id AND its exact accepted revision.
  const included: string[] = [];
  if (deliverableTask !== undefined && deliverable.revision !== undefined) {
    if (integrationInputs === undefined) {
      if (acceptedRevision(deliverableTask) === deliverable.revision) included.push(deliverableTask.id);
    } else {
      for (const task of nonIntegration) {
        const accepted = acceptedRevision(task);
        if (accepted !== undefined && integrationInputs.some((input) => input.taskId === task.id && input.revision === accepted)) included.push(task.id);
      }
    }
  }
  const includedSet = new Set(included);

  const omitted: OmittedTask[] = [];
  for (const task of nonIntegration) {
    if (includedSet.has(task.id)) continue;
    let detail: string | undefined;
    if (task.state === 'CANCELLED') {
      detail = task.cancelReason;
      notes.push(`${task.id} was cancelled${task.cancelReason === undefined ? '' : `: ${task.cancelReason.slice(0, 200)}`}; the deliverable does not cover it, so the full plan is not complete`);
    } else if (task.state === 'FAILED') {
      detail = currentAttempt(task)?.failure?.reason;
    } else {
      const accepted = acceptedRevision(task);
      const input = accepted === undefined || integrationInputs === undefined ? undefined : integrationInputs.find((entry) => entry.taskId === task.id);
      if (accepted !== undefined && input !== undefined) detail = `accepted revision ${short(accepted)} is not the integrated input ${short(input.revision)}`;
      else if (accepted !== undefined && integrationInputs !== undefined) detail = 'PASSED but not included in the deliverable integration';
      else if (accepted !== undefined) detail = 'PASSED but not part of the deliverable';
    }
    omitted.push({ taskId: task.id, state: task.state, ...(detail === undefined ? {} : { detail }) });
  }

  // Conservative handling of inputs the current board cannot account for.
  if (integrationInputs !== undefined) {
    const known = new Set(nonIntegration.map((task) => task.id));
    for (const input of integrationInputs) {
      if (!known.has(input.taskId)) notes.push(`integration input ${input.taskId}@${short(input.revision)} has no such task on the current board (legacy or cross-session evidence); it is not counted toward coverage`);
    }
  }

  const evidence = deliverable.revision === undefined ? undefined : deliveryEvidence(deliverableTask, deliverable as Deliverable & { readonly revision: string }, notes);
  const lines = ['DELIVERY SUMMARY'];
  if (evidence === undefined) lines.push(`  deliverable: none (${deliverable.reason ?? 'not ready'})`);
  else lines.push(...renderEvidence(evidence));
  const coverage = { complete: evidence !== undefined && omitted.length === 0, total: nonIntegration.length, included, omitted: omitted.slice(0, MAX_LISTED), omittedCount: omitted.length };
  lines.push(...renderCoverage(coverage, notes));

  return {
    ...(evidence === undefined ? {} : { deliverable: evidence }),
    coverage,
    notes: notes.slice(0, MAX_LISTED + 1),
    text: lines.join('\n'),
  };
}
