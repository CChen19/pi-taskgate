import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCatalog } from '../src/core/catalog.ts';
import { planDispatch } from '../src/core/preflight.ts';
import { IMPLEMENTER_ROLE_ID } from '../src/core/defaults.ts';
import { fixtureConfig, PROFILE_FAST } from './fixtures.ts';
import type { TaskContract } from '../src/core/task-contract.ts';
import {
  assembleScopedContext,
  renderScopedPrompt,
  scopedContextFromPlan,
  validateChangedPaths,
  type ScopedContextBundle,
} from '../src/adapters/scoped-context.ts';
import {
  WorktreeManager,
  WORKTREE_MARKER_PREFIX,
  type WorktreePort,
  type WorkspaceLease,
} from '../src/adapters/worktree-manager.ts';
import {
  PiHerdrExecutor,
  restoreHandle,
  serializeHandle,
  type HerdrSubagentPort,
  type HerdrSpawnRequest,
} from '../src/adapters/pi-herdr-executor.ts';

function contextInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'Tadapter',
    objective: 'Implement the adapter boundary',
    acceptanceCriteria: ['The boundary is isolated', 'The result is revision bound'],
    filesInScope: ['src/adapters/'],
    verificationCommands: ['npm run check'],
    role: { id: 'implementer', kind: 'worker' },
    model: { profileId: 'profile-fast', provider: 'fixture-provider', model: 'fixture-model' },
    baseRevision: 'base-1',
    artifactRevision: 'base-1',
    evidenceSummaries: [{ reference: 'evidence://1', summary: 'No prior evidence' }],
    referenceSummaries: [{ reference: 'docs://s8', summary: 'Adapter seam only' }],
    ...overrides,
  };
}

class FakeWorktree implements WorktreePort {
  readonly creates: unknown[] = [];
  readonly inspections: unknown[] = [];
  readonly removals: unknown[] = [];
  readonly bindings = new Map<string, Record<string, unknown>>();
  failCreate = false;
  failRemove = false;
  changedPaths: readonly string[] = ['src/adapters/pi-herdr-executor.ts'];
  artifactRevision = 'observed-revision';
  clean = true;
  commitsAhead = 1;

  create(request: unknown): unknown {
    this.creates.push(request);
    if (this.failCreate) throw new Error('create fixture failure');
    const value = request as Record<string, string>;
    return {
      workspacePath: value.workspacePath,
      branch: value.branch,
      ownershipToken: value.ownershipToken,
      managedMarker: `${WORKTREE_MARKER_PREFIX}${value.ownershipToken}`,
      baseRevision: value.baseRevision,
    };
  }
  bindSession(request: unknown): unknown {
    const value = request as Record<string, unknown>;
    this.bindings.set(String(value.workspacePath), { ...value });
    return { owned: true, ...value };
  }
  inspectChangedPaths(request: unknown): unknown {
    this.inspections.push(request);
    return { changedPaths: [...this.changedPaths], artifactRevision: this.artifactRevision, diffRef: 'diff://observed', clean: this.clean, commitsAhead: this.commitsAhead };
  }
  verifyOwnership(request: unknown): unknown {
    const value = request as Record<string, unknown>;
    const actual = this.bindings.get(String(value.workspacePath));
    return actual === undefined ? { owned: false, ...value } : { owned: true, ...actual };
  }
  remove(request: unknown): unknown {
    this.removals.push(request);
    if (this.failRemove) throw new Error('remove fixture failure');
    return undefined;
  }
}

class FakeHerdr implements HerdrSubagentPort {
  readonly spawns: HerdrSpawnRequest[] = [];
  readonly interrupts: string[] = [];
  readonly closes: string[] = [];
  readonly polls: unknown[] = [];
  nextPoll: unknown = { status: 'running' };
  failSpawn = false;
  spawn(request: HerdrSpawnRequest): unknown {
    this.spawns.push(request);
    if (this.failSpawn) throw new Error('spawn fixture failure');
    return { sessionId: `session-${this.spawns.length}` };
  }
  poll(sessionId: string): unknown {
    this.polls.push(sessionId);
    return this.nextPoll;
  }
  interrupt(sessionId: string): void { this.interrupts.push(sessionId); }
  close(sessionId: string): void { this.closes.push(sessionId); }
}

function managerAndPort() {
  let id = 0;
  const port = new FakeWorktree();
  const manager = new WorktreeManager({ repoRoot: '/repo', workspaceRoot: '/workspaces', idSource: () => `id-${++id}` });
  return { manager, port };
}

