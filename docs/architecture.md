# Architecture

Status: P0 (task tools) and P1 (integration) are implemented and have run for real on TinyWebServer (2026-09-22). What happened, including every failure the tools caught, is in [field-report-2026-09.md](field-report-2026-09.md). How we plan to measure the benefit against Pier alone is in [evaluation.md](evaluation.md).

## Target: the Pi main session orchestrates; code enforces

```text
Human ⇄ Pi main session (Pier master; the only semantic orchestrator)
          │  semantic: decompose, parallelize, re-plan, ask the human, summarize
          ▼
   Pier `subagent` (real panes, human takeover, resume)   pi-taskgate task tools
          │                                                 (companion Pi extension)
   worker panes in host-owned worktrees ─────────────► host inspection · scope · allowlisted
   reviewer pane (read-only role, fresh)                clean-room verification · revision-bound review
                                                        · exact-revision integration
```

There is exactly one control plane. The main agent decides the next action; the task tools provide ground truth and refuse illegal transitions. Nothing outside the Pi session decides what runs next.

## What Pier provides, and what this project adds

| Concern | Pier (unchanged, used through public surfaces) | This extension adds |
|---|---|---|
| Agents | `subagent` spawns workers and reviewers in real herdr panes; human takeover; revive; background settle notices | Nothing. The extension never spawns an agent; it returns the exact spawn arguments to use |
| Roles | Role files (`tools`, `permissions`) resolved per workspace | Before every review, a check that the reviewer role explicitly denies every mutating or executing tool |
| Who ran what | Delegation ledger: pane, cwd, role, status, closing output, `revivedFrom` | Reads the ledger (read-only) to bind a worker to its worktree, to wait for settlement, and to take the reviewer's verdict from its own output rather than the master's paraphrase |
| Workspaces | cwd per subagent | Host-owned git worktree + branch per task attempt, created from an exact base revision, with an ownership ledger |
| Task state | Todo list (free text, auto-ticked on settle) | Event-sourced task board: contracts, dependencies, attempts, checks, candidate revision, review, verdict |
| "Is it done?" | The child says so | Host inspection of git, scope check, allowlisted commands in a clean-room checkout, fresh review bound to the exact revision |
| Combining work | — | Cherry-pick integration of exact accepted revisions onto an exact base, then the same verify + fresh review |
| Recovery | Session files; `--session` resume | Task board replayed from the session's own event entries on resume and on branch switch |

## Task lifecycle: worker → verify → fresh review → retry / accept

```text
task_plan ──► PENDING/READY ──task_start──► RUNNING ──task_bind──► (worker works, commits)
                                               │
                         Pier settle notice    ▼
                                         task_verify ── fail ──► check recorded, attempt stays RUNNING
                                               │                 (master may `subagent send` a fix;
                                               │                  > maxChecksPerAttempt ⇒ attempt fails)
                                             pass
                                               ▼
                                   VERIFYING (candidate = exact revision)
                                               │
                                     task_review_brief ──► spawn fresh read-only reviewer
                                               │
                                     task_review_record ── rejected ──► RETRYING ──task_start──► RUNNING (attempt n+1)
                                               │                         (or FAILED when the budget is spent)
                                            passed
                                               ▼
                                            PASSED
```

1. **Plan.** `task_plan` adds contracts atomically:
   - unique ids, known dependencies and no cycles;
   - non-empty `files_in_scope`;
   - verification commands that match the human-authored allowlist exactly;
   - review required by default;
   - no path overlap between tasks that can run in parallel, unless both declare it in `planned_overlap`.
