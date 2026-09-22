import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlannerPrompt, validateRunPlan } from '../src/host/run-plan.ts';

const task = (id: string, depends_on: string[] = []) => ({ id, objective: `do ${id}`, depends_on, files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: ['npm test'] });

describe('host run plan boundary', () => {
  it('validates and freezes single and plan shapes with DAG dependencies', () => {
    const single = validateRunPlan({ version: 1, executionMode: 'single', tasks: [task('Tone')], finalVerification: ['npm test'] });
    assert.equal(single.tasks.length, 1);
    assert.equal(Object.isFrozen(single), true);
    const plan = validateRunPlan({ version: 1, executionMode: 'plan', tasks: [task('Tbase'), task('Tleaf', ['Tbase'])], finalVerification: ['npm test'] });
    assert.deepEqual(plan.tasks[1]?.depends_on, ['Tbase']);
    assert.throws(() => validateRunPlan({ version: 1, executionMode: 'plan', tasks: [task('Ta', ['Tb']), task('Tb', ['Ta'])], finalVerification: ['npm test'] }), /cycle/);
    assert.throws(() => validateRunPlan({ version: 1, executionMode: 'single', tasks: [task('Ta'), task('Tb')], finalVerification: ['npm test'] }), /single/);
  });

  it('prompt is deterministic and demands read-only exact JSON', () => {
    const first = buildPlannerPrompt({ userTask: 'make a change', repoRoot: '/repo', baseRevision: 'HEAD', authorizedVerificationCommands: ['npm test'] });
    assert.equal(first, buildPlannerPrompt({ userTask: 'make a change', repoRoot: '/repo', baseRevision: 'HEAD', authorizedVerificationCommands: ['npm test'] }));
    assert.match(first, /read-only inspection/);
    assert.match(first, /exact JSON only/);
    assert.equal(first.includes('markdown'), true);
    assert.match(first, /Host verificationAllowlist/);
    assert.match(first, /npm test/);
    assert.match(first, /TaskContract fields are exactly/);
    assert.match(first, /only exact strings from the host verificationAllowlist/);
  });
});
