# Interview case study: one interface failure, one probe, and what acceptance means

A self-contained walkthrough of a failure the benchmark rounds exposed repeatedly, the
minimal tool built afterwards, and the exact claim each piece of evidence carries. The
probe reference is [interface-probe.md](interface-probe.md); the gate mechanics are in
[architecture.md](architecture.md). Historical experiment records (pre-registrations and
benchmark reports) are left untouched; this document only interprets them.

## The failure

In rounds 2 and 3, three delivered trials of the `expire_at` task — `wm21a`, `wm21b`
(round 2) and `xm61a` (round 3) — put the function `valid_expire_at` inside
`namespace handler`. The task's caller (the hidden grading oracle) expects a **global**
`bool valid_expire_at(const std::string&)`. The candidates' own trees built and passed
their allowlisted verification, because nothing inside a candidate compiles the caller
side; the mismatch only surfaced when the oracle was compiled against the delivered
header, which then did not build. All three failed their hidden calendar oracle
(`oracle_pass: false`). Both benchmark arms failed the same way — with and without the
taskgate tools — so this is not a tooling regression: it is a gap no arm's checks
covered.

## Root cause: a shared interface assumption nobody wrote down

Candidate code and its callers agree on an interface, and in these trials that agreement
lived only in the caller's head. The plan and worker brief described behavior, but never
pinned the linkage the caller relies on: global, not namespace-qualified;
`const std::string&`, not by value. No allowlisted verification command compiled a
caller, and the reviewer saw the candidate's diff without the caller's expectations. The
error was therefore invisible to every check the plan made checkable, and it repeated
identically across two models and three trials — a property of how the task was
specified, not model-specific noise. This is evidence of one specific, repeated
specification gap; it is not evidence that any mechanism generally reduces model error
rates.

## The minimal independent probe

The fix is not a smarter agent but a written-down contract, checked independently: a
caller-owned **compile probe** for exactly one fixed interface contract — after
including `handler/expire_at.h`, a caller can use a global
`bool valid_expire_at(const std::string&)`. The probe (`probe-valid-expire-at.cpp`)
includes the candidate's header and checks, at compile time, that the function's address
converts to the caller's pointer type `bool (*)(const std::string&)`. It never declares,
aliases, or wraps the implementation, contains no `assert()` (so `-DNDEBUG` cannot erase
the check — it is a type conversion, not a runtime assert), and is never linked or
executed. Its runner (`run-probe.sh`) compiles the probe into a private temporary
directory, prints the compiler's diagnostics verbatim, and exits 0 (contract satisfied)
or 1 (violated).

Usage in this system: the human adds the probe's exact command line to the
verification allowlist, and `task_verify` runs it like any other allowlisted command —
in the clean checkout of the exact candidate revision, before any review. The probe
files are deployed once, host-owned, outside every repository and worker scope; a
candidate can influence the probe only as compiler input. That protection is an
operational property of the deployment, not a sandbox: capability declarations are
policy data, and candidate-owned wiring of the probe inside its own tree is not a gate.

## Historical positive/negative results

Run against the exact delivered revisions, from temporary clones (original repositories
and worktrees untouched; no model trial rerun). Compiler: GCC 9.4.0 via `c++`,
`-std=c++14`.

| Trial | Arm / scenario | Revision | Probe exit | Evidence |
| --- | --- | --- | --- | --- |
| wm21a | A / M | `1b8582614147fbbd70f601f93f8c0615c245ccbb` | 1 | `'::valid_expire_at' has not been declared; did you mean 'handler::valid_expire_at'?` |
| wm21b | B1 / M | `8c8328ecb3bdd1b4319942b8e8606051c8f242f4` | 1 | same as wm21a |
| xm61a | A / M6 | `7d701a64a0311a5c38ec03a8fcc0c2178599f2d3` | 1 | same as wm21a |
| xm62c | B2 / M6 | `0866890150ebc0b6561f1adbd216fcde10dfdbfd` | 0 | global contract usable from `handler/expire_at.h` |

The three negatives are exactly the trials whose hidden oracle failed; the one positive
is the trial whose oracle passed. That, plus synthetic offline cases (namespace-only
slip rejected; correct global interface accepted; incompatible signature rejected by the
same conversion check), is the entire evidence base.

## Limits

- **One fixed contract.** The probe judges nothing except the `valid_expire_at` linkage.
  A new contract means a hand-written probe and a human-added allowlist entry; nothing
  generates probes automatically.
- **Declaration-level only.** It shows the symbol exists with that type at the
  interface. It says nothing about behavior, and it complements rather than replaces
  behavioral oracles.
- **Bounded evidence.** Evidenced for the four revisions above and the synthetic cases.
  No claim is made — and none should be inferred — about future trials, other
  codebases, or model error rates.
- **No general correctness or security guarantee.** The probe, the allowlist, and the
  gate are narrow checks; nothing here makes an accepted artifact correct in general or
  secure, and the deployment trust properties are operational, not declared.

## What an accepted revision is — and is not

A taskgate acceptance (PASSED, `DELIVERABLE`) is a statement about host-observed
evidence at one exact revision: a clean in-scope worktree, the human-allowlisted
verification — including the probe, once wired in — run against a fresh checkout of
that revision, and a fresh read-only reviewer who read that brief and returned a verdict
naming that revision. That is all it states.

It is **not** a statement that the plan was complete. The `expire_at` trials passed
every check their plans made checkable and still missed the caller's interface, because
the plans never recorded that interface as a criterion. Acceptance inherits the plan's
blind spots; only the human writing contracts, scope, and the allowlist can close them.
The probe is the pattern for one such closure — take a known, written-down assumption
and turn it into a checkable command — not a step toward automatic completeness. The
`task_status` delivery summary ([delivery-summary.md](delivery-summary.md)) similarly
reports which evidence binds to the delivered revision and which planned tasks the
deliverable omits: visibility, not certification.

Accordingly, the probe work's own accepted revision means its evidence obligations were
met at that revision (offline tests, its reference document, no allowlist or config
change shipped with it). It does not mean the probe idea is finished, that other
interface contracts are covered, or that anything built on top of it is correct or
secure.
