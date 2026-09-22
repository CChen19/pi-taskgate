# agent-orchestrator

给 Pi 主会话（Pier master）用的 deterministic orchestration primitives。**主 Pi agent 是唯一的语义 orchestrator 和人机入口**：它负责拆解任务、决定并行、动态重规划、何时问人。本项目只提供事实和约束：结构化 task state、宿主观察的 git artifact、files_in_scope、allowlist 机械验证、绑定 revision 的 fresh review。worker/reviewer 由主 agent 通过 Pier 的 `subagent` 工具在真实 pane 中启动，人随时可以进入 pane 接管。

> 架构调整（2026-09）：早期的"外层 coordinator + 独立 planner 进程"路线（下文 *Legacy* 部分）已冻结，不再继续开发。其中正确的机制（artifact 真相、完成≠验收、worktree 隔离、scope、allowlist、fresh reviewer）被复用到下面的主会话扩展里。

## 主会话扩展（当前方向，P0 已实现，尚未真机验证）

`src/pi-extension/index.ts` 是一个与 Pier 并列加载的 Pi extension，只在主会话中注册 8 个工具，不 spawn 任何 agent：

| 工具 | 由代码保证的事实 |
|---|---|
| `task_status` | task board：state、未满足依赖、attempts、绑定的 Pier agent、worktree、失败的 check、candidate revision、review、verdict、READY 列表 |
| `task_plan` | 原子地加入 TaskContract（全部校验通过才写入）：id 唯一、依赖存在且无环、`files_in_scope` 非空、verification 命令必须逐字在 host allowlist 中；`review_required` 默认 true |
| `task_start` | 任务必须 READY/RETRYING 且依赖已 PASSED；host 从主 checkout 的 HEAD（或某个已 PASSED 依赖的 revision）建独立 worktree+branch，返回 worker prompt 和 `subagent` spawn 参数；`reuse_worktree` 在同一分支上开下一个 attempt |
| `task_bind` | 通过 Pier ledger 确认该 agent 确实在该 worktree 中启动 |
| `task_verify` | 要求 worker 在 Pier ledger 中已不是 running；host 检查 HEAD、changed paths、clean、commits ahead、scope，然后在该 revision 上跑 allowlist 命令；失败只记一次 check（attempt 不消耗，超过 `maxChecksPerAttempt` 才判 attempt 失败），通过则 settle 为 candidate（不需要 review 时直接 PASSED） |
| `task_review_brief` | 先确认 reviewer role 对所有写/执行类工具显式 deny，且 candidate 仍是 HEAD 且干净；生成绑定 revision + 一次性 review id 的 brief |
| `task_review_record` | 从 **Pier ledger** 读取 reviewer 的收尾输出（不采信主 agent 转述）；要求 reviewer ≠ implementer、role 正确、非 revived、在 brief 之后启动、review id 与 revision 都匹配、worktree 未变，然后 PASSED 或 RETRYING/FAILED |
| `task_abandon` | 主 agent 放弃当前 attempt（受 retry 预算约束）或取消任务（依赖方变 BLOCKED） |

task 事件以 `agent-orchestrator.task-event` custom entry 写入 Pi session，`/resume` 和分支切换时回放重建；worktree lease 通过 ownership ledger 重新 adopt。每次变更先在回放出的副本上试 apply，再持久化，失败时状态不变。

### 运行（P0）

1. 写一个人工维护的配置（默认读 `<主会话 cwd>/.pi-herdr/agent-orchestrator.json`，或用环境变量 `AGENT_ORCHESTRATOR_CONFIG` 指定），allowlist 只来自这里：

```json
{
  "version": 1,
  "repoRoot": "/path/to/repo",
  "workspaceRoot": "/short/path/wt",
  "verificationAllowlist": ["make -j4", "./run_tests.sh"],
  "verificationTimeoutMs": 600000,
  "reviewerRole": "reviewer-readonly",
  "maxChecksPerAttempt": 5,
  "defaultMaxAttempts": 3
}
```

`workspaceRoot` 必须很短：Pier 为每个 subagent 创建 `/tmp/pi-herdr-<编码后的 cwd>-<pane>.sock`，Unix socket 路径上限约 108 字节，`/` 编码后占 3 字节。配置加载时和每次 `task_start` 都会检查，超长时 fail closed；worktree 使用紧凑命名 `<task≤12>-a<n>-<hash>`，分支为 `ao/...`。

