import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VerificationError,
  decideVerdict,
  validateEvidenceBundle,
  type EvidenceBundle,
  type VerificationRunnerResult,
} from '../src/core/verification.ts';
import {
  ReviewerBriefError,
  assembleReviewerBrief,
  decideFinalVerdict,
  validateReviewVerdict,
} from '../src/core/reviewer-brief.ts';

/** An evidence bundle for two commands, shaped like the one task_verify records. */
function runEvidence(results: readonly VerificationRunnerResult[], artifactRevision = 'diff-sha-1'): { bundle: EvidenceBundle } {
  const bundle = validateEvidenceBundle({
    taskId: 'Tverify',
    attemptId: 'Tverify:attempt-1',
    artifactRevision,
    commands: [{ command: 'npm run check', cwd: '/workspace', timeoutMs: 30_000 }, { command: 'npm test' }].slice(0, Math.max(results.length, 1)),
    outcomes: results.map((result) => ({ exitCode: result.exitCode, durationMs: 1, timedOut: result.timedOut, ...(result.output === undefined ? {} : { output: result.output }), ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }) })),
    startedAt: 100,
    endedAt: 105,
  });
  return { bundle };
}

describe('mechanical verdict', () => {
  it('decides pass, partial failure, timeout, and expectation failure without side effects', () => {
    const allPass = runEvidence([
      { exitCode: 0, timedOut: false, output: 'ok' },
      { exitCode: 0, timedOut: false, output: 'ok' },
    ]).bundle;
    assert.deepEqual(decideVerdict(allPass), {
      verdict: 'passed',
      artifactRevision: 'diff-sha-1',
      reasons: [],
    });

    const partial = runEvidence([
      { exitCode: 0, timedOut: false, output: 'ok' },
      { exitCode: 2, timedOut: false, output: 'failed' },
    ]).bundle;
    const partialVerdict = decideVerdict(partial);
    assert.equal(partialVerdict.verdict, 'rejected');
    assert.deepEqual(partialVerdict.reasons, ['command 2 exited with code 2']);

    const timedOut = runEvidence([
      { exitCode: 124, timedOut: true, output: 'timeout' },
      { exitCode: 0, timedOut: false, output: 'not reached in real adapter' },
    ]).bundle;
    assert.deepEqual(decideVerdict(timedOut).reasons, ['command 1 timed out', 'command 1 exited with code 124']);

    const tooFew = decideVerdict(allPass, { minimumCommands: 3 });
    assert.deepEqual(tooFew, {
      verdict: 'rejected',
      artifactRevision: 'diff-sha-1',
      reasons: ['expected at least 3 command(s), received 2'],
    });
    assert.equal(Object.isFrozen(tooFew), true);
  });

  it('rejects a timeout even when its exit code is zero', () => {
    assert.deepEqual(decideVerdict(runEvidence([{ exitCode: 0, timedOut: true }, { exitCode: 0, timedOut: false }]).bundle).reasons, ['command 1 timed out']);
  });

  it('fails closed on missing revisions, sparse outcomes, and unbounded identifiers', () => {
    const valid = runEvidence([{ exitCode: 0, timedOut: false }]).bundle;
    const missingRevision = { ...valid } as Record<string, unknown>;
    delete missingRevision.artifactRevision;
    assert.throws(() => decideVerdict(missingRevision), (error: VerificationError) => error.code === 'MISSING_ARTIFACT_REVISION' && error.path === 'bundle.artifactRevision');
    assert.throws(() => decideVerdict({ ...valid, outcomes: new Array(valid.outcomes.length) }), (error: VerificationError) => error.code === 'INVALID_EVIDENCE' && /bundle\.outcomes\[0\]/.test(error.path));
    for (const [field, value] of [['taskId', 'T' + 'a'.repeat(64)], ['attemptId', 'a'.repeat(129)], ['artifactRevision', 'r'.repeat(257)]] as const) {
      assert.throws(() => validateEvidenceBundle({ ...valid, [field]: value }), VerificationError, field);
    }
  });
});

