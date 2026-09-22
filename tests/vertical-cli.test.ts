import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog } from '../src/core/catalog.ts';
import { FakeExecutor, type ExecutorStartRequest } from '../src/core/executor-port.ts';
import type { IntegrationRunner } from '../src/core/integration.ts';
import type { VerificationRunner } from '../src/core/verification.ts';
import type { WorktreePort } from '../src/adapters/worktree-manager.ts';
import { parseVerticalConfig, runVerticalCli } from '../src/host/vertical-cli.ts';
import { VerticalSliceCoordinator, type VerticalHost } from '../src/host/vertical-slice.ts';
import { fixtureConfig, FULL_BASE_SHA, PROFILE_FAST, PROFILE_SLASH } from './fixtures.ts';

const port: WorktreePort = { create: () => undefined, bindSession: () => undefined, inspectChangedPaths: () => undefined, verifyOwnership: () => undefined, remove: () => undefined };
const host: VerticalHost = { herdr: {} as never, worktree: port, createVerificationRunner: (): VerificationRunner => ({ run: () => ({ exitCode: 0, timedOut: false, output: 'ok' }) }), readArtifactDiff: () => 'diff --git a/src/x b/src/x\n+ok' }; 
const integration: IntegrationRunner = { gitOps: { rebase: (_base, unit) => ({ ok: true, revision: unit.revision, details: 'ok' }), merge: () => ({ ok: true, revision: 'final', details: 'ok' }), conflicts: () => ({ conflicts: [] }), status: () => ({ revision: 'final', clean: true, details: 'clean' }) }, commandRunner: { run: () => ({ exitCode: 0, timedOut: false, output: 'ok' }) } };

function rawConfig(root: string): Record<string, unknown> {
  return { repoRoot: root, workspaceRoot: join(root, 'workspaces'), baseRevision: FULL_BASE_SHA, userTask: 'single task', catalog: fixtureConfig(), plannerRoleId: 'planner', implementerRoleId: 'implementer', reviewerRoleId: 'reviewer', plannerModelProfileId: PROFILE_FAST, implementerModelProfileId: PROFILE_SLASH, reviewerModelProfileId: PROFILE_FAST, verificationAllowlist: ['final'], verificationTimeoutMs: 1000, herdr: { herdrBinary: 'fake', piExtension: 'fake', provider: 'fixture', model: 'fixture', workspaceId: 'fake', roleManifests: {}, roleBases: {}, timeouts: { startMs: 1, promptMs: 1, probeMs: 1 } }, concurrency: 1, pollIntervalMs: 1, runTimeoutMs: 1000, reviewerStrategy: 'never', finalOutputDir: root };
}

