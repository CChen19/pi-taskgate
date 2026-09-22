# Architecture: minimal real vertical slice

## Boundary

`src/core` is deterministic and side-effect free. The LLM planner decides only task objectives, decomposition, dependency edges, minimal scope, acceptance criteria, and verification commands. The coordinator validates that proposal and owns graph construction, scheduling, concurrency, worktree allocation, verification, reviewer gating, revision matching, and integration. There is no rule engine that decomposes tasks.

`src/host` is the only side-effect boundary. It may use the public `herdr` CLI, system `git`, allowlisted verification processes, and append-only JSONL observability. Tests inject fakes and do not start any of those resources.

## Run-wide immutable base

Every run pins one immutable base revision for all workers, reviews, and integration. `baseRevision` must be a complete git object id — 40 hex characters (SHA-1) or 64 hex characters — and both `parseVerticalConfig` and the coordinator constructor reject `HEAD`, branch/tag names, short SHAs, and revision expressions before any planner pane or worktree exists. The CLI never resolves revisions on the user's behalf: paste the verbatim output of `git rev-parse HEAD` from the target repository. Mutable revspecs are rejected because each worker/integration workspace resolves them against its own HEAD, which yields zero commits ahead, empty diffs and reviews, and failing base-ancestor checks. One offline test exercises the real semantics against a plain temporary git repository (no worktree, no network).

## Flow

1. `StructuredPlanner` is dispatched as the explicit `planner` worker role. It receives deterministic read-only-first instructions, the exact host verification allowlist, and returns strict JSON.
2. `validateRunPlan` validates exact root fields, Task Contracts, unique IDs, dependency references, DAG acyclicity, and `single`/`plan` cardinality. A plan file can bypass the planner for A/B experiments.
3. Tasks are added to `TaskGraph` in topological order. `Scheduler` is the only lifecycle authority; worker terminal is not acceptance.
4. For each eligible settlement, coordinator reads only host-observed `workspacePath`, `branch`, and `artifactRevision`. Mechanical verification runs with `cwd` equal to that workspace. Ineligible/scope-violating settlements never reach verification.
5. Passed mechanical evidence is sent to a new reviewer pane only when S4 route/reviewer strategy requires it. The host reads an actual `git diff --no-ext-diff --no-color <base>...<artifact>` in the artifact workspace; reviewer input contains only spec, bounded revision-bound patch, and bounded S5 evidence. A missing/failed diff or stale revision is rejected.
6. The coordinator submits the final S2 verdict to Scheduler. Only passed tasks become integration units.
7. S6 creates a separate integration lease from base, confirms each unit branch HEAD and base ancestry, merges with `--no-ff --no-edit`, runs final verification in the integration workspace, then checks conflicts and clean HEAD. It never updates user master and never pushes.
8. A merged integration workspace/branch is the final artifact. Worker worktrees are cleaned only after merge; failed integration and interrupted worker resources remain for audit.

## Ports and structured results

`HerdrCliPort` keeps poll outcomes bounded (160 characters) and caches only the final assistant message in memory (32 KiB maximum). Immediately after a successful `agent start`, and before submitting the prompt, it requires a present and parseable absolute agent session JSONL and fails closed (terminal `failed`) if that boundary is unavailable or malformed. The pinned boundary is the absolute path, device/inode, byte length, and a SHA-256 digest over the full pre-prompt bytes. A successful `agent prompt --wait` does not by itself prove that the generation ran: post-prompt idle/done without a new appended assistant outcome receives exactly three grace probes and fails on the fourth, while a valid quick-completion append is accepted without a working probe. After working is observed, done still requires an assistant parsed from bytes appended after that boundary; exactly two missing-outcome done probes are allowed and the third fails. The transcript grace counter is monotonic for the turn; working probes do not reset it. A path change, a `dev`/`inode` change, a shortening, mutation of any pinned prefix byte, malformed CLI/session data, or a stale/preexisting assistant cannot settle the turn. Replacement detection is deliberately limited to those observable signals: a same-`dev`/same-`inode` rewrite that reproduces the entire pinned prefix byte-for-byte is indistinguishable from an append and is accepted as an append-only continuation. Reattach is a fail-closed boundary recovery policy: it re-pins the current boundary and resets working/post-prompt-idle/transcript-grace accounting before accepting later output, refuses to resurrect terminal, closed, or actively starting/prompting panes, and does not partially mutate state if re-pinning fails; it does not claim to identify turns, so a completion that predates the reattach boundary is deliberately not recoverable. `readFinalAssistant(sessionId)` is one-shot and rejects non-terminal, malformed, and oversized results. `StructuredAgentRunner` uses fresh spawn/poll/close lifecycle with injected clock/sleep; idle is not terminal acceptance.

`PiHerdrExecutor` remains the worker `ExecutorPort` adapter and host-observes artifacts through `WorktreePort`. The coordinator never trusts worker-reported revisions. Cancellation in the vertical-slice runtime can retain interrupted leases for audit.

`GitIntegrationRunner` binds command verification to the integration workspace, checks each final command against the global exact allowlist, and applies the configured timeout. Its rebase entry refuses any base that differs from the pinned `options.baseRevision`. The coordinator hands core `runIntegration` the frozen plain structural port from `asPort()`, never the class instance, which the strict plain-object runner boundary rejects — a seam mismatch found by the first real run and covered by offline regressions. `GitWorktreePort` runs git plumbing under the same shared minimal environment (only `PATH`/`HOME`/`LANG`/`LC_ALL`/`TMPDIR`; never the full `process.env`) with explicit plumbing timeouts and bounded output. `ProcessVerificationRunner` executes only commands already declared by the contract/final plan and authorized by the host.

## Observability

Each run appends bounded JSON records to `<workspaceRoot>/.agent-orchestrator/runs/<runId>.jsonl`, including planner attempts, scheduler lifecycle, task/attempt IDs, artifact provenance, verification/reviewer/integration outcomes, timestamps and metrics. Prompts, transcripts, credentials and full command logs are excluded. A summary JSON is written under the configured final output directory. Summary `metrics.modelCalls` counts planner attempts, required reviewer sessions, and one per successfully started worker attempt (`task_started`); pure executor start failures are not model calls.

## Runtime manifests

Runtime manifest data has exact intended shape `{role:string,version:"1.0.0",tools:string[],permissions:Record<string,"allow"|"ask"|"deny">,unknownTools:"allow"|"deny",services?,guidelines:string[]}`. Planner/reviewer use only `read,todo_write,ask_user_question`; implementer additionally uses `bash,edit,write` but explicitly denies `subagent` and `terminal` and must commit without pushing. Missing/empty role manifests and bases are filled by safe defaults during config parsing. These declarations are policy data, not an OS sandbox.

## Failure policy

Mechanical rejection, review rejection, stale review, dependency failure, verification failure and integration conflict stop acceptance and prevent merge. Failure cleanup is explicit and errors are surfaced; audit workspaces are not force-removed. Final success requires every task passed, integration merged, and final verification passed.

## Current limits

This is intentionally a small 1–3 task slice. JSONL is not a database, recovery across coordinator processes is not supplied by this slice, manifests do not enforce OS capabilities, and integration is retained on its private branch rather than merged into user master. Real execution depends on correctly deployed Herdr/Pi auth, role bases, and verification allowlists. The offline suite covers planner preflight, manifest defaults, allowlist/timeout, fast completion, cancellation, revision-bound diff, rejection/staleness, dependency blocking, and retained failed integration; fuzzing is intentionally out of scope.
