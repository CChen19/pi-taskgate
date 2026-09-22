import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeCommandRunner } from '../src/host/command-runner.ts';
import type { CommandRunner, CommandSpec, CommandResult, RunningCommand } from '../src/host/command-runner.ts';
import { GitWorktreePort, changedFromStatus } from '../src/host/git-worktree-port.ts';
import { HerdrCliPort } from '../src/host/herdr-cli-port.ts';
import { ProcessVerificationRunner } from '../src/host/process-verification-runner.ts';
import { GitIntegrationRunner } from '../src/host/git-integration-runner.ts';
import { planIntegration, runIntegration } from '../src/core/integration.ts';
import { WorktreeManager, WORKTREE_MARKER_PREFIX } from '../src/adapters/worktree-manager.ts';
import type { HerdrSpawnRequest } from '../src/adapters/pi-herdr-executor.ts';

function result(stdout = '', stderr = '', exitCode = 0, timedOut = false): CommandResult {
  return { status: timedOut ? 'signaled' : 'exited', exitCode, signal: null, timedOut, stdout, stderr, stdoutTruncated: false, stderrTruncated: false };
}

class DeferredCommand implements CommandRunner {
  readonly jobs: Array<{ readonly spec: CommandSpec; readonly resolve: (value: CommandResult) => void; cancelled: boolean }> = [];
  readonly sync: CommandSpec[] = [];

  run(spec: CommandSpec): CommandResult {
    this.sync.push(spec);
    return spec.args[0] === 'tab' ? result('{"result":{"root_pane":{"pane_id":"pane-race"}}}') : result();
  }

  runAsync(spec: CommandSpec): RunningCommand {
    this.sync.push(spec);
    let resolve!: (value: CommandResult) => void;
    const job = { spec, resolve: (value: CommandResult) => resolve(value), cancelled: false };
    this.jobs.push(job);
    const promise = new Promise<CommandResult>((next) => { resolve = next; });
    return { promise, cancel: () => { job.cancelled = true; } };
  }
}

class FakeCommand implements CommandRunner {
  readonly sync: CommandSpec[] = [];
  readonly async: CommandSpec[] = [];
  status = '';
  commits = '1\n';
  workspace = '/tmp/fake-worktree';
  sessionFile: string | undefined;