function executorFixture() {
  const catalog = createCatalog(fixtureConfig());
  const herdr = new FakeHerdr();
  const { manager, port } = managerAndPort();
  const executor = new PiHerdrExecutor({
    herdr,
    workspace: manager,
    worktreePort: port,
    dispatchResolver: (request) => planDispatch(catalog, request),
    roleId: IMPLEMENTER_ROLE_ID,
    modelProfileId: PROFILE_FAST,
    baseRevision: 'base-1',
    clock: () => 1,
  });
  return { executor, herdr, manager, port };
}

function startRequest(): { taskId: string; attemptId: string; contract: TaskContract; startedAt: number } {
  return {
    taskId: 'Tadapter',
    attemptId: 'Tadapter:attempt-1',
    startedAt: 1,
    contract: {
      id: 'Tadapter', objective: 'Implement the adapter boundary', depends_on: [],
      files_in_scope: ['src/adapters/'], acceptance_criteria: ['scope is enforced'], verification: [],
      retry: { max_attempts: 0 },
    },
  };
}

describe('S8 scoped context and scope gate', () => {
  it('rejects transcript, secrets, full logs, unknown fields, and unsafe paths', () => {
    for (const field of ['workerTranscript', 'fullLog', 'secrets', 'env']) {
      assert.throws(() => assembleScopedContext(contextInput({ [field]: 'must not enter' })), /unknown field/);
    }
    assert.throws(() => assembleScopedContext(contextInput({ filesInScope: ['../secret'] })), (error: { code: string }) => error.code === 'PATH_POLICY');
    assert.throws(() => assembleScopedContext(contextInput({ filesInScope: ['C:\\secret'] })), /safe relative path/);
    assert.throws(() => assembleScopedContext(contextInput({ filesInScope: ['src/.GIT/config'] })), /forbidden segment/);
    const result = assembleScopedContext(contextInput());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.acceptanceCriteria), true);
    assert.equal(Object.isFrozen(result.role), true);
    assert.equal(renderScopedPrompt(result), renderScopedPrompt(result));
    assert.equal(renderScopedPrompt(result).includes('must not enter'), false);
    assert.throws(() => { (result as { objective: string }).objective = 'changed'; }, TypeError);
  });

  it('normalizes paths and avoids prefix confusion while supporting directory scopes', () => {
    const allowed = validateChangedPaths(['./src/a.ts', 'src/nested/b.ts'], ['src/']);
    assert.equal(allowed.allowed, true);
    const prefix = validateChangedPaths(['src/ab.ts'], ['src/a']);
    assert.equal(prefix.allowed, false);
    assert.deepEqual(prefix.violations, ['src/ab.ts']);
    for (const path of ['/tmp/a', '../a', 'src/../a', '.git/config', 'src\\a', 'src/\0a']) {
      assert.throws(() => validateChangedPaths([path], ['src/']), /relative|forbidden/);
    }
    const unicode = validateChangedPaths(['src/évil.ts'], ['src/'],);
    assert.equal(unicode.allowed, true);
  });

  it('normalizes public throwing boundaries into structured errors', () => {
    const revokedLike = new Proxy({}, { getPrototypeOf() { throw new Error('revoked'); } });
    assert.throws(() => restoreHandle(revokedLike), (error: { code: string; message: string }) => error.code === 'UNKNOWN_HANDLE' && error.message.length <= 160);
    const throwingHandle: Record<string, unknown> = { schemaVersion: 1, taskId: 'Tadapter', attemptId: 'Tadapter:attempt-1', sessionId: 'session-1', roleId: IMPLEMENTER_ROLE_ID, modelProfileId: PROFILE_FAST, filesInScope: ['src/adapters/'], workspacePath: '/workspaces/a', branch: 'orchestrator/a', ownershipToken: 'token', managedMarker: `${WORKTREE_MARKER_PREFIX}token`, baseRevision: 'base-1' };
    Object.defineProperty(throwingHandle, 'sessionId', { get() { throw new Error('secret getter'); }, enumerable: true });
    assert.throws(() => serializeHandle(throwingHandle), (error: { code: string; message: string }) => error.code === 'UNKNOWN_HANDLE' && !error.message.includes('secret'));
    const hostilePlan = new Proxy({}, { get() { throw new Error('plan getter'); } });
    assert.throws(() => scopedContextFromPlan(hostilePlan as never, hostilePlan as never, 'base-1'), (error: { code: string; message: string }) => error.code === 'INVALID_CONTEXT' && error.message.length <= 160);
  });

  it('rejects sparse, method-tampered arrays and hostile getters structurally', () => {
    const sparse = new Array(1) as unknown[];
    assert.throws(() => assembleScopedContext(contextInput({ acceptanceCriteria: sparse })), /sparse/);
    const tampered = Object.assign(['src/'], { map: null });
    assert.throws(() => assembleScopedContext(contextInput({ filesInScope: tampered })), /unknown array property|override array method/);
    const hostile = new Proxy(contextInput(), { get() { throw new Error('secret getter'); } });
    assert.throws(() => assembleScopedContext(hostile), (error: { code: string; message: string }) => error.code === 'INVALID_CONTEXT' && !error.message.includes('secret'));
  });
});

