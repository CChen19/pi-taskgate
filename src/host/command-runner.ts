import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, chmodSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export type CommandResult = {
  readonly status: 'exited' | 'signaled' | 'failed';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
};

export interface RunningCommand {
  readonly promise: Promise<CommandResult>;
  cancel(): void;
}

export interface CommandRunner {
  run(spec: CommandSpec): CommandResult;
  runAsync(spec: CommandSpec): RunningCommand;
}

const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

/**
 * Smallest hermetic environment shared by task and integration verification
 * (and host git) commands; never forwards the full process environment.
 */
export function minimalProcessEnv(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const origin = source ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    const value = origin[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const POSIX = process.platform !== 'win32';
const KILL_GRACE_MS = 150;
const SETSID = existsSync('/usr/bin/setsid') ? '/usr/bin/setsid' : '/bin/setsid';

interface OutputBuffer {
  readonly chunks: Buffer[];
  total: number;
  truncated: boolean;
}

function outputBuffer(): OutputBuffer {
  return { chunks: [], total: 0, truncated: false };
}

function appendOutput(target: OutputBuffer, chunk: Buffer | string, limit: number): void {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  target.total += value.byteLength;
  if (target.total > limit) target.truncated = true;
  const kept = Buffer.concat(target.chunks).byteLength;
  if (kept < limit) target.chunks.push(value.subarray(0, limit - kept));
}

function outputText(target: OutputBuffer): string {
  return Buffer.concat(target.chunks).toString('utf8');
}

function resultFrom(
  status: CommandResult['status'],
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  timedOut: boolean,
  stdout: OutputBuffer,
  stderr: OutputBuffer,
  limit: number,
  stdoutHint = false,
  stderrHint = false,
): CommandResult {
  return Object.freeze({
    status,
    exitCode,
    signal,
    timedOut,
    stdout: outputText(stdout),
    stderr: outputText(stderr),
    stdoutTruncated: stdout.truncated || stdoutHint || stdout.total > limit,
    stderrTruncated: stderr.truncated || stderrHint || stderr.total > limit,
  });
}

function normalizeSpec(spec: CommandSpec): CommandSpec {
  if (typeof spec.command !== 'string' || spec.command.length === 0 || !Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== 'string') || typeof spec.cwd !== 'string' || spec.cwd.length === 0 || spec.env === undefined) {
    throw new TypeError('command spec requires command, argv, cwd, and env');
  }
  if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)) throw new TypeError('command timeoutMs must be a positive integer');
  if (spec.maxOutputBytes !== undefined && (!Number.isInteger(spec.maxOutputBytes) || spec.maxOutputBytes <= 0)) throw new TypeError('command maxOutputBytes must be a positive integer');
  return spec;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (POSIX) {
    signalGroup(child.pid, signal);
    return;
  }
  try { child.kill(signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

const SYNC_GROUP_WRAPPER = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const marker = process.argv[1];
const command = process.argv[2];
const args = process.argv.slice(3);
fs.writeFileSync(marker, String(process.pid), { encoding: 'utf8', mode: 0o600 });
try {
  const result = spawnSync(command, args, { shell: false, stdio: 'inherit' });
  process.exitCode = result.status === null ? 1 : result.status;
} finally {
  try { fs.unlinkSync(marker); } catch {}
}
`;

function readPid(marker: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(marker, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 1 ? value : undefined;
  } catch { return undefined; }
}

function cleanupDirectory(directory: string, marker: string): void {
  try { unlinkSync(marker); } catch { /* already removed */ }
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ }
}

function isOutputLimitError(error: NodeJS.ErrnoException | undefined): boolean {
  return error?.code === 'ENOBUFS' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function syncResult(raw: ReturnType<typeof spawnSync>, stdout: OutputBuffer, stderr: OutputBuffer, limit: number, timedOut: boolean, outputLimit: boolean): CommandResult {
  const error = raw.error as (NodeJS.ErrnoException | undefined);
  if (error !== undefined && !timedOut && !outputLimit && raw.status === null) appendOutput(stderr, `\n${error.message}`, limit);
  if (error !== undefined && !timedOut && !outputLimit && raw.status === null) return resultFrom('failed', null, raw.signal, false, stdout, stderr, limit);
  return resultFrom(raw.status === null ? 'signaled' : 'exited', raw.status, raw.signal, timedOut, stdout, stderr, limit, outputLimit, outputLimit);
}

/** Node implementation. shell is deliberately never enabled. */
export class NodeCommandRunner implements CommandRunner {
  run(rawSpec: CommandSpec): CommandResult {
    const spec = normalizeSpec(rawSpec);
    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!POSIX) return this.runWindowsSync(spec, limit);
    const directory = mkdtempSync(join(tmpdir(), 'ao-command-'));
    chmodSync(directory, 0o700);
    const marker = join(directory, 'pgid');
    let raw: ReturnType<typeof spawnSync>;
    try {
      raw = spawnSync(SETSID, [process.execPath, '-e', SYNC_GROUP_WRAPPER, marker, spec.command, ...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        timeout: spec.timeoutMs,
        maxBuffer: limit,
        encoding: 'buffer' as unknown as BufferEncoding,
      });
      const stdout = outputBuffer();
      const stderr = outputBuffer();
      appendOutput(stdout, Buffer.isBuffer(raw.stdout) ? raw.stdout : Buffer.from(raw.stdout ?? ''), limit);
      appendOutput(stderr, Buffer.isBuffer(raw.stderr) ? raw.stderr : Buffer.from(raw.stderr ?? ''), limit);
      const error = raw.error as (NodeJS.ErrnoException | undefined);
      const timedOut = error?.code === 'ETIMEDOUT' || (error?.message.includes('ETIMEDOUT') ?? false);
      const outputLimit = isOutputLimitError(error);
      if (timedOut || outputLimit) {
        const pgid = readPid(marker);
        if (pgid !== undefined) {
          try { signalGroup(pgid, 'SIGKILL'); } catch (killError) { appendOutput(stderr, `\nprocess-group kill failed: ${(killError as Error).message}`, limit); }
        }
      }
      return syncResult(raw, stdout, stderr, limit, timedOut, outputLimit);
    } finally {
      cleanupDirectory(directory, marker);
    }
  }

  private runWindowsSync(spec: CommandSpec, limit: number): CommandResult {
    const raw = spawnSync(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, timeout: spec.timeoutMs, maxBuffer: limit, encoding: 'buffer' as unknown as BufferEncoding });
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    appendOutput(stdout, Buffer.isBuffer(raw.stdout) ? raw.stdout : Buffer.from(raw.stdout ?? ''), limit);
    appendOutput(stderr, Buffer.isBuffer(raw.stderr) ? raw.stderr : Buffer.from(raw.stderr ?? ''), limit);
    const error = raw.error as (NodeJS.ErrnoException | undefined);
    const timedOut = error?.code === 'ETIMEDOUT' || (error?.message.includes('ETIMEDOUT') ?? false);
    const outputLimit = isOutputLimitError(error);
    return syncResult(raw, stdout, stderr, limit, timedOut, outputLimit);
  }

  runAsync(rawSpec: CommandSpec): RunningCommand {
    const spec = normalizeSpec(rawSpec);
    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let child: ChildProcess | undefined;
    let settled = false;
    let timedOut = false;
    let terminationRequested = false;
    let killStageComplete = !POSIX;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let pendingFinish: { readonly status: CommandResult['status']; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null } | undefined;
    let resolvePromise!: (result: CommandResult) => void;
    const promise = new Promise<CommandResult>((resolve) => { resolvePromise = resolve; });
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const finish = (status: CommandResult['status'], exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (terminationRequested && !killStageComplete) {
        pendingFinish = { status, exitCode, signal };
        return;
      }
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      resolvePromise(resultFrom(status, exitCode, signal, timedOut, stdout, stderr, limit));
    };
    const completeKillStage = (): void => {
      killStageComplete = true;
      if (pendingFinish !== undefined) finish(pendingFinish.status, pendingFinish.exitCode, pendingFinish.signal);
    };
    const forceKill = (): void => {
      try {
        if (child !== undefined) killProcessGroup(child, 'SIGKILL');
      } catch (error) {
        appendOutput(stderr, `\nprocess-group kill failed: ${(error as Error).message}`, limit);
      } finally {
        completeKillStage();
      }
    };
    const terminate = (timeout: boolean): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      timedOut ||= timeout;
      if (child === undefined) { completeKillStage(); return; }
      try { killProcessGroup(child, 'SIGTERM'); }
      catch (error) { appendOutput(stderr, `\nprocess-group terminate failed: ${(error as Error).message}`, limit); }
      killTimer = setTimeout(forceKill, KILL_GRACE_MS);
    };
    try {
      child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, detached: POSIX, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer | string) => appendOutput(stdout, chunk, limit));
      child.stderr?.on('data', (chunk: Buffer | string) => appendOutput(stderr, chunk, limit));
      child.once('error', (error) => { appendOutput(stderr, error.message, limit); finish('failed', null, null); });
      child.once('exit', (code, signal) => finish(code === null ? 'signaled' : 'exited', code, signal));
      if (spec.timeoutMs !== undefined) timeoutTimer = setTimeout(() => terminate(true), spec.timeoutMs);
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate(false);
        else spec.signal.addEventListener('abort', () => terminate(false), { once: true });
      }
    } catch (error) {
      appendOutput(stderr, error instanceof Error ? error.message : 'spawn failed', limit);
      finish('failed', null, null);
    }
    return { promise, cancel: () => terminate(false) };
  }
}
