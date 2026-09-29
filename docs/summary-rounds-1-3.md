# Summary: what three benchmark rounds show about pi-taskgate (2026-09-22 – 09-29)

This summarizes the three controlled rounds and the field report. It adds no new data: every number is taken from the round reports, which hold the per-trial tables, deviations and raw-data paths.

- [Field report](field-report-2026-09.md): the first real runs, 2026-09-18 → 22.
- [Round 1](benchmark-2026-09-22.md): 14 trials, Kimi masters.
- [Round 2](benchmark-2026-09-29.md): 44 valid trials with a strong master, plus 24 with a weaker one. Pre-registered.
- [Critical-path analysis](critical-path-2026-09-29.md): where round 2's wall time went.
- [Round 3](benchmark-round3-2026-09-29.md): 12 trials, union merge and agent cap. Pre-registered.

## The question

pi-taskgate is a Pi extension that sits next to Pier. The Pier master stays the only orchestrator; the extension gives it deterministic primitives: an event-sourced task board, host-created worktrees, clean-room verification at an exact revision, a review bound to that revision, and a single `DELIVERABLE`.

Two questions ran through all three rounds:

1. Does the layer make delivered code more correct than Pier alone?
2. What does it cost in wall time and money, and can that cost be removed?

## Answer in brief

- **With a strong master, the layer does not change outcomes.** Round 2 found 0 bad acceptances in 44 valid trials, in every arm, including against injected faults.
- **With a weaker master, it does.** Pier alone accepted a vacuous `assert` test in 3 of 3 I2 trials; the tools in 0 of 3. That met the pre-registered rule "the value depends on master strength". The whole effect came from one deterministic rule in the worker's brief.
- **Its time cost is gone for append-only shared files.** In round 2, the tools were 1.6× slower than Pier alone on 6-task work, because tasks on the shared `CMakeLists.txt` had to run one after another. With round 3's union merge, they were 0.74× Pier alone's time, with 0 bad acceptances.
- **Its process guarantees hold, but several were never tested by a live attempt.** No master tried to nudge a reviewer after the brief, write with git, or edit a line in a union file.

## Outcomes across rounds

Bad acceptances are delivered revisions that fail the hidden oracle, change a path out of scope, carry a vacuous test, or were never verified at that revision.

| Round | Master | Arm | Valid trials | Bad acceptances | What they were |
|---|---|---|---|---|---|
| 1 | Kimi (I8: `gpt-5.6-luna`) | A: Pier only | 7 | 1 | `i2a`: vacuous `assert` test |
| 1 | | B: tools, round-1 code | 7 | 0 | |
| 2 | `gpt-6-sol` | A | 17 | 0 | |
| 2 | | B0: round-1 code | 9 | 0 | (one timeout, no delivery) |
| 2 | | B1: G1–G3 fixed | 18 | 0 | |
| 2 | `gpt-6-luna` | A | 12 | 4 | `wi21a`–`wi23a`: vacuous `assert` tests; `wm21a`: interface slip |
| 2 | | B1 | 12 | 1 | `wm21b`: interface slip |
| 3 | `gpt-6-sol` | A | 6 | 1 | `xm61a`: interface slip |
| 3 | | B2: union merge + cap | 6 | 0 | |

- **Two failure classes, nothing else.**
  - *Vacuous `assert` tests* (4, all Pier-only). The tests used `assert()`, which the Release verification build compiles out. A fresh reviewer passed every one. Every tool arm with the assert rule in its brief had 0; its workers never wrote the fault.
  - *Interface slips* (3: two Pier-only, one tools). The `expire_at` header declared `valid_expire_at` inside `namespace handler`, not with the signature the task gave, so the hidden oracle did not compile. The logic was right in all three. Neither the tests the workers wrote nor any reviewer checks the interface, so both arms let it through.
- **Do not add up the rows.** Masters, child models, code versions and environments changed between rounds, and N is 3 per cell. The table shows where failures fell, not a rate.

## Cost: the 6-task workload (M6)