describe('S8 worktree manager', () => {
  it('creates unique contained leases per concurrent attempt and cleans idempotently', () => {
    const { manager, port } = managerAndPort();
    const first = manager.acquire(port, 'Tadapter', 'Tadapter:attempt-1', 'base-1');
    const second = manager.acquire(port, 'Tadapter', 'Tadapter:attempt-2', 'base-1');
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.notEqual(first.branch, second.branch);
    assert.ok(first.workspacePath.startsWith('/workspaces/'));
    assert.equal(Object.isFrozen(first), true);
    assert.deepEqual(manager.cleanup(port, first).ok, true);
    assert.deepEqual(manager.cleanup(port, first).ok, true);
    assert.equal(port.removals.length, 1);
    assert.equal(manager.cleanup(port, { ...second }).ok, false);
    assert.equal(port.removals.length, 1);
  });

  it('normalizes revoked Proxy hasLease failures', () => {
    const fixture = managerAndPort();
    const lease = fixture.manager.acquire(fixture.port, 'Tadapter', 'a-1', 'base');
    const revoked = Proxy.revocable(lease, {});
    revoked.revoke();
    assert.throws(() => fixture.manager.hasLease(revoked.proxy), (error: { code: string; message: string }) => error.code === 'OWNERSHIP_MISMATCH' && error.message.length <= 160);
  });

  it('normalizes throwing lease getter hasLease failures', () => {
    const fixture = managerAndPort();
    const lease = fixture.manager.acquire(fixture.port, 'Tadapter', 'a-1', 'base');
    const hostile = Object.create(lease) as WorkspaceLease;
    Object.defineProperty(hostile, 'taskId', { get() { throw new Error('secret getter'); } });
    assert.throws(() => fixture.manager.hasLease(hostile), (error: { code: string; message: string }) => error.code === 'OWNERSHIP_MISMATCH' && error.message.length <= 160 && !error.message.includes('secret'));
  });

  it('fails closed for containment, marker mismatch, create failure, and remove failure', () => {
    assert.throws(() => new WorktreeManager({ repoRoot: 'relative', workspaceRoot: '/workspaces', idSource: () => 'x' }), /absolute/);
    assert.throws(() => new WorktreeManager({ repoRoot: '/repo/.GIT/project', workspaceRoot: '/workspaces', idSource: () => 'x' }), /protected/);
    assert.throws(() => new WorktreeManager({ repoRoot: '/repo', workspaceRoot: '/workspaces/.git/cache', idSource: () => 'x' }), /protected/);
    assert.throws(() => new WorktreeManager({ repoRoot: '/repo\0bad', workspaceRoot: '/workspaces', idSource: () => 'x' }), /absolute/);
    const fixture = managerAndPort();
    fixture.port.failCreate = true;
    assert.throws(() => fixture.manager.acquire(fixture.port, 'Tadapter', 'a-1', 'base'), /create fixture failure|worktree create failed/);
    assert.equal(fixture.port.creates.length, 1);
    const lease = managerAndPort();
    const owned = lease.manager.acquire(lease.port, 'Tadapter', 'a-1', 'base');
    lease.port.failRemove = true;
    const failed = lease.manager.cleanup(lease.port, owned);
    assert.equal(failed.ok, false);
    assert.equal(lease.port.removals.length, 1);
    assert.equal(lease.manager.cleanup(lease.port, { ...owned }).ok, false);
  });
});

