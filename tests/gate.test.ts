import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GateConfigError,
  needsFreshReview,
  planRoute,
  type RoutePlan,
} from '../src/core/gate.ts';
import type { TaskContract } from '../src/core/task-contract.ts';

function contract(extra: Partial<TaskContract> = {}): TaskContract {
  return {
    id: 'Tgate-sample',
    objective: 'Implement the small gate change',
    depends_on: [],
    files_in_scope: ['src/core/gate.ts'],
    acceptance_criteria: ['The route is deterministic'],
    verification: ['npm test -- gate'],
    ...extra,
  };
}

function route(extra: Partial<TaskContract> = {}, options?: Parameters<typeof planRoute>[1]): RoutePlan {
  return planRoute(contract(extra), options);
}

function signalLevel(result: RoutePlan, name: string): string {
  return result.signals.find((signal) => signal.name === name)?.level ?? 'missing';
}

describe('orchestration gate', () => {
  it('keeps a small verified task single-agent first', () => {
    const result = route();
    assert.equal(result.complexity, 'simple');
    assert.equal(result.mode, 'single');
    assert.equal(result.forced, false);
    assert.equal(result.expectedTaskCount, 1);
    assert.equal(result.maxConcurrency, 1);
    assert.equal(result.mechanicalVerification.required, true);
    assert.deepEqual(result.mechanicalVerification.commands, ['npm test -- gate']);
    assert.equal(needsFreshReview(result).required, false);
  });

  it('classifies each cardinality signal at its medium and complex boundaries', () => {
    assert.equal(signalLevel(route({ files_in_scope: ['a', 'b'] }), 'files_in_scope'), 'medium');
    assert.equal(signalLevel(route({ files_in_scope: ['a', 'b', 'c', 'd', 'e'] }), 'files_in_scope'), 'complex');
    assert.equal(signalLevel(route({ acceptance_criteria: ['a', 'b', 'c'] }), 'acceptance_criteria'), 'medium');
    assert.equal(signalLevel(route({ acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f'] }), 'acceptance_criteria'), 'complex');
    assert.equal(signalLevel(route({ verification: [] }), 'verification_commands'), 'medium');
    assert.equal(signalLevel(route({ verification: ['a', 'b', 'c', 'd'] }), 'verification_commands'), 'complex');
    assert.equal(signalLevel(route({ depends_on: ['Ta'] }), 'dependencies'), 'medium');
    assert.equal(signalLevel(route({ depends_on: ['Ta', 'Tb', 'Tc'] }), 'dependencies'), 'complex');
  });

  it('classifies contract volume independently and preserves an explainable hit', () => {
    const result = route(
      { objective: 'x'.repeat(500) },
      {
        thresholds: {
          contractCharsMedium: 500,
          contractCharsComplex: 1_000,
          filesInScopeMedium: 10,
          filesInScopeComplex: 20,
          acceptanceCriteriaMedium: 10,
          acceptanceCriteriaComplex: 20,
          dependencyCountMedium: 10,
          dependencyCountComplex: 20,
        },
      },
    );
    assert.equal(signalLevel(result, 'contract_chars'), 'medium');
    assert.ok(result.reasons.some((reason) => reason.includes('contract text volume')));
  });

  it('keeps one and two medium signals at medium, then promotes three to complex', () => {
    const one = route({ files_in_scope: ['a', 'b'] });
    assert.equal(one.complexity, 'medium');
    assert.equal(one.score, 1);

    const two = route({ files_in_scope: ['a', 'b'], acceptance_criteria: ['a', 'b', 'c'] });
    assert.equal(two.complexity, 'medium');
    assert.equal(two.score, 2);

    const result = route({
      files_in_scope: ['a', 'b'],
      acceptance_criteria: ['a', 'b', 'c'],
      depends_on: ['Ta'],
    });
    assert.equal(result.complexity, 'complex');
    assert.equal(result.score, 3);
    assert.equal(result.mode, 'plan');
    assert.equal(result.expectedTaskCount, 4);
    assert.equal(result.maxConcurrency, 2);
    assert.deepEqual(result.reasons, result.signals.filter((signal) => signal.hit).map((signal) => signal.reason));
    for (const reason of result.reasons) {
      assert.ok(result.signals.some((signal) => signal.hit && signal.reason === reason));
    }
  });

  it('treats contract_chars 2000 as the inclusive complex boundary', () => {
    const fixed = contract({ objective: '' });
    const fixedChars = [
      ...(fixed.files_in_scope ?? []),
      ...fixed.acceptance_criteria,
      ...fixed.verification,
      ...fixed.depends_on,
    ].reduce((total, value) => total + value.length, 0);
    const result = route({ objective: 'x'.repeat(2_000 - fixedChars) });
    const signal = result.signals.find((entry) => entry.name === 'contract_chars');
    assert.equal(signal?.value, 2_000);
    assert.equal(signal?.level, 'complex');
    assert.equal(result.complexity, 'complex');
  });

  it('supports threshold overrides without changing caller data', () => {
    const input = contract();
    const files = input.files_in_scope as string[];
    const result = planRoute(input, {
      thresholds: {
        filesInScopeMedium: 1,
        filesInScopeComplex: 2,
      },
    });
    assert.equal(result.complexity, 'medium');
    files.push('caller-only.ts');
    assert.deepEqual(result.mechanicalVerification.commands, ['npm test -- gate']);
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(files), false);
  });

  it('records forced single and forced plan decisions for ablation', () => {
    const complexContract = contract({
      files_in_scope: ['a', 'b', 'c', 'd', 'e'],
      acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const single = planRoute(complexContract, { mode: 'force-single' });
    assert.equal(single.mode, 'single');
    assert.equal(single.forced, true);
    assert.equal(single.forcedMode, 'force-single');
    assert.equal(single.complexity, 'complex');
    assert.equal(single.expectedTaskCount, 1);
    assert.ok(single.decisionReasons.some((reason) => reason.includes('force-single')));

    const forcedPlan = planRoute(contract(), { mode: 'force-plan' });
    assert.equal(forcedPlan.mode, 'plan');
    assert.equal(forcedPlan.forced, true);
    assert.equal(forcedPlan.forcedMode, 'force-plan');
    assert.equal(forcedPlan.expectedTaskCount, 4);
    assert.equal(forcedPlan.maxConcurrency, 2);
    assert.ok(forcedPlan.decisionReasons.some((reason) => reason.includes('force-plan')));
  });

  it('requires a reviewer for plan/complex routes and uncertain verification', () => {
    const medium = route({ files_in_scope: ['a', 'b'] });
    assert.equal(medium.mode, 'plan');
    assert.deepEqual(needsFreshReview(medium), {
      required: true,
      reason: 'plan routes require a fresh reviewer',
    });

    const complexSingle = planRoute(contract({ files_in_scope: ['a', 'b', 'c', 'd', 'e'] }), { mode: 'force-single' });
    assert.equal(needsFreshReview(complexSingle).required, true);
    assert.match(needsFreshReview(complexSingle).reason, /complex/);

    const uncertainSingle = planRoute(contract({ files_in_scope: ['a', 'b'], verification: [] }), { mode: 'force-single' });
    assert.equal(needsFreshReview(uncertainSingle, { status: 'passed' }).required, true);
    assert.match(needsFreshReview(uncertainSingle, { status: 'passed' }).reason, /no command/);

    const simple = route();
    assert.equal(needsFreshReview(simple, { status: 'passed' }).required, false);
    assert.equal(needsFreshReview(simple, { status: 'failed' }).required, true);
    assert.equal(needsFreshReview(simple, { status: 'uncertain' }).required, true);
  });

  it('supports reviewer force-on and force-off independently of route mode', () => {
    const simple = route();
    const always = planRoute(contract(), { reviewer: 'always' });
    assert.equal(needsFreshReview(always).required, true);
    assert.match(needsFreshReview(always).reason, /forced on/);

    const never = planRoute(contract({ files_in_scope: ['a', 'b', 'c', 'd', 'e'] }), { reviewer: 'never' });
    const decision = needsFreshReview(never, { status: 'failed' });
    assert.equal(decision.required, false);
    assert.match(decision.reason, /forced off/);
    assert.equal(simple.mechanicalVerification.required, true);
  });

  it('rejects malformed Task Contracts through the S2 validator', () => {
    for (const value of [null, [], 42, 'contract', new Date(), new Map()]) {
      assert.throws(() => planRoute(value), (error: GateConfigError) => {
        assert.equal(error.code, 'INVALID_CONTRACT');
        assert.equal(error.path, 'contract');
        assert.deepEqual(error.available, []);
        assert.notEqual(error instanceof TypeError, true);
        return true;
      });
    }
    const unknown = { ...contract(), command: 'do-not-run' };
    assert.throws(() => planRoute(unknown), (error: GateConfigError) => {
      assert.equal(error.code, 'INVALID_CONTRACT');
      assert.match(error.message, /command/);
      assert.ok(error.issues?.some((issue) => issue.code === 'UNKNOWN_FIELD'));
      return true;
    });
    const symbol = Symbol('unexpected');
    const withSymbol = { ...contract() } as Record<PropertyKey, unknown>;
    Object.defineProperty(withSymbol, symbol, { value: true, enumerable: false });
    assert.throws(() => planRoute(withSymbol), (error: GateConfigError) => error.code === 'INVALID_CONTRACT');
    const hidden = { ...contract() } as Record<string, unknown>;
    Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
    assert.throws(() => planRoute(hidden), (error: GateConfigError) => error.code === 'INVALID_CONTRACT');
  });

  it('rejects null, unknown, symbol, non-enumerable, and invalid gate options', () => {
    for (const value of [null, 1, [], new Date()]) {
      assert.throws(() => planRoute(contract(), value as never), (error: GateConfigError) => {
        assert.equal(error.code, 'INVALID_GATE_OPTIONS');
        assert.equal(error.path, 'options');
        return true;
      });
    }
    assert.throws(() => planRoute(contract(), { mode: 'sometimes' } as never), (error: GateConfigError) => {
      assert.equal(error.path, 'options.mode');
      assert.deepEqual(error.available, ['auto', 'force-single', 'force-plan']);
      return true;
    });
    assert.throws(() => planRoute(contract(), { unknown: true } as never), (error: GateConfigError) => {
      assert.equal(error.path, 'options');
      assert.match(error.message, /unknown/);
      return true;
    });

    const symbol = Symbol('unexpected');
    const withSymbol: Record<PropertyKey, unknown> = {};
    Object.defineProperty(withSymbol, symbol, { value: true, enumerable: false });
    assert.throws(() => planRoute(contract(), withSymbol as never), GateConfigError);
    const hidden: Record<string, unknown> = {};
    Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
    assert.throws(() => planRoute(contract(), hidden as never), GateConfigError);
    assert.throws(() => planRoute(contract(), { thresholds: { filesInScopeMedium: 0 } } as never), (error: GateConfigError) => {
      assert.equal(error.path, 'options.thresholds.filesInScopeMedium');
      return true;
    });
    assert.throws(() => planRoute(contract(), { thresholds: { filesInScopeMedium: 3, filesInScopeComplex: 3 } } as never), GateConfigError);
  });

  it('rejects RoutePlans whose complexity or mode disagrees with aggregated signals', () => {
    const valid = route();
    const spoofSignals = valid.signals.map((signal) => signal.name === 'files_in_scope'
      ? { ...signal, level: 'medium' as const, hit: true }
      : signal);
    const spoof = {
      ...valid,
      complexity: 'simple' as const,
      mode: 'single' as const,
      score: 1,
      signals: spoofSignals,
      reasons: [spoofSignals[0]!.reason],
    };
    assert.throws(() => needsFreshReview(spoof), (error: GateConfigError) => {
      assert.equal(error.code, 'INVALID_ROUTE_PLAN');
      assert.equal(error.path, 'routePlan.complexity');
      assert.deepEqual(error.available, ['medium']);
      return true;
    });

    const modeSpoof = { ...spoof, complexity: 'medium' as const };
    assert.throws(() => needsFreshReview(modeSpoof), (error: GateConfigError) => {
      assert.equal(error.code, 'INVALID_ROUTE_PLAN');
      assert.equal(error.path, 'routePlan.mode');
      return true;
    });
  });

  it('accepts real simple, medium, complex, and forced RoutePlans', () => {
    const realPlans = [
      route(),
      route({ files_in_scope: ['a', 'b'] }),
      route({ files_in_scope: ['a', 'b', 'c', 'd', 'e'] }),
      planRoute(contract(), { mode: 'force-single' }),
      planRoute(contract(), { mode: 'force-plan' }),
    ];
    for (const realPlan of realPlans) {
      assert.doesNotThrow(() => needsFreshReview(realPlan));
    }
  });

  it('rejects malformed RoutePlan inputs before making a reviewer decision', () => {
    const valid = route();
    for (const value of [null, undefined, [], 42, new Date(), new Map(), {}]) {
      assert.throws(() => needsFreshReview(value as never), (error: GateConfigError) => {
        assert.equal(error.code, 'INVALID_ROUTE_PLAN');
        assert.ok(error.path === 'routePlan' || error.path.startsWith('routePlan.'));
        assert.notEqual(error instanceof TypeError, true);
        return true;
      });
    }
    const missing = { ...valid } as Record<string, unknown>;
    delete missing.mechanicalVerification;
    assert.throws(() => needsFreshReview(missing as never), (error: GateConfigError) => {
      assert.equal(error.code, 'INVALID_ROUTE_PLAN');
      assert.equal(error.path, 'routePlan.mechanicalVerification');
      return true;
    });
    const extra = { ...valid, unexpected: true };
    assert.throws(() => needsFreshReview(extra as never), (error: GateConfigError) => {
      assert.equal(error.code, 'INVALID_ROUTE_PLAN');
      assert.equal(error.path, 'routePlan');
      assert.match(error.message, /unexpected/);
      return true;
    });
    const symbol = Symbol('unexpected');
    const withSymbol = { ...valid } as Record<PropertyKey, unknown>;
    Object.defineProperty(withSymbol, symbol, { value: true, enumerable: false });
    assert.throws(() => needsFreshReview(withSymbol), (error: GateConfigError) => error.code === 'INVALID_ROUTE_PLAN');
  });

  it('rejects malformed verification summaries with structured errors', () => {
    const simple = route();
    assert.throws(() => needsFreshReview(simple, null as never), (error: GateConfigError) => {
      assert.equal(error.code, 'INVALID_VERIFICATION_SUMMARY');
      assert.equal(error.path, 'verificationSummary');
      return true;
    });
    assert.throws(() => needsFreshReview(simple, { status: 'unknown' } as never), (error: GateConfigError) => {
      assert.equal(error.path, 'verificationSummary.status');
      assert.deepEqual(error.available, ['passed', 'failed', 'uncertain']);
      return true;
    });
  });

  it('returns deterministic deeply frozen results', () => {
    const input = contract();
    const first = planRoute(input);
    const second = planRoute(input);
    assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.signals), true);
    assert.equal(Object.isFrozen(first.signals[0]), true);
    assert.equal(Object.isFrozen(first.reasons), true);
    assert.equal(Object.isFrozen(first.decisionReasons), true);
    assert.equal(Object.isFrozen(first.mechanicalVerification), true);
    assert.equal(Object.isFrozen(first.mechanicalVerification.commands), true);
    assert.throws(() => {
      (first as { mode: string }).mode = 'plan';
    }, TypeError);
    assert.throws(() => {
      (first.signals[0] as { reason: string }).reason = 'mutated';
    }, TypeError);
    const decision = needsFreshReview(first);
    assert.equal(Object.isFrozen(decision), true);
  });

  it('runs a realistic contract through route and reviewer decisions', () => {
    const realistic = contract({
      objective: 'Refactor the scheduler integration and add evidence-bound checks for the release path',
      files_in_scope: ['src/core/scheduler.ts', 'src/core/gate.ts', 'tests/scheduler.test.ts'],
      acceptance_criteria: ['scheduler mapping is explicit', 'reviewer policy is recorded', 'failure is fail-closed'],
      verification: ['npm run typecheck', 'npm test'],
      depends_on: ['Tcontract-core'],
    });
    const planned = planRoute(realistic);
    const review = needsFreshReview(planned, { status: 'passed' });
    assert.equal(planned.mode, 'plan');
    assert.equal(planned.complexity, 'complex');
    assert.equal(review.required, true);
    assert.ok(planned.reasons.some((reason) => reason.includes('files_in_scope')));
    assert.ok(planned.reasons.some((reason) => reason.includes('depends_on')));
  });
});
