/**
 * Real host wiring for TaskService: system git, allowlisted verification
 * processes, Pier's ledger (read-only), and Pier role files (read-only).
 * Constructing it creates the workspace/ledger directory but starts no agent.
 */
import { randomUUID } from 'node:crypto';
import { WorktreeManager } from '../adapters/worktree-manager.ts';
import { boundReviewerDiff } from '../core/reviewer-brief.ts';
import { NodeCommandRunner, minimalProcessEnv, type CommandRunner } from '../host/command-runner.ts';
import { GitCleanRoom } from '../host/clean-room.ts';
import { GitHistory } from '../host/git-history.ts';
import { GitWorktreePort } from '../host/git-worktree-port.ts';
import { join } from 'node:path';
import { PierHistoryLedger, pierPipeProblem } from '../host/pier-ledger.ts';
import { readSubagentSession } from '../host/pi-session.ts';
import { BriefStore } from '../host/brief-store.ts';
import { checkReadOnlyRole, defaultPierRoleDirs } from '../host/pier-roles.ts';
import { ProcessAsyncVerificationRunner } from '../host/process-verification-runner.ts';
import type { OrchestrationConfig } from './config.ts';
import type { TaskEvent } from './task-board.ts';
import { TaskService } from './task-service.ts';

export interface HostWiringOptions {
  readonly config: OrchestrationConfig;
  readonly persist: (event: TaskEvent) => void;
  /** Master session cwd; Pier resolves workspace roles against it. */
  readonly masterCwd: string;
  readonly commandRunner?: CommandRunner;
}

const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function createHostTaskService(options: HostWiringOptions): TaskService {
  const { config } = options;
  const commandRunner = options.commandRunner ?? new NodeCommandRunner();
  const git = (cwd: string, args: readonly string[], maxOutputBytes = 64 * 1024) => {
    const result = commandRunner.run({ command: 'git', args, cwd, env: minimalProcessEnv(undefined), timeoutMs: 30_000, maxOutputBytes });
    if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return result;
  };
  const worktreePort = new GitWorktreePort({ repoRoot: config.repoRoot, workspaceRoot: config.workspaceRoot, commandRunner });
  const worktrees = new WorktreeManager({ repoRoot: config.repoRoot, workspaceRoot: config.workspaceRoot, idSource: () => randomUUID(), naming: 'compact' });
  const roleDirs = config.roleDirs ?? defaultPierRoleDirs(options.masterCwd);
  return new TaskService({
    worktrees,
    worktreePort,
    headRevision: () => git(config.repoRoot, ['rev-parse', 'HEAD']).stdout.trim(),
    readDiff: (workspacePath, baseRevision, artifactRevision) => {
      if (!REVISION.test(baseRevision) || !REVISION.test(artifactRevision)) throw new Error('artifact revisions must be full object ids');
      const result = commandRunner.run({ command: 'git', args: ['diff', '--no-ext-diff', '--no-color', `${baseRevision}...${artifactRevision}`, '--'], cwd: workspacePath, env: minimalProcessEnv(undefined), timeoutMs: 30_000, maxOutputBytes: 33 * 1024 });
      // Hitting the output cap stops git early; that is a bounded (marked-truncated) patch, not a failure.
      const complete = result.status === 'exited' && result.exitCode === 0 && !result.timedOut;
      if (!complete && !(result.stdoutTruncated && !result.timedOut)) throw new Error(result.stderr.trim() || 'git diff failed');
      return boundReviewerDiff(result.stdout, result.stdoutTruncated);
    },
    verifier: new ProcessAsyncVerificationRunner({ commandRunner, cwd: config.workspaceRoot, allowedCommands: config.verificationAllowlist, defaultTimeoutMs: config.verificationTimeoutMs, maxOutputBytes: 256 * 1024 }),
    cleanRoom: new GitCleanRoom({ repoRoot: config.repoRoot, root: join(config.workspaceRoot, '.verify'), commandRunner }),
    ledger: new PierHistoryLedger(config.pierHistoryRoots === undefined ? {} : { roots: config.pierHistoryRoots }),
    checkReviewerRole: (role) => checkReadOnlyRole(roleDirs, role ?? config.reviewerRole),
    history: new GitHistory({ repoRoot: config.repoRoot, commandRunner }),
    clock: () => Date.now(),
    persist: options.persist,
    checkWorkerCwd: pierPipeProblem,
    readSubagentSession,
    briefs: new BriefStore(config.workspaceRoot),
  }, {
    verificationAllowlist: config.verificationAllowlist,
    verificationTimeoutMs: config.verificationTimeoutMs,
    reviewerRole: config.reviewerRole,
    maxChecksPerAttempt: config.maxChecksPerAttempt,
    defaultMaxAttempts: config.defaultMaxAttempts,
    sharedPaths: config.sharedPaths,
    rejectTestAsserts: config.rejectTestAsserts,
  });
}
