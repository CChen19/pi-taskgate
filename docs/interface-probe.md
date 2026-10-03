# Interface-contract compile probe (`valid_expire_at`)

Status: **implemented** (probe, runner, offline tests, this document). Deliberately **not** done: any allowlist or gate-config edit, automatic probe generation, a new agent, new config fields, or any real-model benchmark. Wiring the deployed command into a task's verification list is a manual, human-authored step (see "Deployment and trust boundary").

## What it is

A minimal, caller-owned compile probe for one fixed interface contract:

> after including `handler/expire_at.h`, a caller can use a **global** `bool valid_expire_at(const std::string&)`.

This is the interface of the round-2/round-3 `expire_at` tasks, where three trials declared the function inside `namespace handler` instead (a "namespace-only slip") and the hidden oracle then failed them behaviorally. The probe detects that class of error **statically, at the interface level**, before any behavior test runs.

Files (host-owned):

- `examples/interface-probe/probe-valid-expire-at.cpp` — the whole probe. It includes the candidate's `handler/expire_at.h` and performs a single compile-time check: the function's address must convert to the caller's pointer type `bool (*)(const std::string&)`. It never declares, aliases, or wraps the implementation, never uses `assert()` (so `-DNDEBUG` cannot erase the check — it is a type conversion, not a runtime assert), and is never linked or executed.
- `examples/interface-probe/run-probe.sh` — the runner. Compiles the probe against a candidate tree into a private temp directory that is removed on success and failure; prints compiler diagnostics verbatim (temp paths scrubbed) plus a one-line classification on failure; never writes into the candidate tree and never executes candidate code.

Rejection behavior (compiler error text is the evidence; the runner only classifies):

| Candidate header | Result | Evidence |
| --- | --- | --- |
| global `inline bool valid_expire_at(const std::string&)` | exit 0, PASS | — |
| function only inside `namespace handler` | exit 1 | `'::valid_expire_at' has not been declared; did you mean 'handler::valid_expire_at'?` + runner hint "namespace-only slip" |
| global but `bool valid_expire_at(std::string)` (by value) or otherwise incompatible signature/return type | exit 1 | function-pointer conversion error, "interface contract violated" |

A header that provides the global contract *and* extra namespace-level names passes: the caller-owned contract is satisfied.

## Usage and exit codes

```
run-probe.sh [--compiler CMD] [--std STD] [--] [ROOT]
```

`ROOT` defaults to the current directory (the candidate clean-room checkout when run by verification) and must contain `handler/expire_at.h`. All paths are quoted; roots containing spaces work. Use `--` before a `ROOT` that starts with `-`.

| Exit | Meaning |
| --- | --- |
| 0 | contract satisfied |
| 1 | contract violated (compiler diagnostics printed) |
| 2 | usage error |
| 3 | probe source or candidate header not found |
| 4 | compiler not found (e.g. `--compiler nope`) |
| 5 | temp directory could not be created |

The compiler defaults to `c++` with `-std=c++14` (the candidate project's `CMAKE_CXX_STANDARD`); both are overridable because they change the actual compile. Diagnostics are produced under `LC_ALL=C` so they are untranslated and ASCII-quoted, which keeps classification deterministic.

## Deployment and trust boundary

The probe judges the candidate, so it must not be modifiable by the candidate:

1. **Deploy once, host-owned.** Copy both files to a directory outside every repository, worktree, and worker scope, e.g. `/usr/local/lib/interface-probe/` (root-owned, mode 0755/0644). Workers' mutating tools are repository-scoped and clean-room checkouts are pristine detached checkouts, so candidate code cannot alter the deployed probe.
2. **Candidate influence is compiler input only.** The candidate tree is read through `-I ROOT`; its header content can only make the compile fail or pass. Nothing from the candidate is executed; the probe object file is discarded.
3. **The allowlist stays human-authored.** This feature ships no config change. Two integration options:
   - *Allowlist entry (requires a manual, human-added exact string):* `bash /usr/local/lib/interface-probe/run-probe.sh .` — run with the verification cwd at the candidate clean-room checkout root, so `.` is the candidate root.
   - *No allowlist change:* the candidate itself registers a CTest that invokes the deployed probe path; the existing round-3 allowlisted command (`cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j4 && cd build && ctest --output-on-failure`) then runs it inside the clean room, and that one-line registration is reviewed like any other candidate commit. If the deployed path is missing, the CTest fails with exit 4/3 evidence instead of passing silently.

## Tests

`tests/interface-probe.test.ts` (offline, `node --test`; synthesizes candidate trees in the OS temp dir; never touches user data or models):

- accepts the exact global interface (candidate path with spaces), proving the runner wrote nothing into the candidate tree;
- accepts a dash-prefixed root passed after `--`, and rejects a dash-prefixed root without `--` (exit 2);
- rejects the namespace-only slip (exit 1, "did you mean 'handler::valid_expire_at'" + targeted hint);
- rejects an incompatible signature — parameter by value — (exit 1, conversion error, not misclassified as a slip);
- missing candidate header → exit 3 before any compiler is invoked;
- unknown option → exit 2;
- **missing-compiler behavior, tested explicitly** (`--compiler definitely-not-a-compiler-xyz` → exit 4 with a clear message);
- no `interface-probe.*` temp directories are left behind after success or failure.

Compiler availability is documented and probed once from `c++`: when no compiler is installed, the compile-dependent cases skip with an explicit reason while every argument/error-handling case still runs. No test depends on `/home/chris` data.

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

| Trial | Arm / scenario | Revision (full SHA) | Probe exit | Representative diagnostic |
| --- | --- | --- | --- | --- |
| wm21a | A / M | `1b8582614147fbbd70f601f93f8c0615c245ccbb` | 1 | `error: '::valid_expire_at' has not been declared; did you mean 'handler::valid_expire_at'?` → `FAIL: ... namespace-only slip` |
| wm21b | B1 / M | `8c8328ecb3bdd1b4319942b8e8606051c8f242f4` | 1 | same as wm21a |
| xm61a | A / M6 | `7d701a64a0311a5c38ec03a8fcc0c2178599f2d3` | 1 | same as wm21a |
| xm62c | B2 / M6 | `0866890150ebc0b6561f1adbd216fcde10dfdbfd` | 0 | `PASS: global bool valid_expire_at(const std::string&) usable from <root>/handler/expire_at.h` |

Corroborating historical context (structured result fields only): the three negative revisions failed their hidden calendar oracle (`oracle_pass: false`, `"expire: hidden calendar oracle failed"`); xm62c passed it. The probe is an *interface-level* static check that complements such behavioral oracles — it would have localized the failures to the contract violation before any behavior test ran. Compiler used for the evidence above: `c++` → GCC 9.4.0, `-std=c++14` (the runner default).

**Claim scope.** The probe is evidenced only for the known cases above (namespace-only slip rejected; correct global interface accepted; wrong signature rejected by the same conversion check, as covered by the synthetic tests). No claim is made — and none should be inferred — about future model error rates.
