# pi-taskgate

A quality gate for AI coding agents: delegated work is accepted only after clean-room verification and an independent review of the exact revision. It is a Pi extension that runs next to [Pier](https://github.com/July24/pier) (Pi + herdr subagents).

The Pi main session (the Pier master) stays the only semantic orchestrator and the human's single entry point. It decomposes the work, decides what runs in parallel, spawns workers and reviewers with Pier's `subagent` tool, and decides when to ask the human. This extension supplies facts and refusals:

- structured task state;
- git state observed by the host;
- scope checks;
- allowlisted verification in a clean checkout;
- reviews bound to one revision.

It does not make agents smarter. It turns safeguards that Pier leaves to prompt discipline into refusals.

**Status (2026-09-29).**
- **Round 1.** The extension ran on real TinyWebServer tasks, and a first controlled comparison against Pier alone was run ([results](docs/benchmark-2026-09-22.md)). It found three gaps (G1–G3), which have since been fixed. The review brief is now also delivered as a file.
- **Round 2** ([results](docs/benchmark-2026-09-29.md), pre-registered in [docs/evaluation.md](docs/evaluation.md)).
  - **Strong master (`gpt-6-sol`), 44 valid trials:** Pier alone and both versions of the tools had no bad acceptance at all, up to a 6-task workload. The fixed tools held G1–G3, and cost less than the round-1 code. They took about 1.6× Pier-alone's wall time at 6 tasks.
  - **Weaker master (`gpt-6-luna`):** Pier alone accepted a vacuous `assert` test in 3 of 3 trials, and the tools in 0 of 3. That meets the pre-registered rule "the layer's outcome value depends on master strength".

## What Pier provides and what this adds

| | Pier (used as shipped, public surfaces only) | pi-taskgate |
|---|---|---|
| Launching agents | `subagent` starts workers and reviewers in herdr panes; the human can take over; revive; settlement notices | Never spawns. Returns the exact spawn arguments |
| Roles | Role files (tools, permissions) | Checks before every review that the reviewer role denies every mutating tool |
| Who ran what | Delegation ledger: pane, cwd, role, status, closing output, `revivedFrom`, session file | Reads the ledger to bind workers to worktrees, detect settlement, and take the reviewer's own verdict. Reads the reviewer's session file to see exactly what it was told and read |
| Workspace | One cwd per subagent | One host-created git worktree and branch per attempt, from an exact base revision |
| Task state | Free-text todos | Event-sourced board: contracts, dependencies, attempts, checks, candidate revision, review, verdict |
| "Is it done?" | The child says so | Host reads git, checks scope, runs allowlisted commands in a clean checkout of that revision, then a fresh review bound to it |
| Merging | — | Cherry-picks exact accepted revisions onto an exact base, then verification and a fresh review of the integration |
| Delivery | — | `task_status` names the single `DELIVERABLE` revision. Once tasks are planned, the master's git writes are blocked |
| Recovery | Session files, `--session` resume | Replays the board from the session's own entries |

## Flow

```
task_plan ─► task_start ─► subagent spawn (worker, own worktree) ─► task_bind
          ─► task_verify (host inspection + scope + clean-room allowlist run)
          ─► task_review_brief ─► subagent spawn (fresh read-only reviewer) ─► task_review_record
          ─► PASSED ─► task_integrate ─► task_verify ─► review ─► DELIVERABLE
```

A worker saying "done" is not acceptance. Only `task_verify` and `task_review_record` move a task toward PASSED, and both rely on evidence the host observed.

## Tools

| Tool | What the code guarantees |
|---|---|
| `task_status` | The board: state, unmet dependencies, attempts, bound agent, worktree, failed checks, candidate, review and verdict, plus the READY list and **`DELIVERABLE`**. The deliverable is the latest PASSED integration, or the single task's PASSED revision when there is only one task. Otherwise it is none, with a reason |
| `task_plan` | Adds contracts atomically. Ids must be unique, dependencies must exist without cycles, `files_in_scope` must be non-empty, and verification commands must match the host allowlist verbatim. `review_required` defaults to true. **Planning rule:** tasks that can run in parallel must not have overlapping `files_in_scope`. The only exception is a path in the human-written `sharedPaths` config that both tasks list in `planned_overlap`. The model can reference shared paths but cannot add them |
| `task_start` | Needs a READY or RETRYING task. The host creates a worktree and branch and returns the worker prompt and spawn arguments. A task without dependencies starts from HEAD. A task with one dependency is **stacked** on that dependency's accepted revision. With several dependencies, `base_task` is required, and every dependency that changes the same files must already be in that base's stack. `reuse_worktree` continues on the same branch |
| `task_bind` | Confirms in Pier's ledger that the agent was launched in that worktree |
| `task_verify` | The worker must have settled. The host checks HEAD, changed paths, a clean tree, commits ahead and scope, then runs the allowlisted commands in a **fresh checkout of that exact revision** (`<workspaceRoot>/.verify/`, built from git objects only). Ignored build output in the worker tree is never reused. Optionally rejects new `assert(` in C/C++ tests (`rejectTestAsserts`). A failure costs one check; passing settles a candidate |
| `task_review_brief` | Checks that the reviewer role is read-only and that the candidate is still HEAD and clean. Writes the full brief (objective, criteria, scope, verification evidence, patch) to a host-owned file `<workspaceRoot>/.briefs/<reviewId>.md`, recording its sha256 and the issued prompt. The master gets only a 4-line spawn prompt that points at the file |
| `task_review_record` | Takes the verdict from Pier's ledger, never from the master's paraphrase. Requires a reviewer that is not the implementer, runs the read-only role, is not revived, and was launched after the brief. The review id and revision must match, and the worktree must be unchanged. From the reviewer's **own session file** it also requires exactly one prompt, equal to the issued one (`REVIEWER_NOT_INDEPENDENT` otherwise), an unchanged brief (`BRIEF_CHANGED`), and reads that returned every brief line verbatim (`BRIEF_NOT_READ`) |
| `task_integrate` | Cherry-picks (`-x`) exact accepted revisions onto an exact base in a new worktree. Each revision must be PASSED, verified in a clean room and freshly reviewed, with the review re-confirmed in the ledger. A conflict aborts and FAILS the integration; nothing is resolved automatically. The integration then goes through `task_verify` (which also checks patch identity against the sources) and a fresh review |
| `task_abandon` | Gives up the current attempt (within the retry budget) or cancels the task; dependents become BLOCKED |

**Git write guard.** The extension also hooks Pi's `tool_call` event. While the board holds a task, it blocks the master's `bash` git writes under `repoRoot` or `workspaceRoot` and returns `GIT_WRITE_BLOCKED`:
- **Blocked:** `commit`, `merge`, `cherry-pick`, `rebase`, `reset`, `revert`, `am`, `apply`, `push`, `pull`, `update-ref`, `switch`, branch-moving `checkout`, and forced, deleting or renaming `branch`.
- **Parsing:** the guard follows quoting, separators, `$(...)`, heredocs, `cd`, `git -C`, `sh -c` and `eval`. A command whose target directory it cannot resolve is blocked.
- **Allowed:** read-only git commands. With an empty board, the master may commit small work that needs no delegation.

The guard is a string check, not a sandbox. What makes delivery trustworthy is the rule that only `DELIVERABLE` is accepted.

Task events are stored as `agent-orchestrator.task-event` custom entries in the Pi session and replayed on `/resume` and branch navigation. Worktree leases are re-adopted through an ownership ledger. Each change is first applied to a replayed copy and only then persisted, so a refused call changes nothing.

## Setup

1. **Write the config by hand.** The default path is `<master cwd>/.pi-herdr/agent-orchestrator.json`; `AGENT_ORCHESTRATOR_CONFIG` overrides it. The allowlist, repository roots and shared paths come only from this file, never from the model.

   ```json
   {
     "version": 1,
     "repoRoot": "/path/to/repo",
     "workspaceRoot": "/short/path/wt",
     "verificationAllowlist": ["cmake -S . -B build && cmake --build build && cd build && ctest"],
     "verificationTimeoutMs": 600000,
     "reviewerRole": "reviewer-readonly",
     "maxChecksPerAttempt": 5,
     "defaultMaxAttempts": 3,
     "sharedPaths": [],
     "rejectTestAsserts": false
   }
   ```

   - `sharedPaths`: repository-relative paths that parallel tasks may both change. With `[]`, overlapping tasks must be ordered with `depends_on` or given separate files.
   - `rejectTestAsserts`: set this for repositories whose verification builds tests with `-DNDEBUG`, where `assert()` is compiled out.
   - `workspaceRoot` must be short. Pier opens a Unix socket at `/tmp/pi-herdr-<encoded cwd>-<pane>.sock`, and the path limit is about 108 bytes. The limit is checked at config load and at every `task_start`.

2. **Add a read-only reviewer role** to Pier's role directory (`<master cwd>/.pi-herdr/roles/`). It must deny `edit`, `write`, `bash`, `pwsh`, `subagent` and `terminal`, and allow `read`.

3. **Start the master in a herdr pane** with both extensions:

   ```bash
   pi -e /path/to/pier/packages/pier-ext/src/index.ts -e /path/to/pi-taskgate/src/pi-extension/index.ts
   ```

## Known limitations

Evidence for each item is in the benchmarks ([round 1](docs/benchmark-2026-09-22.md), [round 2](docs/benchmark-2026-09-29.md)) and [the field report](docs/field-report-2026-09.md).

- **The outcome benefit is narrow.**
  - With a strong master, round 2 found no outcome difference: 0 bad acceptances in every arm. The tools cost wall time on multi-task work, because shared files force tasks to run in order.
  - With a weaker master, the one difference came from one fault type: `assert` tests compiled out in Release. The worker brief's assert rule prevented it.
  - Scope escapes and smoke-test-only candidates were caught by every master tried, with or without the tools.
  - Logic errors that neither the tests nor the reviewer notice get through in both arms.
- **Some fixes held but were never exercised live.**
  - In round 2, no master messaged a reviewer after its brief, and none tried a git write. The G1 check and the git write guard therefore never had to refuse anything live. They are covered by offline tests.
  - Brief-as-file worked in all 60 round-2 B1 reviews: every reviewer received the issued prompt, and every accepted verdict passed the read-coverage check.
- **A read brief is not a careful review.** The checks prove that the reviewer saw the exact brief, not that it judged well. In round 1, one fresh reviewer caught a weak test (i3b) and one missed an `NDEBUG` problem (Pier-only i2a).
- **The git write guard can be bypassed.** It covers only the master's `bash` command strings. `edit` and `write` can still change files, and aliases, scripts or other languages can still run git. The delivery rule is what holds.
- **Reviewers have no shell.** They sometimes ask the human through `ask_user_question`. Those answers arrive as tool results, not prompts, so the one-prompt check does not catch them. The benchmark operator answered with a fixed "no human is available" text.
- **Integration is mechanical.** It cherry-picks and fails closed on conflict, with no resolution. With empty `sharedPaths`, tasks that touch a shared build file must be ordered with `depends_on` or split. Ordered tasks are stacked automatically, so they integrate cleanly but run one after another, which is slower.
- **Settlement comes from Pier's ledger.** Verifying or recording before a subagent settles is refused with `WORKER_RUNNING`. This happened 11 times in round 1, always without effect.
- **Pier's todo reconciliation** may tick todos whose text matches a spawn description. Use `task_status`, and the `T1:impl`-style descriptions the tools return.
- **Housekeeping.** Worktrees and branches are not cleaned up automatically, and there are no built-in metrics: the evaluation extracts them from session files.
- **Capability declarations are policy data, not a sandbox.**

## Development

```bash
npm run check   # typecheck + 133 offline tests
```

Tests use real temporary git repositories, worktrees and allowlisted processes, with a fake Pier ledger, roles and sessions. They never call a model, Pi, herdr or the network. Node 24 runs the TypeScript directly; there is no build step.

| Path | Contents |
|---|---|
| `src/core` | Pure logic: task contracts, graph, state machine, verification verdicts, reviewer brief, scope, git write classification |
| `src/orchestration` | Task board (event-sourced), task service, briefs, config, host wiring |
| `src/host` | Side effects: git, clean-room checkouts, processes, Pier ledger/roles, Pi session files, brief files |
| `src/adapters` | Worktree lease manager, artifact checks |
| `src/pi-extension` | The Pi extension: tools, git write guard, session replay |

**Legacy.** The earlier external-control-plane slice (outer planner, scheduler, herdr CLI port) was removed from `main`. It is preserved on branch `legacy/vertical-slice`, and the state benchmarked in round 1 is tag `v0.1-bench1`.

**Naming.** The project was renamed from `agent-orchestrator`. Some persisted identifiers keep the old name so that existing sessions and evidence stay readable: the session event type `agent-orchestrator.task-event`, the config file `agent-orchestrator.json`, the variable `AGENT_ORCHESTRATOR_CONFIG`, and the ownership directory `.agent-orchestrator/ledger`.

## Documents

- [docs/architecture.md](docs/architecture.md): design and invariants.
- [docs/evaluation.md](docs/evaluation.md): evaluation method and the round-2 pre-registration.
- [docs/benchmark-2026-09-22.md](docs/benchmark-2026-09-22.md): round-1 results.
- [docs/benchmark-2026-09-29.md](docs/benchmark-2026-09-29.md): round-2 results, including the weak-master extension.
- [docs/critical-path-2026-09-29.md](docs/critical-path-2026-09-29.md): where round-2 wall time went.
- [docs/field-report-2026-09.md](docs/field-report-2026-09.md): the live runs that motivated the design.
- [docs/observations-2026-09-22.md](docs/observations-2026-09-22.md): operator observations (Chinese).

## 中文简介

pi-taskgate 是一个与 Pier 并列加载的 Pi 扩展。Pi 主会话仍是唯一的编排者；本扩展只提供由 host 观察到的事实和拒绝：任务状态、worktree 隔离、scope 检查、干净环境里的 allowlist 验证、绑定 revision 的独立 review，以及唯一的 `DELIVERABLE` 交付 revision。第一、二轮对照实验见 `docs/`。

第二轮结论：
- **强 master（gpt-6-sol）：** 各组都没有错误接受。
- **弱 master（gpt-6-luna）：** 只用 Pier 的一组在 3 次试验中都接受了在 Release 下失效的 `assert` 测试，加载本扩展的一组为 0 次。
