import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

class ControlledHerdrCommand implements CommandRunner {
  readonly sync: CommandSpec[] = [];
  readonly jobs: Array<{ readonly spec: CommandSpec; readonly resolve: (value: CommandResult) => void; cancelled: boolean }> = [];
  private agentGets = 0;
  readonly statuses: readonly string[];
  readonly sessionFile: string;
  readonly paneId: string;
  readonly sessionPaths: readonly string[];
  constructor(statuses: readonly string[], sessionFile: string, paneId = 'pane-controlled', sessionPaths: readonly string[] = []) {
    this.statuses = statuses;
    this.sessionFile = sessionFile;
    this.paneId = paneId;
    this.sessionPaths = sessionPaths;
  }

  run(spec: CommandSpec): CommandResult {
    this.sync.push(spec);
    const args = [...spec.args];
    if (args[0] === 'tab') return result(JSON.stringify({ result: { root_pane: { pane_id: this.paneId } } }));
    if (args[0] === 'pane' && args[1] === 'list') return result(JSON.stringify({ result: { panes: [{ pane_id: this.paneId }] } }));
    if (args[0] === 'agent' && args[1] === 'get') {
      const index = this.agentGets++;
      const status = this.statuses[Math.min(index, this.statuses.length - 1)] ?? 'idle';
      const sessionFile = this.sessionPaths[Math.min(index, this.sessionPaths.length - 1)] ?? this.sessionFile;
      return result(JSON.stringify({ result: { agent: { agent_status: status, agent_session: { value: sessionFile } } } }));
    }
    return result();
  }

  runAsync(spec: CommandSpec): RunningCommand {
    this.sync.push(spec);
    let resolve!: (value: CommandResult) => void;
    const job = { spec, resolve: (value: CommandResult) => resolve(value), cancelled: false };
    this.jobs.push(job);
    const promise = new Promise<CommandResult>((next) => { resolve = next; });
    return { promise, cancel: () => { job.cancelled = true; } };
  }

