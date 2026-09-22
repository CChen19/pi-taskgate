# Architecture

## Target: the Pi main session orchestrates; code enforces

```text
Human ⇄ Pi main session (Pier master; the only semantic orchestrator)
          │  semantic: decompose, parallelize, re-plan, ask the human, summarize
          ▼
   Pier `subagent` (real panes, human takeover, resume)   agent-orchestrator task tools
          │                                                 (companion Pi extension)
   worker panes in host-owned worktrees ─────────────► host inspection · scope · allowlisted
   reviewer pane (read-only role, fresh)                verification · revision-bound review
```

There is exactly one control plane: the main agent decides the next action; the task tools provide ground truth and refuse illegal transitions. Nothing outside the Pi session decides what runs next.

### Components (implemented, P0)

- `src/orchestration/task-board.ts`: pure reducer. `TaskGraph` (dependencies, `task-state` lifecycle with settled ≠ accepted) plus per-attempt evidence: worktree lease, bound Pier agent, failed checks, candidate revision with its `EvidenceBundle`, review request/verdict. Every mutation is a versioned `TaskEvent`; `replayTaskBoard` rebuilds identical state.
- `src/orchestration/task-service.ts`: the deterministic operations behind the tools. Each mutation is trial-applied to a replayed board, then persisted, then swapped in, so a refused or unpersistable operation leaves state unchanged.
  - `plan`: validates all contracts first (unique ids, known deps, no cycles, non-empty `files_in_scope`, verification commands exactly in the host allowlist), adds them in topological order. Review defaults to required.
  - `start`: READY (deps PASSED) or RETRYING only; host reads the main checkout HEAD (or a PASSED dependency's accepted revision via `base_task`) and creates an owned worktree through `WorktreeManager` + `GitWorktreePort`. `reuse_worktree` continues a previous attempt's branch.
  - `bind`: the Pier agent id must appear in Pier's ledger for exactly that worktree cwd.
  - `verify`: refuses while the ledger says the worker is `running`; inspects HEAD/changed paths/clean/commits ahead, applies `checkArtifact` (scope, dirty, no commits), runs allowlisted commands asynchronously in a clean room — a fresh detached checkout of exactly the candidate revision (`src/host/clean-room.ts`), confirmed pristine before commands run and removed afterwards, so ignored or untracked worker output such as `build/` is never reused — then checks the worker's HEAD did not move, and decides with `decideVerdict`. Failures are recorded as checks on the RUNNING attempt (the main agent can `subagent send` a fix); `maxChecksPerAttempt` bounds the loop. Success settles a candidate revision (VERIFYING), or PASSED when review is not required.
  - `reviewBrief`: requires the configured reviewer role to explicitly deny every mutating tool (Pier otherwise treats unknown roles as labels and `allowed_tools` can widen toolsets), re-checks the candidate is still HEAD and clean (else rejects the attempt), and issues a brief bound to the revision and a one-time review id.
  - `recordReview`: reads the reviewer's closing text from Pier's ledger (written by Pier from the child's session JSONL), requires role = reviewer role, not revived, launched after the brief, not an implementer of the task, a verdict line with the issued review id and candidate revision, and an unchanged worktree; then `decideFinalVerdict`.
- `src/pi-extension/index.ts`: registers `task_status`, `task_plan`, `task_start`, `task_bind`, `task_verify`, `task_review_brief`, `task_review_record`, `task_abandon`. Events persist as `agent-orchestrator.task-event` custom entries; `session_start`/`session_tree` replay the current branch and re-adopt leases. If config is missing or state cannot be replayed, every tool fails closed.
- `src/orchestration/config.ts`: human-authored config (repo root, workspace root outside the repo, verification allowlist, reviewer role, budgets). The model never supplies allowlist entries.
- `src/host/pier-ledger.ts` / `src/host/pier-roles.ts`: read-only views of Pier's delegation ledger and role files, matching Pier's storage encodings and lookup order.
- `src/adapters/artifact-check.ts`: pure acceptance gate over a host inspection.

### Integration (P1, implemented)

`task_integrate` admits only candidates that are PASSED through a passing fresh review bound to the exact candidate revision, re-confirmed from Pier's ledger (settled, not revived, read-only role, verdict names the review id and revision). Candidates accepted in earlier sessions are admitted only by replaying those sessions' task events (current branch) with the same reducer. Every candidate must have been built on the declared base (a full object id) or on the revision of an earlier input, so a prerequisite task such as shared build wiring can enter together with the tasks stacked on it; only each candidate's own commits are picked. The host creates a new integration worktree at that base and cherry-picks each candidate's `base..revision` commits in the given order with `-x`; a conflict aborts the pick, records the input, commit and conflicted paths, and fails the integration terminally — there is no resolution step. A clean result becomes an integration task that reuses `task_verify` (clean room, scope = union of input paths, plus a history check that `base..HEAD` is exactly the recorded integrated commits, each patch-identical to and naming its source) and the fresh-review flow; implementers of any input cannot review the integration. Nothing merges into the main checkout or pushes.

Planning rule: tasks that can run in parallel (no dependency path between them, checked against live board tasks too) may not have overlapping `files_in_scope` unless both declare the path in `planned_overlap`; shared coordination files should become per-task fragments or a prerequisite task.

A guard shared by all tasks rejects `assert(` added in test sources (Release builds define `NDEBUG`), scanning only added lines of the committed diff and ignoring comments, string literals and `static_assert`.

### Invariants kept from the earlier design

Worker claims are never evidence; revisions come from host git. Completion is not acceptance. Verification commands are exact allowlist matches, run by the host with a minimal environment. Implementers never approve themselves; reviews are fresh and bound to an exact revision. Scope violations fail closed. The main checkout is never modified except by `git worktree add` bookkeeping; nothing pushes.

### Not implemented yet (P1+)

Conflict resolution for integration, worktree cleanup, parallel limits beyond Pier's own cap, metrics, cross-session recovery beyond Pi session replay, and porting stable pieces into Pier. The end-to-end run in a real Pi/Pier session has not happened yet.

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