2. 在 Pier 的角色目录（`<主会话 cwd>/.pi-herdr/roles/`）放一个只读 reviewer 角色：对 `edit`/`write`/`bash`/`pwsh`/`subagent`/`terminal` 显式 `deny`。
3. 在 herdr pane 中启动主会话，同时加载 Pier 与本扩展：

```bash
pi -e /path/to/pier/packages/pier-ext/src/index.ts -e /path/to/agent-orchestrator/src/pi-extension/index.ts
```

小任务不需要 task 工具，主 agent 直接做并跑检查；复杂或可并行的任务才走 task board。

### 已知限制（P0）

- 尚未在真实 Pi/Pier 会话中端到端跑过；离线测试覆盖真实 git worktree、真实 allowlist 进程、fake Pier ledger。
- `task_verify` 依赖 Pier ledger 的 `running` 状态判断 worker 是否结束；如果 `subagent send` 之后 Pier 没有写新的 running 行，过早 verify 可能看到半成品并记一次失败 check。
- Pier 的 todo 自动对账会在 subagent settle 时勾掉描述匹配的 todo；task 状态只以 `task_status` 为准，建议 spawn description 用 `T1:impl` 这类不与 todo 重合的形式（工具返回的就是这种）。
- 不做自动 integration（P1）；worktree 不自动清理（P1）；git 检查是同步调用，verification 命令是异步调用。

## Legacy：外层 vertical slice（已冻结）

以下是旧的 external-control-plane 实现，代码与测试保留，但不再扩展。`HerdrCliPort` 的 pre-prompt session-boundary 机制只服务于这条路线，新架构不需要它。

### 已实现边界

