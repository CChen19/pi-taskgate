// Offline fixture tests for the host-owned interface-contract probe
// (examples/interface-probe). Hermetic by construction:
//
//   * every case gets its own sandbox: a fixture root plus an EXCLUSIVE
//     TMPDIR handed to that single runner invocation, so nothing is ever
//     asserted about shared global temp state;
//   * each sandbox is removed recursively in the case's t.after hook, so
//     fixtures do not leak;
//   * assertions are compiler-agnostic (exit codes, our own PASS/FAIL
//     lines, and the generic "error:" marker) — c++ may be GCC or clang.
//
// Compiler availability is probed once from `c++` and documented: when no
// compiler is installed, compile-dependent cases skip with an explicit
// reason, while argument/error handling (including the explicit
// missing-compiler case) still runs everywhere. No test reads or writes
// outside its own sandbox, calls models, or starts agents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const RUN_PROBE = fileURLToPath(new URL('../examples/interface-probe/run-probe.sh', import.meta.url));
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

interface Sandbox {
  /** Case fixture root (contains the candidate tree when a header is written). */
  readonly root: string;
  /** Private TMPDIR for exactly one runner invocation; must be empty after it. */
  readonly tmp: string;
}

/**
 * Per-case sandbox under one mkdtemp base. t.after removes the whole base
 * recursively, so neither fixtures nor runner temp dirs can leak.
 */
function makeSandbox(t: TestContext, label: string): Sandbox {
  const base = mkdtempSync(join(tmpdir(), `iface-probe-${label}-`));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, 'root');
  const tmp = join(base, 'tmp');
  mkdirSync(root);
  mkdirSync(tmp);
  return { root, tmp };
}

/** Writes the synthetic candidate tree (only handler/expire_at.h). */
function writeCandidate(sandbox: Sandbox, header: string): void {
  mkdirSync(join(sandbox.root, 'handler'));
  writeFileSync(join(sandbox.root, 'handler', 'expire_at.h'), header);
}

interface ProbeRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnProbe(args: readonly string[], sandbox: Sandbox, cwd?: string): ProbeRun {
  const result = spawnSync('bash', [RUN_PROBE, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, TMPDIR: sandbox.tmp },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return {
    status: result.status ?? -1, // signaled/killed counts as failure
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The runner must consume its private TMPDIR completely: empty means cleaned. */
function assertTempCleaned(sandbox: Sandbox): void {
  assert.deepEqual(readdirSync(sandbox.tmp), [], 'runner left entries in its private TMPDIR');
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
  it('documents missing-compiler behavior: unknown compiler exits 4 with a clear message', (t) => {
    const sandbox = makeSandbox(t, 'missing-compiler');
    writeCandidate(sandbox, GOOD_HEADER);
    const run = spawnProbe(['--compiler', 'definitely-not-a-compiler-xyz', sandbox.root], sandbox);
    assert.equal(run.status, 4);
    assert.match(run.stderr, /compiler not found: 'definitely-not-a-compiler-xyz'/);
    assertTempCleaned(sandbox);
  });

  it('reports a missing candidate header as exit 3 before invoking any compiler', (t) => {
    const sandbox = makeSandbox(t, 'missing-header');
    const run = spawnProbe([sandbox.root], sandbox);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /candidate header not found/);
    assertTempCleaned(sandbox);
  });

  it('rejects unknown options with exit 2', (t) => {
    const sandbox = makeSandbox(t, 'unknown-option');
    const run = spawnProbe(['--header', 'whatever'], sandbox);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown option: --header/);
    assertTempCleaned(sandbox);
  });

  it('rejects a second ROOT with a usage error', (t) => {
    const sandbox = makeSandbox(t, 'extra-root');
    const other = join(sandbox.root, 'second-root');
    mkdirSync(other);
    const run = spawnProbe(['--', sandbox.root, other], sandbox);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unexpected extra arguments/);
    assertTempCleaned(sandbox);
  });

