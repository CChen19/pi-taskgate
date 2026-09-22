export * from './command-runner.ts';
export * from './git-worktree-port.ts';
export * from './herdr-cli-port.ts';
export * from './process-verification-runner.ts';
export * from './structured-agent-runner.ts';
export * from './run-plan.ts';
export * from './git-integration-runner.ts';
export * from './vertical-slice.ts';
export * from './runtime-manifests.ts';
export * from './vertical-cli.ts';

import { GitWorktreePort } from './git-worktree-port.ts';
import { HerdrCliPort, type HerdrCliConfig } from './herdr-cli-port.ts';
import { NodeCommandRunner, minimalProcessEnv, type CommandRunner } from './command-runner.ts';
import { ProcessVerificationRunner } from './process-verification-runner.ts';
import { boundReviewerDiff } from '../core/reviewer-brief.ts';

export interface RealHostOptions {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly herdr: HerdrCliConfig;
  readonly verificationCommands?: readonly string[];
  readonly verificationAllowlist?: readonly string[];
  readonly verificationTimeoutMs?: number;
  readonly commandRunner?: CommandRunner;
}

/** Composable host wiring; constructing it does not start an agent or model. */
export function createRealHost(options: RealHostOptions) {
  const commandRunner = options.commandRunner ?? new NodeCommandRunner();
  const worktree = new GitWorktreePort({ repoRoot: options.repoRoot, workspaceRoot: options.workspaceRoot, commandRunner });
  const herdr = new HerdrCliPort(options.herdr, commandRunner);
  const allowlist = options.verificationAllowlist ?? options.verificationCommands ?? [];
  const createVerificationRunner = (workspacePath: string, allowedCommands: readonly string[] = allowlist) => new ProcessVerificationRunner({ commandRunner, cwd: workspacePath, allowedCommands, ...(options.verificationTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.verificationTimeoutMs }) });
  const readArtifactDiff = (workspacePath: string, baseRevision: string, artifactRevision: string): string => {
    if (![baseRevision, artifactRevision].every((revision) => typeof revision === 'string' && revision.length > 0 && revision.length <= 256 && !/[\0\s]/.test(revision))) throw new Error('artifact revisions are invalid');
    const result = commandRunner.run({ command: 'git', args: ['diff', '--no-ext-diff', '--no-color', `${baseRevision}...${artifactRevision}`, '--'], cwd: workspacePath, env: minimalProcessEnv(undefined), maxOutputBytes: 33 * 1024 });
    if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || 'git diff failed');
    return boundReviewerDiff(result.stdout, result.stdoutTruncated);
  };
  return Object.freeze({ commandRunner, worktree, herdr, createVerificationRunner, readArtifactDiff });
}
