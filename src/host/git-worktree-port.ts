import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandRunner, CommandSpec } from './command-runner.ts';
import {
  WORKTREE_MARKER_PREFIX,
  type WorktreeCreateRequest,
  type WorktreeInspectRequest,
  type WorktreePort,
  type WorktreeRemoveRequest,
  type WorktreeSessionBinding,
} from '../adapters/worktree-manager.ts';

interface LedgerEntry {
  readonly repoRoot: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly baseRevision: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly ownershipToken: string;
  readonly managedMarker: string;
  readonly sessionId?: string;
  readonly roleId?: string;
  readonly modelProfileId?: string;
  readonly filesInScope?: readonly string[];
}

export interface GitWorktreePortOptions {
  readonly gitBinary?: string;
  readonly repoRoot?: string;
  readonly workspaceRoot: string;
  readonly commandRunner: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
}

function tokenFile(root: string, token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return resolve(root, '.agent-orchestrator', 'ledger', `${digest}.json`);
}

function ledgerRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot, '.agent-orchestrator', 'ledger');
}

function command(options: GitWorktreePortOptions, cwd: string, args: readonly string[]): CommandSpec {
  return {
    command: options.gitBinary ?? 'git',
    args,
    cwd,
    env: { ...process.env, ...options.env },
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  };
}

