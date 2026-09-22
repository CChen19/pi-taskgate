import { minimalProcessEnv, type CommandRunner } from './command-runner.ts';
import type { IntegrationGitOps, IntegrationRunner, IntegrationUnit } from '../core/integration.ts';
import type { VerificationCommand } from '../core/verification.ts';
import type { WorkspaceLease } from '../adapters/worktree-manager.ts';

export interface GitIntegrationRunnerOptions {
  readonly commandRunner: CommandRunner;
  readonly integration: WorkspaceLease;
  readonly baseRevision: string;
  readonly verificationAllowlist: readonly string[];
  readonly verificationTimeoutMs: number;
  readonly gitBinary?: string;
  /** Optional timeout for git plumbing; defaults to verificationTimeoutMs. */
  readonly gitTimeoutMs?: number;
  /** Optional env source; only PATH/HOME/LANG/LC_ALL/TMPDIR are forwarded. */
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function command(options: GitIntegrationRunnerOptions, args: readonly string[]) {
  return {
    command: options.gitBinary ?? 'git',
    args,
    cwd: options.integration.workspacePath,
    env: minimalProcessEnv(options.env),
    timeoutMs: options.gitTimeoutMs ?? options.verificationTimeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

function run(options: GitIntegrationRunnerOptions, args: readonly string[]) {
  return options.commandRunner.run(command(options, args));
}

function revisionFrom(output: string): string {
  const revision = output.trim();
  if (revision.length === 0 || /\s/.test(revision)) throw new Error('git returned an invalid revision');
  return revision;
}

/** Real S6 adapter. It never rewrites worker branches and never merges user master. */
export class GitIntegrationRunner implements IntegrationRunner {
  readonly gitOps: IntegrationGitOps;
  readonly commandRunner: { run(command: VerificationCommand): unknown };
  private readonly options: GitIntegrationRunnerOptions;
  constructor(options: GitIntegrationRunnerOptions) {
    this.options = options;
    this.gitOps = {
      rebase: (base, unit: IntegrationUnit) => {
        // Port misuse guard: the run pins one immutable base; a caller passing
        // anything else must fail closed instead of silently rebasing elsewhere.
        if (base !== this.options.baseRevision) throw new Error(`integration rebase base does not match the configured base revision: received ${base}, pinned ${this.options.baseRevision}`);
        const head = run(this.options, ['rev-parse', unit.branch]);
        if (head.status !== 'exited' || head.exitCode !== 0 || head.timedOut) return { ok: false, details: `cannot resolve ${unit.branch}` };
        const branchRevision = revisionFrom(head.stdout);
        if (branchRevision !== unit.revision) return { ok: false, details: `unit revision is stale for ${unit.branch}` };
        const ancestor = run(this.options, ['merge-base', '--is-ancestor', this.options.baseRevision, unit.revision]);
        if (ancestor.status !== 'exited' || ancestor.exitCode !== 0 || ancestor.timedOut) return { ok: false, details: 'base revision is not an ancestor of the unit' };
        return { ok: true, revision: unit.revision, details: `verified ${unit.branch} at ${unit.revision}` };
      },
      merge: (unit: IntegrationUnit) => {
        const merged = run(this.options, ['merge', '--no-ff', '--no-edit', unit.branch]);
        if (merged.status !== 'exited' || merged.exitCode !== 0 || merged.timedOut) return { ok: false, details: merged.stderr || `merge failed for ${unit.branch}` };
        const head = run(this.options, ['rev-parse', 'HEAD']);
        if (head.status !== 'exited' || head.exitCode !== 0 || head.timedOut) return { ok: false, details: 'cannot resolve integration HEAD' };
        return { ok: true, revision: revisionFrom(head.stdout), details: `merged ${unit.branch}` };
      },
      conflicts: () => {
        const result = run(this.options, ['diff', '--name-only', '--diff-filter=U', '-z']);
        if (result.status !== 'exited' || result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || 'conflict query failed');
        return { conflicts: result.stdout.split('\0').filter((path) => path.length > 0) };
      },
      status: () => {
        const status = run(this.options, ['status', '--porcelain=v1', '-z']);
        const head = run(this.options, ['rev-parse', 'HEAD']);
        if (status.status !== 'exited' || status.exitCode !== 0 || status.timedOut || head.status !== 'exited' || head.exitCode !== 0 || head.timedOut) throw new Error('integration status failed');
        return { revision: revisionFrom(head.stdout), clean: status.stdout.length === 0, details: status.stdout.length === 0 ? 'clean' : 'integration worktree is dirty' };
      },
    };
    this.commandRunner = { run: (verification) => {
      if (!this.options.verificationAllowlist.includes(verification.command)) throw new Error('verification command is not authorized');
      const result = this.options.commandRunner.run({ command: 'bash', args: ['-lc', verification.command], cwd: verification.cwd ?? this.options.integration.workspacePath, env: minimalProcessEnv(this.options.env), timeoutMs: verification.timeoutMs ?? this.options.verificationTimeoutMs, maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES });
      return { exitCode: result.exitCode === null ? 1 : result.exitCode, timedOut: result.timedOut, output: [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n'), outputRef: `integration:${verification.command}` };
    }};
  }
}
