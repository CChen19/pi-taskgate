# agent-orchestrator

独立的、deterministic-first orchestration coordinator。当前包含一个最小真实 vertical slice：LLM 只负责 planner 的语义拆分和 fresh reviewer 的裁决；coordinator 是唯一控制面写入者，负责严格校验、DAG、Scheduler 并发、worktree、机械验证、review、revision 绑定和 integration。测试全部 fake，不启动真实 Herdr/Pi/Git worktree、网络或模型。

## 已实现边界

- `src/host/run-plan.ts`：严格冻结的 `RunPlan`（`version: 1`、`single|plan`、1–3 个 `TaskContract`、最终验证命令），校验重复 ID、缺失依赖和环；planner prompt 展开 TaskContract 字段、数量/ID约束，并列出 host verification allowlist，只能选择其中的 exact command。
- `StructuredAgentRunner`：每次 planner/reviewer 使用全新 pane，轮询 terminal/lost/timeout，`idle` 不等于 accepted；`agent prompt --wait` 成功后仍须观察 working 或读取有效 assistant transcript，post-prompt idle 与 transcript 缺失都有界等待；超时/取消都会 interrupt 并 finally close。transport 以 `lost`/`failed`/`cancelled` 终止时，抛出的错误带上 `StructuredAgentRunner` 自行 sanitize 并 cap 到 160 字符的单行 terminal `outcome`（不信任 generic port 契约会自行 bound；例如 pre-prompt readiness 预算耗尽的具体原因），便于 journal 定位 transport 失败；这不改变 planner 的结构性失败分类（仅 `RunPlanValidationError`/`SyntaxError` 会重试）。
- `HerdrCliPort`：`agent start` 成功只视为进程启动确认，不保证 session JSONL 路径/文件已就绪；提交 prompt 前必须取得存在且可解析的绝对 session JSONL。start 完成回调立即做首次捕获尝试；若路径/文件/transcript 暂时缺失或 malformed，则进入确定性的 pre-prompt readiness 阶段，此后每个 host poll 只做一次重试，最多 10 次 poll 重试；第 10 次重试成功仍被接受，第 10 次重试失败即终止（不再有第 11 次），以保留具体有界 boundary 错误的 terminal `failed` 结束（全局 `StructuredAgentRunner` timeout 仍是外层上界）；期间绝不提交 prompt、不 busy-wait、不 sleep/定时器、不阻塞事件循环。边界固定该路径、`dev`/`inode`、字节长度和整个 pre-prompt 前缀的 SHA-256，只接受同一路径边界之后追加的 assistant outcome。路径变化、`dev`/`inode` 变化、变短、任一 pinned prefix 字节被改写、旧结果和 malformed transcript 都 fail closed；替换检测仅限于这些可观察信号，不声称能识别同一 `dev`/`inode` 且完整复现 pinned prefix 的等价重写（那等同于一次 append）。terminal 时在内存缓存最后 assistant 文本（最多 32 KiB）；`readFinalAssistant(sessionId)` 一次性返回只读副本，拒绝未 terminal、重复读取、malformed 或超限结果。poll outcome 仍为有界摘要，不暴露 transcript。reattach 会重新固定当前边界并重置 working/post-prompt idle/transcript grace 计数；对 terminal、closed 或正在 starting/awaiting-boundary/prompting 的 pane 直接 fail closed 而不复活，且重新固定失败时不部分修改状态；它不声称能识别或恢复边界之前已完成的 generation。
- `VerticalSliceCoordinator`：planner 使用显式 worker role；只有结构性输出错误（JSON 语法或 RunPlan 形状）才带 feedback 重试（默认最多两次，`plannerRetries` 可选 0–2），SIGINT/transport 取消或失败立即终止，不重新 spawn。allowlist preflight 发生在 TaskGraph/worktree 前；`baseRevision` 只接受完整不可变 git object id（40/64 位十六进制），`parseVerticalConfig` 与 `validateConfig` 在创建任何 planner pane/worktree 前拒绝 `HEAD`/branch/tag/短 SHA/revspec——run-wide immutable base，避免 worker/integration workspace 各自解析自己的 HEAD（那会导致 commitsAhead=0、diff/review 为空和 integration ancestor 失败）。按拓扑加入任务，Scheduler 是唯一生命周期权威；settlement 的 host artifact 是唯一 workspace/branch/revision 来源。机械验证严格使用 artifact workspace，失败不会 review 或 merge。通过后按 `planRoute`/`needsFreshReview` 和 reviewer 消融配置走 fresh reviewer，reviewer 收到同 revision 的实际有界 patch，revision 不匹配拒绝。
- `GitIntegrationRunner`：从 base 创建独立 integration worktree，机械确认 branch HEAD 和 base ancestor，`git merge --no-ff --no-edit`，检查冲突和 clean HEAD，最终验证在 integration workspace 执行。rebase 入口校验传入 base 与构造时固定的 `options.baseRevision` 一致，防止 port misuse。`GitIntegrationRunner` 与 `GitWorktreePort` 的 git plumbing 及最终验证命令使用与 task verifier 相同的最小环境（仅 `PATH`/`HOME`/`LANG`/`LC_ALL`/`TMPDIR`，不透传完整 `process.env`，`options.env` 只作为同一安全键集合的显式 source/覆盖）、显式 timeout（默认 30s plumbing 超时）和 `maxOutputBytes`（默认 64 KiB）上限，输出始终有界。不会 merge 用户 master，也不会 push。
- 失败的 integration/verification/review 保留 integration 与 worker worktree 供审计；merged 时保留 integration worktree/branch 作为 final artifact，清理 worker worktree 但保留 worker branches。
- `<workspaceRoot>/.agent-orchestrator/runs/<runId>.jsonl` 记录 bounded 结构化生命周期摘要；不写 prompt、transcript、完整日志或凭据。最终 summary 写入 `finalOutputDir`。
- `src/host/runtime-manifests.ts` 提供按 catalog role ID 生成的有效默认 manifest/base。manifest 是策略数据，不是 sandbox；真实执行边界仍由 host adapter 实现。

