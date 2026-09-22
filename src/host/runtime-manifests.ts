import { isAbsolute, normalize } from 'node:path';
import type { RoleDefinition } from '../core/contracts.ts';

export type RuntimePermission = 'allow' | 'ask' | 'deny';
export interface RuntimeManifest {
  readonly role: string;
  readonly version: '1.0.0';
  readonly tools: readonly string[];
  readonly permissions: Readonly<Record<string, RuntimePermission>>;
  readonly unknownTools: 'allow' | 'deny';
  readonly services?: { readonly todos?: { readonly mode: 'serial' | 'parallel' } };
  readonly guidelines: readonly string[];
}

const COMMON_PERMISSIONS: Readonly<Record<string, RuntimePermission>> = Object.freeze({
  read: 'allow', todo_write: 'allow', ask_user_question: 'allow',
  bash: 'deny', edit: 'deny', write: 'deny', subagent: 'deny', terminal: 'deny',
});
const IMPLEMENTER_PERMISSIONS: Readonly<Record<string, RuntimePermission>> = Object.freeze({
  ...COMMON_PERMISSIONS, bash: 'allow', edit: 'allow', write: 'allow',
});

/** Build the exact runtime policy shape for one catalog role. */
export function createDefaultRuntimeManifest(role: Pick<RoleDefinition, 'id' | 'kind'>): RuntimeManifest {
  const plannerLike = role.id === 'planner' || role.kind === 'coordinator';
  const reviewer = role.id === 'reviewer';
  const tools = plannerLike || reviewer
    ? ['read', 'todo_write', 'ask_user_question']
    : role.id === 'implementer'
      ? ['read', 'bash', 'edit', 'write', 'todo_write', 'ask_user_question']
      : ['read', 'todo_write', 'ask_user_question'];
  const permissions = role.id === 'implementer' ? IMPLEMENTER_PERMISSIONS : COMMON_PERMISSIONS;
  const guidelines = plannerLike
    ? ['Inspect read-only first.', 'Return exact JSON only.']
    : reviewer
      ? ['Review only the supplied spec, diff, and evidence.', 'Do not execute or edit files.']
      : role.id === 'implementer'
        ? ['Commit the implementation.', 'Never push.', 'Do not spawn subagents or control terminals.']
        : ['Use only the assigned scope.'];
  return Object.freeze({ role: role.id, version: '1.0.0', tools: Object.freeze([...tools]), permissions, unknownTools: 'deny', services: Object.freeze({ todos: Object.freeze({ mode: 'serial' as const }) }), guidelines: Object.freeze([...guidelines]) });
}

export function createDefaultRoleManifests(roles: readonly Pick<RoleDefinition, 'id' | 'kind'>[]): Readonly<Record<string, RuntimeManifest>> {
  return Object.freeze(Object.fromEntries(roles.map((role) => [role.id, createDefaultRuntimeManifest(role)])));
}

/**
 * Role bases are directories used for role resolution (exported to Herdr as
 * PI_HERDR_ROLE_BASE). They are never descriptive prompt text; the default is
 * the absolute normalized base directory (normally the repository root).
 */
export function createDefaultRoleBases(roleIds: readonly string[], baseDirectory: string): Readonly<Record<string, string>> {
  if (typeof baseDirectory !== 'string' || baseDirectory.length === 0 || !isAbsolute(baseDirectory)) throw new TypeError('role base directory must be a non-empty absolute path');
  const base = normalize(baseDirectory);
  return Object.freeze(Object.fromEntries(roleIds.map((roleId) => [roleId, base])));
}

export const RUNTIME_MANIFESTS: Readonly<Record<string, RuntimeManifest>> = createDefaultRoleManifests([
  { id: 'coordinator', kind: 'coordinator' }, { id: 'planner', kind: 'worker' },
  { id: 'implementer', kind: 'worker' }, { id: 'reviewer', kind: 'worker' },
]);

export function validateRuntimeManifest(value: unknown, roleId: string): value is RuntimeManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const allowed = new Set(['role', 'version', 'tools', 'permissions', 'unknownTools', 'services', 'guidelines']);
  if (Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !allowed.has(key))) return false;
  if (raw.role !== roleId || raw.version !== '1.0.0' || !Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.some((tool) => typeof tool !== 'string' || tool.length === 0)) return false;
  if (raw.unknownTools !== 'allow' && raw.unknownTools !== 'deny') return false;
  if (typeof raw.permissions !== 'object' || raw.permissions === null || Array.isArray(raw.permissions)) return false;
  if (Object.values(raw.permissions as Record<string, unknown>).some((permission) => permission !== 'allow' && permission !== 'ask' && permission !== 'deny')) return false;
  if (raw.services !== undefined) {
    if (typeof raw.services !== 'object' || raw.services === null || Array.isArray(raw.services)) return false;
    const todos = (raw.services as Record<string, unknown>).todos;
    if (todos !== undefined && (typeof todos !== 'object' || todos === null || Array.isArray(todos) || (todos as Record<string, unknown>).mode !== 'serial' && (todos as Record<string, unknown>).mode !== 'parallel')) return false;
  }
  if (!Array.isArray(raw.guidelines) || raw.guidelines.length === 0 || raw.guidelines.some((guideline) => typeof guideline !== 'string' || guideline.length === 0)) return false;
  return true;
}
