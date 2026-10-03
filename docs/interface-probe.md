# Interface-contract compile probe (`valid_expire_at`)

Status: **implemented** (probe, runner, offline tests, this document). Deliberately **not** done: any allowlist or gate-config edit, automatic probe generation, a new agent, new config fields, or any real-model benchmark. Wiring the deployed command into a task's verification list is a manual, human-authored step (see "Deployment and trust boundary").

## What it is

A minimal, caller-owned compile probe for one fixed interface contract:

> after including `handler/expire_at.h`, a caller can use a **global** `bool valid_expire_at(const std::string&)`.

This is the interface of the round-2/round-3 `expire_at` tasks, where three trials declared the function inside `namespace handler` instead (a "namespace-only slip") and the hidden oracle then failed them behaviorally. The probe detects that class of error **statically, at the interface level**, before any behavior test runs.

Files (host-owned):

- `examples/interface-probe/probe-valid-expire-at.cpp` — the whole probe. It includes the candidate's `handler/expire_at.h` and performs a single compile-time check: the function's address must convert to the caller's pointer type `bool (*)(const std::string&)`. It never declares, aliases, or wraps the implementation, never uses `assert()` (so `-DNDEBUG` cannot erase the check — it is a type conversion, not a runtime assert), and is never linked or executed.
- `examples/interface-probe/run-probe.sh` — the runner. Compiles the probe against a candidate tree into a private temp directory (honoring `TMPDIR`) that is removed on success and failure; prints compiler diagnostics **verbatim** plus one generic FAIL line (no output rewriting, no compiler-specific parsing); never writes into the candidate tree and never executes candidate code. Works with any `c++`-style compiler (GCC, clang, ...).

