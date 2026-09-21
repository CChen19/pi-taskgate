import type {
  Catalog,
  CatalogConfig,
  CatalogConfigErrorData,
  CatalogConfigErrorCode,
  ModelProfile,
  ModelRoute,
  RoleDefinition,
} from './contracts.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isNonEmptyStringArray,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

export class CatalogConfigError extends Error implements CatalogConfigErrorData {
  readonly code: CatalogConfigErrorCode;
  readonly path: string;

  constructor(data: CatalogConfigErrorData) {
    super(data.message);
    this.name = 'CatalogConfigError';
    this.code = data.code;
    this.path = data.path;
  }
}

const CONFIG_FIELDS = ['roles', 'models', 'routes'] as const;
const ROLE_FIELDS = ['id', 'description', 'kind', 'tools'] as const;
const MODEL_FIELDS = ['id', 'provider', 'model'] as const;
const ROUTE_FIELDS = ['roleId', 'defaultProfile', 'allowedProfiles'] as const;
const ROLE_KINDS = ['coordinator', 'worker'] as const;

function fail(code: CatalogConfigErrorCode, path: string, message: string): never {
  throw new CatalogConfigError({ code, path, message });
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail('INVALID_CONFIG', path, `${path} must be an object`);
  return value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('INVALID_CONFIG', path, `${path} must be an array`);
  return value;
}

function requireExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  if (!hasExactFields(value, allowed)) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    fail(
      'INVALID_CONFIG',
      path,
      `${path} has unknown field(s): ${unknown.join(', ')}; allowed: ${allowed.join(', ')}`,
    );
  }
}

function requireString(
  value: unknown,
  path: string,
): string {
  const s = asNonEmptyString(value);
  if (s === undefined) fail('EMPTY_ID', path, `${path} must be a non-empty string`);
  return s;
}

function requireRoleKind(value: unknown, path: string): RoleDefinition['kind'] {
  if (typeof value !== 'string' || !ROLE_KINDS.includes(value as RoleDefinition['kind'])) {
    fail('INVALID_CONFIG', path, `${path} must be one of: ${ROLE_KINDS.join(', ')}`);
  }
  return value as RoleDefinition['kind'];
}

function requireNonEmptyStringArray(value: unknown, path: string): readonly string[] {
  if (!isNonEmptyStringArray(value)) {
    fail('INVALID_CONFIG', path, `${path} must be an array of non-empty strings`);
  }
  return value;
}

function requireUniqueId(ids: Set<string>, id: string, path: string): void {
  if (ids.has(id)) fail('DUPLICATE_ID', path, `duplicate id "${truncateForMessage(id)}" at ${path}`);
  ids.add(id);
}

/**
 * Validates an unknown config value and returns an immutable Catalog.
 *
 * Rejects at construction time: unknown fields, empty IDs, duplicate IDs
 * (role IDs, model profile IDs, one route per worker role), unknown references
 * (route → role, route → model profile), defaults outside the allowlist,
 * and worker roles without a route. Construction is side-effect free: the
 * caller's config (including its arrays) is copied, never mutated or frozen.
 * Never falls back silently; never performs I/O.
 */
