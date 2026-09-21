import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IntegrationError,
  assembleIntegrationAgentBrief,
  decideEscalation,
  planIntegration,
  runIntegration,
  type IntegrationRunner,
  type IntegrationUnit,
  type MergePlan,
} from '../src/core/integration.ts';

function unit(taskId: string, revision = `${taskId}-rev`): IntegrationUnit {
  return {
    taskId,
    branch: `feature/${taskId}`,
    revision,
    verification: { verdict: 'passed', artifactRevision: revision, reasons: [] },
  };
}

function runner(overrides: Partial<{
  rebase: IntegrationRunner['gitOps']['rebase'];
  merge: IntegrationRunner['gitOps']['merge'];
  conflicts: IntegrationRunner['gitOps']['conflicts'];
  status: IntegrationRunner['gitOps']['status'];
  run: IntegrationRunner['commandRunner']['run'];
}> = {}): IntegrationRunner {
  return {
    gitOps: {
      rebase: overrides.rebase ?? (() => ({ ok: true, revision: 'rebased' })),
      merge: overrides.merge ?? (() => ({ ok: true, revision: 'merged' })),
      conflicts: overrides.conflicts ?? (() => ({ conflicts: [] })),
      status: overrides.status ?? (() => ({ revision: 'merged', clean: true })),
    },
    commandRunner: {
      run: overrides.run ?? (() => ({ exitCode: 0, timedOut: false, output: 'ok' })),
    },
  };
}

function plan(units: readonly IntegrationUnit[] = [unit('Ta')], commands: readonly string[] = ['npm run check']): MergePlan {
  return planIntegration(units, { baseRevision: 'base-sha', verificationCommands: commands });
}