  it('treats a dash-prefixed ROOT after "--" as a path, not an option', (t) => {
    const sandbox = makeSandbox(t, 'dash');
    const dashRoot = join(sandbox.root, '-dash-root');
    mkdirSync(dashRoot);
    // The argument must be dash-leading relative to the runner's cwd, so run
    // with cwd = sandbox.root and pass the bare name.
    const withoutMarker = spawnProbe(['-dash-root'], sandbox, sandbox.root);
    assert.equal(withoutMarker.status, 2, 'dash-prefixed ROOT without "--" must be a usage error');
    assert.match(withoutMarker.stderr, /unknown option: -dash-root/);
    const withMarker = spawnProbe(['--', '-dash-root'], sandbox, sandbox.root);
    assert.equal(withMarker.status, 3, '"--" must pass the dash-prefixed ROOT through (fails later on missing header)');
    assert.match(withMarker.stderr, /-dash-root/);
    assertTempCleaned(sandbox);
  });

  it('accepts a candidate with the exact global interface (path with spaces)', compileTest, (t) => {
    const sandbox = makeSandbox(t, 'good');
    writeCandidate(sandbox, GOOD_HEADER);
    const files = listFiles(sandbox.root);
    const run = spawnProbe([sandbox.root], sandbox);
    assert.equal(run.status, 0, `expected pass, stderr: ${run.stderr}`);
    assert.match(run.stdout, /PASS/);
    assert.match(run.stdout, /valid_expire_at\(const std::string&\)/);
    assert.deepEqual(listFiles(sandbox.root), files, 'runner wrote into the candidate tree');
    assertTempCleaned(sandbox);
  });

  it('accepts a dash-prefixed candidate root passed after "--"', compileTest, (t) => {
    const sandbox = makeSandbox(t, 'dash-good');
    const dashRoot = join(sandbox.root, '-dash-root');
    mkdirSync(join(dashRoot, 'handler'), { recursive: true });
    writeFileSync(join(dashRoot, 'handler', 'expire_at.h'), GOOD_HEADER);
    const run = spawnProbe(['--', '-dash-root'], sandbox, sandbox.root);
    assert.equal(run.status, 0, `expected pass, stderr: ${run.stderr}`);
    assert.match(run.stdout, /PASS/);
    assertTempCleaned(sandbox);
  });

  it('keeps working when TMPDIR contains shell-special characters', compileTest, (t) => {
    const sandbox = makeSandbox(t, 'special-tmp');
    writeCandidate(sandbox, NAMESPACE_SLIP_HEADER);
    // Replace the plain private TMPDIR with one carrying specials; the
    // mkdtemp base is still cleaned by t.after.
    const specialTmp = join(sandbox.tmp, "tm p|&;'\"()$");
    mkdirSync(specialTmp);
    const special: Sandbox = { root: sandbox.root, tmp: specialTmp };
    const run = spawnProbe([sandbox.root], special);
    assert.equal(run.status, 1, `expected contract violation, stdout: ${run.stdout}`);
    assert.match(run.stderr, /interface-probe: FAIL:/);
    assert.match(run.stderr, /error:/);
    assert.match(run.stderr, /valid_expire_at/);
    assertTempCleaned(special);
  });

  it('rejects a namespace-only slip with compiler evidence', compileTest, (t) => {
    const sandbox = makeSandbox(t, 'slip');
    writeCandidate(sandbox, NAMESPACE_SLIP_HEADER);
    const run = spawnProbe([sandbox.root], sandbox);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /error:/);
    assert.match(run.stderr, /valid_expire_at/);
    assert.match(run.stderr, /interface-probe: FAIL:/);
    assert.doesNotMatch(run.stdout, /PASS/);
    assertTempCleaned(sandbox);
  });

  it('rejects an incompatible signature (parameter by value) as a contract violation', compileTest, (t) => {
    const sandbox = makeSandbox(t, 'byval');
    writeCandidate(sandbox, BY_VALUE_HEADER);
    const run = spawnProbe([sandbox.root], sandbox);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /error:/);
    assert.match(run.stderr, /interface-probe: FAIL:/);
    assert.doesNotMatch(run.stdout, /PASS/);
    assertTempCleaned(sandbox);
  });
});