2. **Start.** `task_start` needs READY (all dependencies PASSED) or RETRYING. The host creates the worktree from the main checkout's HEAD, from a PASSED dependency's accepted revision (`base_task`), or from the previous attempt's branch (`reuse_worktree`). It returns the worker brief and the `subagent` arguments.
3. **Bind.** `task_bind` accepts only an agent id that Pier's ledger shows was launched in exactly that worktree.
4. **Verify.** `task_verify` refuses while the ledger says the worker is still running. Otherwise it:
   1. inspects HEAD, changed paths, cleanliness and commits ahead;
   2. rejects out-of-scope paths and newly added test `assert(`;
   3. runs the allowlisted commands in a fresh detached checkout of exactly that revision;
   4. confirms the worker's HEAD did not move meanwhile.

   Success records the candidate revision with its evidence.
5. **Review.** `task_review_brief` re-checks the reviewer role and that the candidate is still HEAD and clean, then issues a brief bound to the revision and a one-time review id. `task_review_record` reads the reviewer's closing output from Pier's ledger. The reviewer must:
   - use the reviewer role;
   - be neither revived nor an implementer of the task;
   - have been launched after the brief;
   - name the review id and revision in its verdict line.

   The worktree must also be unchanged.
6. **Retry or accept.** A rejection moves the task to RETRYING (or FAILED when the attempt budget is spent). A pass makes it PASSED. `task_abandon` lets the main agent give up an attempt within the budget, or cancel the task; its dependents become BLOCKED.

## Integration: exact revisions → clean-room verify → fresh integration review

1. **Admission.** `task_integrate` admits only PASSED candidates whose passing fresh review is bound to that exact revision and is re-confirmed in Pier's ledger: settled, not revived, read-only role, and a verdict naming the review id and revision. Candidates from earlier sessions are admitted only by replaying those sessions' task events.
2. **Picking.** The host creates a new integration worktree at an exact base revision. It cherry-picks each candidate's own commits in the declared order, with `-x`. A candidate may be stacked on an earlier input, such as a shared build-wiring task.
3. **Conflicts.** A conflict aborts the pick and records the input, the commit and the conflicted paths. The integration then fails terminally. There is no automatic resolution.
4. **Verify and review.** A clean result becomes an integration task. It goes through the same `task_verify` (clean room; scope = union of input paths) plus a history check: `base..HEAD` must be exactly the recorded commits, each patch-identical to and naming its source. Then comes a fresh review. Implementers of any input cannot review the integration.
5. **Merging stays human.** Nothing merges into the main checkout or pushes.

## Fail-closed guards

Every refusal leaves the board unchanged: a mutation is trial-applied to a replayed copy of the board, persisted, and only then swapped in.

| Guard | Refusal | Real-run example |
|---|---|---|
| Verification command not exactly on the human allowlist | `INVALID_INPUT` at plan time; `NOT_ACCEPTED` at integration | — |
| Parallel tasks with overlapping `files_in_scope` | `INVALID_INPUT` at plan time | Would have prevented F4 |
| Worktree path too long for Pier's pipe socket | `LEASE_UNAVAILABLE`; config load fails | Caused R0 before the fix |
| Worker not launched in that worktree, or unbound | `WORKER_NOT_FOUND` / `WORKER_UNBOUND` | — |
| Worker or reviewer still running | `WORKER_RUNNING` | 3× in R1/R4 |
| Dirty tree, no commits, out-of-scope paths, added test `assert(` | Failed check recorded (no settle) | F2 replay: 23 asserts in `0d6c428` |
| Clean-room checkout cannot be made pristine | `VERIFICATION_ERROR` | — |
| Worker HEAD moved during verification | Failed check recorded | — |
| Candidate no longer HEAD or clean at review brief or record | Attempt rejected | — |
| Reviewer role allows a mutating tool | `ROLE_NOT_READ_ONLY` | — |
| Reviewer is the implementer, revived, launched before the brief, or a stale review | `REVIEWER_INVALID` / `REVISION_MISMATCH` | F3 (revived reviewer) |
| No parseable `REVIEW_VERDICT` line | `REVIEW_UNPARSEABLE` | F3 |
| Artifact diff unreadable | `INSPECTION_FAILED` (an oversized diff is now a marked, bounded patch) | F5 |
| Integration input not a fresh-reviewed PASSED revision on an allowed base | `NOT_ACCEPTED` | — |
| Cherry-pick conflict | Integration FAILED (terminal), conflict recorded | F4 |
| Attempt budget spent | `BUDGET_EXHAUSTED` | — |
| Config missing, or state cannot be replayed | Every tool fails | — |