## 运行真实 vertical slice

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

## 角色 manifest

运行时形状固定为：`{role,version,tools,permissions,unknownTools,services,guidelines}`。

- coordinator/planner/reviewer：仅 `read`, `todo_write`, `ask_user_question`。
- implementer：`read`, `bash`, `edit`, `write`, `todo_write`, `ask_user_question`，permissions 显式 deny `subagent`/`terminal`，guideline 必须 commit 且不 push。
- 所有 manifest 使用 `version: "1.0.0"`、`unknownTools: "deny"` 和显式 permissions；例如 planner/reviewer 的最终形状包含 `{ "role": "planner", "version": "1.0.0", "tools": ["read", "todo_write", "ask_user_question"], "permissions": {"read":"allow", "todo_write":"allow", "ask_user_question":"allow", "bash":"deny", "edit":"deny", "write":"deny", "subagent":"deny", "terminal":"deny"}, "unknownTools": "deny", "services": {"todos":{"mode":"serial"}}, "guidelines": [...] }`。`parseVerticalConfig` 对缺失或空 manifest 自动注入最终有效默认，显式项必须仍通过 preflight。
- `herdr.roleBases` 的每个值是用于 role resolution 的目录（导出为 Herdr 的 `PI_HERDR_ROLE_BASE` 环境变量），不是描述性 prompt。模板可继续写 `{}`：默认注入 absolute normalized 的 `repoRoot`。显式提供的 base 必须是绝对路径，`validateConfig` 在创建任何 pane/worktree 之前拒绝空或非绝对值。

## 纯核与 host

`src/core` 保持无 I/O：Task Contract、TaskGraph、Scheduler、S4 route、S5 evidence/verdict、S6 integration report 和 S7 durable/recovery 仍可完全注入 fake。`src/adapters` 只连接已验证的 scoped context、worktree ownership 和 `ExecutorPort`。`src/host` 才能调用公开 Herdr CLI、系统 git 和 allowlisted verification process；coordinator 不拥有任意 shell/write/terminal 工具。

