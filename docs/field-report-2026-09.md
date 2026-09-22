# Field report: real runs on TinyWebServer (2026-09-18 → 2026-09-22)

This report reconstructs what happened in the first real runs of the main-session task tools, from the Pi session files, Pier's delegation ledger and the TinyWebServer git history. Nothing here was rerun. All times are UTC as recorded in the session files (git commit times in TinyWebServer are local, UTC−7).

Every number below was extracted from a file listed in [Evidence sources](#evidence-sources). Costs are Pi's own `usage.cost.total` per assistant message, which prices tokens from Pi's model catalog. They are useful for relative comparison, not as billing records.

## Runs covered

| Round | Master session (`~/.pi/agent/sessions/<encoded master cwd>/…`) | Models | What was asked | Outcome |
|---|---|---|---|---|
| R0 | `2026-09-22T07-39-16-734Z_01a0c80e…` | deepseek-flash | Two new ctest unit tests (T1 lst_timer, T2 locker) | Both workers failed to spawn: Pier pipe socket path too long. No candidate |
| R1 | `2026-09-22T07-45-57-200Z_01a0c814…` | deepseek-flash (master, workers, reviewers) | Same two tasks, compact worktree paths | T1, T2 PASSED on attempt 1. Verification ran in the worker worktree (see F1) |
| R2 | `2026-09-22T08-00-24-822Z_01a0c821…` | kimi-for-coding | Trouter-test (tests only) ∥ Texpire-fix (validator fix + test) | Trouter-test PASSED. Texpire-fix rejected by review, retried, PASSED on attempt 2 |
| R3 | `2026-09-22T08-34-37-802Z_01a0c840…` | kimi-for-coding | P1 integration of the four accepted candidates | FAILED closed: conflict in `CMakeLists.txt` |
| R4 | `2026-09-22T08-47-42-374Z_01a0c84c…` | kimi-for-coding | Twire (CMake fragment wiring), then 4 stacked replacements, then integration | All 5 PASSED on attempt 1. Integration `2bf9e47` PASSED after a tool fix and session resume |

The integrated revision `2bf9e47` was accepted by a human and fast-forwarded into TinyWebServer `master` (not pushed). Superseded and accepted candidates are kept as `ao-archive/*` tags in TinyWebServer.

For comparison, one earlier run used **Pier alone** (no task tools): `~/.pi/agent/sessions/<encoded TinyWebServer cwd>/2026-09-18T21-59-38-296Z_01a0b688…` plus 7 worker sessions in the same directory. It is described in [Pier-only reference run](#pier-only-reference-run-2026-09-18).

## Failures the system caught (or exposed)

### F1. Stale `build/` reused by verification (R1)

- **What happened.** In R1, `task_verify` ran the allowlisted `cmake … && ctest` in the worker's own worktree. The recorded check durations were 3.2 s (T2) and 4.3 s (T1), because the worker had already built in a gitignored `build/` directory. The clean-tree check cannot see ignored files, so a stale or forged build could have satisfied verification.
- **How it was caught.** Noticed by the human operator from the implausibly short duration, not by a guard. This was a gap in the tool.
- **Fix.** `40f5518`: verification runs in a fresh detached checkout of exactly the candidate revision under `<workspaceRoot>/.verify/`, confirmed pristine (no untracked or ignored files) before any command runs, and removed afterwards. Regression tests plant an ignored artifact in the worker worktree and prove it cannot satisfy verification.
- **After the fix.** Every later verification ran in `.verify/v-*`, taking 27.9–56.5 s (median 33.9 s) instead of 3–4 s. The nine clean-room durations recorded in settle evidence are 36.8, 29.3, 28.4, 27.9, 30.0, 51.8, 53.1, 56.5 and 33.9 s. The last is the integration.

### F2. Release-mode `assert()` made a test vacuous (R2, Texpire-fix attempt 1)

- **What happened.** Candidate `0d6c428` added `tests/test_expire_at.cpp` whose checks were all `assert(...)`. The mandated verification builds with `-DCMAKE_BUILD_TYPE=Release`, which defines `NDEBUG`, so every check compiled out. Clean-room verification **passed** (exit 0, 36.8 s).
- **How it was caught.** The fresh reviewer rejected it: "compiles out under -DNDEBUG in the mandated Release verification build … a revert of the fix would still pass ctest". It also pointed at the repository's `expect_true`/`g_failures` convention.
- **Retry.** The main agent called `task_abandon` with that reason and started attempt 2 on the same worktree (`reuse_worktree`). Attempt 2 (`7b1cdc2`) replaced the asserts with an active failure counter. It passed clean-room verification and a new fresh review.
- **Hardening.** `aa14846` added a mechanical guard that rejects newly added `assert(` in test sources (added lines only; comments, strings and `static_assert` ignored). Workers are told about it in their brief.
- **Replay against history.** Running the current `findAddedAsserts` over every historical candidate diff:

  | Candidate | Assert hits |
  |---|---|
  | `0d6c428` | 23 (e.g. `assert(valid_expire_at("2026-12-31 23:59:59"));`) |
  | Other 9 candidates | 0 |

  The guard would now reject F2 before any reviewer is spent, and has no false positives on this history.
- **Note.** `0d6c428` is not tagged and survives only as an unreferenced object. It will disappear on the next `git gc` unless it is archived.

### F3. Malformed reviewer verdict, then a revived reviewer (R2)

- **What happened.** The first Texpire-fix reviewer (`w1V:pG`) wrote a prose review ending without the required `REVIEW_VERDICT <id> {…}` line (Pier ledger `outcome` begins `## Review …`). `task_review_record` refused with `REVIEW_UNPARSEABLE`. The error message at the time advised `subagent send` to the reviewer.
- **The trap.** Pier revives a settled pane as a *new* session. The ledger shows `w1V:pJ` with `revivedFrom: "w1V:pG"`, `via: "revive"`. `w1V:pJ` produced a well-formed verdict line, but `task_review_record` refused it with `REVIEWER_INVALID: w1V:pJ is a revived session, not a fresh reviewer`. That refusal is correct: a revived reviewer has seen the follow-up prompt and is no longer independent. The advice, however, led to a dead end.
- **Outcome.** The main agent abandoned the attempt, citing the substantive rejection. That direction is safe, because a rejection never accepts anything. It then retried.
- **Fix.** `af5e135`: the unparseable-review error now points to a new `task_review_brief` + fresh reviewer, or `task_abandon`, instead of a revive.

### F4. Parallel candidates conflicted at integration (R3)

- **What happened.** All four accepted candidates (T1, T2, Trouter-test, Texpire-fix) appended their `add_executable`/`add_test` block at the same place in `CMakeLists.txt`. Every plan had put `CMakeLists.txt` in several parallel tasks' `files_in_scope`. `task_integrate` applied T1, then hit a conflict cherry-picking T2 (`75dd43d`).
- **Guard.** The integration aborted the pick, recorded `integration_conflict` (input, commit, conflicted paths) and `attempt_failed` with `terminal: true`, and left a clean worktree. Nothing was resolved automatically and nothing merged. Elapsed time from `task_integrate` to FAILED was about 0.2 s.
- **Fix, on two sides.**
  - `2fb192d` added the planning rule: tasks that can run in parallel may not share `files_in_scope` unless both list the path in `planned_overlap`. The R1 plan (T1 ∥ T2, both `CMakeLists.txt`) is exactly the shape the rule rejects (test *rejects exact and directory overlaps between tasks that can run in parallel*).
  - R4 re-planned the work as a prerequisite `Twire` (CMake includes sorted `tests/cmake/*.cmake`) plus four tasks stacked on it, each owning its own fragment. `task_integrate` learned to accept candidates stacked on an earlier input and to pick only each candidate's own commits.
- **Outcome.** R4 integrated all five inputs with no conflicts.

### F5. Oversized integration diff broke the review brief (R4)

- **What happened.** The integration `Tint-1` passed clean-room verification (33.9 s). `task_review_brief` then failed twice with `INSPECTION_FAILED: could not read the artifact diff: git diff failed` (09:06:39, 09:06:46). The combined diff (1025 lines) exceeded the 33 KiB reviewer patch cap. The command runner stopped `git` at the cap and `readDiff` treated that as an error.
- **Guard.** Fail-closed. No brief was issued and the task stayed VERIFYING. No reviewer was spawned on a partial or empty patch.
- **Fix.** `559491b`: output-limit truncation now yields a bounded patch explicitly marked as truncated. The reviewer may read the files in the worktree. Timeouts and real git errors still fail.

### F6. Session resume after a tool fix (R4)

- **What happened.** Between 09:06:46 and 09:08:20 the extension code was fixed (F5) and the *same* Pi session file was resumed with `--session`. Nothing was reconstructed by hand.
- **Evidence.** The first call after resume, `task_status Tint-1` at 09:08:29, returned `Tint-1 VERIFYING · attempts 1/1` at revision `2bf9e475…`. That state was rebuilt purely by replaying the session's `agent-orchestrator.task-event` entries. The next `task_review_brief` succeeded (review id `4a1ac8c69dc67237`). The fresh integration reviewer `w1V:p12` made 18 `read` calls, asked no questions and passed the integration at 09:13:03.
- **Significance.** This was the first real use of the replay path. No task state lost, no duplicated worktree, no re-verification needed.

### Other refusals observed (no state change)

| Time | Tool | Refusal | Cause |
|---|---|---|---|
| R1 07:48:46 | `task_verify T2` | `WORKER_RUNNING` | Main agent verified before the worker settled |
| R4 08:51:23 | `task_review_record Twire` | `WORKER_RUNNING` | Recorded before the reviewer settled |
| R4 08:59:54 | `task_review_record Tlocker` | `WORKER_RUNNING` | Same |
| R2 08:11:06, 08:12:12 | `task_review_record` | `REVIEW_UNPARSEABLE` | F3 |
| R2 08:12:16 | `task_review_record` | `REVIEWER_INVALID` (revived) | F3 |
| R4 09:06:39, 09:06:46 | `task_review_brief Tint-1` | `INSPECTION_FAILED` | F5 |

Eight refused calls in total. No task event was written at any of those timestamps, so each refusal left the board unchanged.

### Failures the tool itself introduced

- **R0: pipe path overflow.** `task_start` created worktrees under a long `.agent-orchestrator-workspaces/tinywebserver-main/<long-name>` path. Pier names each child's pipe `/tmp/pi-herdr-<encoded cwd>-<pane>.sock`, which exceeded the Unix socket path limit, so both spawns timed out ("pipe not ready within 94s"). Fixed in `5df9c09`: compact worktree naming under a short root, plus a path-length check at config load and on every `task_start`.
- **R4: reviewer grounded on a human answer.** The `reviewer-readonly-kimi` role correctly has no shell. The Tlocker reviewer asked the human through `ask_user_question` (09:04:05) to run `cmp`/`git diff`, and the answer "Both checks pass" came from the pane at 09:04:40. The verdict therefore partly rested on a human statement. It was later confirmed independently, but it is not host evidence.
- **Overstated reviewer reason.** The Tlst reviewer credited byte-identity to "host-run cmp verification", but the host only ran cmake/ctest. The verdict was correct; the stated reason was not.

## Reviewer behaviour

| Reviewer | Task | Role | Tool calls | Duration | Verdict |
|---|---|---|---|---|---|
| `w1V:pB` | T1 | reviewer-readonly | read×5 | 25 s | passed |
| `w1V:pC` | T2 | reviewer-readonly | read×6 | 29 s | passed (non-blocking nit) |
| `w1V:pH` | Trouter-test | reviewer-readonly-kimi | read×5 | 71 s | passed |
| `w1V:pG` → `w1V:pJ` | Texpire-fix a1 | reviewer-readonly-kimi | read×12 | 309 s total, including the revive | rejected (F2); malformed first, then revived (F3) |
| `w1V:pM` | Texpire-fix a2 | reviewer-readonly-kimi | read×7 | 74 s | passed |
| `w1V:pR` | Twire | reviewer-readonly-kimi | read×3 | 27 s | passed |
| `w1V:pX` | Tlocker | reviewer-readonly-kimi | read×13, todo×2, ask×1 | 402 s | passed (asked human, see above) |
| `w1V:pY` | Tlst | reviewer-readonly-kimi | read×4 | 74 s | passed (overstated reason) |
| `w1V:pZ` | Trouter | reviewer-readonly-kimi | read×3 | 35 s | passed |
| `w1V:p0` | Texpire | reviewer-readonly-kimi | read×5 | 50 s | passed |
| `w1V:p12` | Tint-1 (integration) | reviewer-readonly-kimi | read×18 | 109 s | passed |

Role enforcement held: no reviewer session contains a mutating or shell tool call. The Pier role manifest recorded in each reviewer session lists only `ask_user_question, glob, grep, read, todo_write`. One out of eleven fresh reviews found a real defect that mechanical verification missed (F2). One produced an unparseable verdict (F3).

## Cost and time

Per-round totals are summed over the master session and every worker and reviewer session of that round.

| Round | Wall time (first prompt → final status) | Worker attempts | Fresh reviews | Model cost (Pi-reported) |
|---|---|---|---|---|
| R1 | 7.9 min | 2 | 2 | $0.088 |
| R2 | 19.0 min | 3 (1 retry) | 3 (+1 revived, refused) | $0.732 |
| R3 | 0.3 min | 0 (host-only) | 0 | $0.020 |
| R4 | 25.4 min, including ≈1.5 min tool fix | 5 + integration | 6 | $0.963 |

- **The main agent dominates cost.** Master sessions account for $0.03–0.65 per round, workers for $0.015–0.09 each, and reviewers for $0.009–0.09 each.
- **Master cost grows with polling.** Most of it is re-reading tool output and subagent status while waiting for settlement notices.

## Pier-only reference run (2026-09-18)

The same repository was worked on by Pier alone, with a glm-5.3-flash master and seven workers.

- **Request.** Review code quality, test the bug-prone core logic, clean up docs and leftovers, and push to GitHub, using a plan → dispatch → subagent workflow.
- **Result.** Seven commits `0c5fbd3..67e64e4` were pushed to `origin/master` at 23:16.
- **Size.** 75 minutes from request to push. Total cost $0.44: master $0.18, workers $0.26.

This is a different and larger task than R1–R4, so it is a qualitative reference, not a controlled baseline. Observations relevant to what the task tools enforce:

- **No isolation.** All workers ran in the single shared checkout. The master ran `rm -rf build/ …` in that checkout at 22:08:25 while three review workers were running. It was safe only because their prompts told them to build under `/tmp`.
- **Work drifted into the master session.** The master began implementing fixes itself. It hit an overlapping-edit error, and the human intervened at 22:40:20: "these fixes should be dispatched, not kept in your session".
- **A fix of the fix.** The master's own `retain_pipelined_bytes` fix called `init()` after `memmove`, and `init()`'s `memset` zeroed the retained bytes. The master found this by ad-hoc debugging (22:50–22:56). It then edited `http/http_conn.cpp` in the shared tree while test worker E was running and told E by `subagent send`.
- **Human decisions mid-run.** Two were needed: a scoping decision (22:08) and a blocked worker question about a remaining NUL-overwrite bug (23:09 → 23:11, "send a new agent to fix it").
- **Acceptance was the master's own check.** One clean build + ctest in `/tmp/tws-final` (23:13:58), then commit and **push**. No review was bound to the fix revisions. Workers' reported test results were accepted as reported.

None of this was wrong in outcome as far as we know. The point is that every safeguard in that run was prompt discipline and the master's diligence. The task tools turn the equivalent safeguards (isolated worktrees, host-observed revisions, clean-room checks, independent revision-bound review, no push) into refusals.

## Evidence sources

- **Master sessions.** `~/.pi/agent/sessions/<encoded master cwd>/2026-09-22T0{7,8,9}*.jsonl`
  - Task events are `custom` entries with `customType: "agent-orchestrator.task-event"`.
  - Tool calls and results are `message` entries.
  - Usage and cost are on assistant messages.
- **Worker and reviewer sessions.** `~/.pi/agent/sessions/<encoded worktree cwd>/`. Each carries a `pi-herdr.role-manifest` entry.
- **Pier delegation ledger.** `~/.local/share/agent/herdr-pi/history/<encoded worktree cwd>/history.jsonl`. It holds status, outcome, `revivedFrom` and `via`.
- **Pier-only run.** `~/.pi/agent/sessions/<encoded TinyWebServer cwd>/2026-09-18T2*.jsonl`
- **TinyWebServer.** Tags `ao-archive/{accepted,superseded,integration,legacy}/*`. Integrated revision `2bf9e47`; Pier-only commits `0c5fbd3..67e64e4`.
- **Worktree ownership ledger.** `<workspaceRoot>/.agent-orchestrator/ledger/`
- **This repository's fix commits.** `5df9c09`, `40f5518`, `af5e135`, `aa14846`, `2fb192d`, `559491b`.