export function createCatalog(input: unknown): Catalog {
  const root = requireObject(input, 'config');
  requireExactFields(root, CONFIG_FIELDS, 'config');

  const roleInputs = requireArray(ownValue(root, 'roles'), 'config.roles');
  if (roleInputs.length === 0) fail('INVALID_CONFIG', 'config.roles', 'config.roles must not be empty');

  const roles: RoleDefinition[] = [];
  const roleIds = new Set<string>();
  for (let i = 0; i < roleInputs.length; i++) {
    const path = `config.roles[${i}]`;
    const raw = requireObject(roleInputs[i], path);
    requireExactFields(raw, ROLE_FIELDS, path);
    const id = requireString(ownValue(raw, 'id'), `${path}.id`);
    requireUniqueId(roleIds, id, `${path}.id`);
    roles.push({
      id,
      description: requireString(ownValue(raw, 'description'), `${path}.description`),
      kind: requireRoleKind(ownValue(raw, 'kind'), `${path}.kind`),
      // Copied: the catalog must never freeze or alias caller-owned arrays.
      tools: [...requireNonEmptyStringArray(ownValue(raw, 'tools'), `${path}.tools`)],
    });
  }

  const modelInputs = requireArray(ownValue(root, 'models'), 'config.models');
  const models: ModelProfile[] = [];
  const modelProfileIds = new Set<string>();
  for (let i = 0; i < modelInputs.length; i++) {
    const path = `config.models[${i}]`;
    const raw = requireObject(modelInputs[i], path);
    requireExactFields(raw, MODEL_FIELDS, path);
    const id = requireString(ownValue(raw, 'id'), `${path}.id`);
    requireUniqueId(modelProfileIds, id, `${path}.id`);
    models.push({
      id,
      provider: requireString(ownValue(raw, 'provider'), `${path}.provider`),
      model: requireString(ownValue(raw, 'model'), `${path}.model`),
    });
  }

  const routes: ModelRoute[] = [];
  const routedRoleIds = new Set<string>();
  const routeInputs = requireArray(ownValue(root, 'routes'), 'config.routes');
  for (let i = 0; i < routeInputs.length; i++) {
    const path = `config.routes[${i}]`;
    const raw = requireObject(routeInputs[i], path);
    requireExactFields(raw, ROUTE_FIELDS, path);
    const roleId = requireString(ownValue(raw, 'roleId'), `${path}.roleId`);
    if (!roleIds.has(roleId)) {
      fail('UNKNOWN_REFERENCE', `${path}.roleId`, `route references unknown role "${truncateForMessage(roleId)}"`);
    }
    requireUniqueId(routedRoleIds, roleId, `${path}.roleId`);
    const defaultProfile = requireString(ownValue(raw, 'defaultProfile'), `${path}.defaultProfile`);
    // Copied: the catalog must never freeze or alias caller-owned arrays.
    const allowedProfiles = [...requireNonEmptyStringArray(ownValue(raw, 'allowedProfiles'), `${path}.allowedProfiles`)];
    for (const [j, profile] of allowedProfiles.entries()) {
      if (!modelProfileIds.has(profile)) {
        fail(
          'UNKNOWN_REFERENCE',
          `${path}.allowedProfiles[${j}]`,
          `allowed profile "${truncateForMessage(profile)}" is not a registered model profile`,
        );
      }
    }
    if (!allowedProfiles.includes(defaultProfile)) {
      fail(
        'DEFAULT_NOT_ALLOWED',
        `${path}.defaultProfile`,
        `default profile "${truncateForMessage(defaultProfile)}" is not in allowedProfiles`,
      );
    }
    routes.push({ roleId, defaultProfile, allowedProfiles });
  }

  for (const role of roles) {
    if (role.kind === 'worker' && !routedRoleIds.has(role.id)) {
      fail('UNKNOWN_REFERENCE', 'config.routes', `worker role "${role.id}" has no model route`);
    }
  }

  const config: CatalogConfig = deepFreeze({ roles, models, routes });
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const modelById = new Map(models.map((model) => [model.id, model]));
  const routeByRoleId = new Map(routes.map((route) => [route.roleId, route]));

  return deepFreeze({
    roleIds: roles.map((role) => role.id),
    modelProfileIds: models.map((model) => model.id),
    workerRoleIds: roles.filter((role) => role.kind === 'worker').map((role) => role.id),
    getRole: (id: string) => roleById.get(id),
    getModelProfile: (id: string) => modelById.get(id),
    getRoute: (roleId: string) => {
      const route = routeByRoleId.get(roleId);
      if (route === undefined) {
        throw new CatalogConfigError({
          code: 'UNKNOWN_REFERENCE',
          message: `no route for role "${truncateForMessage(roleId)}"`,
          path: 'config.routes',
        });
      }
      return route;
    },
    snapshot: () => config,
  });
}
