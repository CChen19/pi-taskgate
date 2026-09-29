/**
 * Git history operations for integration and the added-line guard.
 *
 * All revisions are validated full object ids; nothing here resolves branch
 * names. Cherry-picks run one commit at a time with a fixed committer identity
 * and `-x`, so each integrated commit names its source; a conflict aborts the
 * pick (leaving the integration worktree clean at the last good commit) and
 * reports the conflicted paths. The only automatic resolution is Git's built-in
 * `union` merge driver, for the human-configured union paths alone, applied
 * through a temporary attributes file on that one command; picks it resolved
 * are marked so the host can check them line by line.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minimalProcessEnv, type CommandRunner } from './command-runner.ts';

export interface AppliedPick {
  readonly source: string;
  readonly integrated: string;
  /** Present when the pick is not patch-identical to its source because a union path was merged. */
  readonly resolved?: 'union';
}

export type ApplyResult =
  | { readonly ok: true; readonly applied: readonly AppliedPick[]; readonly revision: string }
  | { readonly ok: false; readonly applied: readonly AppliedPick[]; readonly commit: string; readonly paths: readonly string[]; readonly detail: string };

export interface GitHistoryPort {
  /** Commits of base..revision oldest first; throws unless base is an ancestor of revision. */
  commitRange(baseRevision: string, revision: string): readonly string[];
  /** Commits of base..HEAD in `cwd`, oldest first. */
  commitsSince(cwd: string, baseRevision: string): readonly string[];
  /** `unionPaths`: repository-relative files merged with Git's `union` driver on conflict. */
  cherryPick(cwd: string, commits: readonly string[], options?: { readonly unionPaths?: readonly string[] }): ApplyResult;
  /** `git show -U0` of one commit (no context lines), for line-level comparison of a pick with its source. */
  commitLineDiff(commit: string): string;
  /** A file's content at a revision, or undefined when the path does not exist there. */
  fileAt(revision: string, path: string): string | undefined;
  /** Stable patch id of one commit (content identity independent of parents and line numbers). */
  patchId(commit: string): string;
  /** Source commit named by the `-x` trailer, if any. */
  pickedFrom(commit: string): string | undefined;
  /** `git diff -U0 base...revision` for scanning added lines; `truncated` means the scan is incomplete. */
  changedLineDiff(cwd: string, baseRevision: string, revision: string): { readonly text: string; readonly truncated: boolean };
}

export interface GitHistoryOptions {
  readonly repoRoot: string;
  readonly commandRunner: CommandRunner;
  readonly timeoutMs?: number;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IDENTITY = ['-c', 'user.name=agent-orchestrator', '-c', 'user.email=agent-orchestrator@localhost'];
const DIFF_LIMIT = 4 * 1024 * 1024;
/** Plain repository paths only: an attributes line must not be able to carry glob or quoting syntax. */
const UNION_PATH = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

function requireId(value: string, label: string): string {
  if (!OBJECT_ID.test(value)) throw new Error(`${label} must be a full object id`);
  return value;
}

export class GitHistory implements GitHistoryPort {
  private readonly options: GitHistoryOptions;

  constructor(options: GitHistoryOptions) {
    this.options = options;
  }

  commitRange(baseRevision: string, revision: string): readonly string[] {
    requireId(baseRevision, 'base revision');
    requireId(revision, 'revision');
    const ancestor = this.raw(this.options.repoRoot, ['merge-base', '--is-ancestor', baseRevision, revision]);
    if (ancestor.exitCode !== 0) throw new Error(`${baseRevision} is not an ancestor of ${revision}`);
    return this.lines(this.options.repoRoot, ['rev-list', '--reverse', `${baseRevision}..${revision}`]);
  }

  commitsSince(cwd: string, baseRevision: string): readonly string[] {
    requireId(baseRevision, 'base revision');
    return this.lines(cwd, ['rev-list', '--reverse', `${baseRevision}..HEAD`]);
  }