describe('fresh reviewer contract', () => {
  function evidence(): EvidenceBundle {
    return runEvidence([
      { exitCode: 0, timedOut: false, output: 'mechanical pass' },
      { exitCode: 0, timedOut: false, output: 'mechanical pass' },
    ]).bundle;
  }

  it('assembles only spec, revision-bound diff, and bounded evidence', () => {
    const bundle = evidence();
    const input = {
      spec: {
        objective: 'Add S5 evidence acceptance',
        acceptance_criteria: ['Mechanical checks are recorded', 'Fresh review is isolated'],
        files_in_scope: ['src/core/verification.ts'],
      },
      artifactRevision: 'diff-sha-1',
      diff: 'd'.repeat(1_000),
      evidence: bundle,
    };
    const brief = assembleReviewerBrief(input);
    assert.deepEqual(Object.keys(brief).sort(), ['diff', 'evidence', 'spec']);
    assert.equal(brief.diff.artifactRevision, 'diff-sha-1');
    assert.equal(brief.diff.patch?.length, 1000);
    assert.equal(brief.evidence.artifactRevision, 'diff-sha-1');
    const large = assembleReviewerBrief({ ...input, diff: 'x'.repeat(40_000) });
    assert.equal(large.diff.patch?.length, 32 * 1024);
    assert.ok((large.diff.patch?.length ?? 0) > 160);
    assert.match(large.diff.patch ?? '', /diff truncated/);
    assert.equal(Object.isFrozen(brief), true);
    assert.equal(Object.isFrozen(brief.spec), true);
    assert.equal(Object.isFrozen(brief.diff), true);
    assert.equal(Object.isFrozen(brief.evidence), true);
    assert.equal(Object.isFrozen(brief.evidence.outcomes[0]), true);

    const outputShapedInput = {
      spec: input.spec,
      diff: { artifactRevision: 'diff-sha-1', patch: input.diff },
      evidence: bundle,
    };
    assert.equal(assembleReviewerBrief(outputShapedInput).diff.patch?.length, 1000);

    const withTranscript = { ...input, workerTranscript: 'must not cross context' };
    assert.throws(() => assembleReviewerBrief(withTranscript), (error: ReviewerBriefError) => {
      assert.equal(error.code, 'INVALID_REVIEW_BRIEF');
      assert.equal(error.path, 'input');
      assert.match(error.message, /workerTranscript/);
      return true;
    });
  });

  it('rejects revision mismatch and malformed reviewer verdicts structurally', () => {
    const bundle = evidence();
    assert.throws(() => assembleReviewerBrief({
      spec: { objective: 'x', acceptance_criteria: ['y'], files_in_scope: [] },
      artifactRevision: 'different-revision',
      evidence: bundle,
    }), (error: ReviewerBriefError) => error.code === 'ARTIFACT_REVISION_MISMATCH');

    for (const invalid of [
      { outcome: 'maybe', reasons: ['x'], artifactRevision: 'diff-sha-1' },
      { outcome: 'passed', reasons: [], artifactRevision: 'diff-sha-1' },
      { outcome: 'passed', reasons: ['x'], artifactRevision: '' },
    ]) {
      assert.throws(() => validateReviewVerdict(invalid), (error: ReviewerBriefError) => {
        assert.equal(error.code, 'INVALID_REVIEW_VERDICT');
        assert.ok(error.path.startsWith('reviewVerdict.'));
        assert.ok(Array.isArray(error.available));
        return true;
      });
    }
  });

  it('rejects sparse or tampered criteria and reasons structurally', () => {
    const valid = evidence();
    assert.throws(() => validateReviewVerdict({ outcome: 'passed', reasons: new Array(1), artifactRevision: 'rev' }), (error: ReviewerBriefError) => error.code === 'INVALID_REVIEW_VERDICT' && /reasons\[0\]/.test(error.path));
    for (const acceptance_criteria of [new Array(1), Object.assign(['criterion'], { map: null })]) {
      assert.throws(() => assembleReviewerBrief({ spec: { objective: 'objective', acceptance_criteria, files_in_scope: [] }, artifactRevision: 'diff-sha-1', evidence: valid }), (error: ReviewerBriefError) => error.code === 'INVALID_REVIEW_BRIEF');
    }
  });

  it('covers the complete final-verdict matrix and binds review to the artifact', () => {
    const passed = { verdict: 'passed' as const, artifactRevision: 'rev', reasons: [] };
    const rejected = { verdict: 'rejected' as const, artifactRevision: 'rev', reasons: ['command failed'] };
    const reviewPassed = { outcome: 'passed' as const, artifactRevision: 'rev', reasons: ['reviewed'] };
    const reviewRejected = { outcome: 'rejected' as const, artifactRevision: 'rev', reasons: ['criterion missing'] };

    assert.equal(decideFinalVerdict(rejected), 'rejected');
    assert.equal(decideFinalVerdict(rejected, reviewPassed, true), 'rejected');
    assert.equal(decideFinalVerdict(passed), 'passed');
    assert.equal(decideFinalVerdict(passed, undefined, true), 'needs_review');
    assert.equal(decideFinalVerdict(passed, reviewPassed, true), 'passed');
    assert.equal(decideFinalVerdict(passed, reviewRejected, true), 'rejected');
    assert.equal(decideFinalVerdict(passed, reviewRejected, false), 'rejected');

    assert.throws(() => decideFinalVerdict(passed, { ...reviewPassed, artifactRevision: 'other' }), (error: ReviewerBriefError) => {
      assert.equal(error.code, 'ARTIFACT_REVISION_MISMATCH');
      assert.equal(error.path, 'review.artifactRevision');
      return true;
    });
  });
});
