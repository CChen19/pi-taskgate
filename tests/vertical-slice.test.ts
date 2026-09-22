import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCatalog } from '../src/core/catalog.ts';
import { FakeExecutor, type AttemptSettlement, type ExecutorStartRequest, type AttemptHandle, type ExecutorPort } from '../src/core/executor-port.ts';
import type { VerificationRunner } from '../src/core/verification.ts';
import type { ReviewBrief } from '../src/core/reviewer-brief.ts';
import { fixtureConfig, FULL_BASE_SHA, PROFILE_FAST, PROFILE_SLASH } from './fixtures.ts';
import { StructuredPlanner, VerticalSliceCoordinator, type VerticalHost } from '../src/host/vertical-slice.ts';
import { StructuredAgentRunner } from '../src/host/structured-agent-runner.ts';
import type { HerdrSpawnRequest } from '../src/adapters/pi-herdr-executor.ts';
import type { WorktreePort } from '../src/adapters/worktree-manager.ts';
import type { IntegrationRunner } from '../src/core/integration.ts';
import { createDefaultRoleManifests, createDefaultRoleBases } from '../src/host/runtime-manifests.ts';

const noWorktree: WorktreePort = { create: () => { throw new Error('not used'); }, bindSession: () => undefined, inspectChangedPaths: () => undefined, verifyOwnership: () => undefined, remove: () => undefined };
const configBase = {
  repoRoot: '/repo', workspaceRoot: '/tmp/ao-vertical-workspaces', baseRevision: FULL_BASE_SHA, userTask: 'implement two things', catalog: createCatalog(fixtureConfig()),
  plannerRoleId: 'planner', implementerRoleId: 'implementer', reviewerRoleId: 'reviewer', plannerModelProfileId: PROFILE_FAST, implementerModelProfileId: PROFILE_SLASH, reviewerModelProfileId: PROFILE_FAST,
  verificationAllowlist: ['check', 'final', 'final-check'], verificationTimeoutMs: 1000,
  herdr: { herdrBinary: 'fake', piExtension: 'fake', provider: 'fixture', model: 'fixture', workspaceId: 'fake', roleManifests: createDefaultRoleManifests([{ id: 'planner', kind: 'worker' }, { id: 'implementer', kind: 'worker' }, { id: 'reviewer', kind: 'worker' }]), roleBases: createDefaultRoleBases(['planner', 'implementer', 'reviewer'], '/repo'), timeouts: { startMs: 1, promptMs: 1, probeMs: 1 } },
  concurrency: 2, pollIntervalMs: 1, runTimeoutMs: 1000, reviewerStrategy: 'always' as const, finalOutputDir: '/tmp/ao-vertical-test',
};

class FinalizableExecutor implements ExecutorPort {
  readonly inner: FakeExecutor;
  readonly finalized: string[] = [];
  constructor() {
    this.inner = new FakeExecutor((request: ExecutorStartRequest) => [{ status: 'settled', outcome: 'completed', settlement: settlement(request.taskId) }]);
  }
  start(request: ExecutorStartRequest): AttemptHandle { return this.inner.start(request); }
  finalizeArtifact(taskId: string, attemptId: string): { ok: true } { this.finalized.push(`${taskId}/${attemptId}`); return { ok: true }; }
}
function settlement(taskId: string): AttemptSettlement {
  const safe = taskId.toLowerCase();
  return { conclusion: 'completed', acceptanceEligible: true, artifact: { artifactRevision: `rev-${safe}`, workspacePath: `/workspaces/${safe}`, branch: `branch/${safe}`, changedPaths: [], clean: true, commitsAhead: 1 } };
}
function host(cwds: string[]): VerticalHost {
  return { herdr: {} as never, worktree: noWorktree, createVerificationRunner: (workspacePath: string): VerificationRunner => ({ run: () => { cwds.push(workspacePath); return { exitCode: 0, timedOut: false, output: 'ok' }; } }), readArtifactDiff: () => 'diff --git a/src/x b/src/x\n+ok' };
}
function integration(conflict = false): IntegrationRunner {
  return { gitOps: {
    rebase: (_base, unit) => ({ ok: true, revision: unit.revision, details: 'ok' }),
    merge: (unit) => conflict && unit.taskId === 'Tsecond' ? { ok: false, details: 'conflict' } : { ok: true, revision: `merged-${unit.taskId}`, details: 'ok' },
    conflicts: () => ({ conflicts: conflict ? ['src/conflict.ts'] : [] }), status: () => ({ revision: 'merged-Tsecond', clean: true, details: 'clean' }),
  }, commandRunner: { run: () => ({ exitCode: 0, timedOut: false, output: 'ok' }) } };
}

