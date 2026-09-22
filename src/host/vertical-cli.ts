import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCatalog } from '../core/catalog.ts';
import type { CatalogConfig } from '../core/contracts.ts';
import { createDefaultRoleBases, createDefaultRoleManifests } from './runtime-manifests.ts';
import { createRealVerticalSlice, isValidGitObjectId, normalizeGitObjectId, BASE_REVISION_REJECTION, VerticalSliceCoordinator, type VerticalSliceConfig, type VerticalSliceDependencies } from './vertical-slice.ts';

const FORBIDDEN_CONFIG_KEYS = new Set(['credential', 'credentials', 'token', 'password', 'apiKey', 'secret', 'auth']);

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function rejectCredentials(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) { for (const [index, entry] of value.entries()) rejectCredentials(entry, `${path}[${index}]`); return; }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) throw new Error(`${path}.${key} must not contain credentials`);
    rejectCredentials(entry, `${path}.${key}`);
  }
}

export function parseVerticalConfig(input: unknown, planFile?: string): VerticalSliceConfig {
  rejectCredentials(input);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('config must be a JSON object');
  const raw = input as Record<string, unknown>;
  const repoRoot = raw.repoRoot;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('config.repoRoot is required');
  if (!isValidGitObjectId(raw.baseRevision)) throw new Error(`config.${BASE_REVISION_REJECTION}`);
  const catalogRaw = raw.catalog;
  if (typeof catalogRaw !== 'object' || catalogRaw === null || Array.isArray(catalogRaw)) throw new Error('config.catalog is required');
  const catalog = createCatalog(catalogRaw as CatalogConfig);
  const herdr = raw.herdr;
  if (typeof herdr !== 'object' || herdr === null || Array.isArray(herdr)) throw new Error('config.herdr is required');
  const snapshot = catalog.snapshot();
  const defaultManifests = createDefaultRoleManifests(snapshot.roles);
  const defaultBases = createDefaultRoleBases(snapshot.roles.map((role) => role.id), resolve(repoRoot));
  const rawHerdr = herdr as Record<string, unknown>;
  const explicitManifests = rawHerdr.roleManifests;
  const explicitBases = rawHerdr.roleBases;
  if (explicitManifests !== undefined && (typeof explicitManifests !== 'object' || explicitManifests === null || Array.isArray(explicitManifests))) throw new Error('config.herdr.roleManifests must be an object');
  if (explicitBases !== undefined && (typeof explicitBases !== 'object' || explicitBases === null || Array.isArray(explicitBases))) throw new Error('config.herdr.roleBases must be an object');
  const normalizedHerdr = { ...rawHerdr, roleManifests: { ...defaultManifests, ...(explicitManifests as Record<string, unknown> | undefined) }, roleBases: { ...defaultBases, ...(explicitBases as Record<string, string> | undefined) } };
  const result = { ...raw, baseRevision: normalizeGitObjectId(raw.baseRevision as string), catalog, herdr: normalizedHerdr, verificationAllowlist: raw.verificationAllowlist ?? ['npm run check'], verificationTimeoutMs: raw.verificationTimeoutMs ?? 300_000, ...(planFile === undefined ? {} : { planFile }) } as unknown as VerticalSliceConfig;
  return result;
}

export async function runVerticalCli(args: readonly string[], dependencies: VerticalSliceDependencies = {}): Promise<{ readonly summary: Awaited<ReturnType<VerticalSliceCoordinator['run']>>; readonly exitCode: number }> {
  if (args[0] !== 'run') throw new Error('usage: run --config <json> [--plan-file <json>]');
  const configPath = flag(args, '--config');
  if (configPath === undefined) throw new Error('missing --config');
  const planFile = flag(args, '--plan-file');
  const config = parseVerticalConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown, planFile);
  const coordinator = Object.keys(dependencies).length === 0 ? createRealVerticalSlice(config) : new VerticalSliceCoordinator(config, dependencies);
  const onSignal = (): void => coordinator.cancel('SIGINT');
  process.once('SIGINT', onSignal);
  let summary: Awaited<ReturnType<VerticalSliceCoordinator['run']>>;
  try { summary = await coordinator.run(); }
  finally { process.removeListener('SIGINT', onSignal); }
  return { summary, exitCode: summary.status === 'passed' ? 0 : 1 };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runVerticalCli(argv);
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1]?.endsWith('/src/host/vertical-cli.ts') === true || process.argv[1]?.endsWith('src/host/vertical-cli.ts') === true) {
  void main().catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'vertical run failed' })}\n`); process.exitCode = 1; });
}
