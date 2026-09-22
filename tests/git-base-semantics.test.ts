import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { NodeCommandRunner, minimalProcessEnv } from '../src/host/command-runner.ts';
import { createRealHost } from '../src/host/index.ts';

/**
 * Real-git semantics for the run-wide immutable base (normal temp repo only;
 * no worktree, no network, no agent). It pins down why vertical config only
 * accepts complete git object ids: after a worker commit, a pinned SHA yields
 * exactly one commit ahead and a non-empty diff, while a mutable `HEAD` base
 * resolves against the workspace's own HEAD and collapses to 0/empty.
 */

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8', env: minimalProcessEnv(undefined) }).status === 0;

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', env: minimalProcessEnv(undefined) });
  if (result.error !== undefined || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || String(result.error)}`);
  return result.stdout;
}

const IDENTITY = ['-c', 'user.email=orchestrator@example.com', '-c', 'user.name=orchestrator'];

describe('immutable base git semantics', { skip: !gitOk }, () => {
  it('keeps worker artifacts countable and reviewable from a pinned SHA while HEAD collapses to zero', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-git-base-'));
    try {
      const repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q']);
      writeFileSync(join(repo, 'README.md'), 'base state\n');
      git(repo, ['add', '.']);
      git(repo, [...IDENTITY, 'commit', '-q', '-m', 'base state']);
      const base = git(repo, ['rev-parse', 'HEAD']).trim();
      assert.match(base, /^[0-9a-f]{40}$/, 'this fixture repo uses SHA-1 object ids');

      // Simulated worker commit on top of the pinned base.
      writeFileSync(join(repo, 'feature.txt'), 'worker change\n');
      git(repo, ['add', '.']);
      git(repo, [...IDENTITY, 'commit', '-q', '-m', 'worker artifact']);
      const workerHead = git(repo, ['rev-parse', 'HEAD']).trim();

      // Pinned immutable base: exactly one commit ahead, non-empty three-dot diff,
      // and the integration ancestor gate holds.
      assert.equal(git(repo, ['rev-list', '--count', `${base}..HEAD`]).trim(), '1');
      assert.match(git(repo, ['diff', '--no-ext-diff', '--no-color', `${base}...HEAD`, '--']), /worker change/);
      git(repo, ['merge-base', '--is-ancestor', base, 'HEAD']);

      // Mutable `HEAD` base resolved in the workspace cwd: zero commits ahead and
      // an empty diff — the failure mode behind empty reviews and failed units.
      assert.equal(git(repo, ['rev-list', '--count', 'HEAD..HEAD']).trim(), '0');
      assert.equal(git(repo, ['diff', '--no-ext-diff', '--no-color', 'HEAD...HEAD', '--']).trim(), '');

      // The real host seam shows the same split: pinned base produces the reviewer
      // patch; a HEAD base produces the empty diff that reviews reject.
      const host = createRealHost({
        repoRoot: repo,
        workspaceRoot: join(root, 'workspaces'),
        herdr: { herdrBinary: 'unused', piExtension: 'unused', provider: 'unused', model: 'unused', workspaceId: 'unused', roleManifests: {}, roleBases: {}, timeouts: { startMs: 1, promptMs: 1, probeMs: 1 } },
        verificationAllowlist: ['true'],
        commandRunner: new NodeCommandRunner(),
      });
      assert.match(host.readArtifactDiff(repo, base, workerHead), /worker change/);
      assert.equal(host.readArtifactDiff(repo, 'HEAD', workerHead), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
