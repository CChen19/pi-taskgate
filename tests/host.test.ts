import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeCommandRunner } from '../src/host/command-runner.ts';
import type { CommandRunner, CommandSpec, CommandResult, RunningCommand } from '../src/host/command-runner.ts';
import { GitWorktreePort, changedFromStatus } from '../src/host/git-worktree-port.ts';
import { ProcessAsyncVerificationRunner } from '../src/host/process-verification-runner.ts';
import { WorktreeManager, WORKTREE_MARKER_PREFIX } from '../src/adapters/worktree-manager.ts';

function result(stdout = '', stderr = '', exitCode = 0, timedOut = false): CommandResult {
  return { status: timedOut ? 'signaled' : 'exited', exitCode, signal: null, timedOut, stdout, stderr, stdoutTruncated: false, stderrTruncated: false };
}

class FakeCommand implements CommandRunner {
  readonly sync: CommandSpec[] = [];
  readonly async: CommandSpec[] = [];
  status = '';
  commits = '1\n';
  workspace = '/tmp/fake-worktree';

  run(spec: CommandSpec): CommandResult {
    this.sync.push(spec);
    const args = [...spec.args];
    if (args[0] === 'worktree' && args[1] === 'list') return result(`worktree ${this.workspace}\n\n`);
    if (args[0] === 'diff') return result('old name\0new-name\0');
    if (args[0] === 'status') return result(this.status);
    if (args[0] === 'rev-parse') return result('abc123\n');
    if (args[0] === 'rev-list') return result(this.commits);
    return result();
  }

  runAsync(spec: CommandSpec): RunningCommand {
    this.async.push(spec);
    return { promise: Promise.resolve(result()), cancel: () => undefined };
  }
}

const PROCESS_TREE_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
writeFileSync(process.env.PID_FILE, String(child.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;
const LEADER_EXITS_SCRIPT = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
writeFileSync(process.env.PID_FILE, String(child.pid));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readPidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 1) return pid;
    } catch { /* child has not written it yet */ }
    await delay(10);
  }
  throw new Error('child PID was not written');
}

async function waitGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`process ${pid} survived process-group cleanup`);
}

