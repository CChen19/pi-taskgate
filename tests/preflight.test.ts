import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCatalog } from '../src/core/catalog.ts';
import { IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID } from '../src/core/defaults.ts';
import { planDispatch } from '../src/core/preflight.ts';
import { PROFILE_FAST, PROFILE_SLASH, SLASH_MODEL_ID, fixtureConfig } from './fixtures.ts';

function catalog() {
  return createCatalog(JSON.parse(JSON.stringify(fixtureConfig())));
}

function workerRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'Add a README section',
    instructions: 'Write the section under docs/.',
    roleId: IMPLEMENTER_ROLE_ID,
    ...extra,
  };
}

describe('planDispatch', () => {
  it('resolves the role default profile with routingReason role-default', () => {
    const result = planDispatch(catalog(), workerRequest());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.routingReason, 'role-default');
    assert.equal(result.plan.model.id, PROFILE_SLASH);
    assert.equal(result.plan.role.kind, 'worker');
    assert.equal(result.plan.task.roleId, IMPLEMENTER_ROLE_ID);
    assert.equal(result.plan.task.modelProfileId, undefined);
  });

  it('honors a task-level override and reports task-override', () => {
    const result = planDispatch(catalog(), workerRequest({ modelProfileId: PROFILE_FAST }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.routingReason, 'task-override');
    assert.equal(result.plan.model.id, PROFILE_FAST);
    assert.equal(result.plan.task.modelProfileId, PROFILE_FAST);
  });

  it('keeps slash model IDs intact through dispatch', () => {
    const result = planDispatch(catalog(), workerRequest({ modelProfileId: PROFILE_SLASH }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.model.model, SLASH_MODEL_ID);
    assert.equal(result.plan.model.model.split('/').length, 2);
  });

  it('rejects a hallucinated or unknown role, listing available roles', () => {
    const result = planDispatch(catalog(), workerRequest({ roleId: 'senior-architect' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'UNKNOWN_ROLE');
    assert.deepEqual([...result.error.available].sort(), ['coordinator', 'explorer', 'implementer', 'planner', 'reviewer'].sort());
  });

  it('refuses coordinator as a delegation target and lists worker roles', () => {
    const result = planDispatch(catalog(), workerRequest({ roleId: 'coordinator' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'ROLE_NOT_DELEGATABLE');
    assert.deepEqual([...result.error.available].sort(), ['explorer', 'implementer', 'planner', 'reviewer'].sort());
  });

  it('distinguishes unknown profiles from profiles not allowed for the role', () => {
    const unknown = planDispatch(catalog(), workerRequest({ modelProfileId: 'profile-turbo' }));
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.error.code, 'UNKNOWN_MODEL_PROFILE');
      assert.deepEqual([...unknown.error.available].sort(), [PROFILE_FAST, PROFILE_SLASH].sort());
    }

    const notAllowed = planDispatch(catalog(), workerRequest({ roleId: REVIEWER_ROLE_ID, modelProfileId: PROFILE_SLASH }));
    assert.equal(notAllowed.ok, false);
    if (!notAllowed.ok) {
      assert.equal(notAllowed.error.code, 'MODEL_PROFILE_NOT_ALLOWED');
      assert.deepEqual([...notAllowed.error.available], [PROFILE_FAST]);
    }
  });

  it('rejects non-object and structurally invalid requests', () => {
    const catalogInstance = catalog();
    for (const bad of [null, undefined, 42, 'task', [], true]) {
      const result = planDispatch(catalogInstance, bad);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'INVALID_REQUEST');
    }

    for (const missing of [
      {},
      { description: 'd', instructions: 'i' },
      { instructions: 'i', roleId: IMPLEMENTER_ROLE_ID },
      { description: 'd', roleId: IMPLEMENTER_ROLE_ID },
    ]) {
      const result = planDispatch(catalogInstance, missing);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'INVALID_REQUEST');
    }

    for (const empty of [workerRequest({ description: '' }), workerRequest({ instructions: '   ' }), workerRequest({ modelProfileId: '' })]) {
      const result = planDispatch(catalogInstance, empty);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'INVALID_REQUEST');
    }
  });

  it('rejects unknown fields such as allowed_tools or command', () => {
    const catalogInstance = catalog();
    for (const injected of ['allowed_tools', 'command', 'role', 'tools', 'model']) {
      const result = planDispatch(catalogInstance, workerRequest({ [injected]: ['bash'] }));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'INVALID_REQUEST');
        assert.match(result.error.message, new RegExp(injected));
      }
    }
  });

  it('plans are frozen read-only snapshots decoupled from catalog internals', () => {
    const catalogInstance = catalog();
    const result = planDispatch(catalogInstance, workerRequest());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const plan = result.plan as unknown as Record<string, unknown>;
    assert.equal(Object.isFrozen(result.plan), true);
    assert.equal(Object.isFrozen(result.plan.task), true);
    assert.equal(Object.isFrozen(result.plan.role), true);
    assert.equal(Object.isFrozen(result.plan.model), true);
    assert.throws(() => {
      plan['routingReason'] = 'hacked';
    }, TypeError);
    assert.throws(() => {
      (plan['model'] as Record<string, unknown>)['model'] = 'mutated';
    }, TypeError);
    // Regression M1: plan.task must be frozen too.
    assert.throws(() => {
      (result.plan.task as { roleId: string }).roleId = 'coordinator';
    }, TypeError);
    assert.throws(() => {
      (result.plan.task as { description: string }).description = 'mutated';
    }, TypeError);
    // Mutating the plan does not affect the catalog.
    assert.equal(catalogInstance.getModelProfile(PROFILE_SLASH)?.model, SLASH_MODEL_ID);
  });

  it('ignores prototype-inherited request fields (H1)', () => {
    const catalogInstance = catalog();
    const inherited = Object.create({
      description: 'd',
      instructions: 'i',
      roleId: IMPLEMENTER_ROLE_ID,
      modelProfileId: PROFILE_FAST,
    });
    const result = planDispatch(catalogInstance, inherited);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'INVALID_REQUEST');

    const inheritedRole = Object.create({ roleId: 'coordinator' });
    Object.assign(inheritedRole, { description: 'd', instructions: 'i' });
    const result2 = planDispatch(catalogInstance, inheritedRole);
    assert.equal(result2.ok, false);
    if (!result2.ok) assert.equal(result2.error.code, 'INVALID_REQUEST');
  });

  it('bounds echoed input in error messages (H2)', () => {
    const result = planDispatch(catalog(), workerRequest({ roleId: 'x'.repeat(100_000) }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'UNKNOWN_ROLE');
      assert.ok(result.error.message.length < 400);
      assert.match(result.error.message, /\[truncated\]/);
      // Structure unaffected: available IDs still listed in full.
      assert.equal(result.error.available.length, 5);
    }
  });
});