Rejection behavior (the compiler's own diagnostics are the evidence; the runner adds no interpretation):

| Candidate header | Result | Evidence |
| --- | --- | --- |
| global `inline bool valid_expire_at(const std::string&)` | exit 0, PASS | — |
| function only inside `namespace handler` | exit 1 | compiler reports the missing global name (GCC 9 adds `'::valid_expire_at' has not been declared; did you mean 'handler::valid_expire_at'?`) + runner FAIL line |
| global but `bool valid_expire_at(std::string)` (by value) or otherwise incompatible signature/return type | exit 1 | function-pointer conversion error + runner FAIL line |

A header that provides the global contract *and* extra namespace-level names passes: the caller-owned contract is satisfied.

## Usage and exit codes

```
run-probe.sh [--compiler CMD] [--std STD] [--] [ROOT]
```

`ROOT` defaults to the current directory (the candidate clean-room checkout when run by verification) and must contain `handler/expire_at.h`. All paths are quoted; roots containing spaces work. Use `--` before a `ROOT` that starts with `-`; a second `ROOT` is a usage error. `TMPDIR` may contain arbitrary characters (spaces, quotes, `|`, `&`, `$`) — the runner quotes every expansion and does not post-process diagnostics with pattern substitution.

| Exit | Meaning |
| --- | --- |
| 0 | contract satisfied |
| 1 | contract violated (compiler diagnostics printed) |
| 2 | usage error |
| 3 | probe source or candidate header not found |
| 4 | compiler not found (e.g. `--compiler nope`) |
| 5 | temp directory could not be created |

The compiler defaults to `c++` with `-std=c++14` (the candidate project's `CMAKE_CXX_STANDARD`); both are overridable because they change the actual compile. The compile runs under `LC_ALL=C` so diagnostics do not vary with the host locale.

## Deployment and trust boundary

The probe judges the candidate, so the candidate must not be able to alter it. **That guarantee is an operational property of the deployment, not something this feature (or any role/scope declaration) provides:** capability declarations in this system are policy data, not an OS sandbox, and clean-room pristineness protects the checked-out candidate tree only — not host-owned paths. The human deploying the probe therefore owns these prerequisites:

1. **Deploy once, host-owned, non-writable by workers.** Copy both files to a directory outside every repository, worktree, and worker scope — e.g. `/usr/local/lib/interface-probe/`, root-owned `0755`, files `0644` — and verify the permissions and ownership as part of the deploy step. Workers must not have write access to that path through any identity they run as.
2. **Candidate influence is compiler input only.** The candidate tree is read through `-I ROOT`; its header content can only make the compile fail or pass. Nothing from the candidate is executed; the probe object file is discarded.
3. **The allowlist is the enforcement point.** The gate is the exact-match allowlisted command run by the verification runner with its cwd at the candidate clean-room checkout root: `bash /usr/local/lib/interface-probe/run-probe.sh .` Adding that string to the task's verification list (and to the host allowlist it must match) is a manual, human-authored act; this feature ships no config change.

**Candidate-owned wiring is not a gate.** If a candidate registers the probe as a CTest or script inside its own repo, that wiring is candidate-controlled: it can be omitted, weakened, or pointed at something else, and nothing host-side verifies what it actually executes. Such registration may exist as convenience, but it must never be presented or accepted as equivalent independent enforcement — only the host-added allowlisted command in the clean-room cwd is.

## Tests

`tests/interface-probe.test.ts` (offline, `node --test`): every case runs the runner inside its own sandbox — a fixture root plus an **exclusive `TMPDIR`** passed to that single invocation — and the sandbox is removed recursively in the case's `t.after` hook. Assertions never scan shared global temp state; "cleanup" means the runner's private `TMPDIR` is left empty after success and after failure. Assertions are compiler-agnostic (exit codes, the runner's own PASS/FAIL lines, the generic `error:` marker), so the suite holds whether `c++` is GCC or clang.

Cases: accepts the exact global interface (candidate path with spaces), accepts a dash-prefixed root after `--` and rejects it without `--` (exit 2), rejects the namespace-only slip (exit 1 with compiler evidence), rejects an incompatible signature — parameter by value — (exit 1), missing candidate header → exit 3 before any compiler runs, unknown option → exit 2, a second `ROOT` → usage error, `TMPDIR` with shell-special characters still produces intact diagnostics and cleanup, **missing-compiler behavior tested explicitly** (`--compiler definitely-not-a-compiler-xyz` → exit 4 with a clear message), and the runner never writes into the candidate tree. No test reads or writes outside its own sandbox and no test depends on `/home/chris` data.

Compiler availability is documented and probed once from `c++`: when no compiler is installed, the compile-dependent cases skip with an explicit reason while every argument/error-handling case still runs.

## Historical evidence (temporary checkouts; originals untouched)

The probe was run against the exact delivered revisions of the historical trials, read from **temporary clones**; the original trial repositories and worktrees were not modified, and no model trial was rerun. `REV` is `final_revision` from the trial's structured metrics record; the revisions below are the full delivered SHAs.

Reproduction template (portable paths; `<trial repo>` is the trial's repository for that ID):

```bash
WORK=$(mktemp -d)
git clone --no-checkout "<trial repo>" "$WORK/<ID>"
git -C "$WORK/<ID>" checkout <REV>
bash /usr/local/lib/interface-probe/run-probe.sh "$WORK/<ID>"; echo "exit=$?"
rm -rf "$WORK"
```

| Trial | Arm / scenario | Revision (full SHA) | Probe exit | Representative output |
| --- | --- | --- | --- | --- |
| wm21a | A / M | `1b8582614147fbbd70f601f93f8c0615c245ccbb` | 1 | `error: '::valid_expire_at' has not been declared; did you mean 'handler::valid_expire_at'?` + `interface-probe: FAIL: contract not satisfied at <root>/handler/expire_at.h; ...` |
| wm21b | B1 / M | `8c8328ecb3bdd1b4319942b8e8606051c8f242f4` | 1 | same as wm21a |
| xm61a | A / M6 | `7d701a64a0311a5c38ec03a8fcc0c2178599f2d3` | 1 | same as wm21a |
| xm62c | B2 / M6 | `0866890150ebc0b6561f1adbd216fcde10dfdbfd` | 0 | `PASS: global bool valid_expire_at(const std::string&) usable from <root>/handler/expire_at.h` |

Corroborating historical context (structured result fields only): the three negative revisions failed their hidden calendar oracle (`oracle_pass: false`, `"expire: hidden calendar oracle failed"`); xm62c passed it. The probe is an *interface-level* static check that complements such behavioral oracles — it would have localized the failures to the contract violation before any behavior test ran. Compiler used for the evidence above: `c++` → GCC 9.4.0, `-std=c++14` (the runner default); the quoted diagnostic is that compiler's wording.

**Claim scope.** The probe is evidenced only for the known cases above (namespace-only slip rejected; correct global interface accepted; wrong signature rejected by the same conversion check, as covered by the synthetic tests). No claim is made — and none should be inferred — about future model error rates.
