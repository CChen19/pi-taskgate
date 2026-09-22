# Architecture

Status: P0 (task tools) and P1 (integration) are implemented and have run for real on TinyWebServer (2026-09-22). What happened, including every failure the tools caught, is in [field-report-2026-09.md](field-report-2026-09.md). How we plan to measure the benefit against Pier alone is in [evaluation.md](evaluation.md).

## Target: the Pi main session orchestrates; code enforces

```text
Human ⇄ Pi main session (Pier master; the only semantic orchestrator)
          │  semantic: decompose, parallelize, re-plan, ask the human, summarize
          ▼
   Pier `subagent` (real panes, human takeover, resume)   agent-orchestrator task tools
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

## Legacy: external vertical slice (frozen)

The sections below describe the earlier external-control-plane slice (`src/host/vertical-slice.ts`, `vertical-cli.ts`, `structured-agent-runner.ts`, `herdr-cli-port.ts`, `adapters/pi-herdr-executor.ts`, `core/scheduler.ts`). The code and tests remain but are not extended. The pre-prompt session-boundary machinery exists only because an outside process had to prompt Pi; under the target architecture Pier owns child session lifecycles, so that invariant is not needed.

### Boundary

`src/core` is deterministic and side-effect free. The LLM planner decides only task objectives, decomposition, dependency edges, minimal scope, acceptance criteria, and verification commands. The coordinator validates that proposal and owns graph construction, scheduling, concurrency, worktree allocation, verification, reviewer gating, revision matching, and integration. There is no rule engine that decomposes tasks.

`src/host` is the only side-effect boundary. It may use the public `herdr` CLI, system `git`, allowlisted verification processes, and append-only JSONL observability. Tests inject fakes and do not start any of those resources.

### Run-wide immutable base

Every run pins one immutable base revision for all workers, reviews, and integration. `baseRevision` must be a complete git object id — 40 hex characters (SHA-1) or 64 hex characters — and both `parseVerticalConfig` and the coordinator constructor reject `HEAD`, branch/tag names, short SHAs, and revision expressions before any planner pane or worktree exists. The CLI never resolves revisions on the user's behalf: paste the verbatim output of `git rev-parse HEAD` from the target repository. Mutable revspecs are rejected because each worker/integration workspace resolves them against its own HEAD, which yields zero commits ahead, empty diffs and reviews, and failing base-ancestor checks. One offline test exercises the real semantics against a plain temporary git repository (no worktree, no network).

### Flow

1. `StructuredPlanner` is dispatched as the explicit `planner` worker role. It receives deterministic read-only-first instructions, the exact host verification allowlist, and returns strict JSON.
2. `validateRunPlan` validates exact root fields, Task Contracts, unique IDs, dependency references, DAG acyclicity, and `single`/`plan` cardinality. A plan file can bypass the planner for A/B experiments.
3. Tasks are added to `TaskGraph` in topological order. `Scheduler` is the only lifecycle authority; worker terminal is not acceptance.
4. For each eligible settlement, coordinator reads only host-observed `workspacePath`, `branch`, and `artifactRevision`. Mechanical verification runs with `cwd` equal to that workspace. Ineligible/scope-violating settlements never reach verification.
5. Passed mechanical evidence is sent to a new reviewer pane only when S4 route/reviewer strategy requires it. The host reads an actual `git diff --no-ext-diff --no-color <base>...<artifact>` in the artifact workspace; reviewer input contains only spec, bounded revision-bound patch, and bounded S5 evidence. A missing/failed diff or stale revision is rejected.
6. The coordinator submits the final S2 verdict to Scheduler. Only passed tasks become integration units.
7. S6 creates a separate integration lease from base, confirms each unit branch HEAD and base ancestry, merges with `--no-ff --no-edit`, runs final verification in the integration workspace, then checks conflicts and clean HEAD. It never updates user master and never pushes.
8. A merged integration workspace/branch is the final artifact. Worker worktrees are cleaned only after merge; failed integration and interrupted worker resources remain for audit.

### Ports and structured results

`HerdrCliPort` keeps poll outcomes bounded (160 characters) and caches only the final assistant message in memory (32 KiB maximum). A successful `agent start` is treated only as a process-start acknowledgement: the Pi session JSONL path/file may not be reported yet. The start-completion callback makes one immediate boundary capture attempt; if the path/file/transcript is temporarily unavailable or malformed it enters a deterministic pre-prompt readiness phase and retries exactly once per later host poll, for at most ten poll-driven retries. A capture that succeeds on retry ten is accepted, and a capture that fails on retry ten terminates immediately with `failed` (there is no eleventh retry), retaining the specific bounded boundary error. The prompt is never submitted until an absolute, existing, parseable boundary is pinned first; the phase never busy-waits, blocks the event loop, uses sleeps/timers inside the port, or submits a prompt without a boundary. The outer `StructuredAgentRunner` timeout remains the global bound, and a missing pane or permanently malformed path fails closed within the readiness budget; a pane that disappears during readiness becomes terminal `lost` and drops any saved prompt/env data. A pre-prompt `blocked`/`cancelled` probe also fails closed without launching the prompt, and a successful capture returns running immediately so the pre-prompt probe snapshot is never interpreted as post-prompt state (for example, it cannot set `workingSeen`). The pinned boundary is the absolute path, device/inode, byte length, and a SHA-256 digest over the full pre-prompt bytes. A successful `agent prompt --wait` does not by itself prove that the generation ran: post-prompt idle/done without a new appended assistant outcome receives exactly three grace probes and fails on the fourth, while a valid quick-completion append is accepted without a working probe. After working is observed, done still requires an assistant parsed from bytes appended after that boundary; exactly two missing-outcome done probes are allowed and the third fails. The transcript grace counter is monotonic for the turn; working probes do not reset it. A path change, a `dev`/`inode` change, a shortening, mutation of any pinned prefix byte, malformed CLI/session data, or a stale/preexisting assistant cannot settle the turn. Replacement detection is deliberately limited to those observable signals: a same-`dev`/same-`inode` rewrite that reproduces the entire pinned prefix byte-for-byte is indistinguishable from an append and is accepted as an append-only continuation. Reattach is a fail-closed boundary recovery policy: it re-pins the current boundary and resets working/post-prompt-idle/transcript-grace accounting before accepting later output, refuses to resurrect terminal, closed, or actively starting/awaiting-boundary/prompting panes, and does not partially mutate state if re-pinning fails; it does not claim to identify turns, so a completion that predates the reattach boundary is deliberately not recoverable. `readFinalAssistant(sessionId)` is one-shot and rejects non-terminal, malformed, and oversized results. `StructuredAgentRunner` uses fresh spawn/poll/close lifecycle with injected clock/sleep; idle is not terminal acceptance. When the port reports `lost`/`failed`/`cancelled`, the runner propagates a cap-160 sanitized terminal `outcome` in its thrown error — neutralizing C0/C1 controls (including NEL U+0085), Unicode line/paragraph separators, and bidi marks/embeddings/isolates so the message stays single-line and unspoofed, and never truncating inside a surrogate pair — so journals reveal the specific transport failure (for example, an exhausted boundary readiness budget) — the runner bounds this itself rather than trusting the generic port contract; planner failure classification is unchanged because only `RunPlanValidationError`/`SyntaxError` are treated as structural planner-output errors.

`PiHerdrExecutor` remains the worker `ExecutorPort` adapter and host-observes artifacts through `WorktreePort`. The coordinator never trusts worker-reported revisions. Cancellation in the vertical-slice runtime can retain interrupted leases for audit.

`GitIntegrationRunner` binds command verification to the integration workspace, checks each final command against the global exact allowlist, and applies the configured timeout. Its rebase entry refuses any base that differs from the pinned `options.baseRevision`. The coordinator hands core `runIntegration` the frozen plain structural port from `asPort()`, never the class instance, which the strict plain-object runner boundary rejects — a seam mismatch found by the first real run and covered by offline regressions. `GitWorktreePort` runs git plumbing under the same shared minimal environment (only `PATH`/`HOME`/`LANG`/`LC_ALL`/`TMPDIR`; never the full `process.env`) with explicit plumbing timeouts and bounded output. `ProcessVerificationRunner` executes only commands already declared by the contract/final plan and authorized by the host.

### Observability

Each run appends bounded JSON records to `<workspaceRoot>/.agent-orchestrator/runs/<runId>.jsonl`, including planner attempts, scheduler lifecycle, task/attempt IDs, artifact provenance, verification/reviewer/integration outcomes, timestamps and metrics. Prompts, transcripts, credentials and full command logs are excluded. A summary JSON is written under the configured final output directory. Summary `metrics.modelCalls` counts planner attempts, required reviewer sessions, and one per successfully started worker attempt (`task_started`); pure executor start failures are not model calls.

### Runtime manifests

Runtime manifest data has exact intended shape `{role:string,version:"1.0.0",tools:string[],permissions:Record<string,"allow"|"ask"|"deny">,unknownTools:"allow"|"deny",services?,guidelines:string[]}`. Planner/reviewer use only `read,todo_write,ask_user_question`; implementer additionally uses `bash,edit,write` but explicitly denies `subagent` and `terminal` and must commit without pushing. Missing/empty role manifests and bases are filled by safe defaults during config parsing. These declarations are policy data, not an OS sandbox.

### Failure policy

Mechanical rejection, review rejection, stale review, dependency failure, verification failure and integration conflict stop acceptance and prevent merge. Failure cleanup is explicit and errors are surfaced; audit workspaces are not force-removed. Final success requires every task passed, integration merged, and final verification passed.

### Current limits

This is intentionally a small 1–3 task slice. JSONL is not a database, recovery across coordinator processes is not supplied by this slice, manifests do not enforce OS capabilities, and integration is retained on its private branch rather than merged into user master. Real execution depends on correctly deployed Herdr/Pi auth, role bases, and verification allowlists. The offline suite covers planner preflight, manifest defaults, allowlist/timeout, fast completion, cancellation, revision-bound diff, rejection/staleness, dependency blocking, and retained failed integration; fuzzing is intentionally out of scope.
