/**
 * Fail-closed check that a Pier role profile is read-only before a reviewer is
 * dispatched with it. Pier treats an unknown role name as a display label with
 * default worker tools, and `allowed_tools` can widen a toolset unless the role
 * explicitly denies a tool, so every mutating tool must carry a `deny` rule.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MUTATING_TOOLS: readonly string[] = Object.freeze(['edit', 'write', 'bash', 'pwsh', 'subagent', 'terminal']);
const RESERVED = ['master', 'worker-default'];
const ROLE_NAME = /^[a-z0-9-]+$/;

export type RoleCheck = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly reason: string };

/** Pier's lookup order: `<masterCwd>/.pi-herdr/roles`, then the user-global roles dir. */
export function defaultPierRoleDirs(masterCwd: string): readonly string[] {
  return [join(masterCwd, '.pi-herdr', 'roles'), join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles')];
}

export function checkReadOnlyRole(roleDirs: readonly string[], role: string): RoleCheck {
  if (!ROLE_NAME.test(role) || RESERVED.includes(role)) return { ok: false, reason: `role name "${role}" is invalid or reserved` };
  const file = roleDirs.map((dir) => join(dir, `${role}.json`)).find((candidate) => existsSync(candidate));
  if (file === undefined) return { ok: false, reason: `role "${role}" was not found in ${roleDirs.join(', ')}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: `role file ${file} is not valid JSON` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: `role file ${file} is not an object` };
  const root = parsed as Record<string, unknown>;
  if (root.role !== role) return { ok: false, reason: `role file ${file} declares role "${String(root.role)}"` };
  const manifest = root.manifest as Record<string, unknown> | undefined;
  if (typeof manifest !== 'object' || manifest === null) return { ok: false, reason: `role file ${file} has no manifest` };
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  const rules = typeof manifest.rules === 'object' && manifest.rules !== null ? manifest.rules as Record<string, unknown> : {};
  const granted = MUTATING_TOOLS.filter((tool) => tools.includes(tool));
  if (granted.length > 0) return { ok: false, reason: `role "${role}" grants mutating tools: ${granted.join(', ')}` };
  const undenied = MUTATING_TOOLS.filter((tool) => rules[tool] !== 'deny');
  if (undenied.length > 0) return { ok: false, reason: `role "${role}" must explicitly deny: ${undenied.join(', ')}` };
  return { ok: true, file };
}
