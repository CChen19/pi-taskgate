import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { CommandRunner, CommandSpec, RunningCommand } from './command-runner.ts';
import type { HerdrSpawnRequest, HerdrSubagentPort } from '../adapters/pi-herdr-executor.ts';

export interface HerdrTimeouts {
  readonly startMs: number;
  readonly promptMs: number;
  readonly probeMs: number;
}

export interface HerdrCliConfig {
  readonly herdrBinary: string;
  readonly piExtension: string;
  /** Fallback only; a non-empty request provider/model always wins. */
  readonly provider: string;
  /** Fallback only; a non-empty request provider/model always wins. */
  readonly model: string;
  readonly workspaceId: string;
  readonly roleManifests: Readonly<Record<string, unknown>>;
  readonly roleBases: Readonly<Record<string, string>>;
  readonly timeouts: HerdrTimeouts;
  /** Optional source for explicitly selected pass-through variables. */
  readonly env?: NodeJS.ProcessEnv;
  readonly passEnv?: readonly string[];
  readonly maxOutputBytes?: number;
}

type Terminal = { readonly status: 'settled' | 'failed' | 'cancelled' | 'lost'; readonly outcome: string; readonly resultRef?: string };
const MAX_ASSISTANT_TEXT = 32 * 1024;
type Probe = { readonly status: 'working' | 'done' | 'blocked' | 'cancelled' | 'failed' | 'missing'; readonly sessionPath?: string };

interface PaneState {
  readonly paneId: string;
  readonly cwd: string;
  owned: boolean;
  phase: 'starting' | 'prompting' | 'ready' | 'terminal';
  workingSeen: boolean;
  generation: number;
  cancelled: boolean;
  closed: boolean;
  terminal?: Terminal;
  assistantText?: string;
  assistantRead?: boolean;
  currentJob?: RunningCommand;
  startJob?: RunningCommand;
  promptJob?: RunningCommand;
  startAbort?: AbortController;
  promptAbort?: AbortController;
}

const MAX_TEXT = 160;
const SAFE_EXACT_ENV = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMP', 'TMPDIR']);

