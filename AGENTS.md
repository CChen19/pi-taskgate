# Development rules

- Target architecture: the Pi main session (Pier master) is the only semantic orchestrator and the human's single entry point. This project supplies deterministic primitives (task state, host inspection, scope, verification, revision-bound review) to it as a companion Pi extension. Do not build a second, external control plane.
- Do not edit sibling pier/Pi repositories or global user configuration as part of this project's development. Until P0 ends, integrate with Pier only through its public surfaces (the `subagent` tool, role files, the delegation ledger read-only). Porting pieces into Pier later is a separate, explicitly approved step.
- Keep `src/core` independent of Pi, herdr, terminal APIs, filesystem mutation, and model providers. Pi/Pier coupling lives in `src/pi-extension`, `src/orchestration/host-wiring.ts`, and `src/host`.
- Validate role, model, and policy before any process/workspace creation. Unknown values fail closed; never silently broaden permissions.
- The main agent runs with Pier's master permissions and may do small tasks itself when the work needs no delegation (the task board is empty). Once a task is planned, its git writes in the repository and task worktrees are blocked, and the only deliverable is the `DELIVERABLE` revision in `task_status`. Delegated workers use role manifests; reviewers must use a role that explicitly denies every mutating tool (checked before each review dispatch).
- Capability declarations are policy data, NOT a sandbox. Runtime enforcement must be implemented and tested separately.
- Agent completion is not task acceptance. Acceptance requires host-observed evidence tied to a specific artifact revision: clean committed worktree, in-scope changed paths, allowlisted verification at that revision, and (when required) a fresh reviewer verdict bound to that revision.
- Do not treat terminal output or model claims as authoritative workflow state. The verification allowlist and repository roots come from human-authored config, never from the model.
- Keep credentials out of source, tests, logs, and artifacts. Tests must not call real models or start real agents.
- Run `npm run check` after changes. Update documentation to distinguish implemented features from planned features.
- Node 24 runs TypeScript directly; use erasable syntax and explicit `.ts` imports. No build step is required for tests.