- `src/host/run-plan.ts`：严格冻结的 `RunPlan`（`version: 1`、`single|plan`、1–3 个 `TaskContract`、最终验证命令），校验重复 ID、缺失依赖和环；planner prompt 展开 TaskContract 字段、数量/ID约束，并列出 host verification allowlist，只能选择其中的 exact command。
- `StructuredAgentRunner`：每次 planner/reviewer 使用全新 pane，轮询 terminal/lost/timeout，`idle` 不等于 accepted；`agent prompt --wait` 成功后仍须观察 working 或读取有效 assistant transcript，post-prompt idle 与 transcript 缺失都有界等待；超时/取消都会 interrupt 并 finally close。transport 以 `lost`/`failed`/`cancelled` 终止时，抛出的错误带上 `StructuredAgentRunner` 自行 sanitize 并 cap 到 160 字符的单行 terminal `outcome`（不信任 generic port 契约会自行 bound；例如 pre-prompt readiness 预算耗尽的具体原因），便于 journal 定位 transport 失败；这不改变 planner 的结构性失败分类（仅 `RunPlanValidationError`/`SyntaxError` 会重试）。
- `HerdrCliPort`：`agent start` 成功只视为进程启动确认，不保证 session JSONL 路径/文件已就绪；提交 prompt 前必须取得存在且可解析的绝对 session JSONL。start 完成回调立即做首次捕获尝试；若路径/文件/transcript 暂时缺失或 malformed，则进入确定性的 pre-prompt readiness 阶段，此后每个 host poll 只做一次重试，最多 10 次 poll 重试；第 10 次重试成功仍被接受，第 10 次重试失败即终止（不再有第 11 次），以保留具体有界 boundary 错误的 terminal `failed` 结束（全局 `StructuredAgentRunner` timeout 仍是外层上界）；期间绝不提交 prompt、不 busy-wait、不 sleep/定时器、不阻塞事件循环。边界固定该路径、`dev`/`inode`、字节长度和整个 pre-prompt 前缀的 SHA-256，只接受同一路径边界之后追加的 assistant outcome。路径变化、`dev`/`inode` 变化、变短、任一 pinned prefix 字节被改写、旧结果和 malformed transcript 都 fail closed；替换检测仅限于这些可观察信号，不声称能识别同一 `dev`/`inode` 且完整复现 pinned prefix 的等价重写（那等同于一次 append）。terminal 时在内存缓存最后 assistant 文本（最多 32 KiB）；`readFinalAssistant(sessionId)` 一次性返回只读副本，拒绝未 terminal、重复读取、malformed 或超限结果。poll outcome 仍为有界摘要，不暴露 transcript。reattach 会重新固定当前边界并重置 working/post-prompt idle/transcript grace 计数；对 terminal、closed 或正在 starting/awaiting-boundary/prompting 的 pane 直接 fail closed 而不复活，且重新固定失败时不部分修改状态；它不声称能识别或恢复边界之前已完成的 generation。
- `VerticalSliceCoordinator`：planner 使用显式 worker role；只有结构性输出错误（JSON 语法或 RunPlan 形状）才带 feedback 重试（默认最多两次，`plannerRetries` 可选 0–2），SIGINT/transport 取消或失败立即终止，不重新 spawn。allowlist preflight 发生在 TaskGraph/worktree 前；`baseRevision` 只接受完整不可变 git object id（40/64 位十六进制），`parseVerticalConfig` 与 `validateConfig` 在创建任何 planner pane/worktree 前拒绝 `HEAD`/branch/tag/短 SHA/revspec——run-wide immutable base，避免 worker/integration workspace 各自解析自己的 HEAD（那会导致 commitsAhead=0、diff/review 为空和 integration ancestor 失败）。按拓扑加入任务，Scheduler 是唯一生命周期权威；settlement 的 host artifact 是唯一 workspace/branch/revision 来源。机械验证严格使用 artifact workspace，失败不会 review 或 merge。通过后按 `planRoute`/`needsFreshReview` 和 reviewer 消融配置走 fresh reviewer，reviewer 收到同 revision 的实际有界 patch，revision 不匹配拒绝。
- `GitIntegrationRunner`：从 base 创建独立 integration worktree，机械确认 branch HEAD 和 base ancestor，`git merge --no-ff --no-edit`，检查冲突和 clean HEAD，最终验证在 integration workspace 执行。rebase 入口校验传入 base 与构造时固定的 `options.baseRevision` 一致，防止 port misuse。`GitIntegrationRunner` 与 `GitWorktreePort` 的 git plumbing 及最终验证命令使用与 task verifier 相同的最小环境（仅 `PATH`/`HOME`/`LANG`/`LC_ALL`/`TMPDIR`，不透传完整 `process.env`，`options.env` 只作为同一安全键集合的显式 source/覆盖）、显式 timeout（默认 30s plumbing 超时）和 `maxOutputBytes`（默认 64 KiB）上限，输出始终有界。不会 merge 用户 master，也不会 push。
- 失败的 integration/verification/review 保留 integration 与 worker worktree 供审计；merged 时保留 integration worktree/branch 作为 final artifact，清理 worker worktree 但保留 worker branches。
- `<workspaceRoot>/.agent-orchestrator/runs/<runId>.jsonl` 记录 bounded 结构化生命周期摘要；不写 prompt、transcript、完整日志或凭据。最终 summary 写入 `finalOutputDir`。
- `src/host/runtime-manifests.ts` 提供按 catalog role ID 生成的有效默认 manifest/base。manifest 是策略数据，不是 sandbox；真实执行边界仍由 host adapter 实现。

### 运行真实 vertical slice

前置需要 Node 24、`git`、`herdr`、`pi` 和已配置 Pi auth store。配置不含凭据；provider/model 由已配置的 Pi/Herdr 运行时自行解析。首跑使用 planner，不使用 bypass：

```bash
npm run vertical:run -- run --config ./vertical.config.json
```

消融或复现实验可显式绕过 planner：

```bash
npm run vertical:run -- run --config ./vertical.config.json --plan-file ./plan.json
```

配置模板（示例值，未声称已运行）：