完成不是验收：worker terminal 只产生 settlement，只有同一 artifact revision 的 mechanical verdict、fresh review（如要求）、Scheduler verdict 和最终 integration verification 全部通过，run 才返回 `status: "passed"`。

## 检查

```bash
npm run check
```

当前测试数量由 `npm test` 动态决定（本轮 242 项：241 项 fake + 1 项真实本地临时 git repo 语义验证），均不调用真实模型、Herdr、Pi、Git worktree、网络或凭据。vertical slice 的 fake 覆盖包括：并发独立任务 + 精确 revision review + integration；allowlist 升级在 executor start 前拒绝；SIGINT 取消运行中 worker；机械验证失败不 review/merge；reviewer 显式拒绝与 stale revision 均不 merge 且清理 artifact；`SCOPE_VIOLATION` 等 acceptanceEligible=false 的 settlement 从不触发机械 verify/review/merge；prerequisite 失败后 dependent 从不 start 且 journal 记录 BLOCKED；final integration verification 失败时保留 worker artifacts 与 integration workspace；malformed planner 首次失败后带结构 feedback 重试一次成功（planner 调用 2、metrics 正确）；metrics.modelCalls 对每个成功 task_started 的 worker attempt 计一次（retry 按实际 start 计，纯 executor start failure 不计，2-task happy path 断言 5）；真实 `GitIntegrationRunner.asPort()` 以冻结 plain port 过 core 严格 plain-object boundary 完成 rebase/merge/verification/conflict/status 并断言 merged（含 coordinator 未注入 integrationRunner 的 real-runner 构造 seam 回归，旧代码以 `runner must be a plain object` 失败）；planner transport 取消/失败/超时立即失败不重试；SIGINT 后 planner 只 spawn 一次、interrupt+close 各一次且 summary failed；config 边界（非绝对/空 role base、非法 reviewerStrategy、越界 plannerRetries、allowlist 重复/空白、可变 baseRevision（HEAD/branch/tag/短 SHA/revspec/空白））在任何 planner/executor 调用与 pane/worktree 前拒绝；默认 role base 由 repoRoot 注入为绝对路径。host fake 另外断言 integration git/verification 命令与 worktree plumbing 使用最小 env（不含密钥）、timeout、maxOutputBytes 上限，integration rebase 传入 base 必须等于固定 `options.baseRevision`，且未授权命令被拒；新增 pre-prompt boundary readiness 回归：session JSONL 延迟出现后只提交一次 prompt 并以有效的 post-boundary 追加结果 settle，永久缺失/永久 malformed 都在第 10 次（也是最后一次）poll 重试按文档化预算失败，close/interrupt 在 readiness 期间绝不提交 prompt，malformed 可在预算内恢复，pre-prompt `working` 快照不会污染 post-prompt `workingSeen`，pre-prompt `blocked`/`cancelled` 直接 fail closed 且不启动 prompt，readiness 期间 pane 从 host pane list 消失时 fail closed 为 `lost` 并丢弃保存的 prompt/env（phase 置 terminal），且 `StructuredAgentRunner` 自行 sanitize（中和 C0/C1 控制符、NEL、U+2028/U+2029、bidi embedding/isolate/标记）并 cap（160 字符，且不在 surrogate 对中间截断）port 提供的 terminal `outcome` 后带入抛错（含超大、Unicode-spoofing 与 surrogate-boundary 回归）。另有一项真实本地临时 git repo 语义单测（普通 repo，不建 worktree、不联网）：固定 base SHA 在 worker commit 后 `git rev-list base..HEAD` 为 1 且 `git diff base...HEAD` 非空，而 `HEAD` 基准为 0/空。下一步主控命令是：

```bash
npm run vertical:run -- run --config ./vertical.config.json
```

有限制：当前是 1–3 task 的最小切片；durable event log 仍是 host JSONL 而非数据库；manifest capability 不是 OS sandbox；integration branch 不会自动合并到用户 master；真实运行仍依赖外部 Herdr/Pi auth、role base 和命令 allowlist 的正确部署配置。