function killIfAlive(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

describe('git worktree host port', () => {
  it('parses NUL status rename/untracked records', () => {
    assert.deepEqual(changedFromStatus('R  old.txt\0new.txt\0?? untracked.txt\0'), ['old.txt', 'new.txt', 'untracked.txt']);
  });

  it('writes, binds, verifies, and removes the ledger without force', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-host-'));
    const repo = join(root, 'repo');
    const command = new FakeCommand();
    const port = new GitWorktreePort({ workspaceRoot: root, commandRunner: command, env: { PATH: '/usr/bin', HOME: '/home', SECRET_TOKEN: 'topsecret', API_KEY: 'zzz' }, gitTimeoutMs: 123 });
    const manager = new WorktreeManager({ repoRoot: repo, workspaceRoot: root, idSource: () => 'token-1' });
    const lease = manager.acquire(port, 'T-host', 'T-host:attempt-1', 'base');
    command.workspace = lease.workspacePath;
    const binding = { taskId: 'T-host', attemptId: 'T-host:attempt-1', sessionId: lease.workspacePath, roleId: 'implementer', modelProfileId: 'profile-fast', filesInScope: ['src/'], baseRevision: 'base', workspacePath: lease.workspacePath, branch: lease.branch, ownershipToken: lease.ownershipToken, managedMarker: `${WORKTREE_MARKER_PREFIX}${lease.ownershipToken}` };
    assert.deepEqual(manager.bindSession(port, lease, binding).sessionId, binding.sessionId);
    assert.deepEqual((port.verifyOwnership(binding) as { owned: boolean }).owned, true);
    assert.ok(readdirSync(join(root, '.agent-orchestrator', 'ledger')).length === 1);
    const inspection = manager.inspect(port, lease);
    assert.equal(inspection.clean, true);
    assert.equal(inspection.commitsAhead, 1);
    const file = join(root, '.agent-orchestrator', 'ledger', readdirSync(join(root, '.agent-orchestrator', 'ledger'))[0]!);
    const tampered = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    tampered.branch = 'attacker';
    writeFileSync(file, JSON.stringify(tampered));
    assert.throws(() => port.verifyOwnership(binding), /ownership|match/);
    for (const spec of command.sync) {
      assert.equal(spec.command, 'git');
      assert.equal(spec.env.SECRET_TOKEN, undefined);
      assert.equal(spec.env.API_KEY, undefined);
      assert.deepEqual(Object.keys(spec.env).every((key) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key)), true);
      assert.equal(spec.env.PATH, '/usr/bin');
      assert.equal(spec.timeoutMs, 123);
      assert.equal(spec.maxOutputBytes, 64 * 1024);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reports dirty and no-commit artifacts and refuses dirty remove', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-host-'));
    const command = new FakeCommand();
    const port = new GitWorktreePort({ workspaceRoot: root, commandRunner: command });
    const manager = new WorktreeManager({ repoRoot: join(root, 'repo'), workspaceRoot: root, idSource: () => 'token-2' });
    const lease = manager.acquire(port, 'T-host', 'a-1', 'base');
    command.workspace = lease.workspacePath;
    command.status = '?? dirty.txt\0';
    command.commits = '0\n';
    const inspection = manager.inspect(port, lease);
    assert.equal(inspection.clean, false);
    assert.equal(inspection.commitsAhead, 0);
    assert.equal(manager.cleanup(port, lease).ok, false);
    assert.equal(command.sync.every((spec) => spec.timeoutMs === 30_000 && spec.maxOutputBytes === 64 * 1024), true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('process tree cleanup', { concurrency: false }, () => {
  it('kills async timeout process groups after the leader exits', { skip: process.platform === 'win32' }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-async-timeout-'));
    const pidFile = join(directory, 'child.pid');
    let childPid: number | undefined;
    try {
      const command = new NodeCommandRunner();
      const running = command.runAsync({ command: process.execPath, args: ['-e', PROCESS_TREE_SCRIPT], cwd: directory, env: { ...process.env, PID_FILE: pidFile }, timeoutMs: 1000 });
      childPid = await readPidFile(pidFile);
      const outcome = await running.promise;
      assert.equal(outcome.timedOut, true);
      await waitGone(childPid);
    } finally {
      killIfAlive(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('still SIGKILLs the group when the leader exits during SIGTERM grace', { skip: process.platform === 'win32' }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-async-leader-exit-'));
    const pidFile = join(directory, 'child.pid');
    let childPid: number | undefined;
    try {
      const command = new NodeCommandRunner();
      const running = command.runAsync({ command: process.execPath, args: ['-e', LEADER_EXITS_SCRIPT], cwd: directory, env: { ...process.env, PID_FILE: pidFile }, timeoutMs: 1000 });
      childPid = await readPidFile(pidFile);
      const outcome = await running.promise;
      assert.equal(outcome.timedOut, true);
      await waitGone(childPid);
    } finally {
      killIfAlive(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('kills async abort process groups after the leader exits', { skip: process.platform === 'win32' }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-async-abort-'));
    const pidFile = join(directory, 'child.pid');
    const controller = new AbortController();
    let childPid: number | undefined;
    try {
      const command = new NodeCommandRunner();
      const running = command.runAsync({ command: process.execPath, args: ['-e', PROCESS_TREE_SCRIPT], cwd: directory, env: { ...process.env, PID_FILE: pidFile }, signal: controller.signal });
      childPid = await readPidFile(pidFile);
      controller.abort();
      const outcome = await running.promise;
      assert.equal(outcome.timedOut, false);
      await waitGone(childPid);
    } finally {
      killIfAlive(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('kills sync timeout descendants through the POSIX setsid wrapper', { skip: process.platform === 'win32' }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-sync-timeout-'));
    const pidFile = join(directory, 'child.pid');
    let childPid: number | undefined;
    try {
      const command = new NodeCommandRunner();
      const outcome = command.run({ command: process.execPath, args: ['-e', PROCESS_TREE_SCRIPT], cwd: directory, env: { ...process.env, PID_FILE: pidFile }, timeoutMs: 1000 });
      childPid = await readPidFile(pidFile);
      assert.equal(outcome.timedOut, true);
      await waitGone(childPid);
    } finally {
      killIfAlive(childPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('process verification host runner', () => {
  it('runs allowed commands with bash -lc, timeout mapping, and bounded auth-safe output', async () => {
    const command = new FakeCommand();
    command.runAsync = (spec) => { command.async.push(spec); return { promise: Promise.resolve(result('token-value', '', 1, true)), cancel: () => undefined }; };
    const runner = new ProcessAsyncVerificationRunner({ commandRunner: command, cwd: '/repo', allowedCommands: ['npm test'], env: { PATH: '/bin', TEST_TOKEN: 'token-value' } });
    const outcome = await runner.run({ command: 'npm test', timeoutMs: 10 });
    assert.deepEqual(command.async[0]?.args, ['-lc', 'npm test']);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.output?.includes('token-value'), false);
    await assert.rejects(runner.run({ command: 'rm -rf /' }), /authorized/);
  });
});