```json
{
  "repoRoot": "/path/to/repo",
  "workspaceRoot": "/path/to/dedicated-workspaces",
  "baseRevision": "0123456789abcdef0123456789abcdef01234567",
  "userTask": "Implement the TinyWebServer workload",
  "catalog": {
    "roles": [
      { "id": "coordinator", "description": "orchestrates", "kind": "coordinator", "tools": ["read", "todo_write", "ask_user_question"] },
      { "id": "planner", "description": "plans", "kind": "worker", "tools": ["read", "todo_write", "ask_user_question"] },
      { "id": "implementer", "description": "implements", "kind": "worker", "tools": ["read", "bash", "edit", "write", "todo_write", "ask_user_question"] },
      { "id": "reviewer", "description": "reviews", "kind": "worker", "tools": ["read", "todo_write", "ask_user_question"] }
    ],
    "models": [
      { "id": "planner-profile", "provider": "configured-provider", "model": "configured-model" },
      { "id": "implementer-profile", "provider": "configured-provider", "model": "configured-model" },
      { "id": "reviewer-profile", "provider": "configured-provider", "model": "configured-model" }
    ],
    "routes": [
      { "roleId": "planner", "defaultProfile": "planner-profile", "allowedProfiles": ["planner-profile"] },
      { "roleId": "implementer", "defaultProfile": "implementer-profile", "allowedProfiles": ["implementer-profile"] },
      { "roleId": "reviewer", "defaultProfile": "reviewer-profile", "allowedProfiles": ["reviewer-profile"] }
    ]
  },
  "plannerRoleId": "planner",
  "implementerRoleId": "implementer",
  "reviewerRoleId": "reviewer",
  "plannerModelProfileId": "planner-profile",
  "implementerModelProfileId": "implementer-profile",
  "reviewerModelProfileId": "reviewer-profile",
  "herdr": {
    "herdrBinary": "herdr",
    "piExtension": "/path/to/pier-ext/src/index.ts",
    "provider": "configured-provider",
    "model": "configured-model",
    "workspaceId": "configured-workspace",
    "roleManifests": {},
    "roleBases": {},
    "timeouts": { "startMs": 30000, "promptMs": 3600000, "probeMs": 5000 }
  },
  "verificationAllowlist": ["npm run check"],
  "verificationTimeoutMs": 300000,
  "concurrency": 2,
  "pollIntervalMs": 1000,
  "runTimeoutMs": 7200000,
  "reviewerStrategy": "auto",
  "finalOutputDir": "/path/to/final-artifacts"
}
```

`baseRevision` 不是可保留的示例值：必须替换为目标仓 `git rev-parse HEAD` 输出的完整 40 位 SHA（也接受 64 位十六进制 object id）。CLI 不会自动解析 revision——`HEAD`、branch/tag 名、短 SHA 和 revspec 会在 `parseVerticalConfig`/`validateConfig` 阶段被直接拒绝（先在目标仓运行 `git rev-parse HEAD` 并原样粘贴完整 SHA），因为 worker/integration cwd 会各自解析自己的 `HEAD`，导致 diff/review 为空和 ancestor 校验失败。上文示例 SHA 只是格式示意，必须替换。

`reviewerStrategy` 可以是 `auto`、`always` 或 `never`（validateConfig 拒绝其他值）；`never` 只关闭 reviewer，不关闭 mechanical verification。`verificationAllowlist` 拒绝空白和重复项；`plannerRetries` 若给定必须是 0–2 的整数。`single`/`plan` 由 planner 决定，显式 `plan-file` 只提供 bypass/A-B 对照。所有 SIGINT、task failure、review rejection、verification failure 和 integration conflict 都停止后续集成并保留可审计资源。

### 角色 manifest

运行时形状固定为：`{role,version,tools,permissions,unknownTools,services,guidelines}`。

- coordinator/planner/reviewer：仅 `read`, `todo_write`, `ask_user_question`。
- implementer：`read`, `bash`, `edit`, `write`, `todo_write`, `ask_user_question`，permissions 显式 deny `subagent`/`terminal`，guideline 必须 commit 且不 push。
- 所有 manifest 使用 `version: "1.0.0"`、`unknownTools: "deny"` 和显式 permissions；例如 planner/reviewer 的最终形状包含 `{ "role": "planner", "version": "1.0.0", "tools": ["read", "todo_write", "ask_user_question"], "permissions": {"read":"allow", "todo_write":"allow", "ask_user_question":"allow", "bash":"deny", "edit":"deny", "write":"deny", "subagent":"deny", "terminal":"deny"}, "unknownTools": "deny", "services": {"todos":{"mode":"serial"}}, "guidelines": [...] }`。`parseVerticalConfig` 对缺失或空 manifest 自动注入最终有效默认，显式项必须仍通过 preflight。
- `herdr.roleBases` 的每个值是用于 role resolution 的目录（导出为 Herdr 的 `PI_HERDR_ROLE_BASE` 环境变量），不是描述性 prompt。模板可继续写 `{}`：默认注入 absolute normalized 的 `repoRoot`。显式提供的 base 必须是绝对路径，`validateConfig` 在创建任何 pane/worktree 之前拒绝空或非绝对值。

### 纯核与 host

`src/core` 保持无 I/O：Task Contract、TaskGraph、Scheduler、S4 route、S5 evidence/verdict、S6 integration report 和 S7 durable/recovery 仍可完全注入 fake。`src/adapters` 只连接已验证的 scoped context、worktree ownership 和 `ExecutorPort`。`src/host` 才能调用公开 Herdr CLI、系统 git 和 allowlisted verification process；coordinator 不拥有任意 shell/write/terminal 工具。

