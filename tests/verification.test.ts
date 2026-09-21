import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { needsFreshReview, planRoute } from '../src/core/gate.ts';
import {
  MechanicalVerifier,
  VerificationError,
  decideVerdict,
  type EvidenceBundle,
  type VerificationCommand,
  type VerificationRunner,
  type VerificationRunnerResult,
} from '../src/core/verification.ts';
import {
  ReviewerBriefError,
  assembleReviewerBrief,
  decideFinalVerdict,
  s2VerdictInput,
  validateReviewVerdict,
} from '../src/core/reviewer-brief.ts';
import { validateTaskContract, type TaskContract } from '../src/core/task-contract.ts';

function commands(): VerificationCommand[] {
  return [
    { command: 'npm run check', cwd: '/workspace', timeoutMs: 30_000 },
    { command: 'npm test' },
  ];
}

function runEvidence(
  results: readonly VerificationRunnerResult[],
  artifactRevision = 'diff-sha-1',
): { bundle: EvidenceBundle; calls: VerificationCommand[] } {
  const calls: VerificationCommand[] = [];
  let now = 100;
  const runner: VerificationRunner = {
    run(command) {
      calls.push(command);
      return results[calls.length - 1] ?? { exitCode: 0, timedOut: false, output: 'default' };
    },
  };
  const verifier = new MechanicalVerifier();
  const bundle = verifier.run(commands(), {
    taskId: 'Ts5-verification',
    attemptId: 'Ts5-verification:attempt-1',
    artifactRevision,
    clock: () => now++,
    runner,
  });
  return { bundle, calls };
}

