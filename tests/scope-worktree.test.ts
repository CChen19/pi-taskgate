import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateChangedPaths } from '../src/core/scope.ts';
import {
  WorktreeManager,
  WORKTREE_MARKER_PREFIX,
  type WorkspaceLease,
  type WorktreePort,
} from '../src/adapters/worktree-manager.ts';

class FakeWorktree implements WorktreePort {
  readonly creates: unknown[] = [];
  readonly inspections: unknown[] = [];
  readonly removals: unknown[] = [];
  readonly bindings = new Map<string, Record<string, unknown>>();
  failCreate = false;
  failRemove = false;
  changedPaths: readonly string[] = ['src/a.ts'];
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

function managerAndPort() {
  let id = 0;
  const port = new FakeWorktree();
  const manager = new WorktreeManager({ repoRoot: '/repo', workspaceRoot: '/workspaces', idSource: () => `id-${++id}` });
  return { manager, port };
}

describe('scope gate', () => {
  it('normalizes paths and avoids prefix confusion while supporting directory scopes', () => {
    const allowed = validateChangedPaths(['./src/a.ts', 'src/nested/b.ts'], ['src/']);
    assert.equal(allowed.allowed, true);
    assert.equal(Object.isFrozen(allowed.changedPaths), true);
    const prefix = validateChangedPaths(['src/ab.ts'], ['src/a']);
    assert.equal(prefix.allowed, false);
    assert.deepEqual(prefix.violations, ['src/ab.ts']);
    for (const path of ['/tmp/a', 'C:\\a', '../a', 'src/../a', '.git/config', 'src/.GIT/config', 'src\\a', 'src/\0a']) {
      assert.throws(() => validateChangedPaths([path], ['src/']), (error: { code: string }) => error.code === 'PATH_POLICY', path);
    }
    assert.equal(validateChangedPaths(['src/évil.ts'], ['src/']).allowed, true);
  });

  it('rejects sparse, method-tampered arrays and hostile getters without echoing them', () => {
    assert.throws(() => validateChangedPaths(new Array(1), ['src/']), /sparse/);
    assert.throws(() => validateChangedPaths(Object.assign(['src/a'], { map: null }), ['src/']), /unknown array property|override array method/);
    const hostile = new Proxy(['src/a'], { get() { throw new Error('secret getter'); } });
    assert.throws(() => validateChangedPaths(hostile, ['src/']), (error: { code: string; message: string }) => error.code === 'INVALID_INPUT' && !error.message.includes('secret'));
  });
});

describe('worktree manager', () => {
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