完成不是验收：worker terminal 只产生 settlement，只有同一 artifact revision 的 mechanical verdict、fresh review（如要求）、Scheduler verdict 和最终 integration verification 全部通过，run 才返回 `status: "passed"`。

## 检查

```bash
npm run check
```

本轮 270 项测试（含主会话扩展的 28 项：真实临时 git repo + worktree + allowlist 进程，fake Pier ledger/role），均不调用真实模型、Herdr、Pi 或网络。以下为 legacy slice 的覆盖说明。

Legacy slice 部分（242 项：241 项 fake + 1 项真实本地临时 git repo 语义验证），均不调用真实模型、Herdr、Pi、Git worktree、网络或凭据。vertical slice 的 fake 覆盖包括：并发独立任务 + 精确 revision review + integration；allowlist 升级在 executor start 前拒绝；SIGINT 取消运行中 worker；机械验证失败不 review/merge；reviewer 显式拒绝与 stale revision 均不 merge 且清理 artifact；`SCOPE_VIOLATION` 等 acceptanceEligible=false 的 settlement 从不触发机械 verify/review/merge；prerequisite 失败后 dependent 从不 start 且 journal 记录 BLOCKED；final integration verification 失败时保留 worker artifacts 与 integration workspace；malformed planner 首次失败后带结构 feedback 重试一次成功（planner 调用 2、metrics 正确）；metrics.modelCalls 对每个成功 task_started 的 worker attempt 计一次（retry 按实际 start 计，纯 executor start failure 不计，2-task happy path 断言 5）；真实 `GitIntegrationRunner.asPort()` 以冻结 plain port 过 core 严格 plain-object boundary 完成 rebase/merge/verification/conflict/status 并断言 merged（含 coordinator 未注入 integrationRunner 的 real-runner 构造 seam 回归，旧代码以 `runner must be a plain object` 失败）；planner transport 取消/失败/超时立即失败不重试；SIGINT 后 planner 只 spawn 一次、interrupt+close 各一次且 summary failed；config 边界（非绝对/空 role base、非法 reviewerStrategy、越界 plannerRetries、allowlist 重复/空白、可变 baseRevision（HEAD/branch/tag/短 SHA/revspec/空白））在任何 planner/executor 调用与 pane/worktree 前拒绝；默认 role base 由 repoRoot 注入为绝对路径。host fake 另外断言 integration git/verification 命令与 worktree plumbing 使用最小 env（不含密钥）、timeout、maxOutputBytes 上限，integration rebase 传入 base 必须等于固定 `options.baseRevision`，且未授权命令被拒；新增 pre-prompt boundary readiness 回归：session JSONL 延迟出现后只提交一次 prompt 并以有效的 post-boundary 追加结果 settle，永久缺失/永久 malformed 都在第 10 次（也是最后一次）poll 重试按文档化预算失败，close/interrupt 在 readiness 期间绝不提交 prompt，malformed 可在预算内恢复，pre-prompt `working` 快照不会污染 post-prompt `workingSeen`，pre-prompt `blocked`/`cancelled` 直接 fail closed 且不启动 prompt，readiness 期间 pane 从 host pane list 消失时 fail closed 为 `lost` 并丢弃保存的 prompt/env（phase 置 terminal），且 `StructuredAgentRunner` 自行 sanitize（中和 C0/C1 控制符、NEL、U+2028/U+2029、bidi embedding/isolate/标记）并 cap（160 字符，且不在 surrogate 对中间截断）port 提供的 terminal `outcome` 后带入抛错（含超大、Unicode-spoofing 与 surrogate-boundary 回归）。另有一项真实本地临时 git repo 语义单测（普通 repo，不建 worktree、不联网）：固定 base SHA 在 worker commit 后 `git rev-list base..HEAD` 为 1 且 `git diff base...HEAD` 非空，而 `HEAD` 基准为 0/空。下一步主控命令是：

```bash
npm run vertical:run -- run --config ./vertical.config.json
```

有限制：当前是 1–3 task 的最小切片；durable event log 仍是 host JSONL 而非数据库；manifest capability 不是 OS sandbox；integration branch 不会自动合并到用户 master；真实运行仍依赖外部 Herdr/Pi auth、role base 和命令 allowlist 的正确部署配置。
