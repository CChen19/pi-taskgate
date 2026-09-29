# Benchmark results, round 3: parallel work on a shared build file (2026-09-29)

This is the round pre-registered in [evaluation.md](evaluation.md#round-3-pre-registration-parallel-work-on-a-shared-build-file-2026-09-29), with amendment R3-1. It tests the first batch of [design-parallel-recovery.md](design-parallel-recovery.md): a union merge for a human-declared append-only file, and a host-side agent cap.

Every number below comes from Pi session files, Pier's delegation ledger, git, and the hidden oracle run on the delivered revision. N = 3 per cell. Counts are reported, not rates, and no significance tests are run.

## Headline

- **Correctness held.** B2 had 0 bad acceptances in 6 trials. A had 1, in M6 (`xm61a`); it is an interface slip, not wrong logic (see below).
- **Parallelism recovered: the pre-registered rule is met.**
  - B2's median M6 wall time was 29.5 min, against 40.0 for A: a ratio of 0.74, well under the 1.2 bar.
  - All 3 B2 M6 trials ran 3 children at once (the bar was ≥ 2 in 2 of 3).
  - For reference only (round 2, a different environment, never pooled): B1 took a median 66.5 min on M6 with at most 1 child at a time.
- **The union merge did the work.** 13 cherry-picks were resolved by the union driver in 5 of 6 B2 trials, and every one passed the line check, verification and a fresh integration review at the first attempt.
- **No integration failure, so integration repair is not built.** By the pre-registered rule, round 4 (I9) does not run.
- **The cap was reached but never refused a call** in a counted trial. Masters stayed at 3 children on their own; the one live refusal was in dry run `xd2c`.

## Setup

As pre-registered. In short:

| Item | Value |
|---|---|
| Arms | **A**: Pier only. **B2**: tag `v0.3.1-bench3` (amendment R3-1), B1's round-2 config plus `sharedPaths: [{ "path": "CMakeLists.txt", "merge": "union" }]` and `maxParallelAgents: 3` |
| Models | Master `openai-codex/gpt-6-sol`, thinking `high`. Children `zai/glm-5.3-flash`. Session files show no other model |
| Environment | `PIER_OBSERVATION_WINDOW_MS=5000` in every arm's master pane |
| Kit | v3.1, `KIT_FREEZE_v3.1.sha256` (prefix `fa345d0e5b771906`), frozen before the first counted trial |
| Oracle | The round-2 oracle: Release build, full ctest, scope, mutation kills (18 mutants in M6) and the hidden calendar test for `expire_at`. Run after the queue, one at a time, on an idle machine |
| Schedule | M6 one trial at a time, alternating which arm goes first. I7 in A/B2 pairs, order rotated |

**Validity.**
- All 12 counted trials are valid: outage 0 s, no foreign message, no wrong model, end reason `final` in each.
- No trial was excluded or rerun, and no person acted during a trial.
- Dry runs `xd1c` and `xd2c` are not counted; they are described in the amendment and under [Dry runs](#dry-runs).

## Outcomes

| Cell | Arm | n | Correct deliveries | Bad acceptances | Wall min, median (range) | Cost $, mean |
|---|---|---|---|---|---|---|
| M6 | A | 3 | 2 | 1 | 40.0 (37.4–43.0) | 1.06 |
| M6 | B2 | 3 | 3 | 0 | 29.5 (23.6–30.1) | 0.95 |
| I7 | A | 3 | 3 | 0 | 32.6 (18.0–35.8) | 0.47 |
| I7 | B2 | 3 | 3 | 0 | 24.2 (24.1–26.0) | 0.36 |

**The bad acceptance.**
- `xm61a` (A, M6): the hidden calendar oracle did not compile. The delivered `handler/expire_at.h` declares `valid_expire_at` inside `namespace handler`. The task text gives the function as `inline bool valid_expire_at(const std::string&)` in that header, and the oracle calls it unqualified.
- The logic is correct. As a diagnostic only, with `using namespace handler;` added to the oracle, all 24 cases pass. The score is not changed: the frozen rule counts any oracle failure, and round 2 counted the same slip the same way.
- The other 5 modules, the build, the full suite, scope and all mutants passed.

**Correction to round 2.** The same diagnostic on `wm21a` and `wm21b` (round-2 weak-master M2) also gives 0 failures. Both were this namespace slip, not a wrong calendar check as the round-2 report said. Their counts do not change. The wording in [benchmark-2026-09-29.md](benchmark-2026-09-29.md) now carries a note.

## Decision rules

- **Correctness: met.** B2 had no more bad acceptances than A in either cell (M6: 0 vs 1; I7: 0 vs 0). There is no B2 bug to report.
- **Parallelism recovered: met.**
  - B2 median M6 wall / A median M6 wall = 29.5 / 40.0 = **0.74** (bar: ≤ 1.2).
  - Maximum concurrent children in B2 M6: 3, 3, 3 (bar: ≥ 2 in at least 2 of 3).
- **Integration repair: not triggered.** B2 had 0 integration failures in 6 integrations: no conflict outside union files, no failed integration check, no rejected integration review. Every integration passed at attempt 1. Repair (design change 2) is not built, and round 4 (I9) is not run.

## Where the time went

From `critical_path.py`, frozen with the kit. Medians per cell, in minutes unless noted.

| Cell | Arm | Wall | Children only | Both | Master only | Verify blocking | Worker union | Reviewer union | Mean / max children | Master LLM | Notice latency (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| M6 | A | 40.1 | 28.5 | 6.7 | 5.6 | 2.5 | 26.9 | 22.3 | 2.1 / 3 | 7.2 | 5.5 |
| M6 | B2 | 29.5 | 16.6 | 7.7 | 2.9 | 0.6 | 15.9 | 15.8 | 2.0 / 3 | 6.1 | 5.4 |
| I7 | A | 32.6 | 25.5 | 2.1 | 4.5 | 1.6 | 13.6 | 14.3 | 1.5 / 2 | 4.1 | 5.5 |
| I7 | B2 | 24.2 | 19.4 | 2.1 | 2.4 | 0.6 | 10.1 | 12.9 | 1.5 / 2 | 2.5 | 5.4 |

- **B2 now runs as wide as A.** Mean concurrency while children ran was about 2 in M6 for both arms, against B1's 1.0 in round 2. B2 masters planned all six M6 tasks with `planned_overlap: ["CMakeLists.txt"]` in every trial.
- **B2 was faster than A, which the rule did not require.** With N = 3 this is not a claim, but the buckets show where it came from:
  - Less child time: B2's worker union was 15.9 min against A's 26.9. A's masters started 7 workers for 6 tasks in every M6 trial, B2's 6.
  - Less master time: A's masters build and run ctest themselves (2.5 min of verification with no child running); B2's host verification ran mostly while children worked.
- **The shorter observation window worked as set.** The median time from a child's end to the master's next message was 5.4–5.5 s in every cell, against about 30.5 s in round 2. It applied to both arms. For B1's 12-step chain it would be worth about 5 min, a small part of the 66.5 → 29.5 min change.
- **No rate limiting, no load flake.** 0 `429` responses and 0 `local_cache` failures during trials.

## Process events (B2)

| Trial | Union-merged picks / picks | Integration | `CAPACITY` refusals | Other refusals |
|---|---|---|---|---|
| `xm61c` | 0 / 7 | PASSED, attempt 1 | 0 | 1 `REVIEW_UNPARSEABLE` |
| `xm62c` | 5 / 6 | PASSED, attempt 1 | 0 | — |
| `xm63c` | 5 / 6 | PASSED, attempt 1 | 0 | 1 `REVIEW_UNPARSEABLE` |
| `xi71c` | 1 / 2 | PASSED, attempt 1 | 0 | — |
| `xi72c` | 1 / 2 | PASSED, attempt 1 | 0 | — |
| `xi73c` | 1 / 2 | PASSED, attempt 1 | 0 | — |

- **Counting.** A pick is union-merged when its patch-id differs from its source's; each such pick is also marked `(union-merged)` in its integration brief. The first pick of a series always applies cleanly, so 5 of 6 (M6) and 1 of 2 (I7) is every pick that could conflict.
- **`xm61c` needed no union merge.** Its master told each worker to append after a different existing `add_test` line, so the six hunks did not touch and every pick was patch-identical. It had 7 picks because one task had two commits.
- **Delivery.** Every B2 delivery was the board's `DELIVERABLE` and matched the master's `FINAL_REVISION`. There was no bypass.
- **Two unparseable reviews** were refused, as designed; each cost one extra reviewer.
- **The cap.** B2 masters kept to 3 children, which is also what the prompt asks of both arms. The only live `CAPACITY` refusal so far was in dry run `xd2c`, where it refused one start while 3 children were running.

## Dry runs

- **`xd1c`** found the defect fixed in amendment R3-1: a blank line that both sides add is kept once by Git's union merge, and the first line check refused that correct result. It delivered nothing.
- **`xd2c`** ran on `v0.3.1-bench3`: 36.6 min, parallel plan, union integration PASSED, 1 `CAPACITY` refusal, oracle passed. No defect, so counting started.

## Limits

- N = 3 per cell, one repository, one master model. The wall-time ratio has a wide spread in I7 for A (18.0–35.8 min).
- The workload's conflicts are all appends to one registry file. The union merge is not meant for anything else, and the rule that tasks may only add lines to a union file was never tested live, because no worker tried to edit an existing line.
- The union driver resolves text, not meaning. Whether a merged `CMakeLists.txt` is correct as a whole is left to verification and the integration review. Both passed here, but a semantic conflict (round 4's I9) was not tested, because the pre-registered trigger did not fire.
- The cap was never tested in a counted trial against a master that tried to exceed it.

## Data

- Kit and raw results: `~/.ao-bench/r3/` (outside the repository, because B-arm masters load code from it). Per trial: `results/<id>.metrics.json`, `.oracle.json`, `.timeline.txt`, `.audit.json`; `results/RUNLOG.txt`.
- Analysis: `analysis/critical_path.py` → `analysis/critical_path.json` (counted trials `xm*`, `xi*` only).