describe('vertical slice coordinator', () => {
  it('runs independent tasks concurrently, reviews exact revisions, integrates, and retains final artifact', async () => {
    const cwds: string[] = [];
    const executor = new FinalizableExecutor();
    const plan = { version: 1, executionMode: 'plan', tasks: [
      { id: 'Tfirst', objective: 'first', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['first done'], verification: ['check'] },
      { id: 'Tsecond', objective: 'second', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['second done'], verification: ['check'] },
    ], finalVerification: ['final-check'] } as const;
    const reviewed: Array<{ revision: string; patch: string | undefined; cwd: string }> = [];
    const coordinator = new VerticalSliceCoordinator(configBase, {
      executor, host: { ...host(cwds), readArtifactDiff: (_workspacePath, base, revision) => { assert.equal(base, FULL_BASE_SHA); return `patch for ${revision}`; } }, planner: { plan: () => plan }, reviewer: { review: (brief, context) => { reviewed.push({ revision: brief.diff.artifactRevision, patch: brief.diff.patch, cwd: context.workspacePath }); return { outcome: 'passed', reasons: ['looks good'], artifactRevision: brief.diff.artifactRevision }; } }, integrationRunner: integration(), runId: 'run-fake', clock: () => 0, sleep: async () => undefined,
    });
    const result = await coordinator.run();
    assert.equal(result.status, 'passed');
    assert.equal(result.taskResults.length, 2);
    assert.deepEqual(new Set(reviewed.map((entry) => entry.revision)), new Set(['rev-tfirst', 'rev-tsecond']));
    assert.deepEqual(new Set(reviewed.map((entry) => entry.patch)), new Set(['patch for rev-tfirst', 'patch for rev-tsecond']));
    assert.deepEqual(new Set(reviewed.map((entry) => entry.cwd)), new Set(['/workspaces/tfirst', '/workspaces/tsecond']));
    assert.deepEqual(new Set(cwds), new Set(['/workspaces/tfirst', '/workspaces/tsecond']));
    assert.equal(result.integration?.outcome, 'merged');
    assert.equal(result.finalRevision, 'merged-Tsecond');
    assert.equal(executor.finalized.length, 2);
  });

  it('rejects planner verification escalation before executor start', async () => {
    const executor = new FakeExecutor(() => [{ status: 'settled', outcome: 'completed', settlement: settlement('Tbad-plan') }]);
    const coordinator = new VerticalSliceCoordinator(configBase, { executor, host: host([]), planner: { plan: () => ({ version: 1, executionMode: 'single', tasks: [{ id: 'Tbad-plan', objective: 'bad', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['bad'], verification: ['forbidden'] }], finalVerification: ['final'] }) }, integrationRunner: integration(), runId: 'run-allowlist', clock: () => 0, sleep: async () => undefined });
    const result = await coordinator.run();
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /not authorized/);
    assert.equal(executor.startCalls.length, 0);
  });

  it('cancels a running worker on coordinator cancellation', async () => {
    const executor = new FakeExecutor({ defaultSteps: [{ status: 'pending' }] });
    let coordinator!: VerticalSliceCoordinator;
    let slept = false;
    coordinator = new VerticalSliceCoordinator({ ...configBase, reviewerStrategy: 'never' }, { executor, host: host([]), planner: { plan: () => ({ version: 1, executionMode: 'single', tasks: [{ id: 'Tcancel', objective: 'wait', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['wait'], verification: [] }], finalVerification: ['final'] }) }, integrationRunner: integration(), runId: 'run-cancel', clock: () => 0, sleep: async () => { if (!slept) { slept = true; coordinator.cancel('test cancel'); } } });
    const result = await coordinator.run();
    assert.equal(result.status, 'failed');
    assert.equal(executor.cancelCalls.length, 1);
  });

  it('does not review or merge a mechanical failure and retains conflict integration', async () => {
    const badExecutor = new FakeExecutor((request) => [{ status: 'settled', outcome: 'completed', settlement: settlement(request.taskId) }]);
    let verifyCalls = 0; let reviewCalls = 0; let mergeCalls = 0;
    const badHost: VerticalHost = { ...host([]), createVerificationRunner: () => ({ run: () => { verifyCalls++; return { exitCode: 1, timedOut: false, output: 'bad' }; } }) };
    const bad = new VerticalSliceCoordinator({ ...configBase, reviewerStrategy: 'always' }, { executor: badExecutor, host: badHost, planner: { plan: () => ({ version: 1, executionMode: 'single', tasks: [{ id: 'Tbad', objective: 'bad', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['bad'], verification: ['check'] }], finalVerification: ['final'] }) }, reviewer: { review: () => { reviewCalls++; return { outcome: 'passed', reasons: ['x'], artifactRevision: 'no' }; } }, integrationRunner: { ...integration(), gitOps: { ...integration().gitOps, merge: () => { mergeCalls++; return { ok: true, revision: 'x' }; } } }, runId: 'run-bad', clock: () => 0, sleep: async () => undefined });
    const failed = await bad.run();
    assert.equal(failed.status, 'failed');
    assert.equal(verifyCalls, 1); assert.equal(reviewCalls, 0); assert.equal(mergeCalls, 0);

    const conflictExecutor = new FinalizableExecutor();
    const conflict = new VerticalSliceCoordinator(configBase, { executor: conflictExecutor, host: host([]), planner: { plan: () => ({ version: 1, executionMode: 'plan', tasks: [
      { id: 'Tfirst', objective: 'first', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['ok'], verification: [] },
      { id: 'Tsecond', objective: 'second', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['ok'], verification: [] },
    ], finalVerification: ['final'] }) }, reviewer: { review: (brief) => ({ outcome: 'passed', reasons: ['ok'], artifactRevision: brief.diff.artifactRevision }) }, integrationRunner: integration(true), runId: 'run-conflict', clock: () => 0, sleep: async () => undefined });
    const conflicted = await conflict.run();
    assert.equal(conflicted.status, 'failed'); assert.equal(conflicted.integration?.outcome, 'conflict'); assert.equal(conflictExecutor.finalized.length, 0);
  });
});