describe('S8 Pi/herdr ExecutorPort adapter', () => {
  it('passes only cwd, validated role/model, contract, and scoped context to spawn', () => {
    const fixture = executorFixture();
    const handle = fixture.executor.start(startRequest());
    assert.equal(fixture.herdr.spawns.length, 1);
    const payload = fixture.herdr.spawns[0]!;
    assert.ok(payload.cwd.startsWith('/workspaces/'));
    assert.equal(payload.roleId, IMPLEMENTER_ROLE_ID);
    assert.equal(payload.modelProfileId, PROFILE_FAST);
    assert.equal(payload.scopedContext.taskId, 'Tadapter');
    assert.equal('workerTranscript' in payload, false);
    assert.equal('fullLog' in payload, false);
    assert.equal(Object.isFrozen(payload), true);
    assert.deepEqual(handle.poll(), { status: 'pending' });
  });

  it('does not spawn when workspace creation fails and cleans a failed spawn', () => {
    const fixture = executorFixture();
    fixture.port.failCreate = true;
    assert.throws(() => fixture.executor.start(startRequest()), /workspace|create/);
    assert.equal(fixture.herdr.spawns.length, 0);
    const second = executorFixture();
    second.herdr.failSpawn = true;
    assert.throws(() => second.executor.start(startRequest()), /spawn fixture failure/);
    assert.equal(second.port.removals.length, 1);
  });

  it('polls running then terminal, observes artifact revision from worktree, and gates scope', () => {
    const fixture = executorFixture();
    const handle = fixture.executor.start(startRequest()) as unknown as { poll(): unknown; terminalResult(): unknown; close(): void };
    fixture.herdr.nextPoll = { status: 'idle' };
    assert.deepEqual(handle.poll(), { status: 'pending' });
    fixture.herdr.nextPoll = { status: 'settled', outcome: 'worker claimed revision forged-by-worker' };
    const settled = handle.poll() as { status: string; outcome: string; settlement: { artifact: { artifactRevision: string; workspacePath: string; branch: string } } };
    assert.equal(settled.status, 'settled');
    assert.equal(settled.outcome, 'worker claimed revision forged-by-worker');
    assert.equal(settled.settlement.artifact.artifactRevision, 'observed-revision');
    assert.ok(settled.settlement.artifact.workspacePath.startsWith('/workspaces/'));
    assert.match(settled.settlement.artifact.branch, /^orchestrator\//);
    const terminal = handle.terminalResult() as Record<string, unknown>;
    assert.equal(terminal.artifactRevision, 'observed-revision');
    assert.equal(terminal.scopeAllowed, true);
    assert.equal(fixture.port.removals.length, 0);
    const repeated = handle.poll() as { status: string; settlement: unknown };
    assert.equal(repeated.status, 'settled');
    assert.ok(repeated.settlement);
    handle.close();
    assert.equal(fixture.port.removals.length, 0);
    assert.equal(fixture.executor.finalizeArtifact('Tadapter', 'Tadapter:attempt-1').ok, true);
    assert.equal(fixture.port.removals.length, 1);

    const out = executorFixture();
    out.port.changedPaths = ['src/other/outside.ts'];
    const outHandle = out.executor.start(startRequest()) as unknown as { poll(): unknown; terminalResult(): Record<string, unknown> };
    out.herdr.nextPoll = { status: 'settled', outcome: 'done' };
    const result = outHandle.poll();
    assert.equal((result as { status: string }).status, 'settled');
    assert.equal(outHandle.terminalResult().scopeAllowed, false);
    assert.match((result as { outcome: string }).outcome, /scope violation/);
  });

  it('handles malformed transport, cancel/close idempotence, and cleanup failure without trusting worker revision', () => {
    const fixture = executorFixture();
    const handle = fixture.executor.start(startRequest());
    fixture.herdr.nextPoll = { status: 'settled', outcome: 'ok', artifactRevision: 'forged' };
    const malformed = handle.poll() as { status: string; settlement: { acceptanceEligible: boolean; failureCode: string } };
    assert.equal(malformed.status, 'settled');
    assert.equal(malformed.settlement.acceptanceEligible, false);
    assert.equal(malformed.settlement.failureCode, 'MALFORMED_TRANSPORT');
    handle.close();
    handle.close();
    assert.equal(fixture.herdr.interrupts.length, 0);
    assert.equal(fixture.herdr.closes.length, 1);

    const failed = executorFixture();
    failed.port.failRemove = true;
    const failedHandle = failed.executor.start(startRequest()) as unknown as { close(): void; lastError(): { code: string } | undefined };
    assert.throws(() => failedHandle.close(), /remove fixture failure/);
    assert.equal(failedHandle.lastError()?.code, 'CLEANUP_FAILURE');
    failed.port.failRemove = false;
    assert.deepEqual(failed.executor.retryPendingCleanup('Tadapter', 'Tadapter:attempt-1'), { ok: true });
  });

  it('round-trips and rejects every tampered recovery binding without spawning or cleanup', () => {
    const fixture = executorFixture();
    const started = fixture.executor.start(startRequest()) as unknown as { state: Record<string, unknown>; close(): void };
    const state = started.state;
    const encoded = serializeHandle(state);
    assert.deepEqual(restoreHandle(encoded), encoded);
    assert.equal(Object.isFrozen(encoded), true);
    started.close();
    const reattached = fixture.executor.reattach(encoded);
    assert.equal(fixture.herdr.spawns.length, 1);
    for (const field of ['taskId', 'attemptId', 'sessionId', 'roleId', 'modelProfileId', 'filesInScope', 'baseRevision', 'workspacePath', 'branch', 'ownershipToken', 'managedMarker']) {
      const tampered = { ...encoded, [field]: field === 'filesInScope' ? ['src/other/'] : `${String((encoded as unknown as Record<string, unknown>)[field])}-tampered` };
      assert.throws(() => fixture.executor.reattach(tampered), /ownership|binding|match/);
    }
    assert.equal(fixture.herdr.spawns.length, 1);
    assert.equal(fixture.port.inspections.length, 0);
    assert.equal(fixture.port.removals.length, 1);
    fixture.herdr.nextPoll = { status: 'running' };
    assert.deepEqual(reattached.poll(), { status: 'pending' });
  });

  it('retains artifacts through cleanup failure and deletes retained state after retry', () => {
    const fixture = executorFixture();
    const handle = fixture.executor.start(startRequest());
    fixture.herdr.nextPoll = { status: 'settled', outcome: 'done' };
    assert.equal((handle.poll() as { status: string }).status, 'settled');
    fixture.port.failRemove = true;
    assert.equal(fixture.executor.finalizeArtifact('Tadapter', 'Tadapter:attempt-1').ok, false);
    assert.ok(fixture.executor.artifactLease('Tadapter', 'Tadapter:attempt-1'));
    fixture.port.failRemove = false;
    assert.deepEqual(fixture.executor.retryPendingCleanup('Tadapter', 'Tadapter:attempt-1'), { ok: true });
    assert.equal(fixture.executor.artifactLease('Tadapter', 'Tadapter:attempt-1'), undefined);
  });

  it('rejects dirty and no-commit terminal artifacts and cleans them', () => {
    for (const change of [{ clean: false, commitsAhead: 2 }, { clean: true, commitsAhead: 0 }]) {
      const fixture = executorFixture();
      fixture.port.clean = change.clean;
      fixture.port.commitsAhead = change.commitsAhead;
      const handle = fixture.executor.start(startRequest());
      fixture.herdr.nextPoll = { status: 'settled', outcome: 'done' };
      const settled = handle.poll() as { settlement: { acceptanceEligible: boolean; failureCode: string } };
      assert.equal(settled.settlement.acceptanceEligible, false);
      assert.equal(settled.settlement.failureCode, 'INSPECTION_FAILED');
      assert.equal(fixture.port.removals.length, 1);
    }
  });

  it('runs an end-to-end fake contract → dispatch → worktree → spawn → poll → scope gate flow', () => {
    const fixture = executorFixture();
    const handle = fixture.executor.start(startRequest()) as unknown as { poll(): unknown; terminalResult(): Record<string, unknown> };
    fixture.herdr.nextPoll = { status: 'settled', outcome: 'completed' };
    const settled = handle.poll() as { status: string; outcome: string; settlement: unknown };
    assert.equal(settled.status, 'settled');
    assert.equal(settled.outcome, 'completed');
    assert.ok(settled.settlement);
    assert.equal(handle.terminalResult().artifactRevision, fixture.port.artifactRevision);
    assert.equal(handle.terminalResult().scopeAllowed, true);
    assert.equal(fixture.port.creates.length, 1);
    assert.equal(fixture.port.inspections.length, 1);
    assert.equal(fixture.port.removals.length, 0);
    assert.equal(fixture.executor.finalizeArtifact('Tadapter', 'Tadapter:attempt-1').ok, true);
    assert.equal(fixture.port.removals.length, 1);
  });
});