  run(spec: CommandSpec): CommandResult {
    this.sync.push(spec);
    const args = [...spec.args];
    if (args[0] === 'tab') return result('{"result":{"root_pane":{"pane_id":"pane-1"}}}');
    if (args[0] === 'pane' && args[1] === 'list') return result('{"result":{"panes":[{"pane_id":"pane-1"}]}}');
    if (args[0] === 'agent' && args[1] === 'get') {
      const status = this.sync.filter((entry) => entry.args[0] === 'agent' && entry.args[1] === 'get').length === 1 ? 'working' : 'idle';
      return result(JSON.stringify({ result: { agent: { agent_status: status, agent_session: { value: this.sessionFile ?? '/tmp/session.jsonl' } } } }));
    }
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

function herdrConfig() {
  return {
    herdrBinary: 'herdr', piExtension: '/pier-ext/src/index.ts', provider: 'fixture-provider', model: 'fixture/model', workspaceId: 'ws-1',
    roleManifests: { implementer: { tools: ['read'] } }, roleBases: { implementer: '/repo' },
    timeouts: { startMs: 1000, promptMs: 2000, probeMs: 100 },
  } as const;
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

const spawnRequest: HerdrSpawnRequest = {
  taskId: 'T-host', attemptId: 'T-host:attempt-1', cwd: '/tmp/worktree', roleId: 'implementer', modelProfileId: 'profile-fast', provider: 'provider', model: 'model',
  contract: { id: 'T-host', objective: 'do work', depends_on: [], files_in_scope: [], acceptance_criteria: ['done'], verification: [], retry: { max_attempts: 0 } },
  scopedContext: {} as never, prompt: 'do the work', baseRevision: 'base',
};

describe('host command seams', () => {
  it('uses the public herdr command sequence and maps working then idle', async () => {
    const command = new FakeCommand();
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'ao-session-')), 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"assistant","content":"committed artifact"}\n');
    command.sessionFile = sessionFile;
    const port = new HerdrCliPort({ ...herdrConfig(), env: { API_KEY: 'secret', HERDR_ENV: 'test' } }, command);
    const spawned = port.spawn(spawnRequest) as { sessionId: string };
    assert.equal(spawned.sessionId, 'pane-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(command.sync[0]?.args[0], 'tab');
    assert.match(command.async[0]?.args[2] ?? '', /^[a-z][a-z0-9_-]{0,31}$/);
    assert.deepEqual(command.async[0]?.args.slice(0, 6), ['agent', 'start', command.async[0]?.args[2], '--kind', 'pi', '--pane']);
    assert.equal(command.async[0]?.args.at(-1), 'fullscreen');
    assert.deepEqual(command.async[0]?.args.slice(-6), ['--provider', 'provider', '--model', 'model', '--tui-mode', 'fullscreen']);
    assert.equal(command.sync[0]?.args.at(-1), 'PI_HERDR_ROLE_BASE=/repo');
    assert.equal(command.sync[0]?.args.includes('PI_HERDR_SUBAGENT=1'), true);
    assert.equal(command.sync[0]?.args.some((arg) => arg === '--workspace' || arg === 'ws-1'), true);
    assert.equal(command.sync[0]?.env.API_KEY, undefined);
    assert.equal(command.sync[0]?.env.HERDR_ENV, 'test');
    assert.deepEqual(port.poll('pane-1'), { status: 'running' });
    assert.deepEqual(port.poll('pane-1'), { status: 'settled', outcome: 'committed artifact', resultRef: 'herdr-session:pane-1' });
    const listCall = command.sync.find((entry) => entry.args[0] === 'pane' && entry.args[1] === 'list');
    assert.deepEqual(listCall?.args.slice(-2), ['--workspace', 'ws-1']);
    const active = new HerdrCliPort(herdrConfig(), command);
    active.spawn(spawnRequest);
    active.interrupt('pane-1', 'stop');
    assert.ok(command.sync.some((entry) => entry.args[0] === 'agent' && entry.args[1] === 'send-keys'));
    port.close('pane-1');
    assert.ok(command.sync.some((entry) => entry.args[0] === 'pane' && entry.args[1] === 'close'));
  });

  it('accepts a prompt --wait completion when the first probe is already idle/done', async () => {
    const command = new FakeCommand();
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'ao-fast-session-')), 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"assistant","content":"fast result"}\n');
    command.sessionFile = sessionFile;
    command.run = (spec) => {
      command.sync.push(spec);
      if (spec.args[0] === 'tab') return result('{"result":{"root_pane":{"pane_id":"pane-fast"}}}');
      if (spec.args[0] === 'pane' && spec.args[1] === 'list') return result('{"result":{"panes":[{"pane_id":"pane-fast"}]}}');
      if (spec.args[0] === 'agent' && spec.args[1] === 'get') return result(JSON.stringify({ result: { agent: { agent_status: 'idle', agent_session: { value: sessionFile } } } }));
      return result();
    };
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-fast'), { status: 'settled', outcome: 'fast result', resultRef: 'herdr-session:pane-fast' });
  });

  it('cancels stale start continuations on close and never starts prompt afterward', async () => {
    const command = new DeferredCommand();
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    assert.equal(command.jobs.length, 1);
    port.close('pane-race');
    command.jobs[0]!.resolve(result());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(command.jobs.length, 1);
    assert.deepEqual(port.poll('pane-race'), { status: 'cancelled', outcome: 'worker pane closed' });
    port.close('pane-race');
  });

  it('fails closed on extra stdout JSON and malformed session JSONL', async () => {
    const malformedOutput = new FakeCommand();
    malformedOutput.run = (spec) => {
      malformedOutput.sync.push(spec);
      if (spec.args[0] === 'tab') return result('{"result":{"root_pane":{"pane_id":"pane-bad"}}}\n{}');
      return result();
    };
    assert.throws(() => new HerdrCliPort(herdrConfig(), malformedOutput).spawn(spawnRequest), /JSON/);

    const sessionFile = join(mkdtempSync(join(tmpdir(), 'ao-malformed-')), 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"assistant","content":"ok"}\nnot-json\n');
    const command = new FakeCommand();
    command.sessionFile = sessionFile;
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-1'), { status: 'running' });
    assert.deepEqual(port.poll('pane-1'), { status: 'failed', outcome: 'herdr session JSONL was malformed or had no assistant outcome' });
  });

  it('maps absent panes to lost and supports pane-id reattach without spawn', () => {
    const command = new FakeCommand();
    command.run = (spec) => {
      command.sync.push(spec);
      if (spec.args[0] === 'pane' && spec.args[1] === 'list') return result('{"result":{"panes":[]}}');
      return result();
    };
    const port = new HerdrCliPort(herdrConfig(), command);
    assert.deepEqual(port.poll('gone'), { status: 'lost', outcome: 'herdr pane is no longer present' });
    assert.throws(() => port.reattach('gone'), /missing/);
  });
});

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