  complete(index: number): void {
    const job = this.jobs[index];
    assert.ok(job, `missing async job ${index}`);
    job.resolve(result());
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
    writeFileSync(sessionFile, '');
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
    writeFileSync(sessionFile, '{"role":"assistant","content":"committed artifact"}\n');
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

  it('waits through idle after prompt success before working and then settles from the transcript', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-race-session-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['idle', 'working', 'done'], sessionFile, 'pane-race-generation');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    assert.equal(command.jobs.length, 1);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(command.jobs.length, 2);
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(port.poll('pane-race-generation'), { status: 'running' });
    assert.deepEqual(port.poll('pane-race-generation'), { status: 'running' });
    writeFileSync(sessionFile, '{"role":"assistant","content":"race result"}\n');
    assert.deepEqual(port.poll('pane-race-generation'), { status: 'settled', outcome: 'race result', resultRef: 'herdr-session:pane-race-generation' });
  });

  it('fails after bounded idle grace when no working state or assistant outcome appears', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-idle-timeout-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-idle-timeout');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-idle-timeout'), { status: 'running' });
    assert.deepEqual(port.poll('pane-idle-timeout'), { status: 'running' });
    assert.deepEqual(port.poll('pane-idle-timeout'), { status: 'running' });
    assert.deepEqual(port.poll('pane-idle-timeout'), { status: 'failed', outcome: 'herdr session JSONL was unchanged or had no new assistant outcome' });
  });

  it('accepts a genuinely quick prompt completion without observing working', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-fast-session-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['idle', 'idle'], sessionFile, 'pane-fast');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeFileSync(sessionFile, '{"role":"assistant","content":"fast result"}\n');
    assert.deepEqual(port.poll('pane-fast'), { status: 'settled', outcome: 'fast result', resultRef: 'herdr-session:pane-fast' });
  });

  it('fails after cumulative grace when done probes lack an assistant transcript', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-no-outcome-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['idle', 'working', 'done', 'working', 'done', 'done'], sessionFile, 'pane-no-outcome');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-no-outcome'), { status: 'running' });
    assert.deepEqual(port.poll('pane-no-outcome'), { status: 'running' });
    assert.deepEqual(port.poll('pane-no-outcome'), { status: 'running' });
    assert.deepEqual(port.poll('pane-no-outcome'), { status: 'running' });
    assert.deepEqual(port.poll('pane-no-outcome'), { status: 'failed', outcome: 'herdr session JSONL was unchanged or had no new assistant outcome' });
  });

  it('rejects a pre-prompt assistant outcome from the same session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-stale-session-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"assistant","content":"stale result"}\n');
    const command = new ControlledHerdrCommand(['idle', 'done'], sessionFile, 'pane-stale');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-stale'), { status: 'running' });
    assert.deepEqual(port.poll('pane-stale'), { status: 'running' });
    assert.deepEqual(port.poll('pane-stale'), { status: 'running' });
    assert.deepEqual(port.poll('pane-stale'), { status: 'failed', outcome: 'herdr session JSONL was unchanged or had no new assistant outcome' });
  });

  it('settles from only a post-boundary append and never the stale pre-prompt outcome', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-append-session-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"assistant","content":"stale pre-prompt result"}\n');
    const command = new ControlledHerdrCommand(['done', 'done', 'done'], sessionFile, 'pane-append');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The boundary was pinned over the stale pre-prompt assistant. A normal
    // post-boundary user message grows the file without a new assistant outcome.
    appendFileSync(sessionFile, '{"role":"user","content":"do the work"}\n');
    // If the implementation parsed the whole file instead of the appended bytes,
    // this would settle from the stale pre-prompt assistant right here.
    assert.deepEqual(port.poll('pane-append'), { status: 'running' });
    assert.deepEqual(port.poll('pane-append'), { status: 'running' });

    appendFileSync(sessionFile, '{"role":"assistant","content":"fresh appended result"}\n');
    assert.deepEqual(port.poll('pane-append'), { status: 'settled', outcome: 'fresh appended result', resultRef: 'herdr-session:pane-append' });
    assert.equal(port.readFinalAssistant('pane-append'), 'fresh appended result');
  });

  it('fails closed when pre-boundary bytes are mutated in place even though the file grows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-prefix-mutation-'));
    const sessionFile = join(directory, 'session.jsonl');
    const originalPrefix = '{"role":"user","content":"original boundary!!"}\n';
    const mutatedPrefix = '{"role":"user","content":"mutated boundary!!!"}\n';
    assert.equal(originalPrefix.length, mutatedPrefix.length);
    writeFileSync(sessionFile, originalPrefix);
    const command = new ControlledHerdrCommand(['done', 'done'], sessionFile, 'pane-prefix-mutation');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const inodeBefore = statSync(sessionFile).ino;
    // Same inode, same prefix length, different pinned bytes, plus a valid append.
    writeFileSync(sessionFile, `${mutatedPrefix}{"role":"assistant","content":"appended after mutation"}\n`);
    assert.equal(statSync(sessionFile).ino, inodeBefore);
    assert.deepEqual(port.poll('pane-prefix-mutation'), { status: 'failed', outcome: 'herdr session JSONL was truncated or replaced' });
  });

  it('fails closed on the bounded attempt when the agent session path never appears', async () => {
    const command = new ControlledHerdrCommand(['idle'], '/tmp/ao-unused-session.jsonl', 'pane-missing-session');
    command.run = (spec) => {
      command.sync.push(spec);
      if (spec.args[0] === 'tab') return result('{"result":{"root_pane":{"pane_id":"pane-missing-session"}}}');
      if (spec.args[0] === 'pane' && spec.args[1] === 'list') return result('{"result":{"panes":[{"pane_id":"pane-missing-session"}]}}');
      if (spec.args[0] === 'agent' && spec.args[1] === 'get') return result('{"result":{"agent":{"agent_status":"idle","agent_session":{}}}}');
      return result();
    };
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The initial start-completion attempt plus ten poll retries stay running...
    for (let retry = 0; retry < 9; retry++) assert.deepEqual(port.poll('pane-missing-session'), { status: 'running' });
    // Retry ten is the last allowed poll-driven attempt; its failure terminates.
    assert.deepEqual(port.poll('pane-missing-session'), { status: 'failed', outcome: 'herdr agent session boundary readiness budget (10 poll retries) exhausted: herdr agent session path was unavailable' });
  });

  it('delays the prompt until the session JSONL appears and then submits it exactly once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-delayed-boundary-'));
    const sessionFile = join(directory, 'session.jsonl');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-delayed-boundary');
    const port = new HerdrCliPort(herdrConfig(), command);
    assert.deepEqual(port.spawn(spawnRequest), { sessionId: 'pane-delayed-boundary' });
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // `agent start` was acknowledged, but the boundary is absent: no prompt yet.
    assert.equal(command.jobs.length, 1);
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
    assert.deepEqual(port.poll('pane-delayed-boundary'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);

    // The Pi session JSONL becomes available on a later host poll.
    writeFileSync(sessionFile, '');
    assert.deepEqual(port.poll('pane-delayed-boundary'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 1);
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Later polls must never resubmit the prompt.
    assert.deepEqual(port.poll('pane-delayed-boundary'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 1);
    appendFileSync(sessionFile, '{"role":"assistant","content":"delayed result"}\n');
    assert.deepEqual(port.poll('pane-delayed-boundary'), { status: 'settled', outcome: 'delayed result', resultRef: 'herdr-session:pane-delayed-boundary' });
    assert.equal(port.readFinalAssistant('pane-delayed-boundary'), 'delayed result');
  });

  it('fails on the documented attempt when the session JSONL path never appears', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-permanent-boundary-'));
    const sessionFile = join(directory, 'never.jsonl');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-permanent-boundary');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let retry = 0; retry < 9; retry++) assert.deepEqual(port.poll('pane-permanent-boundary'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
    assert.deepEqual(port.poll('pane-permanent-boundary'), { status: 'failed', outcome: 'herdr agent session boundary readiness budget (10 poll retries) exhausted: herdr session JSONL boundary was unavailable or malformed' });
  });

  it('accepts a boundary captured on poll retry 10 and terminates on the tenth failed retry', async () => {
    // Success on the tenth and final allowed poll-driven retry.
    const successDirectory = mkdtempSync(join(tmpdir(), 'ao-boundary-retry-ten-'));
    const successFile = join(successDirectory, 'session.jsonl');
    const success = new ControlledHerdrCommand(['idle'], successFile, 'pane-boundary-retry-ten');
    const successPort = new HerdrCliPort(herdrConfig(), success);
    successPort.spawn(spawnRequest);
    success.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let retry = 1; retry <= 9; retry++) assert.deepEqual(successPort.poll('pane-boundary-retry-ten'), { status: 'running' });
    assert.equal(success.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
    writeFileSync(successFile, '');
    assert.deepEqual(successPort.poll('pane-boundary-retry-ten'), { status: 'running' });
    assert.equal(success.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 1);

    // A failure on the tenth retry terminates immediately with no eleventh retry.
    const failureDirectory = mkdtempSync(join(tmpdir(), 'ao-boundary-retry-exhausted-'));
    const failureFile = join(failureDirectory, 'never.jsonl');
    const failure = new ControlledHerdrCommand(['idle'], failureFile, 'pane-boundary-retry-exhausted');
    const failurePort = new HerdrCliPort(herdrConfig(), failure);
    failurePort.spawn(spawnRequest);
    failure.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let retry = 1; retry <= 9; retry++) assert.deepEqual(failurePort.poll('pane-boundary-retry-exhausted'), { status: 'running' });
    assert.deepEqual(failurePort.poll('pane-boundary-retry-exhausted'), { status: 'failed', outcome: 'herdr agent session boundary readiness budget (10 poll retries) exhausted: herdr session JSONL boundary was unavailable or malformed' });
    assert.equal(failure.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
  });

  it('drops pending prompt data and fails closed as lost when the pane disappears during readiness', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-boundary-lost-'));
    const sessionFile = join(directory, 'never.jsonl');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-boundary-lost');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-boundary-lost'), { status: 'running' });
    // Narrow test-only inspection: the pane really is awaiting its boundary.
    const state = (port as unknown as { panes: Map<string, { phase: string; pendingPrompt?: unknown }> }).panes.get('pane-boundary-lost');
    assert.equal(state?.phase, 'awaiting-boundary');
    assert.notEqual(state?.pendingPrompt, undefined);

    // The host pane list no longer contains the tracked pane.
    command.run = (spec) => {
      command.sync.push(spec);
      if (spec.args[0] === 'pane' && spec.args[1] === 'list') return result('{"result":{"panes":[]}}');
      return result();
    };
    assert.deepEqual(port.poll('pane-boundary-lost'), { status: 'lost', outcome: 'herdr pane is no longer present' });
    assert.equal(state?.phase, 'terminal');
    assert.equal(state?.pendingPrompt, undefined);
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
  });

  it('recovers a malformed session JSONL before the bound and then prompts exactly once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-malformed-recovery-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, 'not-json\n');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-malformed-recovery');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let attempt = 0; attempt < 4; attempt++) assert.deepEqual(port.poll('pane-malformed-recovery'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
    writeFileSync(sessionFile, '{"role":"user","content":"prompt"}\n');
    assert.deepEqual(port.poll('pane-malformed-recovery'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 1);
  });

  it('fails closed when a malformed session JSONL persists past the bound', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-malformed-permanent-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, 'not-json\n');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-malformed-permanent');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let retry = 0; retry < 9; retry++) assert.deepEqual(port.poll('pane-malformed-permanent'), { status: 'running' });
    assert.deepEqual(port.poll('pane-malformed-permanent'), { status: 'failed', outcome: 'herdr agent session boundary readiness budget (10 poll retries) exhausted: herdr session JSONL boundary was unavailable or malformed' });
  });

  it('never starts the prompt when the pane is closed or interrupted during boundary readiness', async () => {
    const closeDirectory = mkdtempSync(join(tmpdir(), 'ao-close-boundary-'));
    const closeFile = join(closeDirectory, 'never.jsonl');
    const closed = new ControlledHerdrCommand(['idle'], closeFile, 'pane-close-boundary');
    const closePort = new HerdrCliPort(herdrConfig(), closed);
    closePort.spawn(spawnRequest);
    closed.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(closePort.poll('pane-close-boundary'), { status: 'running' });
    closePort.close('pane-close-boundary');
    writeFileSync(closeFile, '');
    assert.deepEqual(closePort.poll('pane-close-boundary'), { status: 'cancelled', outcome: 'worker pane closed' });
    assert.equal(closed.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);

    const cancelDirectory = mkdtempSync(join(tmpdir(), 'ao-cancel-boundary-'));
    const cancelFile = join(cancelDirectory, 'never.jsonl');
    const cancelled = new ControlledHerdrCommand(['idle'], cancelFile, 'pane-cancel-boundary');
    const cancelPort = new HerdrCliPort(herdrConfig(), cancelled);
    cancelPort.spawn(spawnRequest);
    cancelled.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelPort.poll('pane-cancel-boundary'), { status: 'running' });
    cancelPort.interrupt('pane-cancel-boundary', 'stop');
    writeFileSync(cancelFile, '');
    assert.deepEqual(cancelPort.poll('pane-cancel-boundary'), { status: 'cancelled', outcome: 'worker interrupted' });
    assert.equal(cancelled.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
  });

  it('does not consume a pre-prompt working snapshot as post-prompt state after boundary capture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-pre-prompt-working-'));
    const sessionFile = join(directory, 'session.jsonl');
    const command = new ControlledHerdrCommand(['working', 'working', 'done'], sessionFile, 'pane-pre-prompt-working');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The initial capture failed (file absent); the next poll's snapshot is working.
    writeFileSync(sessionFile, '');
    assert.deepEqual(port.poll('pane-pre-prompt-working'), { status: 'running' });
    assert.equal(command.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 1);
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // A pre-prompt working snapshot must not set workingSeen: post-prompt idle
    // grace (3) applies, not transcript grace after working (2).
    assert.deepEqual(port.poll('pane-pre-prompt-working'), { status: 'running' });
    assert.deepEqual(port.poll('pane-pre-prompt-working'), { status: 'running' });
    assert.deepEqual(port.poll('pane-pre-prompt-working'), { status: 'running' });
    assert.deepEqual(port.poll('pane-pre-prompt-working'), { status: 'failed', outcome: 'herdr session JSONL was unchanged or had no new assistant outcome' });
  });

  it('fails closed without launching the prompt for a pre-prompt blocked or cancelled agent', async () => {
    const blockedDirectory = mkdtempSync(join(tmpdir(), 'ao-pre-prompt-blocked-'));
    const blockedFile = join(blockedDirectory, 'session.jsonl');
    const blocked = new ControlledHerdrCommand(['blocked'], blockedFile, 'pane-pre-prompt-blocked');
    const blockedPort = new HerdrCliPort(herdrConfig(), blocked);
    blockedPort.spawn(spawnRequest);
    blocked.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeFileSync(blockedFile, '');
    assert.deepEqual(blockedPort.poll('pane-pre-prompt-blocked'), { status: 'failed', outcome: 'worker is blocked' });
    assert.equal(blocked.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);

    const cancelledDirectory = mkdtempSync(join(tmpdir(), 'ao-pre-prompt-cancelled-'));
    const cancelledFile = join(cancelledDirectory, 'session.jsonl');
    const cancelled = new ControlledHerdrCommand(['cancelled'], cancelledFile, 'pane-pre-prompt-cancelled');
    const cancelledPort = new HerdrCliPort(herdrConfig(), cancelled);
    cancelledPort.spawn(spawnRequest);
    cancelled.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeFileSync(cancelledFile, '');
    assert.deepEqual(cancelledPort.poll('pane-pre-prompt-cancelled'), { status: 'cancelled', outcome: 'worker was cancelled' });
    assert.equal(cancelled.jobs.filter((job) => job.spec.args[1] === 'prompt').length, 0);
  });

  it('rejects an oversized appended assistant outcome permanently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-oversized-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['done', 'done'], sessionFile, 'pane-oversized');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    appendFileSync(sessionFile, `${JSON.stringify({ role: 'assistant', content: 'x'.repeat(32 * 1024 + 1) })}\n`);
    assert.deepEqual(port.poll('pane-oversized'), { status: 'failed', outcome: 'herdr assistant result exceeded the in-memory limit' });
  });

  it('reads the settled assistant exactly once and rejects premature or repeated reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-one-shot-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['done', 'done'], sessionFile, 'pane-one-shot');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(() => port.readFinalAssistant('pane-one-shot'), /unavailable before a terminal settled state/);
    appendFileSync(sessionFile, '{"role":"assistant","content":"one shot result"}\n');
    assert.deepEqual(port.poll('pane-one-shot'), { status: 'settled', outcome: 'one shot result', resultRef: 'herdr-session:pane-one-shot' });
    assert.equal(port.readFinalAssistant('pane-one-shot'), 'one shot result');
    assert.throws(() => port.readFinalAssistant('pane-one-shot'), /already read/);
  });

  it('fails closed when the agent session path changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-changed-session-'));
    const firstSession = join(directory, 'first.jsonl');
    const secondSession = join(directory, 'second.jsonl');
    writeFileSync(firstSession, '{"role":"user","content":"prompt"}\n');
    writeFileSync(secondSession, '{"role":"assistant","content":"wrong session"}\n');
    const command = new ControlledHerdrCommand(['idle', 'done'], firstSession, 'pane-changed', [firstSession, secondSession]);
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(port.poll('pane-changed'), { status: 'failed', outcome: 'herdr agent session path changed' });
  });

  it('fails closed when the session is replaced instead of appended', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-replaced-session-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"prompt"}\n');
    const command = new ControlledHerdrCommand(['idle', 'done'], sessionFile, 'pane-replaced');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replacementFile = join(directory, 'replacement.jsonl');
    writeFileSync(replacementFile, '{"role":"user","content":"prompt"}\n{"role":"assistant","content":"replacement"}\n');
    rmSync(sessionFile);
    renameSync(replacementFile, sessionFile);
    assert.deepEqual(port.poll('pane-replaced'), { status: 'failed', outcome: 'herdr session JSONL was replaced' });
  });

  it('fails closed when the session is truncated before completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-truncated-session-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"long pre-prompt boundary"}\n');
    const command = new ControlledHerdrCommand(['idle', 'done'], sessionFile, 'pane-truncated');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeFileSync(sessionFile, '{"role":"user"}\n');
    assert.deepEqual(port.poll('pane-truncated'), { status: 'failed', outcome: 'herdr session JSONL was truncated or replaced' });
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
    writeFileSync(sessionFile, '{"role":"user","content":"prompt"}\n');
    const command = new FakeCommand();
    command.sessionFile = sessionFile;
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeFileSync(sessionFile, '{"role":"user","content":"prompt"}\nnot-json\n');
    assert.deepEqual(port.poll('pane-1'), { status: 'running' });
    assert.deepEqual(port.poll('pane-1'), { status: 'running' });
    assert.deepEqual(port.poll('pane-1'), { status: 'running' });
    assert.deepEqual(port.poll('pane-1'), { status: 'failed', outcome: 'herdr session JSONL was malformed or had no new assistant outcome' });
  });

  it('reattaches with a single-turn boundary and never accepts a stale outcome', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-reattach-stale-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"assistant","content":"before recovery"}\n');
    const command = new ControlledHerdrCommand(['idle', 'done'], sessionFile, 'pane-reattach-stale');
    const port = new HerdrCliPort(herdrConfig(), command);
    assert.deepEqual(port.reattach('pane-reattach-stale', '/tmp/worktree'), { sessionId: 'pane-reattach-stale' });
    assert.deepEqual(port.poll('pane-reattach-stale'), { status: 'running' });
    assert.deepEqual(port.poll('pane-reattach-stale'), { status: 'running' });
    assert.deepEqual(port.poll('pane-reattach-stale'), { status: 'running' });
    assert.deepEqual(port.poll('pane-reattach-stale'), { status: 'failed', outcome: 'herdr session JSONL was unchanged or had no new assistant outcome' });
  });

  it('re-pins the boundary and resets grace on reattach after an implicit poll attachment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-reattach-repin-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"pre-existing turn"}\n');
    const command = new ControlledHerdrCommand(['done'], sessionFile, 'pane-reattach-repin');
    const port = new HerdrCliPort(herdrConfig(), command);

    // Implicit attachment through poll(unknown pane) pins boundary #1 and probes done.
    assert.deepEqual(port.poll('pane-reattach-repin'), { status: 'running' });
    // Exhaust the post-prompt idle grace before the explicit reattach.
    assert.deepEqual(port.poll('pane-reattach-repin'), { status: 'running' });
    assert.deepEqual(port.poll('pane-reattach-repin'), { status: 'running' });

    // A completion lands after implicit attachment but before reattach; it is stale.
    appendFileSync(sessionFile, '{"role":"assistant","content":"stale intermediate"}\n');
    assert.deepEqual(port.reattach('pane-reattach-repin', '/tmp/worktree'), { sessionId: 'pane-reattach-repin' });

    // Reattach re-pinned the boundary over the intermediate outcome and reset the
    // grace counters: this is running (not settled stale, not failed from grace).
    assert.deepEqual(port.poll('pane-reattach-repin'), { status: 'running' });

    appendFileSync(sessionFile, '{"role":"assistant","content":"later result"}\n');
    assert.deepEqual(port.poll('pane-reattach-repin'), { status: 'settled', outcome: 'later result', resultRef: 'herdr-session:pane-reattach-repin' });
    assert.equal(port.readFinalAssistant('pane-reattach-repin'), 'later result');
  });

  it('leaves tracked state untouched when a reattach boundary capture fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-reattach-atomic-'));
    const sessionFile = join(directory, 'session.jsonl');
    const missingFile = join(directory, 'missing.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"pre-existing turn"}\n');
    const command = new ControlledHerdrCommand(['done'], sessionFile, 'pane-reattach-atomic', [sessionFile, sessionFile, sessionFile, sessionFile, missingFile, sessionFile]);
    const port = new HerdrCliPort(herdrConfig(), command);

    assert.deepEqual(port.poll('pane-reattach-atomic'), { status: 'running' });
    assert.deepEqual(port.poll('pane-reattach-atomic'), { status: 'running' });
    assert.deepEqual(port.poll('pane-reattach-atomic'), { status: 'running' });

    assert.throws(() => port.reattach('pane-reattach-atomic', '/tmp/worktree'), /cannot reattach/);
    // A failed re-pin must not reset the exhausted grace: the next done probe fails.
    assert.deepEqual(port.poll('pane-reattach-atomic'), { status: 'failed', outcome: 'herdr session JSONL was unchanged or had no new assistant outcome' });
  });

  it('fails closed instead of reattaching an actively starting or terminal pane', async () => {
    const starting = new DeferredCommand();
    const startingPort = new HerdrCliPort(herdrConfig(), starting);
    startingPort.spawn(spawnRequest);
    assert.throws(() => startingPort.reattach('pane-race'), /actively starting, awaiting a boundary, or prompting/);
    startingPort.close('pane-race');
    starting.jobs[0]!.resolve(result());
    await new Promise<void>((resolve) => setImmediate(resolve));

    const directory = mkdtempSync(join(tmpdir(), 'ao-reattach-terminal-'));
    const sessionFile = join(directory, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const command = new ControlledHerdrCommand(['done'], sessionFile, 'pane-reattach-terminal');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    command.complete(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    appendFileSync(sessionFile, '{"role":"assistant","content":"terminal result"}\n');
    assert.deepEqual(port.poll('pane-reattach-terminal'), { status: 'settled', outcome: 'terminal result', resultRef: 'herdr-session:pane-reattach-terminal' });
    assert.throws(() => port.reattach('pane-reattach-terminal'), /terminal/);
  });

  it('refuses to reattach a pane that is awaiting its session boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-reattach-awaiting-'));
    const sessionFile = join(directory, 'never.jsonl');
    const command = new ControlledHerdrCommand(['idle'], sessionFile, 'pane-reattach-awaiting');
    const port = new HerdrCliPort(herdrConfig(), command);
    port.spawn(spawnRequest);
    command.complete(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Start was acknowledged but the JSONL is absent, so the pane is in the
    // bounded pre-prompt readiness phase rather than merely starting.
    assert.deepEqual(port.poll('pane-reattach-awaiting'), { status: 'running' });
    assert.throws(() => port.reattach('pane-reattach-awaiting'), /actively starting, awaiting a boundary, or prompting/);
    port.close('pane-reattach-awaiting');
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