const singleTaskPlan = (id: string) => ({ version: 1, executionMode: 'single' as const, tasks: [{ id, objective: `do ${id}`, depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: ['check'] }], finalVerification: ['final'] });

describe('coordinator config boundaries', () => {
  const invalid: ReadonlyArray<readonly [string, (config: typeof configBase) => unknown, RegExp]> = [
    ['a non-absolute role base', (config) => ({ ...config, herdr: { ...config.herdr, roleBases: { ...config.herdr.roleBases, implementer: 'relative/base' } } }), /absolute role base/],
    ['an empty role base', (config) => ({ ...config, herdr: { ...config.herdr, roleBases: { ...config.herdr.roleBases, planner: '' } } }), /absolute role base/],
    ['an unknown reviewer strategy', (config) => ({ ...config, reviewerStrategy: 'sometimes' as unknown as typeof configBase.reviewerStrategy }), /reviewerStrategy/],
    ['a negative plannerRetries', (config) => ({ ...config, plannerRetries: -1 }), /plannerRetries/],
    ['a too-large plannerRetries', (config) => ({ ...config, plannerRetries: 3 }), /plannerRetries/],
    ['a fractional plannerRetries', (config) => ({ ...config, plannerRetries: 1.5 }), /plannerRetries/],
    ['a duplicate verification allowlist entry', (config) => ({ ...config, verificationAllowlist: ['check', 'final', 'check'] }), /duplicate/],
    ['a blank verification allowlist entry', (config) => ({ ...config, verificationAllowlist: ['check', '   '] }), /verificationAllowlist/],
    ['a HEAD base revision', (config) => ({ ...config, baseRevision: 'HEAD' }), /rev-parse/],
    ['a branch-name base revision', (config) => ({ ...config, baseRevision: 'main' }), /rev-parse/],
    ['a tag base revision', (config) => ({ ...config, baseRevision: 'v1.0.0' }), /rev-parse/],
    ['a short-SHA base revision', (config) => ({ ...config, baseRevision: FULL_BASE_SHA.slice(0, 12) }), /rev-parse/],
    ['a revspec base revision', (config) => ({ ...config, baseRevision: `${FULL_BASE_SHA}~1` }), /rev-parse/],
    ['a blank base revision', (config) => ({ ...config, baseRevision: '   ' }), /rev-parse/],
  ];
  for (const [label, mutate, pattern] of invalid) {
    it(`rejects ${label} before any pane or worktree exists`, () => {
      assert.throws(() => new VerticalSliceCoordinator(mutate(configBase) as typeof configBase, {}), pattern);
    });
  }
  it('accepts plannerRetries within the 0..2 boundary', () => {
    for (const plannerRetries of [0, 1, 2]) {
      assert.doesNotThrow(() => new VerticalSliceCoordinator({ ...configBase, plannerRetries }, {}));
    }
  });
  it('accepts complete immutable object ids in either case and both SHA lengths', () => {
    assert.doesNotThrow(() => new VerticalSliceCoordinator({ ...configBase, baseRevision: FULL_BASE_SHA.toUpperCase() }, {}));
    assert.doesNotThrow(() => new VerticalSliceCoordinator({ ...configBase, baseRevision: `${FULL_BASE_SHA}${FULL_BASE_SHA.slice(0, 24)}` }, {}));
  });
});

