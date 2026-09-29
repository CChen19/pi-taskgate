# Design: parallel tasks on shared files, integration repair, and a concurrency cap

**Status:**
- **Changes 1 and 3 are implemented** (tag `v0.3.1-bench3`) and were run live in round 3 ([results](benchmark-round3-2026-09-29.md)). B2's median M6 wall time was 0.74× Pier-alone's, with 3 children at once and 0 bad acceptances.
- **Change 2 is not built.** Round 3 had no integration failure, so by its pre-registered rule there is no evidence for it yet.

**Background.** This design follows from [critical-path-2026-09-29.md](critical-path-2026-09-29.md). Code changes need approval. Once approved, they get a new tag and a new pre-registered round, and results are never pooled with round 2.

**Approved order (2026-09-29).**
- **First batch:** changes 1 (union merge) and 3 (concurrency cap).
- **Deferred:** change 2 (integration repair). Round 2 had no integration failure, so it waits for evidence from the first batch's round.
- **Round 3 environment:** Pier's observation window is set to 5 s for every arm, as an experiment condition.

## Problem

In round 2, B1 was slow on multi-task work because every task that touched `CMakeLists.txt` had to be ordered: `sharedPaths: []` and G3 required it.

- In M6, B1 ran six tasks as one chain with at most one child at a time: 66.5 min, against 40.4 for Pier alone.
- B1 needed the chain because it has no recovery. An integration conflict, a failing integration check or a rejected integration review ends the integration terminally, and the master must re-plan.

## Principles (unchanged)

- Every line that reaches the deliverable is verified at the exact revision and covered by a fresh, independent review.
- Limits come from the human-written config.
- Refusals are made by deterministic host code, never by prompt discipline.
- A repair is new work. It is verified and reviewed like any other.

## Change 1: host union merge for declared append-only shared files

**Config.** A `sharedPaths` entry may be an object:

```json
"sharedPaths": [{ "path": "CMakeLists.txt", "merge": "union" }]
```

A plain string keeps today's meaning. Planned overlap is allowed on it, and a conflict fails the integration, which change 2 then handles.

**Tasks.** A task may only add lines to a union file. `task_verify` refuses a candidate that removes or edits a line there, and the worker brief says so.

**Planning.** Tasks may declare `planned_overlap` on a union path and run in parallel. Nothing else changes. Overlap on any other file still needs `depends_on`, or a plain `sharedPaths` entry.

**Integration.**
- `task_integrate` cherry-picks with `git -c core.attributesFile=<host temp file> cherry-pick -x`. The temp file maps only the union paths to Git's built-in `union` merge driver. It is scoped to this one command, so the repository and the user's Git config are not touched.
- A conflict in a union path therefore resolves by keeping both sides' lines. A conflict in any other path fails as today.

**History check (replaces "patch-identical" for these commits only).** A cherry-picked commit that the union driver resolved is accepted when both of these hold:
- its diff outside the union paths is patch-identical to its source;
- inside the union paths, it adds exactly the source's added lines (the same multiset of lines) and removes exactly the source's removed lines.

The event records `resolved: "union"` for each such commit.

**Review.**
- The integration brief marks each union-resolved commit and shows the resulting hunk.
- The integration reviewer already checks CMake wiring: every test built and registered once, and no duplicate targets.
- Verification runs as usual on the integrated revision.

**Why deterministic first.** The observed conflicts are two tasks appending blocks after the same line (round-1 I7, the round-2 `d2b` dry run). A union merge resolves that with no agent time, and the line-multiset check makes it safe to accept mechanically. Whether the result is correct as a whole is left to verification and the integration review, as for any integration.

## Change 2: integration repair as a verified and reviewed attempt

**When.** After an integration's cherry-pick stops on an unresolved conflict, fails verification, or gets a rejected review. Today all three are terminal.

**Tool.** `task_repair` takes `task_id` (the integration) and a reason. It starts attempt *n*+1 of the same integration task:
- **Worktree:**
  - after a conflict, the host aborts the failed cherry-pick and keeps the applied prefix;
  - after a failed check or a rejected review, the full integrated revision.