describe('S5 mechanical verification', () => {
  it('runs every command through the fake runner and returns frozen evidence', () => {
    const longOutput = 'x'.repeat(1_000);
    const { bundle, calls } = runEvidence([
      { exitCode: 0, timedOut: false, output: longOutput },
      { exitCode: 0, timedOut: false, outputRef: 'artifact://logs/check' },
    ]);

    assert.deepEqual(calls, commands());
    assert.deepEqual(bundle.commands, commands());
    assert.equal(bundle.outcomes[0]?.durationMs, 1);
    assert.equal(bundle.outcomes[0]?.output?.length, 160);
    assert.equal(bundle.outcomes[1]?.outputRef, 'artifact://logs/check');
    assert.equal(bundle.artifactRevision, 'diff-sha-1');
    assert.equal(Object.isFrozen(bundle), true);
    assert.equal(Object.isFrozen(bundle.commands), true);
    assert.equal(Object.isFrozen(bundle.outcomes[0]), true);
    assert.throws(() => {
      (bundle as { artifactRevision: string }).artifactRevision = 'changed';
    }, TypeError);
  });

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

  it('fails closed on missing artifact revisions and malformed exact fields', () => {
    assert.throws(() => runEvidence([{ exitCode: 0, timedOut: false }], ''), (error: VerificationError) => {
      assert.equal(error.code, 'MISSING_ARTIFACT_REVISION');
      assert.equal(error.path, 'ctx.artifactRevision');
      assert.ok(Array.isArray(error.available));
      return true;
    });

    const valid = runEvidence([{ exitCode: 0, timedOut: false }]).bundle;
    const missingRevision = { ...valid } as Record<string, unknown>;
    delete missingRevision.artifactRevision;
    assert.throws(() => decideVerdict(missingRevision), (error: VerificationError) => {
      assert.equal(error.code, 'MISSING_ARTIFACT_REVISION');
      assert.equal(error.path, 'bundle.artifactRevision');
      return true;
    });

    const input = commands() as unknown as Array<Record<PropertyKey, unknown>>;
    const symbol = Symbol('unexpected');
    Object.defineProperty(input[0], symbol, { value: true, enumerable: false });
    assert.throws(() => new MechanicalVerifier().run(input as unknown as VerificationCommand[], {
      taskId: 'Tshape',
      attemptId: 'a-1',
      artifactRevision: 'rev',
      clock: () => 0,
      runner: { run: () => ({ exitCode: 0, timedOut: false }) },
    }), (error: VerificationError) => error.code === 'INVALID_COMMAND' && error.path === 'commands[0]');
  });

  it('rejects a timeout even when its exit code is zero and wraps runner exceptions', () => {
    const timedOut = runEvidence([
      { exitCode: 0, timedOut: true },
      { exitCode: 0, timedOut: false },
    ]).bundle;
    assert.deepEqual(decideVerdict(timedOut).reasons, ['command 1 timed out']);

    assert.throws(() => new MechanicalVerifier().run([{ command: 'fake-check' }], {
      taskId: 'Tthrows',
      attemptId: 'Tthrows:attempt-1',
      artifactRevision: 'rev',
      clock: () => 0,
      runner: { run: () => { throw new Error('fake runner failure'); } },
    }), (error: VerificationError) => {
      assert.equal(error.code, 'RUNNER_FAILED');
      assert.equal(error.path, 'runner.run[0]');
      assert.match(error.message, /fake runner failure/);
      return true;
    });
  });

  it('rejects sparse and method-tampered arrays with structured errors', () => {
    const valid = runEvidence([{ exitCode: 0, timedOut: false }]).bundle;
    const sparseOutcomes = new Array(valid.outcomes.length) as unknown[];
    assert.throws(() => decideVerdict({ ...valid, outcomes: sparseOutcomes }), (error: VerificationError) => {
      assert.equal(error.code, 'INVALID_EVIDENCE');
      assert.match(error.path, /bundle\.outcomes\[0\]/);
      return true;
    });

    const sparseReasons = new Array(1) as unknown[];
    assert.throws(() => validateReviewVerdict({ outcome: 'passed', reasons: sparseReasons, artifactRevision: 'rev' }), (error: ReviewerBriefError) => {
      assert.equal(error.code, 'INVALID_REVIEW_VERDICT');
      assert.match(error.path, /reasons\[0\]/);
      return true;
    });

    const tamperedCommands = Object.assign([{ command: 'fake-check' }], { map: null });
    assert.throws(() => new MechanicalVerifier().run(tamperedCommands, {
      taskId: 'Ttampered',
      attemptId: 'Ttampered:attempt-1',
      artifactRevision: 'rev',
      clock: () => 0,
      runner: { run: () => ({ exitCode: 0, timedOut: false }) },
    }), (error: VerificationError) => {
      assert.equal(error.code, 'INVALID_COMMAND');
      assert.equal(error.path, 'commands');
      return true;
    });

    const sparseCriteria = new Array(1) as unknown[];
    assert.throws(() => assembleReviewerBrief({
      spec: { objective: 'objective', acceptance_criteria: sparseCriteria, files_in_scope: [] },
      artifactRevision: 'diff-sha-1',
      evidence: valid,
    }), (error: ReviewerBriefError) => {
      assert.equal(error.code, 'INVALID_REVIEW_BRIEF');
      assert.match(error.path, /acceptance_criteria\[0\]/);
      return true;
    });

    const tamperedCriteria = Object.assign(['criterion'], { map: null });
    assert.throws(() => assembleReviewerBrief({
      spec: { objective: 'objective', acceptance_criteria: tamperedCriteria, files_in_scope: [] },
      artifactRevision: 'diff-sha-1',
      evidence: valid,
    }), (error: ReviewerBriefError) => error.code === 'INVALID_REVIEW_BRIEF');
  });

  it('enforces bounded task, attempt, and revision identifiers', () => {
    const base = {
      taskId: 'T' + 'a'.repeat(63),
      attemptId: 'a'.repeat(128),
      artifactRevision: 'r'.repeat(256),
    };
    assert.doesNotThrow(() => new MechanicalVerifier().run([{ command: 'fake-check' }], {
      ...base,
      clock: () => 0,
      runner: { run: () => ({ exitCode: 0, timedOut: false }) },
    }));
    for (const [field, value] of [
      ['taskId', 'T' + 'a'.repeat(64)],
      ['attemptId', 'a'.repeat(129)],
      ['artifactRevision', 'r'.repeat(257)],
    ] as const) {
      assert.throws(() => new MechanicalVerifier().run([{ command: 'fake-check' }], {
        ...base,
        [field]: value,
        clock: () => 0,
        runner: { run: () => ({ exitCode: 0, timedOut: false }) },
      }), (error: VerificationError) => {
        assert.ok(error.code === 'INVALID_CONTEXT' || error.code === 'MISSING_ARTIFACT_REVISION');
        return true;
      });
    }
    assert.throws(() => assembleReviewerBrief({
      spec: { objective: 'objective', acceptance_criteria: ['criterion'], files_in_scope: [] },
      artifactRevision: 'r'.repeat(257),
      evidence: runEvidence([{ exitCode: 0, timedOut: false }]).bundle,
    }), (error: ReviewerBriefError) => error.code === 'INVALID_REVIEW_BRIEF');
  });

});

