import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GitWorktreePort } from './git-worktree-port.ts';
import { NodeCommandRunner, type CommandResult } from './command-runner.ts';
import { WorktreeManager } from '../adapters/worktree-manager.ts';

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = flag(args, name);
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

const DOCTOR_ENV_NAMES = ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID'] as const;

function doctorEnv(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key === 'PATH' || key === 'HOME' || key === 'USER' || key === 'SHELL' || key === 'LANG' || key === 'TERM' || key === 'TMP' || key.startsWith('LC_') || key.startsWith('XDG_') || key.startsWith('HERDR_'))) result[key] = value;
  }
  return result;
}

function probe(runner: NodeCommandRunner, command: string, args: readonly string[]): { readonly ok: boolean; readonly status: CommandResult['status']; readonly exitCode: number | null } {
  const result = runner.run({ command, args, cwd: process.cwd(), env: doctorEnv(), maxOutputBytes: 4096 });
  return { ok: result.status === 'exited' && result.exitCode === 0 && !result.timedOut, status: result.status, exitCode: result.exitCode };
}

export function doctor(): unknown {
  const runner = new NodeCommandRunner();
  const env = Object.fromEntries(DOCTOR_ENV_NAMES.map((name) => [name, Object.hasOwn(process.env, name)]));
  const herdr = probe(runner, process.env['HERDR_BINARY'] ?? 'herdr', ['status']);
  const pi = probe(runner, process.env['PI_BINARY'] ?? 'pi', ['--version']);
  const git = probe(runner, process.env['GIT_BINARY'] ?? 'git', ['--version']);
  const envOk = Object.values(env).every(Boolean);
  return { capability: 'real-host', herdr, pi, git, requiredEnv: env, ok: herdr.ok && pi.ok && git.ok && envOk };
}

export function gitSmoke(args: readonly string[]): unknown {
  const repoRoot = required(args, '--repo');
  const workspaceRoot = required(args, '--workspace-root');
  const base = required(args, '--base');
  if (!existsSync(repoRoot)) throw new Error('repo path does not exist');
  const runner = new NodeCommandRunner();
  const port = new GitWorktreePort({ repoRoot, workspaceRoot, commandRunner: runner });
  const manager = new WorktreeManager({ repoRoot, workspaceRoot, idSource: () => createHash('sha256').update(`${process.pid}:${Date.now()}`).digest('hex').slice(0, 24) });
  const taskId = 'host-git-smoke';
  const attemptId = `${taskId}:attempt-1`;
  const lease = manager.acquire(port, taskId, attemptId, base);
  let inspection: unknown;
  let errorMessage: string | undefined;
  try { inspection = manager.inspect(port, lease); }
  catch (error) { errorMessage = error instanceof Error ? error.message : 'git smoke failed'; }
  const cleaned = manager.cleanup(port, lease);
  return { ok: errorMessage === undefined && cleaned.ok, lease: { workspacePath: lease.workspacePath, branch: lease.branch }, ...(inspection === undefined ? {} : { inspection }), ...(errorMessage === undefined ? {} : { error: errorMessage }), cleanup: cleaned };
}

export function main(argv = process.argv.slice(2)): void {
  const command = argv[0];
  const output = command === 'doctor' ? doctor() : command === 'git-smoke' ? gitSmoke(argv.slice(1)) : (() => { throw new Error('usage: doctor | git-smoke --repo <path> --workspace-root <path> --base <rev>'); })();
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1]?.endsWith('/src/host/cli.ts') === true || process.argv[1]?.endsWith('src/host/cli.ts') === true) {
  try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'host command failed' })}\n`); process.exitCode = 1; }
}
