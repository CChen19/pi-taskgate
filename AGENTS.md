# Development rules

- This is an independent orchestration project. Do not edit sibling pier/Pi repositories or global user configuration as part of its development.
- Keep the core independent of Pi, herdr, terminal APIs, filesystem mutation, and model providers.
- Validate role, model, and policy before any process/workspace creation. Unknown values fail closed; never silently broaden permissions.
- The coordinator plans, delegates, and inspects evidence. Its intended runtime has no arbitrary shell, write, edit, or terminal-control tools.
- Capability declarations are policy data, NOT a sandbox. Runtime enforcement must be implemented and tested separately.
- Agent completion is not task acceptance. Future acceptance requires evidence tied to a specific artifact revision.
- Do not treat terminal output or model claims as authoritative workflow state.
- Keep credentials out of source, tests, logs, and artifacts. Tests must not call real models or start real agents.
- Run `npm run check` after changes. Update documentation to distinguish implemented features from planned features.
- Node 24 runs TypeScript directly; use erasable syntax and explicit `.ts` imports. No build step is required for tests.