  cherryPick(cwd: string, commits: readonly string[], options: { readonly unionPaths?: readonly string[] } = {}): ApplyResult {
    const unionPaths = options.unionPaths ?? [];
    let attributesDir: string | undefined;
    const config: string[] = [];
    if (unionPaths.length > 0) {
      for (const path of unionPaths) {
        if (!UNION_PATH.test(path)) throw new Error(`union path ${JSON.stringify(path)} cannot be written to an attributes file`);
      }
      attributesDir = mkdtempSync(join(tmpdir(), 'ao-union-'));
      const file = join(attributesDir, 'attributes');
      writeFileSync(file, unionPaths.map((path) => `/${path} merge=union\n`).join(''));
      config.push('-c', `core.attributesFile=${file}`);
    }
    try {
      const applied: AppliedPick[] = [];
      for (const commit of commits) {
        requireId(commit, 'commit');
        const pick = this.raw(cwd, [...IDENTITY, ...config, 'cherry-pick', '-x', '--allow-empty', commit]);
        if (pick.exitCode !== 0) {
          const paths = this.lines(cwd, ['diff', '--name-only', '--diff-filter=U']);
          const detail = (pick.stderr || pick.stdout).trim().split('\n').slice(0, 6).join(' | ').slice(0, 500);
          this.raw(cwd, ['cherry-pick', '--abort']);
          return { ok: false, applied, commit, paths, detail };
        }
        const integrated = this.lines(cwd, ['rev-parse', 'HEAD'])[0]!;
        const merged = unionPaths.length > 0 && this.patchId(integrated) !== this.patchId(commit);
        applied.push({ source: commit, integrated, ...(merged ? { resolved: 'union' as const } : {}) });
      }
      const revision = this.lines(cwd, ['rev-parse', 'HEAD'])[0]!;
      return { ok: true, applied, revision };
    } finally {
      if (attributesDir !== undefined) rmSync(attributesDir, { recursive: true, force: true });
    }
  }

  fileAt(revision: string, path: string): string | undefined {
    requireId(revision, 'revision');
    const result = this.options.commandRunner.run({ command: 'git', args: ['show', `${revision}:${path}`], cwd: this.options.repoRoot, env: minimalProcessEnv(undefined), timeoutMs: this.options.timeoutMs ?? 60_000, maxOutputBytes: DIFF_LIMIT });
    if (result.status !== 'exited' || result.timedOut) throw new Error(`git show ${revision}:${path} could not run`);
    if (result.exitCode !== 0) return undefined;
    if (result.stdoutTruncated) throw new Error(`${path} at ${revision} is too large to check`);
    return result.stdout;
  }

  commitLineDiff(commit: string): string {
    requireId(commit, 'commit');
    const result = this.options.commandRunner.run({ command: 'git', args: ['show', '--format=', '-U0', '--no-color', '--no-ext-diff', '--no-renames', commit, '--'], cwd: this.options.repoRoot, env: minimalProcessEnv(undefined), timeoutMs: this.options.timeoutMs ?? 60_000, maxOutputBytes: DIFF_LIMIT });
    if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) throw new Error(`git show failed: ${result.stderr.trim().slice(0, 300)}`);
    if (result.stdoutTruncated) throw new Error(`the diff of ${commit} is too large to compare line by line`);
    return result.stdout;
  }

  patchId(commit: string): string {
    requireId(commit, 'commit');
    // `git show | git patch-id` needs a pipe; the commit id is validated hex, passed as $1.
    const result = this.options.commandRunner.run({
      command: 'bash',
      args: ['-c', 'git show --no-color --no-ext-diff "$1" | git patch-id --stable', 'patch-id', commit],
      cwd: this.options.repoRoot,
      env: minimalProcessEnv(undefined),
      timeoutMs: this.options.timeoutMs ?? 60_000,
      maxOutputBytes: 4096,
    });
    const id = result.stdout.trim().split(/\s+/)[0] ?? '';
    if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(id)) throw new Error(`could not compute patch id of ${commit}`);
    return id;
  }

  pickedFrom(commit: string): string | undefined {
    requireId(commit, 'commit');
    const body = this.raw(this.options.repoRoot, ['log', '-1', '--format=%B', commit]).stdout;
    const matches = [...body.matchAll(/\(cherry picked from commit ([0-9a-f]{40,64})\)/g)];
    return matches.length === 0 ? undefined : matches[matches.length - 1]![1];
  }

  changedLineDiff(cwd: string, baseRevision: string, revision: string): { readonly text: string; readonly truncated: boolean } {
    requireId(baseRevision, 'base revision');
    requireId(revision, 'revision');
    const result = this.options.commandRunner.run({ command: 'git', args: ['diff', '-U0', '--no-color', '--no-ext-diff', `${baseRevision}...${revision}`, '--'], cwd, env: minimalProcessEnv(undefined), timeoutMs: this.options.timeoutMs ?? 60_000, maxOutputBytes: DIFF_LIMIT });
    if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) throw new Error(`git diff failed: ${result.stderr.trim().slice(0, 300)}`);
    return { text: result.stdout, truncated: result.stdoutTruncated };
  }

  private raw(cwd: string, args: readonly string[]) {
    const result = this.options.commandRunner.run({ command: 'git', args, cwd, env: minimalProcessEnv(undefined), timeoutMs: this.options.timeoutMs ?? 60_000, maxOutputBytes: 256 * 1024 });
    if (result.status === 'failed' || result.timedOut) throw new Error(`git ${args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? ''} could not run: ${result.stderr.trim().slice(0, 300)}`);
    return result;
  }

  private lines(cwd: string, args: readonly string[]): readonly string[] {
    const result = this.raw(cwd, args);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }
}
