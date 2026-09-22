import { createHash } from 'node:crypto';
import { minimalProcessEnv, type CommandRunner } from './command-runner.ts';
import type { VerificationCommand, VerificationRunner, VerificationRunnerResult } from '../core/verification.ts';

export interface ProcessVerificationRunnerOptions {
  readonly commandRunner: CommandRunner;
  readonly cwd: string;
  /** Commands must be authorized by the task/preflight layer before execution. */
  readonly allowedCommands: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
}

function redact(output: string, env: NodeJS.ProcessEnv): string {
  let result = output;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= 8 && /(token|secret|password|passwd|key|credential|auth)/i.test(key)) result = result.split(value).join('[REDACTED]');
  }
  return result;
}

/**
 * Executes only an already-authorized verification command through bash -lc.
 * This is the synchronous S5 seam: timeout is Node's spawnSync best-effort
 * timeout, not the async process-group grace/kill protocol.
 */
export class ProcessVerificationRunner implements VerificationRunner {
  private readonly options: ProcessVerificationRunnerOptions;

  constructor(options: ProcessVerificationRunnerOptions) {
    if (options.allowedCommands.length === 0) throw new TypeError('verification runner requires an allowlist');
    this.options = options;
  }

  run(command: VerificationCommand): VerificationRunnerResult {
    if (!this.options.allowedCommands.includes(command.command)) throw new Error('verification command is not authorized');
    const env = minimalProcessEnv(this.options.env);
    const result = this.options.commandRunner.run({
      command: 'bash',
      args: ['-lc', command.command],
      cwd: command.cwd ?? this.options.cwd,
      env,
      ...((command.timeoutMs ?? this.options.defaultTimeoutMs) === undefined ? {} : { timeoutMs: command.timeoutMs ?? this.options.defaultTimeoutMs }),
      ...(this.options.maxOutputBytes === undefined ? {} : { maxOutputBytes: this.options.maxOutputBytes }),
    });
    const output = redact([result.stdout, result.stderr].filter((part) => part.length > 0).join('\n'), this.options.env ?? {});
    return {
      exitCode: result.exitCode === null ? 1 : result.exitCode,
      timedOut: result.timedOut,
      output,
      outputRef: `verification:${createHash('sha256').update(command.command, 'utf8').digest('hex').slice(0, 32)}`, 
    };
  }
}