function run(options: GitWorktreePortOptions, cwd: string, args: readonly string[]): string {
  const result = options.commandRunner.run(command(options, cwd, args));
  if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) {
    throw new Error(`git ${args[0] ?? 'command'} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

function writeLedger(root: string, entry: LedgerEntry): void {
  const file = tokenFile(root, entry.ownershipToken);
  mkdirSync(ledgerRoot(root), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function readLedger(root: string, token: string): LedgerEntry {
  const file = tokenFile(root, token);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('ownership ledger is malformed');
  return parsed as LedgerEntry;
}

function same(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && a === b;
}

function verifyRequest(entry: LedgerEntry, request: WorktreeRemoveRequest): void {
  if (!same(entry.workspacePath, request.workspacePath) || !same(entry.branch, request.branch) || !same(entry.ownershipToken, request.ownershipToken) || !same(entry.managedMarker, request.managedMarker) || request.managedMarker !== `${WORKTREE_MARKER_PREFIX}${request.ownershipToken}`) {
    throw new Error('ownership ledger does not match request');
  }
}

function worktreePaths(output: string): Set<string> {
  const paths = new Set<string>();
  let current = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line.length === 0 && current.length > 0) { paths.add(current); current = ''; }
  }
  if (current.length > 0) paths.add(current);
  return paths;
}

function changedFromDiff(output: string): string[] {
  return output.split('\0').filter((path) => path.length > 0);
}

function changedFromStatus(output: string): string[] {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const changed: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.length < 3) continue;
    const status = token.slice(0, 2);
    changed.push(token.slice(3));
    if ((status.includes('R') || status.includes('C')) && tokens[index + 1] !== undefined) changed.push(tokens[++index]!);
  }
  return changed;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Real git implementation of the S8 WorktreePort. */
export class GitWorktreePort implements WorktreePort {
  private readonly options: GitWorktreePortOptions;

  constructor(options: GitWorktreePortOptions) {
    this.options = { ...options, workspaceRoot: resolve(options.workspaceRoot), ...(options.repoRoot === undefined ? {} : { repoRoot: resolve(options.repoRoot) }) };
    mkdirSync(ledgerRoot(this.options.workspaceRoot), { recursive: true, mode: 0o700 });
  }

  create(request: WorktreeCreateRequest): unknown {
    if (request.taskId === undefined || request.attemptId === undefined) throw new Error('worktree create requires taskId and attemptId');
    if (this.options.repoRoot !== undefined && request.repoRoot !== this.options.repoRoot) throw new Error('worktree repo root does not match host configuration');
    run(this.options, request.repoRoot, ['worktree', 'add', '-b', request.branch, request.workspacePath, request.baseRevision]);
    const entry: LedgerEntry = {
      repoRoot: request.repoRoot,
      taskId: request.taskId,
      attemptId: request.attemptId,
      baseRevision: request.baseRevision,
      workspacePath: request.workspacePath,
      branch: request.branch,
      ownershipToken: request.ownershipToken,
      managedMarker: `${WORKTREE_MARKER_PREFIX}${request.ownershipToken}`,
    };
    try {
      writeLedger(this.options.workspaceRoot, entry);
    } catch (error) {
      // Never remove a worktree by force. The caller can recover this resource.
      throw new Error(`worktree ledger write failed after git create: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return { workspacePath: entry.workspacePath, branch: entry.branch, ownershipToken: entry.ownershipToken, managedMarker: entry.managedMarker, baseRevision: entry.baseRevision };
  }

  bindSession(request: WorktreeSessionBinding): unknown {
    const entry = readLedger(this.options.workspaceRoot, request.ownershipToken);
    verifyRequest(entry, request);
    if (this.options.repoRoot !== undefined && entry.repoRoot !== this.options.repoRoot) throw new Error('ownership ledger repo root does not match host configuration');
    if (entry.taskId !== request.taskId || entry.attemptId !== request.attemptId || entry.baseRevision !== request.baseRevision) throw new Error('binding identity does not match ledger');
    const updated: LedgerEntry = { ...entry, sessionId: request.sessionId, roleId: request.roleId, modelProfileId: request.modelProfileId, filesInScope: [...request.filesInScope] };
    writeLedger(this.options.workspaceRoot, updated);
    return { owned: true, ...request };
  }

  verifyOwnership(request: WorktreeSessionBinding): unknown {
    const entry = readLedger(this.options.workspaceRoot, request.ownershipToken);
    verifyRequest(entry, request);
    if (this.options.repoRoot !== undefined && entry.repoRoot !== this.options.repoRoot) throw new Error('ownership ledger repo root does not match host configuration');
    if (entry.taskId !== request.taskId || entry.attemptId !== request.attemptId || entry.baseRevision !== request.baseRevision || entry.sessionId !== request.sessionId || entry.roleId !== request.roleId || entry.modelProfileId !== request.modelProfileId || JSON.stringify(entry.filesInScope) !== JSON.stringify(request.filesInScope)) return { owned: false, ...request };
    const paths = worktreePaths(run(this.options, entry.repoRoot, ['worktree', 'list', '--porcelain']));
    if (!paths.has(request.workspacePath)) return { owned: false, ...request };
    return { owned: true, ...request };
  }

  inspectChangedPaths(request: WorktreeInspectRequest): unknown {
    const entry = readLedger(this.options.workspaceRoot, request.ownershipToken);
    verifyRequest(entry, request);
    if (this.options.repoRoot !== undefined && entry.repoRoot !== this.options.repoRoot) throw new Error('ownership ledger repo root does not match host configuration');
    const diff = run(this.options, request.workspacePath, ['diff', '--name-only', '-z', `${entry.baseRevision}...HEAD`]);
    const status = run(this.options, request.workspacePath, ['status', '--porcelain=v1', '-z']);
    const revision = run(this.options, request.workspacePath, ['rev-parse', 'HEAD']).trim();
    const commits = run(this.options, request.workspacePath, ['rev-list', '--count', `${entry.baseRevision}..HEAD`]).trim();
    const commitsAhead = Number.parseInt(commits, 10);
    if (!/^[0-9a-fA-F]+$/.test(revision) || !Number.isInteger(commitsAhead) || commitsAhead < 0) throw new Error('git returned an invalid artifact revision');
    const changedPaths = unique([...changedFromDiff(diff), ...changedFromStatus(status)]);
    return { changedPaths, artifactRevision: revision, diffRef: `git-diff:${entry.baseRevision}...HEAD`, clean: status.length === 0, commitsAhead };
  }

  remove(request: WorktreeRemoveRequest): unknown {
    const entry = readLedger(this.options.workspaceRoot, request.ownershipToken);
    verifyRequest(entry, request);
    if (this.options.repoRoot !== undefined && entry.repoRoot !== this.options.repoRoot) throw new Error('ownership ledger repo root does not match host configuration');
    const listed = worktreePaths(run(this.options, entry.repoRoot, ['worktree', 'list', '--porcelain']));
    if (!listed.has(request.workspacePath)) throw new Error('git worktree path is not owned');
    const status = run(this.options, request.workspacePath, ['status', '--porcelain=v1', '-z']);
    if (status.length !== 0) throw new Error('worktree is dirty; refusing cleanup');
    // This intentionally has no --force. A failed removal leaves both ledger and worktree.
    run(this.options, entry.repoRoot, ['worktree', 'remove', request.workspacePath]);
    const file = tokenFile(this.options.workspaceRoot, request.ownershipToken);
    if (existsSync(file)) unlinkSync(file);
    return undefined;
  }
}

export { changedFromDiff, changedFromStatus, worktreePaths };