describe('integration verification host runner', () => {
  it('uses the integration cwd, exact allowlist, hermetic env, timeout, and bounded output', () => {
    const specs: CommandSpec[] = [];
    const integration = { taskId: 'Tintegration', attemptId: 'a-1', baseRevision: 'base', workspacePath: '/integration', branch: 'integration/branch', ownershipToken: 'token', managedMarker: 'agent-orchestrator:token' };
    const commandRunner = {
      run: (spec: CommandSpec) => { specs.push(spec); return result(spec.args[0] === 'rev-parse' ? 'ok\n' : ''); },
      runAsync: () => { throw new Error('unused'); },
    };
    const runner = new GitIntegrationRunner({ commandRunner, integration, baseRevision: 'base', verificationAllowlist: ['final'], verificationTimeoutMs: 77, env: { PATH: '/bin', HOME: '/home', SECRET_TOKEN: 'topsecret', API_KEY: 'zzz' } });
    const unit = { taskId: 'Tone', branch: 'integration/Tone', revision: 'ok', verification: { verdict: 'passed', reasons: ['ok'], artifactRevision: 'ok' } };
    const rebased = runner.gitOps.rebase('base', unit as never);
    assert.equal((rebased as { ok: boolean }).ok, true);
    assert.throws(() => runner.gitOps.rebase('a-different-base', unit as never), /does not match the configured base revision/);
    const outcome = runner.commandRunner.run({ command: 'final' });
    assert.equal((outcome as { exitCode: number }).exitCode, 0);
    assert.equal(specs.length, 3);
    assert.deepEqual(specs[0]?.args.slice(0, 2), ['rev-parse', 'integration/Tone']);
    assert.equal(specs.at(-1)?.command, 'bash');
    for (const spec of specs) {
      assert.equal(spec.cwd, '/integration');
      assert.equal(spec.timeoutMs, 77);
      assert.ok((spec.maxOutputBytes ?? 0) > 0);
      assert.equal(spec.env.SECRET_TOKEN, undefined);
      assert.equal(spec.env.API_KEY, undefined);
      assert.deepEqual(Object.keys(spec.env).every((key) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key)), true);
    }
    assert.throws(() => runner.commandRunner.run({ command: 'unauthorized' }), /authorized/);
  });

  it('asPort() crosses the strict core boundary: plain and frozen, full pipeline merged; the raw class instance must not', () => {
    const commandRunner = {
      run: (spec: CommandSpec) => {
        if (spec.command === 'bash') return result('final verification passed');
        const [verb, ...rest] = spec.args;
        return result(verb === 'rev-parse' && rest[0] === 'HEAD' ? 'merged-1' : verb === 'rev-parse' ? 'rev-unit' : '');
      },
      runAsync: () => { throw new Error('unused'); },
    };
    const integration = { taskId: 'Tintegration', attemptId: 'a-1', baseRevision: 'base', workspacePath: '/integration', branch: 'integration/branch', ownershipToken: 'token', managedMarker: 'agent-orchestrator:token' };
    const runner = new GitIntegrationRunner({ commandRunner, integration, baseRevision: 'base', verificationAllowlist: ['final'], verificationTimeoutMs: 77 });
    const unit = { taskId: 'Tone', branch: 'integration/Tone', revision: 'rev-unit', verification: { verdict: 'passed', reasons: [], artifactRevision: 'rev-unit' } };
    const plan = planIntegration([unit], { baseRevision: 'base', verificationCommands: ['final'] });
    const port = runner.asPort();
    assert.equal(Object.getPrototypeOf(port), Object.prototype);
    assert.equal(Object.getPrototypeOf(port.gitOps), Object.prototype);
    assert.equal(Object.getPrototypeOf(port.commandRunner), Object.prototype);
    assert.equal(Object.isFrozen(port) && Object.isFrozen(port.gitOps) && Object.isFrozen(port.commandRunner), true);
    const report = runIntegration(plan, port, { clock: () => 0 });
    assert.equal(report.outcome, 'merged');
    assert.equal(report.steps.map((step) => step.name).join(','), 'rebase,merge,verification,conflict-check,status');
    assert.equal(report.finalVerification?.verdict.verdict, 'passed');
    assert.equal(report.finalVerification?.evidence.artifactRevision, 'merged-1');
    // Contrast: the strict plain-object core boundary must keep rejecting the class instance.
    assert.throws(() => runIntegration(plan, runner, { clock: () => 0 }), /runner must be a plain object/);
  });
});

describe('process verification host runner', () => {
  it('runs allowed commands with bash -lc, timeout mapping, and bounded auth-safe output', () => {
    const command = new FakeCommand();
    command.run = (spec) => { command.sync.push(spec); return result('token-value', '', 1, true); };
    const runner = new ProcessVerificationRunner({ commandRunner: command, cwd: '/repo', allowedCommands: ['npm test'], env: { PATH: '/bin', TEST_TOKEN: 'token-value' } });
    const outcome = runner.run({ command: 'npm test', timeoutMs: 10 });
    assert.deepEqual(command.sync[0]?.args, ['-lc', 'npm test']);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.output?.includes('token-value'), false);
    assert.throws(() => runner.run({ command: 'rm -rf /' }), /authorized/);
  });
});