## Session recovery

- **Storage.** Every task event is appended to the Pi session as a custom entry (`agent-orchestrator.task-event`). The ownership ledger in `<workspaceRoot>/.agent-orchestrator/ledger` records which session owns which worktree.
- **Replay.** On `session_start` (including `--session` resume) and on `session_tree` (branch switch), the extension replays the events on the current branch with the same pure reducer and re-adopts the worktree leases.
- **Branch switches.** Switching to an earlier branch point shows the board as it was there.
- **Evidence.** F6 is the real case: the extension was fixed mid-run, the session was resumed, and `Tint-1` came back VERIFYING at the same revision.
- **Cross-session integration.** Candidates from another session enter only when that session's file is supplied and replayed as evidence.

## Components

- **`src/orchestration/task-board.ts`** — pure reducer. It combines `TaskGraph` (dependencies, `task-state` lifecycle with settled ≠ accepted) with per-attempt evidence: worktree lease, bound Pier agent, failed checks, candidate revision with its `EvidenceBundle`, and review request/verdict. Every mutation is a versioned `TaskEvent`; `replayTaskBoard` rebuilds identical state.
- **`src/orchestration/task-service.ts`** — the deterministic operations behind the tools, with the checks listed above.
- **`src/pi-extension/index.ts`** — registers the nine tools: `task_status`, `task_plan`, `task_start`, `task_bind`, `task_verify`, `task_review_brief`, `task_review_record`, `task_integrate`, `task_abandon`. It also persists and replays events.
- **`src/orchestration/config.ts`** — human-authored config: repo root, short workspace root outside the repo, verification allowlist, reviewer role, budgets. The model never supplies allowlist entries.
- **`src/orchestration/host-wiring.ts`** — real git, verification processes and Pier adapters.
- **`src/host/pier-ledger.ts`, `src/host/pier-roles.ts`** — read-only views of Pier's delegation ledger and role files, matching Pier's storage encodings and lookup order.
- **`src/host/clean-room.ts`** — detached, pristine verification checkouts.
- **`src/host/git-history.ts`** — commit ranges and patch ids for integration.
- **`src/adapters/artifact-check.ts`** — pure acceptance gate over a host inspection, plus `findAddedAsserts`.

## Invariants kept from the earlier design

- Worker claims are never evidence; revisions come from host git.
- Completion is not acceptance.
- Verification commands are exact allowlist matches, run by the host with a minimal environment.
- Implementers never approve themselves; reviews are fresh and bound to an exact revision.
- Scope violations fail closed.
- The main checkout is never modified except by `git worktree add` bookkeeping; nothing pushes.

## Not implemented yet

- Conflict resolution for integration.
- Automatic cleanup of worktrees and branches (done by hand after the TinyWebServer rounds).
- Parallel limits beyond Pier's own cap.
- Metrics collection. The field report was extracted by hand from session files.
- Porting stable pieces into Pier.
- A larger controlled comparison against Pier alone. The first round is in [benchmark-2026-09-22.md](benchmark-2026-09-22.md); it found gaps G1–G3 (messages to running reviewers, a master bypassing a failed integration with its shell, and `planned_overlap` used by default).

## Legacy: external vertical slice (removed)

The earlier external-control-plane slice (planner process, scheduler, herdr CLI port, integration merge runner, vertical CLI) is no longer on `main`. It is preserved, with its tests and this document's full description of it, on the branch `legacy/vertical-slice`, and the last benchmarked state is tag `v0.1-bench1`. The mechanisms that carried over into the extension are revision truth from git, completion ≠ acceptance, worktree isolation, scope checks, the verification allowlist and fresh review.