describe('S6 mechanical integration', () => {
  it('plans explicit order and stable dependency topology', () => {
    const result = planIntegration([unit('Ta'), unit('Tb'), unit('Tc')], {
      baseRevision: 'base-sha',
      order: ['Tc', 'Tb', 'Ta'],
      dependencies: [
        { taskId: 'Tc', dependsOn: ['Ta'] },
        { taskId: 'Tb', dependsOn: ['Ta'] },
      ],
      verificationCommands: ['npm test'],
    });
    assert.deepEqual(result.units.map((entry) => entry.taskId), ['Ta', 'Tc', 'Tb']);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.units), true);

    assert.throws(() => planIntegration([unit('Ta')], {
      baseRevision: 'base-sha',
      dependencies: [{ taskId: 'Ta', dependsOn: ['Tmissing'] }],
    }), (error: IntegrationError) => {
      assert.equal(error.code, 'INVALID_OPTIONS');
      assert.match(error.path, /dependsOn/);
      assert.deepEqual(error.available, ['Ta']);
      return true;
    });
    assert.throws(() => planIntegration([unit('Ta')], { baseRevision: 'base-sha', unknown: true } as never), IntegrationError);
  });

  it('rejects sparse, method-tampered, unknown, and invalid plan inputs', () => {
    const sparse = new Array(1) as unknown[];
    assert.throws(() => planIntegration(sparse, { baseRevision: 'base' }), (error: IntegrationError) => {
      assert.equal(error.code, 'INVALID_PLAN');
      assert.match(error.path, /units\[0\]/);
      return true;
    });
    const tampered = Object.assign([unit('Ta')], { map: null });
    assert.throws(() => planIntegration(tampered, { baseRevision: 'base' }), (error: IntegrationError) => error.path === 'units');
    const withSymbol = { baseRevision: 'base' } as Record<PropertyKey, unknown>;
    Object.defineProperty(withSymbol, Symbol('unknown'), { value: true });
    assert.throws(() => planIntegration([unit('Ta')], withSymbol), (error: IntegrationError) => error.code === 'INVALID_OPTIONS');
    assert.throws(() => planIntegration([unit('Ta', 'revision-a')], {
      baseRevision: '',
      verificationCommands: [],
    }), (error: IntegrationError) => error.code === 'INVALID_OPTIONS');
    assert.throws(() => planIntegration([{
      ...unit('Ta'),
      verification: { verdict: 'rejected', artifactRevision: 'Ta-rev', reasons: ['failed'] },
    }], { baseRevision: 'base' }), (error: IntegrationError) => {
      assert.equal(error.path, 'units[0].verification.verdict');
      return true;
    });
  });

  it('runs a clean merge, reuses S5 evidence/verdict, and deep freezes the report', () => {
    const calls: string[] = [];
    const result = runIntegration(plan(), runner({
      rebase: (_base, current) => { calls.push(`rebase:${current.taskId}`); return { ok: true, revision: 'rebased-a' }; },
      merge: (current) => { calls.push(`merge:${current.taskId}`); return { ok: true, revision: 'merged-a' }; },
      run: (command) => { calls.push(`verify:${command.command}`); return { exitCode: 0, timedOut: false, output: 'pass' }; },
      conflicts: () => { calls.push('conflicts'); return { conflicts: [] }; },
      status: () => { calls.push('status'); return { revision: 'merged-a', clean: true }; },
    }), { clock: () => 10 });
    assert.equal(result.outcome, 'merged');
    assert.deepEqual(calls, ['rebase:Ta', 'merge:Ta', 'verify:npm run check', 'conflicts', 'status']);
    assert.equal(result.finalVerification?.verdict.verdict, 'passed');
    assert.equal(result.finalVerification?.evidence.artifactRevision, 'merged-a');
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.steps), true);
    assert.equal(Object.isFrozen(result.finalVerification), true);
    assert.throws(() => { (result as { outcome: string }).outcome = 'conflict'; }, TypeError);
    assert.equal(decideEscalation(result).action, 'none');
  });

  it('stops at a conflict and supports a three-unit two-clean-one-conflict flow', () => {
    const merged: string[] = [];
    const result = runIntegration(plan([unit('Ta'), unit('Tb'), unit('Tc')], ['npm test']), runner({
      rebase: (_base, current) => ({ ok: true, revision: `${current.taskId}-rebased` }),
      merge: (current) => {
        if (current.taskId === 'Tc') return { ok: false, details: 'conflict while merging Tc' };
        merged.push(current.taskId);
        return { ok: true, revision: `${current.taskId}-merged` };
      },
      conflicts: () => ({ conflicts: ['src/shared.ts'] }),
      status: () => ({ revision: 'unused', clean: false }),
    }), { clock: () => 0 });
    assert.deepEqual(merged, ['Ta', 'Tb']);
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(result.conflicts, ['src/shared.ts']);
    assert.equal(result.steps.at(-1)?.name, 'conflict-check');
    assert.equal(result.steps.some((step) => step.name === 'verification'), false);
    assert.equal(decideEscalation(result).action, 'integration-agent');

    const brief = assembleIntegrationAgentBrief(plan([unit('Ta'), unit('Tb'), unit('Tc')]), result, [
      { taskId: 'Ta', summary: 'Ta diff summary' },
      { taskId: 'Tb', summary: 'Tb diff summary' },
      { taskId: 'Tc', summary: 'Tc diff summary' },
    ]);
    assert.deepEqual(brief.conflictFiles, ['src/shared.ts']);
    assert.equal(brief.revisions[2]?.revision, 'Tc-rev');
    assert.equal(Object.isFrozen(brief), true);
  });

  it('stops on verification failure, runner exceptions, and malformed step results', () => {
    const failed = runIntegration(plan(), runner({
      run: () => ({ exitCode: 2, timedOut: false, output: 'failed' }),
    }), { clock: () => 0 });
    assert.equal(failed.outcome, 'verification_failed');
    assert.equal(failed.finalVerification?.verdict.verdict, 'rejected');
    assert.equal(decideEscalation(failed, { mechanicalRetries: 2, attempts: 1 }).action, 'mechanical-retry');

    const thrown = runIntegration(plan(), runner({
      merge: () => { throw new Error('fake merge failure'); },
    }), { clock: () => 0 });
    assert.equal(thrown.outcome, 'runner_error');
    assert.equal(thrown.error?.code, 'RUNNER_FAILED');
    assert.equal(decideEscalation(thrown).action, 'human');

    const malformed = runIntegration(plan(), runner({
      rebase: () => ({ ok: 'yes' } as never),
    }), { clock: () => 0 });
    assert.equal(malformed.outcome, 'runner_error');
    assert.equal(malformed.error?.code, 'INVALID_RUNNER_RESULT');
    assert.match(malformed.error?.path ?? '', /rebase/);

    const rebaseThrown = runIntegration(plan(), runner({
      rebase: () => { throw new Error('rebase failed'); },
    }), { clock: () => 0 });
    assert.equal(rebaseThrown.steps.map((step) => step.name).join(','), 'rebase');
    assert.equal(decideEscalation(rebaseThrown).action, 'human');

    const rebaseConflict = runIntegration(plan(), runner({
      rebase: () => ({ ok: false, details: 'rebase conflict' }),
      conflicts: () => ({ conflicts: ['src/rebase.ts'] }),
    }), { clock: () => 0 });
    assert.equal(rebaseConflict.outcome, 'conflict');
    assert.equal(rebaseConflict.steps.map((step) => step.name).join(','), 'rebase,conflict-check');
    assert.equal(decideEscalation(rebaseConflict).action, 'integration-agent');

    assert.throws(() => runIntegration(plan(), {
      gitOps: { rebase() {}, merge() {}, conflicts() {}, status() {} },
      commandRunner: { run() {} },
      unexpected: true,
    } as never, { clock: () => 0 }), (error: IntegrationError) => error.code === 'INVALID_RUNNER');
  });

  it('rejects forged reports by recomputing outcome and step consistency', () => {
    const valid = runIntegration(plan(), runner(), { clock: () => 0 });
    const forged = { ...valid, outcome: 'merged' as const, conflicts: ['fake.ts'] };
    assert.throws(() => decideEscalation(forged), (error: IntegrationError) => {
      assert.equal(error.code, 'INVALID_INTEGRATION_REPORT');
      return true;
    });
    const evidence = valid.finalVerification!.evidence;
    const verdict = valid.finalVerification!.verdict;
    const forgedVerification = {
      ...valid,
      finalVerification: {
        evidence: { ...evidence, outcomes: [{ ...evidence.outcomes[0]!, exitCode: 7 }] },
        verdict: { ...verdict, verdict: 'passed' as const, reasons: [] },
      },
    };
    assert.throws(() => decideEscalation(forgedVerification), (error: IntegrationError) => {
      assert.equal(error.code, 'INVALID_INTEGRATION_REPORT');
      assert.equal(error.path, 'report.finalVerification.verdict');
      return true;
    });
    const forgedCommand = {
      ...valid,
      finalVerification: {
        evidence: { ...evidence, commands: [{ command: 'x'.repeat(100_000) }] },
        verdict,
      },
    };
    assert.throws(() => decideEscalation(forgedCommand), (error: IntegrationError) => {
      assert.equal(error.code, 'INVALID_INTEGRATION_REPORT');
      assert.match(error.path, /evidence\.commands\[0\]\.command/);
      return true;
    });
    const reordered = {
      ...valid,
      steps: [valid.steps[0]!, valid.steps[2]!, valid.steps[1]!, ...valid.steps.slice(3)],
    };
    assert.throws(() => decideEscalation(reordered), (error: IntegrationError) => error.code === 'INVALID_INTEGRATION_REPORT');
    const unknown = { ...valid, extra: true };
    assert.throws(() => decideEscalation(unknown), (error: IntegrationError) => error.code === 'INVALID_REPORT');
    const sparseSteps = { ...valid, steps: new Array(valid.steps.length) };
    assert.throws(() => decideEscalation(sparseSteps), (error: IntegrationError) => error.code === 'INVALID_REPORT');

    const unknownField = { baseRevision: 'base' } as Record<string, unknown>;
    unknownField['x'.repeat(1_000)] = true;
    assert.throws(() => planIntegration([unit('Ta')], unknownField), (error: IntegrationError) => {
      assert.ok(error.message.length <= 160);
      return true;
    });
  });

  it('rejects dependency cycles, duplicate IDs, invalid revisions, and missing git revisions', () => {
    assert.throws(() => planIntegration([unit('Ta'), unit('Tb')], {
      baseRevision: 'base',
      dependencies: [
        { taskId: 'Ta', dependsOn: ['Tb'] },
        { taskId: 'Tb', dependsOn: ['Ta'] },
      ],
    }), (error: IntegrationError) => error.code === 'INVALID_OPTIONS');
    assert.throws(() => planIntegration([unit('Ta'), unit('Ta')], { baseRevision: 'base' }), (error: IntegrationError) => error.code === 'INVALID_PLAN');
    const longRevision = 'x'.repeat(257);
    assert.throws(() => planIntegration([{
      ...unit('Ta'),
      revision: longRevision,
      verification: { verdict: 'passed', artifactRevision: longRevision, reasons: [] },
    }], { baseRevision: 'base' }), (error: IntegrationError) => error.code === 'INVALID_PLAN');
    assert.throws(() => planIntegration([{ ...unit('Ta'), revision: 7 } as never], { baseRevision: 'base' }), (error: IntegrationError) => error.code === 'INVALID_PLAN');

    const missingRevision = runIntegration(plan(), runner({
      rebase: () => ({ ok: true }),
    }), { clock: () => 0 });
    assert.equal(missingRevision.outcome, 'runner_error');
    assert.equal(missingRevision.error?.code, 'INVALID_RUNNER_RESULT');
    assert.equal(missingRevision.error?.path.endsWith('.revision'), true);
  });

  it('bounds commands, conflict paths, and thrown adapter messages', () => {
    assert.throws(() => plan([unit('Ta')], ['x'.repeat(257)]), (error: IntegrationError) => error.code === 'INVALID_OPTIONS');
    const longConflict = runIntegration(plan(), runner({
      conflicts: () => ({ conflicts: ['x'.repeat(257)] }),
    }), { clock: () => 0 });
    assert.equal(longConflict.outcome, 'runner_error');
    assert.equal(longConflict.error?.code, 'INVALID_RUNNER_RESULT');

    const longThrown = runIntegration(plan(), runner({
      merge: () => { throw new Error('x'.repeat(100_000)); },
    }), { clock: () => 0 });
    assert.equal(longThrown.outcome, 'runner_error');
    assert.ok((longThrown.error?.message.length ?? Infinity) <= 160);
  });

  it('stops before conflict/status after verification failure and handles dirty or malformed status', () => {
    let conflictCalls = 0;
    let statusCalls = 0;
    const failed = runIntegration(plan(), runner({
      run: () => ({ exitCode: 7, timedOut: false }),
      conflicts: () => { conflictCalls++; return { conflicts: [] }; },
      status: () => { statusCalls++; return { revision: 'merged', clean: true }; },
    }), { clock: () => 0 });
    assert.equal(failed.outcome, 'verification_failed');
    assert.equal(conflictCalls, 0);
    assert.equal(statusCalls, 0);

    const dirty = runIntegration(plan(), runner({
      status: () => ({ revision: 'merged', clean: false, details: 'dirty' }),
    }), { clock: () => 0 });
    assert.equal(dirty.outcome, 'conflict');
    assert.deepEqual(dirty.conflicts, ['<working-tree>']);

    const malformedConflict = runIntegration(plan(), runner({
      conflicts: () => ({ conflicts: [], extra: true } as never),
      status: () => { throw new Error('status must not run'); },
    }), { clock: () => 0 });
    assert.equal(malformedConflict.outcome, 'runner_error');
    assert.equal(malformedConflict.error?.code, 'INVALID_RUNNER_RESULT');

    const malformedStatus = runIntegration(plan(), runner({
      status: () => ({ revision: 'merged', clean: 'yes' } as never),
    }), { clock: () => 0 });
    assert.equal(malformedStatus.outcome, 'runner_error');
    assert.equal(malformedStatus.error?.code, 'INVALID_RUNNER_RESULT');
  });

  it('validates brief arrays and bounds diff summaries and retry reasons', () => {
    const conflict = runIntegration(plan(), runner({
      merge: () => ({ ok: false, details: 'conflict' }),
      conflicts: () => ({ conflicts: ['src/a.ts'] }),
    }), { clock: () => 0 });
    const summaries = [{ taskId: 'Ta', summary: 's'.repeat(10_000) }];
    const brief = assembleIntegrationAgentBrief(plan(), conflict, summaries);
    assert.equal(brief.diffSummaries[0]?.summary.length, 160);
    const symbol = Symbol('extra');
    Object.defineProperty(summaries, symbol, { value: true, enumerable: false });
    assert.throws(() => assembleIntegrationAgentBrief(plan(), conflict, summaries), (error: IntegrationError) => error.code === 'INVALID_AGENT_BRIEF');

    const failed = runIntegration(plan(), runner({ run: () => ({ exitCode: 1, timedOut: false }) }), { clock: () => 0 });
    const decision = decideEscalation(failed, { mechanicalRetries: 3, attempts: 2 });
    assert.equal(decision.action, 'mechanical-retry');
    assert.match(decision.reason, /1 mechanical retry slot/);
  });
});