| Round | Arm | Wall min, median | Cost $, mean | Max children at once |
|---|---|---|---|---|
| 2 | A | 40.4 | 1.36 | 3 |
| 2 | B0 (round-1 code) | 55.7 | 2.49 | 3 |
| 2 | B1 (`sharedPaths: []`) | 66.5 | 1.03 | 1 |
| 3 | A | 40.0 | 1.06 | 3 |
| 3 | B2 (union `CMakeLists.txt`, cap 3) | 29.5 | 0.95 | 3 |

Round 3 also shortened Pier's observation window from 30 s to 5 s in every arm, so rounds 2 and 3 are compared within a round, never across.

- **B0 cost more** because its master re-requested reviews after format errors, and copied briefs by hand.
- **B1 was slow for one reason:** every task registering a test in `CMakeLists.txt` had to be ordered, so all six ran as a single chain. The master's own time was small, and host verification blocked little.
- **B2 removed that.** Six tasks were planned in parallel on the shared file, and 13 cherry-picks were resolved by Git's union driver. Every one passed the line check, verification and a fresh integration review at the first attempt.
- On the single-task cells, the tools were as fast as Pier alone or faster in round 2.

## What the layer does that Pier alone does not

These hold by construction in every tool arm, and are what a strong master gets from the layer when outcomes are equal:

- **One deliverable, fixed by rule.** From round 2 on, what counts as delivered in B1 and B2 is the board's `DELIVERABLE`, not the master's claim. The master's `FINAL_REVISION` matched it in every main-round B1 trial and every B2 trial: 0 bypasses. In round 1, before the rule, a master delivered a revision it had cherry-picked and verified by hand after the tools failed the integration (G2).
- **Every delivered line was verified and reviewed at that exact revision.** Pier-only masters in round 1 merged reviewed branches and delivered the merge unreviewed (3 of 3 M trials), and in one trial resolved a conflict themselves.
- **The review is provably fresh.** In round 2's main round, all 60 B1 reviewers got the issued prompt and read the whole brief, and no accepted verdict came from a nudged or revived reviewer. B0, on the round-1 code, accepted one nudged verdict.
- **Recovery is exact.** In round 1's I8, after the master was killed, the board replayed from the session with no lost or duplicated work. The Pier-only master rebuilt its state from git and pane output, and left stale ledger rows.

## What is still untested

- **Guards that never had to refuse live:**
  - the G1 check (a reviewer messaged after its brief);
  - the git write guard;
  - the scope check on a candidate submitted for acceptance: every out-of-scope edit that landed (I3′) was caught or reverted earlier;
  - the add-only rule for union files;
  - the agent cap in a counted trial (it refused once, in a dry run).

  All are covered by offline tests only.
- **Integration repair** (design change 2) was not built. Its pre-registered trigger, an integration failure in round 3, did not fire. Semantic conflicts between parallel tasks (I9) were therefore not tested.
- **Generality.** One repository (TinyWebServer), one child model per round, masters from two vendors. All workload conflicts were appends to one registry file.

## Conclusions

1. **The layer's outcome value comes from deterministic rules that reach the worker, not from the orchestration itself.** The one outcome difference came from a brief line that the verification build makes true (no `assert` in Release-verified tests). A strong master caught everything else on its own, and neither arm caught what nobody checked (the interface slips).
2. **The layer's constant value is provenance.** It delivers a single revision, verified and freshly reviewed exactly as delivered. Pier alone did not guarantee this in round 1.
3. **After round 3, that provenance no longer costs wall time on this workload.** It needed the human to declare which shared file is append-only; the model cannot widen that list.
4. **Interface slips point to the next cheap rule.** A task that names a signature could carry a human-written compile probe in the verification allowlist. The allowlist already supports this; it was not part of any arm, so its effect is not measured.

## Possible next steps (none approved)

- **A human-written interface probe** in the verification allowlist, for tasks that name an API, and a re-run of M2/M6 to see whether it removes the interface slips.
- **Live tests of the untested guards**, with injections that provoke them: a worker that edits an existing line in `CMakeLists.txt`, a master prompt that pushes a fourth concurrent agent, a reviewer nudge that a weak master might send.
- **Integration repair and I9**, only if a later run shows an integration failure.
- **A second repository** before any general claim.
- **Porting pieces into Pier** (the deliverable rule, clean-room verification, the brief rules) is a separate step. It needs explicit approval, as [AGENTS.md](../AGENTS.md) states.
