/**
 * Prompt text handed to Pier subagents, and parsing of the reviewer's reply.
 *
 * Briefs are advisory text for the child agent. Nothing a child writes back is
 * trusted except the reviewer verdict line, which is validated, bound to a
 * one-time review id, and bound to the exact candidate revision.
 */
import type { TaskContract } from '../core/task-contract.ts';
import { validateReviewVerdict, type ReviewBrief, type ReviewVerdict } from '../core/reviewer-brief.ts';

export interface WorkerBriefInput {
  readonly contract: TaskContract;
  readonly attemptId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly baseRevision: string;
  /** Accepted dependency this attempt is stacked on. */
  readonly stackedOn?: string;
  readonly feedback?: readonly string[];
  readonly rejectTestAsserts?: boolean;
  /** Union-merged shared files in this task's scope: parallel tasks change them too, so only additions are allowed. */
  readonly unionShared?: readonly string[];
}

export function renderWorkerBrief(input: WorkerBriefInput): string {
  const { contract } = input;
  const lines = [
    `You are implementing task ${contract.id} (attempt ${input.attemptId}).`,
    '',
    `Working directory: ${input.workspacePath}`,
    `Branch: ${input.branch} (created from ${input.baseRevision})`,
    ...(input.stackedOn === undefined ? [] : [`This branch starts from ${input.stackedOn}'s accepted revision: its changes are already here. Build on them; do not redo or revert them.`]),
    '',
    'Objective:',
    contract.objective,
    '',
    'Acceptance criteria:',
    ...contract.acceptance_criteria.map((entry, index) => `${index + 1}. ${entry}`),
    '',
    'Files in scope (a trailing slash means a directory). Changing any other path fails the task:',
    ...(contract.files_in_scope ?? []).map((entry) => `- ${entry}`),
  ];
  if (contract.context !== undefined && contract.context.length > 0) {
    lines.push('', 'Context to read first:', ...contract.context.map((entry) => `- ${entry}`));
  }
  if (input.feedback !== undefined && input.feedback.length > 0) {
    lines.push('', 'Feedback from the previous attempt (fix these):', ...input.feedback.map((entry) => `- ${entry}`));
  }
  lines.push(
    '',
    'After you finish, the host runs these verification commands itself in a fresh clean checkout of your committed revision (uncommitted, untracked, and ignored files such as build output are not used):',
    ...contract.verification.map((entry) => `- ${entry}`),
    '',
    'Rules:',
    '- Work only inside the working directory above. Do not touch the main checkout.',
    '- Commit your finished work to the current branch. Leave no uncommitted or untracked files.',
    '- Never push, never merge, never rebase onto other branches.',
    ...(input.rejectTestAsserts === true ? ['- Do not use assert() in test code: verification builds in Release (-DNDEBUG), which strips it; follow the repo\'s existing non-assert check pattern. New assert( lines in tests are rejected.'] : []),
    ...(input.unionShared !== undefined && input.unionShared.length > 0 ? [`- ${input.unionShared.join(', ')} ${input.unionShared.length === 1 ? 'is' : 'are'} shared with tasks running in parallel. Integration keeps every task's added lines, so only add lines there, in one contiguous block; do not edit, reorder, or delete existing lines (removed or edited lines are rejected).`] : []),
    '- Your own claims (done, revision, tests passed) are not evidence; the host inspects git and runs verification.',
    '- Finish with a short summary of what you changed and anything the coordinator should know.',
  );
  return lines.join('\n');
}

export const REVIEW_VERDICT_TAG = 'REVIEW_VERDICT';

