export * from './command-runner.ts';
export * from './git-worktree-port.ts';
export * from './herdr-cli-port.ts';
export * from './process-verification-runner.ts';

import { GitWorktreePort } from './git-worktree-port.ts';
import { HerdrCliPort, type HerdrCliConfig } from './herdr-cli-port.ts';
import { NodeCommandRunner, type CommandRunner } from './command-runner.ts';
import { ProcessVerificationRunner } from './process-verification-runner.ts';

export interface RealHostOptions {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly herdr: HerdrCliConfig;
  readonly verificationCommands?: readonly string[];
  readonly commandRunner?: CommandRunner;
}

/** Composable host wiring; constructing it does not start an agent or model. */
export function createRealHost(options: RealHostOptions) {
  const commandRunner = options.commandRunner ?? new NodeCommandRunner();
  const worktree = new GitWorktreePort({ repoRoot: options.repoRoot, workspaceRoot: options.workspaceRoot, commandRunner });
  const herdr = new HerdrCliPort(options.herdr, commandRunner);
  const createVerificationRunner = (workspacePath: string, allowedCommands: readonly string[] = options.verificationCommands ?? []) => new ProcessVerificationRunner({ commandRunner, cwd: workspacePath, allowedCommands });
  return Object.freeze({ commandRunner, worktree, herdr, createVerificationRunner });
}