describe('S5 fresh reviewer contract', () => {
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
    assert.equal(brief.diff.patch?.length, 160);
    assert.equal(brief.evidence.artifactRevision, 'diff-sha-1');
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
    assert.equal(assembleReviewerBrief(outputShapedInput).diff.patch?.length, 160);

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
    assert.equal(decideFinalVerdict(passed, reviewPassed, { required: true, reason: 'plan route requires review' }), 'passed');
    assert.equal(s2VerdictInput('passed'), 'passed');
    assert.equal(s2VerdictInput('rejected'), 'rejected');
    assert.throws(() => s2VerdictInput('needs_review'), (error: ReviewerBriefError) => {
      assert.equal(error.code, 'INVALID_FINAL_DECISION');
      assert.deepEqual(error.available, ['passed', 'rejected']);
      return true;
    });

    assert.throws(() => decideFinalVerdict(passed, { ...reviewPassed, artifactRevision: 'other' }), (error: ReviewerBriefError) => {
      assert.equal(error.code, 'ARTIFACT_REVISION_MISMATCH');
      assert.equal(error.path, 'review.artifactRevision');
      return true;
    });
  });

  it('runs contract + S4 route + mechanical verification + fresh brief end to end', () => {
    const rawContract: TaskContract = {
      id: 'Ts5-e2e',
      objective: 'Make acceptance evidence explicit',
      depends_on: [],
      files_in_scope: ['src/core/verification.ts', 'src/core/reviewer-brief.ts'],
      acceptance_criteria: ['Evidence is revision-bound', 'Reviewer input is isolated'],
      verification: ['npm run check'],
    };
    const validated = validateTaskContract(rawContract);
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const route = planRoute(validated.contract);
    const gate = needsFreshReview(route);
    assert.equal(route.mechanicalVerification.required, true);
    assert.equal(gate.required, true);
    const mechanical = new MechanicalVerifier().run(route.mechanicalVerification.commands.map((command) => ({ command })), {
      taskId: validated.contract.id,
      attemptId: 'Ts5-e2e:attempt-1',
      artifactRevision: 'commit-sha-e2e',
      clock: () => 10,
      runner: { run: () => ({ exitCode: 0, timedOut: false, output: 'check passed' }) },
    });
    const mechanicalVerdict = decideVerdict(mechanical, { minimumCommands: 1 });
    const brief = assembleReviewerBrief({
      spec: {
        objective: validated.contract.objective,
        acceptance_criteria: validated.contract.acceptance_criteria,
        files_in_scope: validated.contract.files_in_scope ?? [],
      },
      artifactRevision: 'commit-sha-e2e',
      diff: 'diff --git a/src/core/verification.ts b/src/core/verification.ts',
      evidence: mechanical,
    });
    assert.equal(brief.evidence.taskId, 'Ts5-e2e');
    const final = decideFinalVerdict(mechanicalVerdict, {
      outcome: 'passed',
      reasons: ['criteria checked against the brief'],
      artifactRevision: brief.diff.artifactRevision,
    }, gate);
    assert.equal(final, 'passed');
  });
});