export function renderReviewerPrompt(brief: ReviewBrief, reviewId: string, taskId: string, context: readonly string[] = []): string {
  const evidence = brief.evidence.commands.map((command, index) => {
    const outcome = brief.evidence.outcomes[index];
    return `- \`${command.command}\` → exit ${outcome?.exitCode ?? '?'}${outcome?.timedOut === true ? ' (timed out)' : ''}`;
  });
  return [
    `You are a fresh, independent reviewer for task ${taskId}. You did not write this change.`,
    'Review the artifact below against the objective and acceptance criteria. Do not modify any file.',
    'You may read files in the working directory to understand context.',
    '',
    `Artifact revision: ${brief.diff.artifactRevision}`,
    '',
    'Objective:',
    brief.spec.objective,
    '',
    'Acceptance criteria:',
    ...brief.spec.acceptance_criteria.map((entry, index) => `${index + 1}. ${entry}`),
    '',
    'Files in scope:',
    ...brief.spec.files_in_scope.map((entry) => `- ${entry}`),
    '',
    ...(context.length === 0 ? [] : [...context, '']),
    'Host-run mechanical verification in a clean checkout (already passed):',
    ...evidence,
    '',
    'Patch (base...artifact):',
    '```diff',
    brief.diff.patch ?? '(patch unavailable)',
    '```',
    '',
    'End your final message with exactly one line in this form and nothing after it:',
    `${REVIEW_VERDICT_TAG} ${reviewId} {"outcome":"passed"|"rejected","reasons":["..."],"artifactRevision":"${brief.diff.artifactRevision}"}`,
    'Use "rejected" if any acceptance criterion is unmet or the change is unsafe. "reasons" must list at least one concrete reason, for "passed" as well as "rejected"; an empty list makes the verdict unusable.',
  ].join('\n');
}

export type ParsedReview =
  | { readonly ok: true; readonly verdict: ReviewVerdict }
  | { readonly ok: false; readonly reason: string };

/** Parse the last verdict line of a reviewer's closing text. */
export function parseReviewerOutcome(text: string, reviewId: string): ParsedReview {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(`${REVIEW_VERDICT_TAG} `));
  const line = lines[lines.length - 1];
  if (line === undefined) return { ok: false, reason: `reviewer output has no ${REVIEW_VERDICT_TAG} line` };
  const match = /^REVIEW_VERDICT\s+(\S+)\s+(\{.*\})$/.exec(line);
  if (match === null) return { ok: false, reason: `${REVIEW_VERDICT_TAG} line is malformed` };
  if (match[1] !== reviewId) return { ok: false, reason: 'review id does not match the issued brief' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[2]!);
  } catch {
    return { ok: false, reason: 'verdict JSON is invalid' };
  }
  try {
    return { ok: true, verdict: validateReviewVerdict(parsed) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'verdict is invalid' };
  }
}

/**
 * The only text the main agent passes to a reviewer. It is short enough to be
 * copied verbatim; the brief itself is a host-written file the reviewer reads,
 * so the main agent cannot trim, summarize, or add to it.
 */
export function renderReviewerSpawnPrompt(taskId: string, reviewId: string, briefPath: string): string {
  return [
    `You are a fresh, independent reviewer for task ${taskId} (review ${reviewId}). You did not write this change and must not modify any file.`,
    `Your complete review brief is the file ${briefPath}.`,
    'Before anything else, read the whole file with the read tool; if the output says more lines remain, keep reading from the offset it gives until the end.',
    'Then follow the brief exactly, including its final REVIEW_VERDICT line.',
  ].join('\n');
}

/** Whitespace-insensitive comparison of an issued prompt with what a subagent received. */
export function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

export interface BriefRead {
  readonly path: string;
  readonly offset?: number;
  readonly text: string;
  readonly isError: boolean;
}

/** Pi's read tool appends a continuation notice after the content when it stops early. */
const READ_NOTICE = /\n\n\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file)[^\n]*\]$/;

/**
 * How many lines of `brief` (stored at `briefPath`) the reviewer's successful
 * reads returned verbatim. Pi's read returns the file split on "\n" from line
 * `offset` (1-based), so each result is matched line by line from its offset;
 * matching stops at the first differing line, so appended text cannot count.
 */
export function briefReadCoverage(brief: string, briefPath: string, reads: readonly BriefRead[], resolvePath: (path: string) => string): { readonly covered: number; readonly total: number } {
  const lines = brief.split('\n');
  const total = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const covered = new Set<number>();
  for (const read of reads) {
    if (read.isError || resolvePath(read.path) !== briefPath) continue;
    const start = (read.offset ?? 1) - 1;
    const returned = read.text.replace(READ_NOTICE, '').split('\n');
    for (let i = 0; i < returned.length && start + i < total; i++) {
      if (returned[i] !== lines[start + i]) break;
      covered.add(start + i);
    }
  }
  return { covered: covered.size, total };
}
