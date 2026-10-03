// Offline fixture tests for the host-owned interface-contract probe
// (examples/interface-probe). The suite synthesizes tiny candidate trees in
// the OS temp dir, runs the runner via bash, and asserts exit codes,
// diagnostics, `--` argument handling, and temp-dir cleanup. It never reads
// or writes data outside its own fixtures and never calls models or agents.
//
// Compiler availability is probed once from `c++` and documented: when no
// compiler is installed, compile-dependent cases are skipped with an explicit
// reason, while argument/error handling (including the explicit
// missing-compiler case) still runs everywhere.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUN_PROBE = fileURLToPath(new URL('../examples/interface-probe/run-probe.sh', import.meta.url));
/** The runner's private temp dir prefix; leftovers after a run are a bug. */
const RUNNER_TEMP_PREFIX = 'interface-probe.';
const SKIP_NO_COMPILER = 'no C++ compiler found as c++ on PATH; compile-dependent cases are skipped (missing-compiler behavior is tested separately)';

function compilerAvailable(): boolean {
  const probe = spawnSync('c++', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return probe.error === undefined && probe.status === 0;
}

const hasCompiler = compilerAvailable();
const compileTest = { skip: hasCompiler ? false : SKIP_NO_COMPILER };

/** Minimal correct candidate: the contract function at global scope. */
const GOOD_HEADER = `#ifndef HANDLER_EXPIRE_AT_H
#define HANDLER_EXPIRE_AT_H
#include <string>
inline bool valid_expire_at(const std::string& expire_at) { return expire_at.size() == 19; }
#endif
`;

/** The historical failure shape: same function inside namespace handler. */
const NAMESPACE_SLIP_HEADER = `#ifndef HANDLER_EXPIRE_AT_H
#define HANDLER_EXPIRE_AT_H
#include <string>
namespace handler {
inline bool valid_expire_at(const std::string& expire_at) { return expire_at.size() == 19; }
}
#endif
`;

/** Incompatible signature: callable at the call site, wrong declared shape. */
const BY_VALUE_HEADER = `#ifndef HANDLER_EXPIRE_AT_H
#define HANDLER_EXPIRE_AT_H
#include <string>
inline bool valid_expire_at(std::string expire_at) { return expire_at.size() == 19; }
#endif
`;

/** Writes a synthetic candidate tree holding only handler/expire_at.h. */
function candidate(base: string, header: string): string {
  const root = join(base, 'candidate root');
  mkdirSync(join(root, 'handler'), { recursive: true });
  writeFileSync(join(root, 'handler', 'expire_at.h'), header);
  return root;
}

function freshBase(label: string): string {
  return mkdtempSync(join(tmpdir(), `iface-probe-test-${label}-`));
}

interface ProbeRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnProbe(args: readonly string[], cwd?: string): ProbeRun {
  const result = spawnSync('bash', [RUN_PROBE, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return {
    status: result.status ?? -1, // signaled/killed counts as failure
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runProbe(args: readonly string[]): ProbeRun {
  return spawnProbe(args);
}

function runnerTempEntries(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(RUNNER_TEMP_PREFIX)).sort();
}

function assertRunnerCleanedTemp(before: readonly string[]): void {
  assert.deepEqual(runnerTempEntries(), before, 'runner left temporary directories behind');
}

/** Relative file list, proving the runner never writes into the candidate tree. */
function listFiles(root: string, prefix = ''): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) entries.push(...listFiles(join(root, entry.name), relative));
    else entries.push(relative);
  }
  return entries.sort();
}

describe('interface contract probe (examples/interface-probe)', () => {
  it('documents missing-compiler behavior: unknown compiler exits 4 with a clear message', () => {
    const before = runnerTempEntries();
    const base = freshBase('missing-compiler');
    const run = runProbe(['--compiler', 'definitely-not-a-compiler-xyz', candidate(base, GOOD_HEADER)]);
    assert.equal(run.status, 4);
    assert.match(run.stderr, /compiler not found: 'definitely-not-a-compiler-xyz'/);
    assertRunnerCleanedTemp(before);
  });

  it('reports a missing candidate header as exit 3 before invoking any compiler', () => {
    const before = runnerTempEntries();
    const base = freshBase('missing-header');
    const run = runProbe([base]);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /candidate header not found/);
    assertRunnerCleanedTemp(before);
  });

  it('treats a dash-prefixed ROOT after "--" as a path, not an option', () => {
    const before = runnerTempEntries();
    const base = freshBase('dash');
    const dashRoot = join(base, '-dash-root');
    mkdirSync(dashRoot, { recursive: true });
    // The argument must be dash-leading relative to the runner's cwd, so run
    // with cwd = base and pass the bare name.
    const spawn = (args: readonly string[]): ProbeRun =>
      spawnProbe(args, base);
    const withoutMarker = spawn(['-dash-root']);
    assert.equal(withoutMarker.status, 2, 'dash-prefixed ROOT without "--" must be a usage error');
    assert.match(withoutMarker.stderr, /unknown option: -dash-root/);
    const withMarker = spawn(['--', '-dash-root']);
    assert.equal(withMarker.status, 3, '"--" must pass the dash-prefixed ROOT through (fails later on missing header)');
    assert.match(withMarker.stderr, /-dash-root/);
    assertRunnerCleanedTemp(before);
  });

  it('rejects unknown options with exit 2', () => {
    const run = runProbe(['--header', 'whatever']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown option: --header/);
  });

  it('accepts a candidate with the exact global interface (path with spaces)', compileTest, () => {
    const before = runnerTempEntries();
    const base = freshBase('good');
    const root = candidate(base, GOOD_HEADER);
    const files = listFiles(root);
    const run = runProbe([root]);
    assert.equal(run.status, 0, `expected pass, stderr: ${run.stderr}`);
    assert.match(run.stdout, /PASS/);
    assert.match(run.stdout, /valid_expire_at\(const std::string&\)/);
    assert.deepEqual(listFiles(root), files, 'runner wrote into the candidate tree');
    assertRunnerCleanedTemp(before);
  });

  it('accepts a dash-prefixed candidate root passed after "--"', compileTest, () => {
    const before = runnerTempEntries();
    const base = freshBase('dash-good');
    const dashRoot = join(base, '-dash-root');
    mkdirSync(join(dashRoot, 'handler'), { recursive: true });
    writeFileSync(join(dashRoot, 'handler', 'expire_at.h'), GOOD_HEADER);
    const run = spawnProbe(['--', '-dash-root'], base);
    assert.equal(run.status, 0, `expected pass, stderr: ${run.stderr}`);
    assert.match(run.stdout, /PASS/);
    assertRunnerCleanedTemp(before);
  });

  it('rejects a namespace-only slip with a targeted hint and compiler evidence', compileTest, () => {
    const before = runnerTempEntries();
    const base = freshBase('slip');
    const run = runProbe([candidate(base, NAMESPACE_SLIP_HEADER)]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /has not been declared/);
    assert.match(run.stderr, /did you mean 'handler::valid_expire_at'/);
    assert.match(run.stderr, /namespace-only slip/);
    assertRunnerCleanedTemp(before);
  });

  it('rejects an incompatible signature (parameter by value) as a contract violation', compileTest, () => {
    const before = runnerTempEntries();
    const base = freshBase('byval');
    const run = runProbe([candidate(base, BY_VALUE_HEADER)]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /error:/);
    assert.match(run.stderr, /interface contract violated/);
    assert.doesNotMatch(run.stderr, /namespace-only slip/, 'signature failure must not be misclassified as a slip');
    assertRunnerCleanedTemp(before);
  });
});