function bounded(value: string): string {
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT - 12)}…[truncated]`;
}

function safeEnv(config: HerdrCliConfig): NodeJS.ProcessEnv {
  const source = config.env ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SAFE_EXACT_ENV.has(key) || key.startsWith('LC_') || key.startsWith('XDG_') || key.startsWith('HERDR_') || config.passEnv?.includes(key) === true) result[key] = value;
  }
  return result;
}

function roleEnv(config: HerdrCliConfig, request: HerdrSpawnRequest): { readonly manifest: string; readonly base: string } {
  const manifest = config.roleManifests[request.roleId];
  const base = config.roleBases[request.roleId];
  if (manifest === undefined || base === undefined) throw new Error(`missing herdr role manifest/base for ${request.roleId}`);
  const encoded = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  if (encoded === undefined) throw new Error('role manifest is not JSON serializable');
  return { manifest: encoded, base };
}

function spec(config: HerdrCliConfig, cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): CommandSpec {
  return { command: config.herdrBinary, args, cwd, env, timeoutMs, ...(signal === undefined ? {} : { signal }), ...(config.maxOutputBytes === undefined ? {} : { maxOutputBytes: config.maxOutputBytes }) };
}

/** Herdr emits one JSON object per CLI invocation; log lines are rejected. */
function parsedJson(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed.length === 0) throw new Error('herdr returned empty JSON output');
  return JSON.parse(trimmed) as unknown;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

function resultOf(value: unknown): Record<string, unknown> {
  return record(record(value, 'envelope').result, 'envelope.result');
}

function stringField(value: unknown, path: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`${path} must be a bounded non-empty string`);
  return value;
}

function tabPaneId(value: unknown): string {
  const result = resultOf(value);
  const rootPane = record(result.root_pane, 'result.root_pane');
  return stringField(rootPane.pane_id, 'result.root_pane.pane_id', 128);
}

function paneIds(value: unknown): readonly string[] {
  const result = resultOf(value);
  if (!Array.isArray(result.panes)) throw new Error('result.panes must be an array');
  return result.panes.map((entry, index) => stringField(record(entry, `result.panes[${index}]`).pane_id, `result.panes[${index}].pane_id`, 128));
}

interface AgentSnapshot {
  readonly status: string;
  readonly sessionPath?: string;
}

function agentSnapshot(value: unknown): AgentSnapshot {
  const result = resultOf(value);
  const agent = record(result.agent, 'result.agent');
  const status = stringField(agent.agent_status, 'result.agent.agent_status').toLowerCase();
  const session = record(agent.agent_session, 'result.agent.agent_session');
  const sessionValue = session.value;
  return sessionValue === undefined
    ? { status }
    : { status, sessionPath: stringField(sessionValue, 'result.agent.agent_session.value') };
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const pieces = value.map(textFrom).filter((entry): entry is string => entry !== undefined);
    return pieces.length === 0 ? undefined : pieces.join('\n');
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    return textFrom(item.text ?? item.content ?? item.message ?? item.output);
  }
  return undefined;
}

function readLastAssistant(path: string): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  if (!isAbsolute(path)) return { ok: false };
  let raw: string;
  try { raw = readFileSync(path, { encoding: 'utf8' }); } catch { return { ok: false }; }
  let last: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return { ok: false }; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    const root = parsed as Record<string, unknown>;
    const messageValue = root.message ?? root.data ?? parsed;
    if (typeof messageValue !== 'object' || messageValue === null || Array.isArray(messageValue)) return { ok: false };
    const message = messageValue as Record<string, unknown>;
    if (message.role === 'assistant') {
      const text = textFrom(message.content ?? message.text ?? message.message);
      if (text !== undefined && text.length > 0) last = text;
    }
  }
  return last === undefined ? { ok: false } : { ok: true, text: last };
}

/** Stable opaque name: task/attempt characters never enter the Herdr name. */
function agentName(request: HerdrSpawnRequest): string {
  return `ao-${createHash('sha256').update(`${request.taskId}\0${request.attemptId}`, 'utf8').digest('hex').slice(0, 29)}`;
}

function commandFailed(result: { readonly status: string; readonly exitCode: number | null; readonly timedOut: boolean }): boolean {
  return result.status !== 'exited' || result.exitCode !== 0 || result.timedOut;
}

/** Public herdr CLI transport. Long agent calls are never awaited by poll(). */
export class HerdrCliPort implements HerdrSubagentPort {
  private readonly config: HerdrCliConfig;
  private readonly runner: CommandRunner;
  private readonly panes = new Map<string, PaneState>();

  constructor(config: HerdrCliConfig, runner: CommandRunner) {
    for (const [name, value] of [['herdrBinary', config.herdrBinary], ['piExtension', config.piExtension], ['provider', config.provider], ['model', config.model], ['workspaceId', config.workspaceId]] as const) {
      if (typeof value !== 'string' || value.length === 0) throw new TypeError(`herdr config ${name} must be non-empty`);
    }
    for (const [name, value] of Object.entries(config.timeouts)) if (!Number.isInteger(value) || value <= 0) throw new TypeError(`herdr config timeout ${name} must be positive`);
    if (config.roleManifests === null || typeof config.roleManifests !== 'object' || config.roleBases === null || typeof config.roleBases !== 'object') throw new TypeError('herdr role manifests and bases are required');
    this.config = config;
    this.runner = runner;
  }

  spawn(request: HerdrSpawnRequest): unknown {
    const roles = roleEnv(this.config, request);
    const env = safeEnv(this.config);
    const tab = this.runner.run(spec(this.config, request.cwd, [
      'tab', 'create', '--workspace', this.config.workspaceId, '--cwd', request.cwd, '--label', agentName(request),
      '--env', 'PI_HERDR_SUBAGENT=1', '--env', `PI_HERDR_ROLE_MANIFEST=${roles.manifest}`, '--env', `PI_HERDR_ROLE_BASE=${roles.base}`,
    ], env, this.config.timeouts.probeMs));
    if (commandFailed(tab)) throw new Error(`herdr tab create failed: ${bounded(tab.stderr || tab.stdout)}`);
    const id = tabPaneId(parsedJson(tab.stdout));
    const state: PaneState = { paneId: id, cwd: request.cwd, owned: true, phase: 'starting', workingSeen: false, generation: 0, cancelled: false, closed: false };
    this.panes.set(id, state);
    const generation = state.generation;
    const startAbort = new AbortController();
    state.startAbort = startAbort;
    let startJob: RunningCommand;
    try {
      startJob = this.runner.runAsync(spec(this.config, request.cwd, [
        'agent', 'start', agentName(request), '--kind', 'pi', '--pane', id, '--timeout', String(this.config.timeouts.startMs), '--',
        '-a', '-e', this.config.piExtension, '--provider', request.provider || this.config.provider, '--model', request.model || this.config.model, '--tui-mode', 'fullscreen',
      ], env, this.config.timeouts.startMs, startAbort.signal));
      state.startJob = state.currentJob = startJob;
    } catch (error) {
      state.terminal = { status: 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr agent start failed') };
      state.phase = 'terminal';
      return { sessionId: id };
    }
    void startJob.promise.then((started) => {
      if (!this.current(state, generation)) return;
      delete state.startJob;
      if (commandFailed(started)) { state.terminal = { status: 'failed', outcome: bounded(started.stderr || 'herdr agent start failed') }; state.phase = 'terminal'; return; }
      state.phase = 'prompting';
      const promptAbort = new AbortController();
      state.promptAbort = promptAbort;
      let promptJob: RunningCommand;
      try {
        promptJob = this.runner.runAsync(spec(this.config, request.cwd, ['agent', 'prompt', id, request.prompt, '--wait', '--timeout', String(this.config.timeouts.promptMs)], env, this.config.timeouts.promptMs, promptAbort.signal));
        state.promptJob = state.currentJob = promptJob;
      } catch (error) {
        if (!this.current(state, generation)) return;
        state.terminal = { status: 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr agent prompt failed') };
        state.phase = 'terminal';
        return;
      }
      void promptJob.promise.then((prompted) => {
        if (!this.current(state, generation)) return;
        delete state.promptJob;
        if (state.currentJob === promptJob) delete state.currentJob;
        if (commandFailed(prompted)) state.terminal = { status: 'failed', outcome: bounded(prompted.stderr || 'herdr agent prompt failed') };
        else state.workingSeen = true; // --wait success proves this generation completed, even if probe skipped working.
        state.phase = state.terminal === undefined ? 'ready' : 'terminal';
      }, (error: unknown) => {
        if (!this.current(state, generation)) return;
        state.terminal = { status: state.cancelled ? 'cancelled' : 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr agent prompt failed') };
        state.phase = 'terminal';
      }).catch((error: unknown) => {
        if (!this.current(state, generation)) return;
        state.terminal = { status: state.cancelled ? 'cancelled' : 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr agent prompt failed') };
        state.phase = 'terminal';
      });
    }, (error: unknown) => {
      if (!this.current(state, generation)) return;
      state.terminal = { status: state.cancelled ? 'cancelled' : 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr agent start failed') };
      state.phase = 'terminal';
    }).catch((error: unknown) => {
      if (!this.current(state, generation)) return;
      state.terminal = { status: state.cancelled ? 'cancelled' : 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr agent start failed') };
      state.phase = 'terminal';
    });
    return { sessionId: id };
  }

  /** Return the cached final assistant message exactly once; transcript is never exposed. */
  readFinalAssistant(sessionId: string): string {
    const state = this.panes.get(sessionId);
    if (state === undefined || state.terminal?.status !== 'settled') throw new Error('assistant result is unavailable before a terminal settled state');
    if (state.assistantRead === true) throw new Error('assistant result was already read');
    if (state.assistantText === undefined || state.assistantText.length > MAX_ASSISTANT_TEXT) throw new Error('assistant result is malformed or exceeds the in-memory limit');
    state.assistantRead = true;
    return String(state.assistantText);
  }

  poll(sessionId: string): unknown {
    const state = this.panes.get(sessionId);
    if (state === undefined) return this.probeUnknown(sessionId);
    if (state.closed) return state.terminal ?? { status: 'cancelled', outcome: 'herdr pane was closed' };
    if (state.terminal !== undefined) return state.terminal;
    if (state.phase === 'starting') return { status: 'running' };
    const quick = this.probe(state);
    if (quick.status === 'missing') { state.terminal = { status: 'lost', outcome: 'herdr pane is no longer present' }; return state.terminal; }
    if (quick.status === 'failed') { state.terminal = { status: 'failed', outcome: 'herdr agent probe failed' }; return state.terminal; }
    if (quick.status === 'working') { state.workingSeen = true; return { status: 'running' }; }
    if (state.phase === 'prompting') return { status: 'running' };
    if (quick.status === 'blocked') { state.terminal = { status: 'failed', outcome: 'worker is blocked' }; return state.terminal; }
    if (quick.status === 'cancelled') { state.terminal = { status: 'cancelled', outcome: 'worker was cancelled' }; return state.terminal; }
    if (quick.status === 'done' && state.workingSeen) {
      const result = this.finishFromAgentGet(state.paneId, quick.sessionPath);
      state.terminal = result;
      return result;
    }
    return { status: 'running' };
  }

  interrupt(sessionId: string, _reason: string): unknown {
    const state = this.panes.get(sessionId);
    if (state === undefined || !state.owned || state.terminal !== undefined || state.closed) return undefined;
    this.cancelJobs(state);
    state.terminal = { status: 'cancelled', outcome: 'worker interrupted' };
    state.phase = 'terminal';
    try {
      const result = this.runner.run(spec(this.config, state.cwd, ['agent', 'send-keys', sessionId, 'ctrl+c'], safeEnv(this.config), this.config.timeouts.probeMs));
      if (commandFailed(result)) throw new Error(result.stderr || result.stdout || 'herdr interrupt failed');
    } catch (error) {
      state.terminal = { status: 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr interrupt failed') };
      throw error;
    }
    return undefined;
  }

  close(sessionId: string): unknown {
    const state = this.panes.get(sessionId);
    if (state === undefined || !state.owned || state.closed) return undefined;
    this.cancelJobs(state);
    state.closed = true;
    if (state.terminal === undefined) state.terminal = { status: 'cancelled', outcome: 'worker pane closed' };
    state.phase = 'terminal';
    try {
      const result = this.runner.run(spec(this.config, state.cwd, ['pane', 'close', sessionId], safeEnv(this.config), this.config.timeouts.probeMs));
      if (commandFailed(result)) throw new Error(result.stderr || result.stdout || 'herdr pane close failed');
    } catch (error) {
      state.terminal = { status: 'failed', outcome: bounded(error instanceof Error ? error.message : 'herdr pane close failed') };
      throw error;
    }
    return undefined;
  }

  /** Recovery path: paneId is the persisted session id. It never restarts a pane. */
  reattach(sessionId: string, cwd = process.cwd()): { readonly sessionId: string } {
    const existing = this.panes.get(sessionId);
    if (existing !== undefined) { existing.owned = true; existing.closed = false; existing.cancelled = false; return { sessionId }; }
    const listed = this.runner.run(spec(this.config, cwd, ['pane', 'list', '--workspace', this.config.workspaceId], safeEnv(this.config), this.config.timeouts.probeMs));
    if (commandFailed(listed)) throw new Error('cannot reattach: herdr pane list was unavailable');
    let parsed: unknown;
    try { parsed = parsedJson(listed.stdout); } catch { throw new Error('cannot reattach from malformed herdr pane list'); }
    if (!paneIds(parsed).includes(sessionId)) throw new Error('cannot reattach missing herdr pane');
    this.panes.set(sessionId, { paneId: sessionId, cwd, owned: true, phase: 'ready', workingSeen: false, generation: 0, cancelled: false, closed: false });
    return { sessionId };
  }

  private current(state: PaneState, generation: number): boolean {
    return state.generation === generation && !state.closed && !state.cancelled;
  }

  private cancelJobs(state: PaneState): void {
    state.generation++;
    state.cancelled = true;
    state.startAbort?.abort();
    state.promptAbort?.abort();
    state.startJob?.cancel();
    state.promptJob?.cancel();
    delete state.currentJob;
  }

  private probe(state: PaneState): Probe {
    try {
      const listed = this.runner.run(spec(this.config, state.cwd, ['pane', 'list', '--workspace', this.config.workspaceId], safeEnv(this.config), this.config.timeouts.probeMs));
      if (commandFailed(listed)) return { status: 'failed' };
      const ids = paneIds(parsedJson(listed.stdout));
      if (!ids.includes(state.paneId)) return { status: 'missing' };
      const agent = this.runner.run(spec(this.config, state.cwd, ['agent', 'get', state.paneId], safeEnv(this.config), this.config.timeouts.probeMs));
      if (commandFailed(agent)) return { status: 'failed' };
      const snapshot = agentSnapshot(parsedJson(agent.stdout));
      const status = snapshot.status;
      if (status === 'working' || status === 'running' || status === 'busy') return { status: 'working', ...(snapshot.sessionPath === undefined ? {} : { sessionPath: snapshot.sessionPath }) };
      if (status === 'blocked') return { status: 'blocked', ...(snapshot.sessionPath === undefined ? {} : { sessionPath: snapshot.sessionPath }) };
      if (status === 'cancelled' || status === 'canceled') return { status: 'cancelled', ...(snapshot.sessionPath === undefined ? {} : { sessionPath: snapshot.sessionPath }) };
      if (status === 'idle' || status === 'done' || status === 'completed' || status === 'settled') return { status: 'done', ...(snapshot.sessionPath === undefined ? {} : { sessionPath: snapshot.sessionPath }) };
      return { status: 'failed' };
    } catch { return { status: 'failed' }; }
  }

  private probeUnknown(sessionId: string): unknown {
    try {
      const listed = this.runner.run(spec(this.config, process.cwd(), ['pane', 'list', '--workspace', this.config.workspaceId], safeEnv(this.config), this.config.timeouts.probeMs));
      if (commandFailed(listed)) return { status: 'failed', outcome: 'herdr pane list was unavailable' };
      if (!paneIds(parsedJson(listed.stdout)).includes(sessionId)) return { status: 'lost', outcome: 'herdr pane is no longer present' };
      const state: PaneState = { paneId: sessionId, cwd: process.cwd(), owned: false, phase: 'ready', workingSeen: false, generation: 0, cancelled: false, closed: false };
      this.panes.set(sessionId, state);
      return this.poll(sessionId);
    } catch { return { status: 'failed', outcome: 'herdr pane probe was unavailable' }; }
  }

  private finishFromAgentGet(paneId: string, sessionPath: string | undefined): Terminal {
    if (sessionPath === undefined) return { status: 'failed', outcome: 'herdr agent session path was unavailable' };
    const transcript = readLastAssistant(sessionPath);
    if (!transcript.ok) return { status: 'failed', outcome: 'herdr session JSONL was malformed or had no assistant outcome' };
    if (transcript.text.length > MAX_ASSISTANT_TEXT) return { status: 'failed', outcome: 'herdr assistant result exceeded the in-memory limit' };
    const state = this.panes.get(paneId);
    if (state !== undefined) state.assistantText = transcript.text;
    return { status: 'settled', outcome: bounded(transcript.text), resultRef: `herdr-session:${paneId}` };
  }
}

export { agentName, parsedJson, safeEnv };