- **Brief.** The repair worker receives:
  - the declared inputs;
  - the conflict (paths, commit, detail), or the failing command output, or the review reasons;
  - the rule that only the repair commits are new work.

**History check for a repair attempt.**
- The history is: the prefix of declared cherry-picks, checked as today (with change 1's union rule), followed by at least one repair commit.
- The repair commits change only the integration's `files_in_scope` (the union of the inputs' paths). Changes outside it need a new task.
- After a conflict, the declared inputs that were not applied must be fully present afterwards. The host checks this per input: every added line of the input appears in the repair diff, or it names the lines that are missing, and the reviewer judges them.

**Review.** The reviewer is fresh, and the repair gets its own review id. The brief contains two parts:
- the repair commits as a separate diff, to review as new code;
- the combined integration, as today.

**Budget.**
- An integration keeps `max_attempts` from a new config field `integrationRepairAttempts` (default 1). An integration therefore has 1 + that many attempts. After that, it fails terminally as today.
- The deliverable rule is unchanged: the latest PASSED integration. A repaired integration is PASSED only through verification and a passing fresh review.

**Implementer independence.**
- The repair worker must not be any input's reviewer, and the repair reviewer must not be the repair worker. These are checked through the ledger rows, like today's checks.
- Input implementers may do the repair.

## Change 3: host-side concurrency cap

**Config.** `maxParallelAgents` (an integer; optional; unset means no cap, as today).

**Check.**
- The count uses the latest Pier ledger row of every subagent under the roots. A start or review counts as a reservation only until Pier has any row for that directory.
- `task_start` and `task_review_brief` count the live agents, and refuse with `CAPACITY` when the count has reached the cap. The count is:
  - Pier ledger rows with status `running` whose working directory is inside `repoRoot` or `workspaceRoot`;
  - plus attempts started or reviews requested in the last 120 s that have no ledger row yet, so that a start just granted cannot be double-counted as free.
- The refusal lists what is running, and says to wait for Pier's notice or to abandon a dead attempt.
- Agents the master spawns outside these directories are not counted. This is documented as a limit, like the git write guard.

## Not in this change

- **Pier's 30 s observation window** (`PIER_OBSERVATION_WINDOW_MS`). This is a Pier setting. Lowering it is an experiment condition applied to every arm, decided by the experimenter, not code in this project.
- **Pipelining review with the next implementation, automatic `task_bind`, and integration-only verification sets.** They are candidates for later. Measured gain: overlapping with this change, seconds per task, and unknown, respectively.

## Tests (offline, no real agents)

- **Union merge:**
  - two candidates appending after the same line apply cleanly;
  - a hand-edited union resolution (extra or missing line) is refused;
  - a non-union conflict still fails.
- **Repair:**
  - after a conflict, after a failed check and after a rejected review;
  - repair commits out of scope are refused;
  - a missing input line is named in the brief;
  - the budget is exhausted after N repairs;
  - the deliverable only after a passing repair review;
  - reviewer independence.
- **Cap:**
  - refusals at the limit, from ledger rows and from fresh reservations;
  - no cap when unset;
  - restore from events.

## Evaluation (round 3, to be pre-registered before any trial)

- **Arms:** A (Pier only) and B2 (this change, `sharedPaths` with union `CMakeLists.txt`, `maxParallelAgents: 3`). B1 is optional as a reference.
- **Cells:**
  - M6 and I7 (parallel work on the shared file);
  - a new **I9, semantic conflict**: two tasks that each pass alone but break a test together. This exercises the repair path.
- **Primary metrics:** bad acceptances and correct deliveries, as in round 2.
- **Secondary metrics:** wall time and the critical-path buckets from `critical_path.py`, plus repair count and repair outcome.
- **Decision rule, written before trials:** B2 must have no more bad acceptances than A in any cell. The claim "B2 recovers B1's parallel wall-time loss" needs B2's median M6 wall time within 1.2× of A's.
