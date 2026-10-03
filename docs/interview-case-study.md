# Interview case study: one interface failure, one probe, and what acceptance means

A self-contained walkthrough of a failure the benchmark rounds observed three times, the
minimal tool built afterwards, and the exact claim each piece of evidence carries. The
probe reference is [interface-probe.md](interface-probe.md), which ships with the
interface-probe slice (accepted revision `891b6391287042f8d56e16df931cfe360a4b3515`) and
resolves in the integrated checkout, not in this branch slice; the probe's design and
limits are in "The minimal independent probe" below, and the gate mechanics are in
[architecture.md](architecture.md). Historical experiment records (pre-registrations and
benchmark reports) are left untouched; this document only interprets them.

## The failure

The `expire_at` task text names the requested interface explicitly: *"Move the
validation into a new header `handler/expire_at.h` as `inline bool
valid_expire_at(const std::string&)` and make `short_url_handler.cpp` use it."* In
three delivered trials — `wm21a` and `wm21b` (round 2), `xm61a` (round 3) — the
delivered `handler/expire_at.h` instead declared the function inside `namespace
handler`. The delivered logic was correct in all three and the workers' own tests
passed; what failed is the hidden grading oracle, which follows the task text and calls
the function unqualified, so its translation unit did not compile (`oracle_pass:
false`). The slips were observed in both benchmark arms — two in Pier-only arms, one in
a tools arm ([summary](summary-rounds-1-3.md)) — so the checks of either arm could let
this specific failure through.

## The observed check gap

The requested interface was present in the task text, down to the `inline` keyword and
the `const std::string&` parameter. What no check in either arm did was **enforce** it
against a caller outside the candidate's own tree:

- The workers' own tests include the header and exercise the logic through the same
  namespace-qualified spelling, so they compile and pass.
- The verification allowlist runs the repository's own build and tests, which agree
  with a candidate whose internal callers use its declaration.
- The reviewers read the diff and the brief; in these trials none compiled an outside
  caller either, and no gate check requires it.

So an interface requirement stated in the task text, and relied on by an external
caller, can survive local verification end to end. That is the observable lesson
recorded here — nothing more. The three trials are the entire evidence base; no claim
is made about why individual models slipped, whether the pattern generalizes, or what
any model does in general.

## The minimal independent probe

The remedy is to make the already-written contract checked, independently of the
candidate's own callers: a caller-owned **compile probe** for exactly one fixed
interface contract — after including `handler/expire_at.h`, a caller can use a global
`inline bool valid_expire_at(const std::string&)` as the task text requests. The probe
(`probe-valid-expire-at.cpp`) includes the candidate's header and checks, at compile
time, that the function's address converts to the caller's pointer type
`bool (*)(const std::string&)`. It never declares, aliases, or wraps the
implementation, contains no `assert()` (so `-DNDEBUG` cannot erase the check — it is a
type conversion, not a runtime assert), and is never linked or executed. Its runner
(`run-probe.sh`) compiles the probe into a private temporary directory, prints the
compiler's diagnostics verbatim, and exits 0 (contract satisfied) or 1 (violated).

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
  codebases, model behavior, or model error rates.
- **No general correctness or security guarantee.** The probe, the allowlist, and the
  gate are narrow checks; nothing here makes an accepted artifact correct in general or
  secure, and the deployment trust properties are operational, not declared.

## What an accepted revision is — and is not

A taskgate acceptance (PASSED, `DELIVERABLE`) is a statement about host-observed
evidence at one exact revision: a clean in-scope worktree, the human-allowlisted
verification — including the probe, once wired in — run against a fresh checkout of
that revision, and, **when a review is required**, a fresh read-only reviewer who read
that brief and returned a verdict naming that revision. `review_required` defaults to
true, but a task can set it to false; such a task is accepted on the mechanical
evidence alone, with no review step. That is all acceptance states.

It is **not** a statement of specification or test adequacy. Acceptance runs the checks
the plan defines; a requirement the task text states but no check enforces can still be
missed — the `expire_at` trials are the observed instance: the interface was requested
in the task text, yet nothing in those checks compiled an outside caller against it.
The probe is the pattern for closing one such gap — turn a named requirement into an
enforced, allowlisted command — not a step toward automatically adequate specifications
or tests.

The `task_status` delivery summary ([delivery-summary.md](delivery-summary.md)) measures
a different thing again: **plan coverage** — whether every planned task's exact accepted
revision is included in the deliverable, and which planned tasks it omits. "All planned
tasks are included" is not "the plan captured what the human wanted" and not "the tests
were adequate"; the summary reports inclusion only and is silent about adequacy. It is
visibility, not certification.

Accordingly, the probe work's own accepted revision means its evidence obligations were
met at that revision (offline tests, its reference document, no allowlist or config
change shipped with it). It does not mean other interface contracts are covered, that
specifications or tests elsewhere are adequate, or that anything built on top of it is
correct or secure.
