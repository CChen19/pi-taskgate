import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CatalogConfigError, createCatalog } from '../src/core/catalog.ts';
import { IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID, EXPLORER_ROLE_ID } from '../src/core/defaults.ts';
import { PROFILE_FAST, PROFILE_SLASH, SLASH_MODEL_ID, fixtureConfig } from './fixtures.ts';

function validConfigJson(): Record<string, unknown> {
  const config = fixtureConfig();
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

describe('createCatalog', () => {
  it('builds a queryable catalog from a valid config', () => {
    const catalog = createCatalog(validConfigJson());
    assert.deepEqual([...catalog.roleIds].sort(), ['coordinator', EXPLORER_ROLE_ID, IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID].sort());
    assert.deepEqual([...catalog.workerRoleIds].sort(), [EXPLORER_ROLE_ID, IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID].sort());
    assert.deepEqual([...catalog.modelProfileIds].sort(), [PROFILE_FAST, PROFILE_SLASH].sort());

    const implementer = catalog.getRole(IMPLEMENTER_ROLE_ID);
    assert.equal(implementer?.kind, 'worker');

    const slashProfile = catalog.getModelProfile(PROFILE_SLASH);
    // Full slash/colon model ID is preserved verbatim.
    assert.equal(slashProfile?.model, SLASH_MODEL_ID);
    assert.equal(slashProfile?.provider, 'fixture-provider');

    const route = catalog.getRoute(REVIEWER_ROLE_ID);
    assert.equal(route.defaultProfile, PROFILE_FAST);
    assert.deepEqual([...route.allowedProfiles], [PROFILE_FAST]);
  });

  it('model profile IDs and models containing slashes are never split', () => {
    const config = validConfigJson();
    (config['models'] as unknown[]).push({ id: 'a/b:c', provider: 'p/q', model: 'org/name:tag' });
    const catalog = createCatalog(config);
    assert.deepEqual([...catalog.modelProfileIds], [...(fixtureConfig().models.map((m) => m.id)), 'a/b:c']);
    assert.equal(catalog.getModelProfile('a/b:c')?.model, 'org/name:tag');
  });

  it('rejects non-object and unknown top-level fields', () => {
    assert.throws(() => createCatalog(null), CatalogConfigError);
    assert.throws(() => createCatalog('config'), CatalogConfigError);
    assert.throws(() => createCatalog([]), CatalogConfigError);
    const config = validConfigJson() as Record<string, unknown>;
    config['sandbox'] = true;
    assert.throws(() => createCatalog(config), (error: CatalogConfigError) => {
      assert.equal(error.code, 'INVALID_CONFIG');
      assert.match(error.message, /sandbox/);
      return true;
    });
  });

  it('rejects empty and duplicate IDs', () => {
    const empty = validConfigJson();
    (empty['roles'] as Record<string, unknown>[])[0]!['id'] = '  ';
    assert.throws(() => createCatalog(empty), (error: CatalogConfigError) => {
      assert.equal(error.code, 'EMPTY_ID');
      assert.equal(error.path, 'config.roles[0].id');
      return true;
    });

    const duplicateModel = validConfigJson();
    (duplicateModel['models'] as unknown[]).push({ id: PROFILE_FAST, provider: 'x', model: 'y' });
    assert.throws(() => createCatalog(duplicateModel), (error: CatalogConfigError) => {
      assert.equal(error.code, 'DUPLICATE_ID');
      return true;
    });

    const duplicateRoute = validConfigJson();
    const routes = duplicateRoute['routes'] as unknown[];
    routes.push({ ...(routes[0] as Record<string, unknown>) });
    assert.throws(() => createCatalog(duplicateRoute), (error: CatalogConfigError) => {
      assert.equal(error.code, 'DUPLICATE_ID');
      return true;
    });
  });

  it('rejects invalid role fields, including tool declarations', () => {
    const badKind = validConfigJson();
    (badKind['roles'] as Record<string, unknown>[])[0]!['kind'] = 'wizard';
    assert.throws(() => createCatalog(badKind), (error: CatalogConfigError) => {
      assert.equal(error.code, 'INVALID_CONFIG');
      assert.match(error.message, /kind/);
      return true;
    });

    const badTools = validConfigJson();
    (badTools['roles'] as Record<string, unknown>[])[0]!['tools'] = ['fs.read', ''];
    assert.throws(() => createCatalog(badTools), CatalogConfigError);
  });

  it('rejects unknown references and defaults outside the allowlist', () => {
    const unknownRole = validConfigJson();
    (unknownRole['routes'] as Record<string, unknown>[])[0]!['roleId'] = 'ghost-role';
    assert.throws(() => createCatalog(unknownRole), (error: CatalogConfigError) => {
      assert.equal(error.code, 'UNKNOWN_REFERENCE');
      return true;
    });

    const unknownProfile = validConfigJson();
    (unknownProfile['routes'] as Record<string, unknown>[])[0]!['allowedProfiles'] = ['ghost-profile'];
    assert.throws(() => createCatalog(unknownProfile), (error: CatalogConfigError) => {
      assert.equal(error.code, 'UNKNOWN_REFERENCE');
      assert.match(error.message, /ghost-profile/);
      return true;
    });

    const defaultNotAllowed = validConfigJson();
    (defaultNotAllowed['routes'] as Record<string, unknown>[])[1]!['allowedProfiles'] = [PROFILE_FAST];
    assert.throws(() => createCatalog(defaultNotAllowed), (error: CatalogConfigError) => {
      assert.equal(error.code, 'DEFAULT_NOT_ALLOWED');
      return true;
    });

    const unroutedRole = validConfigJson();
    (unroutedRole['routes'] as unknown[]).pop();
    assert.throws(() => createCatalog(unroutedRole), (error: CatalogConfigError) => {
      assert.equal(error.code, 'UNKNOWN_REFERENCE');
      assert.match(error.message, /has no model route/);
      return true;
    });
  });

  it('rejects requests shaped like tasks with execution bypass fields', () => {
    const config = validConfigJson();
    (config['routes'] as Record<string, unknown>[])[0]!['command'] = 'rm -rf /';
    assert.throws(() => createCatalog(config), (error: CatalogConfigError) => {
      assert.equal(error.code, 'INVALID_CONFIG');
      assert.match(error.message, /command/);
      return true;
    });
  });

  it('construction has zero side effects on the caller-owned config (M2)', () => {
    const config = validConfigJson();
    const roles = config['roles'] as Array<Record<string, unknown>>;
    const routes = config['routes'] as Array<Record<string, unknown>>;
    const explorer = roles.find((role) => role['id'] === EXPLORER_ROLE_ID)!;
    const explorerTools = explorer['tools'] as string[];
    const explorerRoute = routes.find((route) => route['roleId'] === EXPLORER_ROLE_ID)!;
    const allowedProfiles = explorerRoute['allowedProfiles'] as string[];
    const toolsLengthBefore = explorerTools.length;
    const allowedLengthBefore = allowedProfiles.length;

    const catalog = createCatalog(config);

    // Caller arrays are NOT frozen in place and NOT aliased.
    assert.doesNotThrow(() => explorerTools.push('injected-tool'));
    assert.doesNotThrow(() => allowedProfiles.push('profile-injected'));
    assert.equal(explorerTools.length, toolsLengthBefore + 1);
    assert.equal(catalog.getRole(EXPLORER_ROLE_ID)?.tools.includes('injected-tool'), false);
    assert.equal(catalog.getRoute(EXPLORER_ROLE_ID).allowedProfiles.includes('profile-injected'), false);
    assert.equal(Object.isFrozen(explorerTools), false);
    assert.equal(Object.isFrozen(allowedProfiles), false);

    // Caller config stays mutable; catalog is unaffected.
    assert.doesNotThrow(() => roles.push({ id: 'injected', kind: 'worker', description: 'x', tools: [] }));
    assert.equal(catalog.getRole('injected'), undefined);
    assert.deepEqual([...catalog.roleIds].sort(), ['coordinator', EXPLORER_ROLE_ID, IMPLEMENTER_ROLE_ID, REVIEWER_ROLE_ID].sort());
  });

  it('returns deeply frozen snapshots', () => {
    const catalog = createCatalog(validConfigJson());
    const snapshot = catalog.snapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.roles), true);
    assert.equal(Object.isFrozen(snapshot.roles[0]), true);
    assert.equal(Object.isFrozen(snapshot.roles[0]?.tools), true);
    assert.equal(Object.isFrozen(snapshot.models[0]), true);
    assert.equal(Object.isFrozen(snapshot.routes[0]), true);
    assert.throws(() => {
      (snapshot.roles[0] as { id: string }).id = 'mutated';
    }, TypeError);
    assert.throws(() => {
      (snapshot.models[0] as { model: string }).model = 'mutated';
    }, TypeError);
  });
});
