# Where round-2 wall time went (2026-09-29)

This is a read-only analysis of the round-2 trials in [benchmark-2026-09-29.md](benchmark-2026-09-29.md). It uses every valid counted trial: 44 main-round trials and 24 extension trials. No new trials were run, and no code changed.

The question: B1 was up to 1.6× slower than Pier alone on multi-task work. Is that time spent in the master, the host checks, the children, or waiting?

The script is `analysis/critical_path.py` in the bench kit (`~/.ao-bench/r2/`). It reads the trial's session files and splits every second of the master's lifetime into four buckets:

- only children are working;
- only the master is working (its own model turns, tool calls and host verification);
- both are working;
- neither is working.

**What counts as working.**
- A child is working from its first message until it ends a turn and waits for input. Long model generations and long tool calls count as working.
- For each child, the script also measures the time from its end to the master's next message (the notice latency).

## Results (medians per cell, minutes)

| Cell | Arm | Wall | Children only | Master only | Neither | Mean / max concurrent children | Master model time |
|---|---|---|---|---|---|---|---|
| M2 | A | 13.8 | 8.3 | 2.7 | 0.6 | 1.5 / 2 | 3.0 |
| M2 | B1 | 25.6 | 18.2 | 4.2 | 2.6 | 1.0 / 1 | 2.7 |
| M6 | A | 40.4 | 25.5 | 2.7 | 2.2 | 1.9 / 3 | 7.6 |
| M6 | B0 | 55.7 | 23.6 | 9.6 | 2.7 | 1.6 / 3 | 18.0 |
| M6 | B1 | 66.5 | 46.9 | 10.2 | 7.8 | 1.0 / 1 | 7.0 |
| I7 | A | 32.0 | 22.9 | 4.0 | 2.1 | 1.4 / 2 | 4.1 |
| I7 | B0 | 40.1 | 23.3 | 10.7 | 2.6 | 1.2 / 2 | 11.8 |
| I7 | B1 | 42.4 | 30.2 | 7.3 | 2.6 | 1.3 / 2 | 6.1 |

**Single-task cells.** I2, I3′ and I6, in every arm and with both masters, ran one child at a time. Their wall times were 8–25 min, with B1 equal to A or faster.

**Buckets.** "Both" is omitted from the table. The four buckets add up to the wall time.

## Findings

1. **B1's extra time on multi-task work is serialization, not orchestration.**
   - With `sharedPaths: []`, every task that registers a test in `CMakeLists.txt` must be ordered. B1 ran M2 and M6 as a single chain: at most one child at a time.
   - In M6, B1's children did about 51 child-minutes of work (workers 29.2, reviewers 21.9). That is similar to A, whose children overlapped at a mean concurrency of 1.9.
   - At A's concurrency, B1's M6 would take roughly 45 min instead of 66.5. This is an estimate, not a measurement.
2. **The master's own model time is small:** 1.5–7.6 min in most cells.
   - The exception is B0 in M6 (18 min). It re-requested reviews after 10 `REVIEW_UNPARSEABLE` refusals.
   - Removing master turns, for example by binding workers automatically, would save seconds per task.
3. **Every handoff costs a fixed 30 s.**
   - From a child's last message to the master's next message, the median is 30.4–31.1 s in every cell.
   - The source is Pier's `PIER_OBSERVATION_WINDOW_MS`, which defaults to 30 000 ms (`pier-ext/src/runtime-policy.ts`). Before settling a subagent that has gone idle, Pier waits that long, to detect a user taking over the pane.
   - B1's M6 has 13–15 handoffs, all on the critical path, which comes to about 7 min, or about 10% of the wall time.
   - The window is a Pier setting, configurable by environment variable. It is not part of this project.
4. **Host verification blocks little.** Verification running while no child works took 0.5–1.8 min per trial, and 3.9 min in B1's M6 (7 verification runs).
5. **Waiting while READY:**
   - B1: under 1 min per trial. A task starts as soon as its dependency passes.
   - B0 in M6: 30–48 min summed over 6 tasks. This is queueing behind the 3-subagent cap, and it is not on a single critical path.
6. **No rate limiting and no load-caused false failures during trials.**
   - There were 0 `429` responses after the 3-subagent cap (amendment 6).
   - No verification run failed on the load-sensitive `local_cache` test. The only such failure was in oracle scoring (`wi23a`).

## What this implies for the next changes

In order of expected wall-time gain:

1. **Allow parallel tasks on a human-declared shared build file, and add recovery.**
   - List append-only registration files, such as `CMakeLists.txt`, in `sharedPaths`.
   - Turn an integration conflict into a resolution task that is verified and reviewed like any other.
   - Enforce a host-side cap on concurrent agents (3 held the rate limit at zero).
   - Expected gain: about 20 min on M6.
2. **Shorten Pier's observation window for delegated tasks.** Expected gain: up to 7 min on M6. The trade-off is Pier's takeover detection, so this is the experimenter's call.
3. **Pipeline review and the next implementation.** The gain overlaps with item 1. It also needs a rollback rule, for when a review rejects a revision that later work was stacked on.
4. **Fewer master turns** (automatic binding). The gain is seconds per task.

## Limits

- **Busy time comes from message timestamps.** A child's final build, between its last tool call and its closing message, counts as busy. Idle time before a revived session's next prompt does not.
- **Nothing here measures outcomes.** Faster configurations must be re-run under the same oracle before any claim.
