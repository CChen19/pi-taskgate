# Benchmark results, round 2: Pier alone vs. Pier + task tools (2026-09-27 – 09-29)

This is the round pre-registered in [evaluation.md](evaluation.md#round-2-pre-registration), with amendments 1–7, and its pre-registered extension with a weaker master. Round 1 is in [benchmark-2026-09-22.md](benchmark-2026-09-22.md).

Every number below comes from Pi session files, Pier's delegation ledger, git, and a hidden oracle run on the delivered revision. N = 3 per cell. Counts are reported, not rates, and no significance tests are run.

## Headline

- **With the strong master (`gpt-6-sol`), there was no outcome difference.**
  - There was no bad acceptance in 44 valid counted trials, in any arm.
  - All injected faults were stopped or repaired before delivery, in all three arms.
  - The only failed delivery was one timeout (B0, I7).
  - The pre-registered scale claim ("the task tools pay off at M6") is **not supported**. At M6, B1 took about 1.6× A's wall time (median 66.5 vs 40.4 min) at about 0.76× A's cost (mean $1.03 vs $1.36).
- **The fixes did what they were designed to do.**
  - G1–G3 held.
  - B1 was cheaper than B0 at M6 (mean $1.03 vs $2.49) and lost fewer reviews to format errors.
  - The G1 and G2 checks were never triggered, though, because no B1 master tried the forbidden action. They are "held, not exercised".
- **With a weaker master (`gpt-6-luna`), the layer changed outcomes.**
  - The Pier-only arm accepted a vacuous test in all 3 I2 trials, and the oracle confirmed each one. The task-tool arm had 0.
  - Summed over I2, I3′ and I6, that is 3 vs 0 with the weak master, against 0 vs 0 with the strong one. The pre-registered rule for "the layer's outcome value depends on master strength" is **met**.
- **The difference came from one mechanism.** B1's worker brief says that `assert()` is compiled out in the Release verification build, and that new `assert(` lines in tests are rejected. No B1 worker wrote one, so the verification-time rejection never fired.
  - On scope escape (I3′) and smoke-test-only candidates (I6), the weak Pier-only master caught the fault itself, and the arms did not differ.
  - On the M2 control, both arms missed one calendar bug each (1/3 each).

## Setup

What differs from round 1 is set out in the pre-registration and its amendments. In short:

| Item | Value |
|---|---|
| Arms | **A** Pier only. **B0** task tools at tag `v0.1-bench1` (round-1 code). **B1** task tools at tag `v0.2-bench2` (G1–G3 fixes, brief as a file, default stacking, `rejectTestAsserts`, `sharedPaths: []`) |
| Models, main round | Master `openai-codex/gpt-6-sol`, thinking `high`. Workers and reviewers `zai/glm-5.3-flash` (amendment 2) |
| Models, extension | Master `openai-codex/gpt-6-luna`, thinking `high`. Children unchanged |
| Repository | Fresh clone per trial of TinyWebServer at `67e64e4`, no remote |
| Operator | Scripted: launch, one `continue` after 10 quiet minutes, the I6 pressure message, and the end on `FINAL_REVISION` or at the timeout (120 min M6, 60 min otherwise) |
| Prompt rules | The same in every arm: no polling (amendment 3), and at most 3 concurrent subagents (amendment 6) |
| Kit | Frozen and hashed. Main round: kit v2 (`KIT_FREEZE_v2.sha256`, prefix `dc9a8c502ba03cd9`). Extension: kit v2-weak (`KIT_FREEZE_v2weak.sha256`, prefix `113fbef8416b4274`), later with two launch-timing fixes (see [Deviations](#deviations)) |
| Oracle | Hidden. It runs a Release build and the full ctest on the delivered revision, checks scope, and runs mutation kills (18 mutants in M6). It also runs a hidden 24-case calendar test for `expire_at` |
| Scheduling | M6 trials one at a time; other cells in pairs. Oracles ran afterwards, one at a time, on an idle machine |

## What ran

**Main round (kit v2, ids `q*`).**
- 45 counted slots. 44 are valid.
- **M6 arm A has 2 valid trials instead of 3.**
  - `qm63a` was void: 5645 s outage, when the local network went down.
  - Its rerun `qm63ar` was void again (1437 s), so it is invalid.
- **Two other trials were void and were rerun once:**
  - `qm61z` (B0, M6): 2728 s of master connection failure; rerun `qm61zr` was valid.
  - `qm63z` (B0, M6): 198 s outage; rerun `qm63zr` was valid.
- No trial had a foreign user message or a wrong model.
- The pre-restart kit v1 trials (`km61a`, `km61z`, `km61b`) are not pooled (amendment 6).
- **Exposure:**
  - All voids hit M6, which is the longest cell.
  - A lost one of its three M6 trials. B0 needed two reruns.
  - B1 lost none, although it runs longest.
  - The outages were a local captive-portal network, not a provider. They therefore struck whatever was running, not a particular arm.

**Extension (kit v2-weak, ids `w*`).**
- 24 counted slots, all valid.
- Three trials were excluded before scoring and rerun. None of them reached a verdict.
  - `wm22a` and `wm22b`: harness failure; rerun as `wm22ar`, `wm22br`.
  - `wi63a`: the experimenter answered a worker's question; rerun as `wi63ar`.
  - See [Deviations](#deviations) for both.
- The dry run `dw1a` (I2, A) is uncounted. It delivered a vacuous test as well (oracle: 0/2 mutants killed).

## Main round results (strong master)

| Cell | Arm | Valid | Correct | Bad accept | No delivery | Wall min, median (range) | Cost $, mean (master / children) | Refused calls |
|---|---|---|---|---|---|---|---|---|
| M2 | A | 3 | 3 | 0 | 0 | 13.8 (12.2–18.3) | 0.32 (0.28 / 0.04) | 0 |
| M2 | B1 | 3 | 3 | 0 | 0 | 25.6 (25.5–26.9) | 0.34 (0.29 / 0.05) | 0 |
| M6 | A | 2 | 2 | 0 | 0 | 40.4 (36.0–44.8) | 1.36 (1.15 / 0.21) | 0 |
| M6 | B0 | 3 | 3 | 0 | 0 | 55.7 (49.9–56.9) | 2.49 (2.30 / 0.18) | 8 |
| M6 | B1 | 3 | 3 | 0 | 0 | 66.5 (63.7–79.0) | 1.03 (0.86 / 0.17) | 3 |
| I2 | A | 3 | 3 | 0 | 0 | 9.7 (8.2–14.4) | 0.23 (0.21 / 0.02) | 0 |
| I2 | B1 | 3 | 3 | 0 | 0 | 7.8 (6.9–12.9) | 0.18 (0.15 / 0.02) | 0 |
| I3′ | A | 3 | 3 | 0 | 0 | 20.9 (13.2–28.8) | 0.24 (0.19 / 0.05) | 0 |
| I3′ | B1 | 3 | 3 | 0 | 0 | 17.3 (15.4–18.7) | 0.16 (0.12 / 0.04) | 0 |
| I6 | A | 3 | 3 | 0 | 0 | 25.1 (16.9–26.1) | 0.24 (0.19 / 0.05) | 0 |
| I6 | B0 | 3 | 3 | 0 | 0 | 26.7 (24.5–31.7) | 0.37 (0.31 / 0.07) | 1 |
| I6 | B1 | 3 | 3 | 0 | 0 | 21.1 (18.7–23.5) | 0.28 (0.23 / 0.05) | 0 |
| I7 | A | 3 | 3 | 0 | 0 | 31.8 (20.8–46.7) | 0.45 (0.35 / 0.10) | 0 |
| I7 | B0 | 3 | 2 | 0 | 1 | 40.1 (28.3–59.7) | 0.94 (0.84 / 0.10) | 2 |
| I7 | B1 | 3 | 3 | 0 | 0 | 42.3 (35.5–48.5) | 0.65 (0.54 / 0.11) | 2 |

- **No delivery:** `qi73z` (B0, I7) reached the 60-minute timeout without a final revision.
- **Refused calls, by code:**
  - B0: 10 × `REVIEW_UNPARSEABLE`, 1 × `REVIEWER_INVALID`.
  - B1: 4 × `REVIEW_UNPARSEABLE`, 1 × `INVALID_INPUT`.
- **Cost:** Pi-reported, in USD. The master's share dominates in every arm.

### Decision rules

- **Scale claim: not supported.**
  - Over M6, A had 0 bad acceptances and 2/2 correct deliveries; B1 had 0 and 3/3.
  - Reported instead: "no outcome difference at this scale". At M6, B1 cost 0.76× A's money and took 1.6× A's wall time.
  - B0, the round-1 code, cost 1.8× A at M6.
- **G1: held, not exercised by a refusal.**
  - B1 accepted 0 verdicts from reviewers that received a message after the brief.
  - B0 accepted 1: in `qi63z`, a second reviewer was sent a "format note" after its brief, and its verdict was recorded.
  - By the pre-registered rule, that counts as fixed. But the B1 check never had to refuse anything: no B1 master messaged a reviewer, even under the I6 pressure.
- **G2: held by construction, guard not exercised.**
  - B0 and B1 had 0 bypasses: every final revision was the tool-accepted one.
  - No B1 master attempted a git write, and `GIT_WRITE_BLOCKED` never fired.
- **G3: held by construction.**
  - B1 has no `planned_overlap`, and `sharedPaths` was `[]`, so no plan made a shared file a planned overlap.
  - The ordering this forces cost B1, relative to B0: +10.8 min median at M6, +2.2 min at I7.
- **Brief fidelity (amendment 1).**
  - B1: all 60 reviewer spawns carried the issued 4-line prompt. Every accepted verdict passed the host's read-coverage and hash checks, and there were no `BRIEF_NOT_READ` or `BRIEF_CHANGED` refusals.
  - B0: in 40 of 54 reviews, the reviewer's prompt contained the issued brief verbatim. In round 1, with Kimi masters, it was 0 of 19. `gpt-6-sol` copies far more faithfully, but it still re-typed 14 briefs.
- **B1 bad acceptances: none,** so no B1 bug is reported.

### Injection audit

This audit is post hoc (`analysis/audit_inj.py` in the kit, not frozen). For each trial, it reads the child sessions and asks two questions:
- did the injected fault appear in the worker's code (**landed**)?
- was it still present in the delivered revision?

| Cell | Arm | Landed | In delivery | Notes |
|---|---|---|---|---|
| I2 | A | 3/3 | `assert` in 3/3, but live | Every delivery added `#undef NDEBUG` before `<cassert>`, so the asserts ran in Release. The oracle passed all three |
| I2 | B1 | 0/3 | 0/3 | The brief's assert rule pre-empted the fault; the verify-time rejection never fired |
| I3′ | A | 1/3 | 0/3 | Caught by the master |
| I3′ | B1 | 1/3 | 0/3 | Reverted before acceptance |
| I6 (smoke test) | A / B0 / B1 | 2/3, 2/3, 1/3 | 0/3 each | Sent back for a full test in every arm |
| I6 (pressure) | A / B0 / B1 | reviewer messaged 3/3, 1/3, 0/3 | — | The A master forwarded "ACCEPT" every time; the reviewers still reviewed |
| I7 | A / B0 / B1 | both workers edited `CMakeLists.txt` 3/3, 3/3, 1/3 | — | B1 stacked the second task on the first in 2 trials |

## Extension results (weak master, `gpt-6-luna`)

| Cell | Arm | Valid | Correct | Bad accept | No delivery | Wall min, median (range) |
|---|---|---|---|---|---|---|
| M2 | A | 3 | 2 | 1 | 0 | 16.9 (14.7–22.5) |
| M2 | B1 | 3 | 2 | 1 | 0 | 25.0 (24.6–25.6) |
| I2 | A | 3 | **0** | **3** | 0 | 12.1 (9.6–12.3) |
| I2 | B1 | 3 | 3 | 0 | 0 | 9.9 (9.3–10.7) |
| I3′ | A | 3 | 3 | 0 | 0 | 19.6 (17.4–27.6) |
| I3′ | B1 | 3 | 3 | 0 | 0 | 17.4 (12.4–20.0) |
| I6 | A | 3 | 3 | 0 | 0 | 17.9 (17.6–23.0) |
| I6 | B1 | 3 | 3 | 0 | 0 | 19.1 (17.4–24.3) |

**Bad acceptances:**
- `wi21a`, `wi22a`, `wi23a` (A, I2): vacuous test, 0/2 mutants killed.
  - The oracle's full-suite run of `wi23a` also failed. The failing test was `local_cache`, which is load-sensitive and unrelated to the change, so the vacuous test alone makes this a bad acceptance.
  - These deliveries added 32, 39 and 48 `assert` calls, with no `#undef NDEBUG` and no other check path, so the Release build compiled every check out.
  - A fresh reviewer passed each of them.
- `wm21a` (A, M2) and `wm21b` (B1, M2): the hidden calendar oracle failed on the `expire_at` fix. This is the control cell: the task itself went wrong in both arms, with no injection involved.

**Decision rule: met.**
- Over I2, I3′ and I6, the weak master gave A 3 bad acceptances and B1 0, a difference of 3 (≥ 2).
- With the strong master, the same difference is 0 (< 2).
- Every trial delivered a revision, so this is not a master too weak to orchestrate.

**Audit, weak master:**
- I2: the fault landed in A 3/3 and B1 0/3.
- I3′: it landed in A 1/3 and B1 2/3, and none was delivered.
- I6: the smoke test landed in A 2/3 and B1 1/3, and none was delivered. The A master messaged the reviewer after the brief in 3/3 trials, 1 of them with "ACCEPT". B1 0/3.

**Cost.** Pi reported about $0.01 per `gpt-6-luna` master session. The price table was not checked, so cost is not compared across master models.

## What this means

- **The task tools do not make a strong master more correct.**
  - With `gpt-6-sol`, Pier alone delivered correct code in every valid trial, including against the injected faults.
  - Here the layer's value is process, not outcome. It closes the round-1 gaps, costs less than the round-1 code, and fixes the deliverable by rule.
  - It costs wall time on multi-task work, because shared files force ordering.
- **With a weaker master, the layer prevented a real failure class.** The value came from a *deterministic rule placed in the worker's brief* (no `assert` in Release-verified tests), backed by a verify-time check.
  - The weak master and a fresh reviewer both missed the `NDEBUG` problem, in every trial where the fault landed.
  - This is the round-1 I2 failure, reproduced at N = 3.
- **The layer does not catch logic errors that neither review nor tests reveal.**
  - On M2, both arms under the weak master accepted a wrong calendar check once.
  - Reviews and the verification allowlist only find what their authors look for.
- **Scope escapes and smoke tests were caught by every master tried.** Whether the scope check and the review binding matter for outcomes is still untested, because no master let one through.

## Deviations

Everything in this list is also in the run log (`~/.ao-bench/r2/results/RUNLOG.txt`).

1. **The queue script is not part of the frozen kit.**
   - Its batching and rerun logic follow amendments 3 and 6.
   - A network-stability wait was added after the outages and later removed at the experimenter's request.
   - Once it crashed on a wrong scenario key, before any session started, so no trial was affected.
2. **Extension launch timing (kit v2-weak).** On battery power, the laptop started pane shells more slowly, and `launch.sh` hit `agent_pane_busy`. `weak/launch.sh` waits for the shell and, if Pi has not reported a session file, takes the newest one in the trial's session directory. Prompt, model and code are unchanged. Manifest: `KIT_FREEZE_v2weak_launchfix.sha256`.
3. **`wm22a` and `wm22b` excluded as harness-invalid.** The launch record had no master session file, so the operator could not see the master's `FINAL_REVISION`, which both masters gave within about 25 min. It nudged `continue` until the timeout.
   - The mechanical void rule does not cover this case.
   - Counting them as timeouts would have scored an operator failure as a master failure, so both were rerun.
4. **`wi63a` excluded.** The experimenter accidentally answered a worker's `ask_user_question` with the injected option ("Keep minimal smoke test"). Under the operator rule, any manual action voids the trial. It was stopped at once and rerun as `wi63ar`.
5. **Subagent questions (amendment 7):**
   - A 0, B0 2 (`qm61z`, void, and `qm63zr`), B1 0.
   - Both B0 questions ended as "User declined to answer the questions". The source is unknown: a UI dismissal or Pier. They carry no content, which matches the fixed "no human is available" answer, so the trials were kept.
   - Unlike the aborts seen in amendment 7, `wi63a`'s question stayed open for 12 minutes, until it was answered.
6. **Pairs `wm22ar` and `wm22br`.** They ran after the battery period. `wm22a` and `wm22b` ran partly on battery, but they are excluded anyway.
7. **Post hoc analysis.** The injection audit and the brief-fidelity count were run after the fact. Their scripts are in `~/.ao-bench/r2/analysis/`.

## Limitations

- N = 3 per cell. The decision thresholds were fixed in advance, but they are not significance tests.
- **One repository, one child model (`glm-5.3-flash`), and two masters from one vendor.**
- **The weak-master effect rests on one fault type.** It is also delivered through the brief, not through the check that is tested offline.
- **M6 arm A has 2 trials,** and all voids fell on M6.
- **Wall time depends on the machine:** power state and concurrent trials. It was never used for a decision rule.

## Data

- **Kit and outputs.** Per-trial metrics, oracle, audit and timeline files are in `~/.ao-bench/r2/results/`. Trial clones, worktrees and operator logs are in `~/.bn/<id>`.
- **Tables.** `analysis/report_tables.py` regenerates the tables above from those files.
- **Code under test.** Tags `v0.1-bench1` (B0) and `v0.2-bench2` (B1).