describe('vertical CLI', () => {
  it('injects valid default manifests and absolute repo-root role bases when config leaves them empty', () => {
    const config = parseVerticalConfig(rawConfig('/repo'));
    const plannerManifest = config.herdr.roleManifests[config.plannerRoleId] as { role?: string };
    const reviewerManifest = config.herdr.roleManifests[config.reviewerRoleId] as { version?: string };
    assert.equal(plannerManifest.role, config.plannerRoleId);
    assert.equal(reviewerManifest.version, '1.0.0');
    assert.deepEqual(config.herdr.roleBases, { coordinator: '/repo', explorer: '/repo', implementer: '/repo', reviewer: '/repo', planner: '/repo' });
    assert.deepEqual(config.verificationAllowlist, ['final']);
  });

  it('rejects explicit relative role bases and out-of-range plannerRetries at coordinator validation', () => {
    const relative = rawConfig('/repo');
    (relative.herdr as Record<string, unknown>).roleBases = { implementer: 'relative/base' };
    assert.throws(() => new VerticalSliceCoordinator(parseVerticalConfig(relative), {}), /absolute role base/);
    const retries = rawConfig('/repo');
    (retries as Record<string, unknown>).plannerRetries = 3;
    assert.throws(() => new VerticalSliceCoordinator(parseVerticalConfig(retries), {}), /plannerRetries/);
  });

  it('rejects mutable base revisions at config parse and normalizes accepted hex object ids', () => {
    for (const bad of ['HEAD', 'main', 'v1.0.0', FULL_BASE_SHA.slice(0, 12), `${FULL_BASE_SHA}~1`, '   ', '', `origin/${FULL_BASE_SHA}`]) {
      const raw = rawConfig('/repo');
      raw.baseRevision = bad;
      assert.throws(() => parseVerticalConfig(raw), /rev-parse/);
    }
    const upper = rawConfig('/repo');
    upper.baseRevision = FULL_BASE_SHA.toUpperCase();
    assert.equal(parseVerticalConfig(upper).baseRevision, FULL_BASE_SHA);
  });

  it('rejects a HEAD base revision before any planner pane or executor is created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-cli-base-'));
    try {
      const configPath = join(root, 'config.json');
      const raw = rawConfig(root);
      raw.baseRevision = 'HEAD';
      writeFileSync(configPath, JSON.stringify(raw));
      let plannerCalls = 0;
      const planner = { plan: () => { plannerCalls++; return {}; }, cancel: () => undefined };
      await assert.rejects(runVerticalCli(['run', '--config', configPath], { planner }), /rev-parse/);
      assert.equal(plannerCalls, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels a planner on SIGINT without creating a worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-sigint-planner-'));
    try {
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify(rawConfig(root)));
      let cancelled = false;
      let release!: (value: unknown) => void;
      const plan = { version: 1, executionMode: 'single', tasks: [{ id: 'Tsignal', objective: 'wait', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: [] }], finalVerification: ['final'] };
      const planner = { plan: () => new Promise<unknown>((resolve) => { release = resolve; setImmediate(() => process.emit('SIGINT')); }), cancel: () => { cancelled = true; release(plan); } };
      const result = await runVerticalCli(['run', '--config', configPath], { planner, runId: 'sigint-planner', clock: () => 0, sleep: async () => undefined });
      assert.equal(result.summary.status, 'failed');
      assert.equal(cancelled, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('cancels a running worker on SIGINT and invokes executor cancel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-sigint-worker-'));
    try {
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify(rawConfig(root)));
      const executor = new FakeExecutor({ defaultSteps: [{ status: 'pending' }] });
      let signalled = false;
      const planner = { plan: () => ({ version: 1, executionMode: 'single', tasks: [{ id: 'Tsignal-worker', objective: 'wait', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: [] }], finalVerification: ['final'] }) };
      const result = await runVerticalCli(['run', '--config', configPath], { planner, executor, host, runId: 'sigint-worker', clock: () => 0, sleep: async () => { if (!signalled) { signalled = true; process.emit('SIGINT'); } } });
      assert.equal(result.summary.status, 'failed');
      assert.equal(executor.cancelCalls.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('parses config and returns the final verification exit path using only fakes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-cli-'));
    try {
      const configPath = join(root, 'config.json'); const planPath = join(root, 'plan.json');
      writeFileSync(configPath, JSON.stringify(rawConfig(root)));
      writeFileSync(planPath, JSON.stringify({ version: 1, executionMode: 'single', tasks: [{ id: 'Tcli', objective: 'do it', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: [] }], finalVerification: ['final'] }));
      const executor = new FakeExecutor((request: ExecutorStartRequest) => [{ status: 'settled', outcome: 'completed', settlement: { conclusion: 'completed', acceptanceEligible: true, artifact: { artifactRevision: 'worker', workspacePath: join(root, 'worker'), branch: 'worker/branch', changedPaths: [], clean: true, commitsAhead: 1 } } }]);
      const result = await runVerticalCli(['run', '--config', configPath, '--plan-file', planPath], { executor, host, integrationRunner: integration, runId: 'cli-fake', clock: () => 0, sleep: async () => undefined });
      assert.equal(result.exitCode, 0); assert.equal(result.summary.status, 'passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
