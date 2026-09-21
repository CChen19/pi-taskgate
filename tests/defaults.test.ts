import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCatalog } from '../src/core/catalog.ts';
import {
  COORDINATOR_ROLE_ID,
  DEFAULT_ROLES,
  EXPLORER_ROLE_ID,
  IMPLEMENTER_ROLE_ID,
  REVIEWER_ROLE_ID,
} from '../src/core/defaults.ts';
import { fixtureConfig } from './fixtures.ts';

describe('default role definitions', () => {
  it('declare coordinator plus three worker roles', () => {
    assert.equal(DEFAULT_ROLES.length, 4);
    assert.equal(DEFAULT_ROLES.filter((role) => role.kind === 'worker').length, 3);
  });

  it('declare no shell, edit, write, or terminal tools on the coordinator', () => {
    const forbidden = /(^|[:.])?(bash|shell|edit|write|terminal)(:|$)/;
    const coordinator = DEFAULT_ROLES.find((role) => role.id === COORDINATOR_ROLE_ID);
    assert.ok(coordinator);
    for (const tool of coordinator.tools) {
      assert.equal(forbidden.test(tool), false, `coordinator declares forbidden tool "${tool}"`);
    }
  });

  it('coordinator declares only orchestration and evidence tools', () => {
    const coordinator = DEFAULT_ROLES.find((role) => role.id === COORDINATOR_ROLE_ID);
    assert.ok(coordinator);
    assert.deepEqual([...coordinator.tools].sort(), ['orchestrator.delegate', 'orchestrator.inspectEvidence', 'orchestrator.plan'].sort());
  });

  it('compose with fixture models into a valid catalog', () => {
    const catalog = createCatalog(JSON.parse(JSON.stringify(fixtureConfig())));
    for (const id of [COORDINATOR_ROLE_ID, EXPLORER_ROLE_ID, IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID]) {
      assert.ok(catalog.getRole(id), `missing role ${id}`);
    }
    for (const id of [EXPLORER_ROLE_ID, IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID]) {
      assert.ok(catalog.getRoute(id), `missing route for ${id}`);
    }
  });
});
