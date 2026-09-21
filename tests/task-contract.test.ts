import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateTaskContract } from '../src/core/task-contract.ts';
import { hasExactFields, isPlainObject, truncateForMessage } from '../src/core/validate.ts';

function validInput(): Record<string, unknown> {
  return {
    id: 'Tbuild-core',
    objective: 'Build the task contract core',
    depends_on: [],
    context: ['docs/architecture.md', 'https://example.invalid/spec'],
    files_in_scope: ['src/core/task-contract.ts', 'tests/task-contract.test.ts'],
    acceptance_criteria: ['Unknown fields are rejected', 'The result is deeply frozen'],
    verification: [],
    budget: { max_turns: 4, timeout_ms: 30_000 },
    retry: { max_attempts: 2 },
  };
}

describe('validateTaskContract', () => {
  it('accepts a complete contract and preserves valid path/document references', () => {
    const result = validateTaskContract(validInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.contract.id, 'Tbuild-core');
    assert.deepEqual([...result.contract.context!], ['docs/architecture.md', 'https://example.invalid/spec']);
    assert.deepEqual([...result.contract.files_in_scope!], ['src/core/task-contract.ts', 'tests/task-contract.test.ts']);
    assert.deepEqual(result.contract.budget, { max_turns: 4, timeout_ms: 30_000 });
    assert.deepEqual(result.contract.retry, { max_attempts: 2 });
  });

  it('defaults retry.max_attempts to zero', () => {
    const input = validInput();
    delete input.retry;
    const result = validateTaskContract(input);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.contract.retry, { max_attempts: 0 });
  });

  it('rejects unknown fields and aggregates independent problems', () => {
    const input = validInput();
    input['command'] = 'do-not-execute';
    input['allowed_tools'] = ['shell'];
    input['objective'] = ' ';
    input['acceptance_criteria'] = [];
    input['budget'] = { max_turns: 0, timeout_ms: 'fast' };
    input['retry'] = { max_attempts: -1 };

    const result = validateTaskContract(input);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INVALID_CONTRACT');
    assert.equal(result.error.path, 'contract');
    assert.ok(result.error.issues.length >= 6);
    assert.match(result.error.message, /command/);
    assert.match(result.error.message, /allowed_tools/);
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.objective'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.budget.max_turns'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.retry.max_attempts'));
    assert.equal(Object.isFrozen(result.error), true);
    assert.equal(Object.isFrozen(result.error.issues), true);
  });

  it('bounds stable IDs to keep graph keys and event identifiers finite', () => {
    const result = validateTaskContract({ ...validInput(), id: `T${'a'.repeat(64)}` });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.issues.some((entry) => entry.path === 'contract.id' && /at most 64/.test(entry.message)));
  });

  it('rejects invalid IDs, empty strings, duplicate dependencies, and self-reference', () => {
    const input = validInput();
    input['objective'] = '';
    input['depends_on'] = ['Tprior', 'Tprior', 'Tbuild-core'];
    input['acceptance_criteria'] = ['ok', ''];
    input['verification'] = [''];

    const result = validateTaskContract(input);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.objective'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.depends_on[1]'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.depends_on[2]'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.acceptance_criteria[1]'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.verification[0]'));

    const invalidId = validateTaskContract({ ...validInput(), id: 'Task_BAD' });
    assert.equal(invalidId.ok, false);
    if (!invalidId.ok) assert.ok(invalidId.error.issues.some((entry) => entry.path === 'contract.id'));
  });

  it('rejects wrong types, missing required fields, and nested unknown fields', () => {
    const result = validateTaskContract({
      id: 'Tvalid',
      budget: { max_turns: 1, timeout_ms: 1, extra: true },
      retry: { max_attempts: 0, extra: true },
      context: 'src/',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    for (const path of [
      'contract.objective',
      'contract.depends_on',
      'contract.acceptance_criteria',
      'contract.verification',
      'contract.budget',
      'contract.retry',
    ]) {
      assert.ok(result.error.issues.some((entry) => entry.path === path), path);
    }
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.budget'));
    assert.ok(result.error.issues.some((entry) => entry.path === 'contract.retry'));
  });

  it('returns a deeply frozen copy without mutating or freezing caller input', () => {
    const input = validInput();
    const inputDepends = input['depends_on'] as string[];
    const inputCriteria = input['acceptance_criteria'] as string[];
    const result = validateTaskContract(input);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(Object.isFrozen(result.contract), true);
    assert.equal(Object.isFrozen(result.contract.depends_on), true);
    assert.equal(Object.isFrozen(result.contract.acceptance_criteria), true);
    assert.equal(Object.isFrozen(result.contract.budget), true);
    assert.equal(Object.isFrozen(result.contract.retry), true);
    assert.equal(Object.isFrozen(input), false);
    assert.equal(Object.isFrozen(inputDepends), false);
    assert.equal(Object.isFrozen(inputCriteria), false);

    inputDepends.push('Tlater');
    inputCriteria.push('caller mutation');
    assert.deepEqual(result.contract.depends_on, []);
    assert.equal(result.contract.acceptance_criteria.includes('caller mutation'), false);
    assert.throws(() => {
      (result.contract as { objective: string }).objective = 'mutated';
    }, TypeError);
  });

  it('rejects Date, Map, and custom class instances as contract objects', () => {
    class ContractLike {
      readonly id = 'Tcustom';
      readonly objective = 'objective';
      readonly depends_on: string[] = [];
      readonly acceptance_criteria = ['accepted'];
      readonly verification: string[] = [];
    }
    for (const value of [new Date(), new Map(), new ContractLike()]) {
      assert.equal(isPlainObject(value), false);
      const result = validateTaskContract(value);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'INVALID_CONTRACT');
    }
    assert.equal(isPlainObject(Object.create(null)), true);
    assert.equal(isPlainObject({}), true);
  });

  it('treats Symbol and non-enumerable own fields as unknown fields', () => {
    const symbol = Symbol('unexpected');
    const input = validInput();
    Object.defineProperty(input, symbol, { value: true, enumerable: false });
    Object.defineProperty(input, 'hidden', { value: true, enumerable: false });
    assert.equal(hasExactFields(input, [
      'id', 'objective', 'depends_on', 'context', 'files_in_scope',
      'acceptance_criteria', 'verification', 'budget', 'retry',
    ]), false);
    const result = validateTaskContract(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /Symbol\(unexpected\)/);
      assert.match(result.error.message, /hidden/);
    }
  });

  it('truncates to at most 160 code units without splitting surrogate pairs', () => {
    const ascii = truncateForMessage('x'.repeat(1_000));
    assert.equal(ascii.length, 160);
    assert.match(ascii, /…\[truncated\]$/);

    const emoji = truncateForMessage('😀'.repeat(200));
    assert.ok(emoji.length <= 160);
    assert.match(emoji, /…\[truncated\]$/);
    assert.doesNotThrow(() => encodeURIComponent(emoji));
  });

  it('bounds aggregate messages while retaining the complete issue list', () => {
    const input = validInput();
    input['depends_on'] = Array.from({ length: 10_000 }, () => null);
    const result = validateTaskContract(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.message.length < 2_000);
      assert.match(result.error.message, /9990 more issues/);
      assert.ok(result.error.issues.length >= 10_000);
      assert.equal(result.error.issues[0]?.path, 'contract.depends_on[0]');
      assert.equal(result.error.issues[9]?.path, 'contract.depends_on[9]');
    }
  });

  it('does not echo unbounded unknown input in the aggregate error message', () => {
    const input = validInput();
    input['x'.repeat(100_000)] = true;
    const result = validateTaskContract(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.message.length < 500);
      assert.match(result.error.message, /truncated/);
    }
  });
});
