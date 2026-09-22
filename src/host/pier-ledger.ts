/**
 * Read-only view of Pier's delegation ledger (history.jsonl).
 *
 * Pier appends one row per subagent status change, partitioned by the
 * subagent's cwd. The closing `outcome` is the child's final assistant text
 * read from its session JSONL, written by Pier (the host), not relayed by the
 * main agent. This module never writes to Pier's storage.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type WorkerLedgerStatus = 'running' | 'settled' | 'consumed' | 'closed';

export interface WorkerLedgerRow {
  readonly paneId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly cwd: string;
  readonly status: WorkerLedgerStatus;
  readonly outcome: string | null;
  readonly createdAt: number;
  readonly revivedFrom: string | null;
}

export interface WorkerLedger {
  /** Latest row for `paneId` among subagents launched with exactly `cwd`. */
  latest(cwd: string, paneId: string): WorkerLedgerRow | undefined;
}

const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const STATUSES: readonly string[] = ['running', 'settled', 'consumed', 'closed'];

/** Pier's collision-resistant directory encoding (storage-layout.ts sessionDirName). */
export function pierSessionDirName(cwd: string): string {
  return `--${cwd.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\//g, '%2F').replace(/:/g, '%3A')}--`;
}

/** Pier's legacy flattened encoding (storage-layout.ts sessionDirNameLegacy). */
export function pierSessionDirNameLegacy(cwd: string): string {
  return `--${cwd.replace(/[\\/]/g, '-').replace(/:/g, '-')}--`;
}

/** Default history roots: Pier's XDG agent data dir, then the ~/.pi layout. */
export function defaultPierHistoryRoots(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const dataHome = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0 ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
  return [...new Set([join(dataHome, 'agent', 'herdr-pi', 'history'), join(homedir(), '.pi', 'agent', 'herdr-pi', 'history')])];
}

function coerceRow(value: unknown): WorkerLedgerRow | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.paneId !== 'string' || typeof row.taskId !== 'string' || typeof row.cwd !== 'string') return undefined;
  if (typeof row.status !== 'string' || !STATUSES.includes(row.status)) return undefined;
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) return undefined;
  return Object.freeze({
    paneId: row.paneId,
    taskId: row.taskId,
    kind: typeof row.kind === 'string' ? row.kind : 'task',
    cwd: row.cwd,
    status: row.status as WorkerLedgerStatus,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    createdAt: row.createdAt,
    revivedFrom: typeof row.revivedFrom === 'string' && row.revivedFrom.length > 0 ? row.revivedFrom : null,
  });
}

export interface PierHistoryLedgerOptions {
  readonly roots?: readonly string[];
}

export class PierHistoryLedger implements WorkerLedger {
  private readonly roots: readonly string[];

  constructor(options: PierHistoryLedgerOptions = {}) {
    this.roots = options.roots ?? defaultPierHistoryRoots();
  }

  latest(cwd: string, paneId: string): WorkerLedgerRow | undefined {
    for (const file of this.candidateFiles(cwd)) {
      let text: string;
      try {
        if (statSync(file).size > MAX_LEDGER_BYTES) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let found: WorkerLedgerRow | undefined;
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const row = coerceRow(parsed);
        if (row !== undefined && row.paneId === paneId && row.cwd === cwd) found = row;
      }
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private candidateFiles(cwd: string): readonly string[] {
    const names = [...new Set([pierSessionDirName(cwd), pierSessionDirNameLegacy(cwd)])];
    const files: string[] = [];
    for (const root of this.roots) {
      for (const name of names) {
        const file = join(root, name, 'history.jsonl');
        if (existsSync(file)) files.push(file);
      }
    }
    return files;
  }
}

/** Conservative Unix-socket path budget (Linux sun_path is 108 bytes, macOS 104). */
export const PIER_PIPE_PATH_LIMIT = 103;
/** Worst-case encoded herdr pane id length assumed when a pane id is not known yet. */
const PANE_ID_ALLOWANCE = 10;

/** Pier's per-pane pipe socket path (pipe-channel.ts pipeNameFor/pipePathFor, POSIX). */
export function pierPipePath(cwd: string, paneId: string): string {
  return `/tmp/pi-herdr-${pierSessionDirName(cwd)}-${paneId.replace(/[^A-Za-z0-9_-]/g, '-')}.sock`;
}

/** Reason a subagent launched in `cwd` could not register Pier's pipe, or undefined when it fits. */
export function pierPipeProblem(cwd: string): string | undefined {
  const length = Buffer.byteLength(pierPipePath(cwd, 'x'.repeat(PANE_ID_ALLOWANCE)), 'utf8');
  if (length <= PIER_PIPE_PATH_LIMIT) return undefined;
  return `a Pier subagent in ${cwd} would need a ${length}-byte pipe socket path (limit ${PIER_PIPE_PATH_LIMIT}); use a shorter workspaceRoot`;
}