describe('vertical acceptance matrix', () => {
  it('blocks merge and cleans the artifact when the reviewer explicitly rejects', async () => {
    const executor = new FinalizableExecutor();
    let verifyCalls = 0; let mergeCalls = 0;
    const reviewedHost: VerticalHost = { ...host([]), createVerificationRunner: () => ({ run: () => { verifyCalls++; return { exitCode: 0, timedOut: false, output: 'ok' }; } }) };
    const coordinator = new VerticalSliceCoordinator(configBase, { executor, host: reviewedHost, planner: { plan: () => singleTaskPlan('Treviewed') }, reviewer: { review: (brief: ReviewBrief) => ({ outcome: 'rejected', reasons: ['does not satisfy acceptance criteria'], artifactRevision: brief.diff.artifactRevision }) }, integrationRunner: { ...integration(), gitOps: { ...integration().gitOps, merge: (unit) => { mergeCalls++; return { ok: true, revision: `merged-${unit.taskId}`, details: 'ok' }; } } }, runId: 'run-review-rejected', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'failed');
    assert.equal(verifyCalls, 1);
    assert.equal(mergeCalls, 0);
    assert.deepEqual(executor.finalized, ['Treviewed/Treviewed:attempt-1']);
    assert.equal(summary.taskResults.length, 0);
  });

  it('blocks merge and cleans the artifact when the review cites a stale revision', async () => {
    const executor = new FinalizableExecutor();
    let mergeCalls = 0;
    const coordinator = new VerticalSliceCoordinator(configBase, { executor, host: host([]), planner: { plan: () => singleTaskPlan('Tstale') }, reviewer: { review: (brief: ReviewBrief) => ({ outcome: 'passed', reasons: ['reviewed something else'], artifactRevision: `stale-${brief.diff.artifactRevision}` }) }, integrationRunner: { ...integration(), gitOps: { ...integration().gitOps, merge: (unit) => { mergeCalls++; return { ok: true, revision: `merged-${unit.taskId}`, details: 'ok' }; } } }, runId: 'run-review-stale', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'failed');
    assert.equal(mergeCalls, 0);
    assert.deepEqual(executor.finalized, ['Tstale/Tstale:attempt-1']);
  });

  it('never mechanically verifies, reviews, or merges a settlement that is not acceptance eligible', async () => {
    let verifyCalls = 0; let reviewCalls = 0; let mergeCalls = 0;
    const executor = new FakeExecutor(() => [{ status: 'settled', outcome: 'scope-violation', settlement: { conclusion: 'scope-violation', acceptanceEligible: false, failureCode: 'SCOPE_VIOLATION', reason: 'edited outside files_in_scope', artifact: { artifactRevision: 'rev-tscope', changedPaths: ['outside/'] } } }]);
    const scopeHost: VerticalHost = { ...host([]), createVerificationRunner: () => ({ run: () => { verifyCalls++; return { exitCode: 0, timedOut: false, output: 'ok' }; } }) };
    const coordinator = new VerticalSliceCoordinator(configBase, { executor, host: scopeHost, planner: { plan: () => singleTaskPlan('Tscope') }, reviewer: { review: () => { reviewCalls++; return { outcome: 'passed', reasons: ['never reached'], artifactRevision: 'rev-tscope' }; } }, integrationRunner: { ...integration(), gitOps: { ...integration().gitOps, merge: (unit) => { mergeCalls++; return { ok: true, revision: `merged-${unit.taskId}`, details: 'ok' }; } } }, runId: 'run-scope-violation', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'failed');
    assert.equal(verifyCalls, 0);
    assert.equal(reviewCalls, 0);
    assert.equal(mergeCalls, 0);
    assert.equal(executor.startCalls.length, 1);
  });

  it('never starts a dependent task after its prerequisite fails and reports it blocked', async () => {
    const executor = new FakeExecutor((request) => request.taskId === 'Tpre'
      ? [{ status: 'settled', outcome: 'failed', settlement: { conclusion: 'failed', acceptanceEligible: false, failureCode: 'WORKER_FAILED', reason: 'prerequisite boom', artifact: { artifactRevision: 'rev-tpre', changedPaths: [] } } }]
      : [{ status: 'settled', outcome: 'completed', settlement: settlement(request.taskId) }]);
    const plan = { version: 1, executionMode: 'plan' as const, tasks: [
      { id: 'Tpre', objective: 'base work', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: ['check'] },
      { id: 'Tdep', objective: 'dependent work', depends_on: ['Tpre'], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: ['check'] },
    ], finalVerification: ['final'] };
    const coordinator = new VerticalSliceCoordinator(configBase, { executor, host: host([]), planner: { plan: () => plan }, integrationRunner: integration(), runId: 'run-prereq-blocked', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'failed');
    assert.deepEqual(executor.startCalls.map((request) => request.taskId), ['Tpre']);
    const journal = readFileSync(join(configBase.workspaceRoot, '.agent-orchestrator', 'runs', 'run-prereq-blocked.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind?: string; type?: string; taskId?: string });
    assert.equal(journal.some((entry) => entry.kind === 'scheduler' && entry.type === 'task_blocked' && entry.taskId === 'Tdep'), true);
  });

  it('retains worker artifacts and the integration workspace when final integration verification fails', async () => {
    const executor = new FinalizableExecutor();
    const lease = { taskId: 'Tintegration', attemptId: 'Tintegration:attempt-1', baseRevision: FULL_BASE_SHA, workspacePath: '/workspaces/integration-final', branch: 'branch/integration', ownershipToken: 'token', managedMarker: 'agent-orchestrator:token' };
    const coordinator = new VerticalSliceCoordinator({ ...configBase, reviewerStrategy: 'never' }, { executor, host: host([]), planner: { plan: () => singleTaskPlan('Tfinal') }, integrationRunner: { gitOps: { rebase: (_base, unit) => ({ ok: true, revision: unit.revision, details: 'ok' }), merge: (unit) => ({ ok: true, revision: `merged-${unit.taskId}`, details: 'ok' }), conflicts: () => ({ conflicts: [] }), status: () => ({ revision: 'merged-Tfinal', clean: true, details: 'clean' }) }, commandRunner: { run: () => ({ exitCode: 1, timedOut: false, output: 'final verification failed' }) } }, integrationLease: lease, runId: 'run-final-verification-failed', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'failed');
    assert.equal(summary.integration?.outcome, 'verification_failed');
    assert.match(summary.error ?? '', /integration outcome: verification_failed/);
    assert.equal(executor.finalized.length, 0);
    assert.equal(summary.finalPath, '/workspaces/integration-final');
    assert.equal(summary.finalBranch, 'branch/integration');
  });
});

describe('planner retry classification', () => {
  it('retries exactly once with structural feedback when the first planner output is malformed', async () => {
    let calls = 0;
    const feedbacks: Array<string | undefined> = [];
    const planner = { plan: (input: { feedback?: string }) => { calls++; feedbacks.push(input.feedback); return calls === 1 ? { version: 2 } : singleTaskPlan('Tretry'); } };
    const executor = new FinalizableExecutor();
    const coordinator = new VerticalSliceCoordinator({ ...configBase, reviewerStrategy: 'never' }, { executor, host: host([]), planner, integrationRunner: { gitOps: { rebase: (_base, unit) => ({ ok: true, revision: unit.revision, details: 'ok' }), merge: (unit) => ({ ok: true, revision: `merged-${unit.taskId}`, details: 'ok' }), conflicts: () => ({ conflicts: [] }), status: () => ({ revision: 'merged-Tretry', clean: true, details: 'clean' }) }, commandRunner: { run: () => ({ exitCode: 0, timedOut: false, output: 'ok' }) } }, runId: 'run-planner-retry', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'passed');
    assert.equal(calls, 2);
    assert.equal(feedbacks[0], undefined);
    assert.match(feedbacks[1] ?? '', /RunPlan structural validation/);
    assert.equal(summary.metrics.modelCalls, 2);
    assert.equal(summary.metrics.retries, 1);
  });

  it('fails immediately without retry when the planner transport cancels, fails, or times out', async () => {
    const messages = ['structured agent ended with cancelled', 'structured agent ended with failed', 'structured agent timed out'];
    for (const [index, message] of messages.entries()) {
      let calls = 0;
      const planner = { plan: () => { calls++; throw new Error(message); } };
      const coordinator = new VerticalSliceCoordinator(configBase, { host: host([]), planner, runId: `run-transport-fail-${index}`, clock: () => 0, sleep: async () => undefined });
      const summary = await coordinator.run();
      assert.equal(summary.status, 'failed');
      assert.equal(calls, 1);
      assert.equal(summary.metrics.modelCalls, 1);
      assert.equal(summary.metrics.retries, 0);
      assert.equal(summary.error, message);
    }
  });
});

class PlannerHerdrFake {
  readonly requests: HerdrSpawnRequest[] = [];
  spawn(request: HerdrSpawnRequest): { sessionId: string } { this.requests.push(request); return { sessionId: 'planner-session' }; }
  poll(): { status: 'settled' } { return { status: 'settled' }; }
  readFinalAssistant(): string { return JSON.stringify({ version: 1, executionMode: 'single', tasks: [{ id: 'Tplan', objective: 'plan', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['done'], verification: ['check'] }], finalVerification: ['final'] }); }
  interrupt(): void { /* fake */ }
  close(): void { /* fake */ }
}

class CancellingHerdrFake {
  readonly spawns: HerdrSpawnRequest[] = [];
  readonly interrupts: string[] = [];
  readonly closes: string[] = [];
  private interrupted = false;
  spawn(request: HerdrSpawnRequest): { sessionId: string } { this.spawns.push(request); return { sessionId: 'planner-session' }; }
  poll(): { status: 'running' | 'cancelled' } { return { status: this.interrupted ? 'cancelled' : 'running' }; }
  readFinalAssistant(): string { return '{}'; }
  interrupt(sessionId: string): void { this.interrupted = true; this.interrupts.push(sessionId); }
  close(sessionId: string): void { this.closes.push(sessionId); }
}

describe('vertical first-run gates', () => {
  it('runs StructuredPlanner through scoped context with the planner worker role', async () => {
    const herdr = new PlannerHerdrFake();
    const runner = new StructuredAgentRunner({ herdr, clock: () => 0, sleep: async () => undefined, pollIntervalMs: 1, timeoutMs: 10 });
    const planner = new StructuredPlanner(configBase, runner, '/repo');
    const plan = await planner.plan({ userTask: 'plan it', repoRoot: '/repo', baseRevision: FULL_BASE_SHA, authorizedVerificationCommands: ['check', 'final'] });
    assert.equal(plan.tasks[0]?.id, 'Tplan');
    assert.equal(herdr.requests[0]?.roleId, 'planner');
    assert.equal(herdr.requests[0]?.scopedContext.role.kind, 'worker');
  });

  it('does not respawn the planner after SIGINT: one spawn, one interrupt, one close, failed summary', async () => {
    const herdr = new CancellingHerdrFake();
    let cancelled = false;
    let coordinator!: VerticalSliceCoordinator;
    const runner = new StructuredAgentRunner({ herdr, clock: () => 0, pollIntervalMs: 1, timeoutMs: 10, sleep: async () => { if (!cancelled) { cancelled = true; coordinator.cancel('SIGINT'); } } });
    const planner = new StructuredPlanner(configBase, runner, '/repo');
    coordinator = new VerticalSliceCoordinator(configBase, { host: host([]), planner, runId: 'run-sigint-planner', clock: () => 0, sleep: async () => undefined });
    const summary = await coordinator.run();
    assert.equal(summary.status, 'failed');
    assert.match(summary.error ?? '', /cancelled/);
    assert.equal(herdr.spawns.length, 1);
    assert.deepEqual(herdr.interrupts, ['planner-session']);
    assert.deepEqual(herdr.closes, ['planner-session']);
    assert.equal(summary.metrics.modelCalls, 1);
    assert.equal(summary.metrics.retries, 0);
  });
});
