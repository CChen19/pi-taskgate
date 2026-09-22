/**
 * Clean-room checkouts for verification.
 *
 * A candidate is verified in a fresh detached worktree created from git
 * objects at the exact candidate revision, never in the worker's worktree.
 * Ignored or untracked files the worker produced (build directories, cached
 * binaries, stamps) therefore cannot influence the verdict. The checkout is
 * confirmed to be at that revision and pristine before any command runs, and
 * it is removed afterwards.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { minimalProcessEnv, type CommandRunner } from './command-runner.ts';

export interface CleanRoomCheckout {
  readonly path: string;
  readonly revision: string;
  /** Remove the checkout; never throws. Returns an error message when removal failed. */
  dispose(): string | undefined;
}

export interface CleanRoomPort {
  prepare(revision: string): CleanRoomCheckout;
}

export interface GitCleanRoomOptions {
  readonly repoRoot: string;
  /** Directory that holds temporary verification checkouts (created on demand). */
  readonly root: string;
  readonly commandRunner: CommandRunner;
  readonly gitTimeoutMs?: number;
}

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class GitCleanRoom implements CleanRoomPort {
  private readonly options: GitCleanRoomOptions;

  constructor(options: GitCleanRoomOptions) {
    this.options = options;
  }

  prepare(revision: string): CleanRoomCheckout {
    if (!FULL_OBJECT_ID.test(revision)) throw new Error('clean room requires a full object id');
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 });
    const path = join(this.options.root, `v-${randomBytes(5).toString('hex')}`);
    this.git(this.options.repoRoot, ['worktree', 'add', '--detach', '--quiet', path, revision]);
    const checkout: CleanRoomCheckout = { path, revision, dispose: () => this.remove(path) };
    try {
      const head = this.git(path, ['rev-parse', 'HEAD']).trim();
      if (head !== revision) throw new Error(`clean room HEAD ${head} does not match ${revision}`);
      const status = this.git(path, ['status', '--porcelain=v1', '--ignored', '-z']);
      if (status.length !== 0) throw new Error('clean room checkout is not pristine');
    } catch (error) {
      checkout.dispose();
      throw error;
    }
    return checkout;
  }

  private remove(path: string): string | undefined {
    let failure: string | undefined;
    try {
      // --force is required: verification leaves build output in this throwaway checkout.
      this.git(this.options.repoRoot, ['worktree', 'remove', '--force', path]);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (existsSync(path)) {
      try { rmSync(path, { recursive: true, force: true }); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      try { this.git(this.options.repoRoot, ['worktree', 'prune']); } catch { /* best effort */ }
    }
    return existsSync(path) ? (failure ?? `could not remove ${path}`) : undefined;
  }

  private git(cwd: string, args: readonly string[]): string {
    const result = this.options.commandRunner.run({ command: 'git', args, cwd, env: minimalProcessEnv(undefined), timeoutMs: this.options.gitTimeoutMs ?? 60_000, maxOutputBytes: 64 * 1024 });
    if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return result.stdout;
  }
}
