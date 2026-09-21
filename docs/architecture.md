# 架构（S8：Pi/herdr 适配边界、worktree 隔离与 scoped context）

## 控制面 / 执行面分离

- **控制面（已实现）**：`Catalog`、`planDispatch`、Task Contract 校验、Orchestration Gate、九态状态机、`TaskGraph`、`Scheduler`、S5 机械验证与 reviewer brief、S6 机械集成报告与升级契约、S7 durable event/projection/recovery 纯核。它们都是内存纯核，无 I/O、网络、进程、worktree、终端、数据库/文件系统或模型调用副作用。
- **执行面（S3/S5/S6/S8 端口）**：`ExecutorPort` 是任务执行边界，`FakeExecutor` 是离线测试 fake；S5 的 `VerificationRunner` 和 S6 的 `IntegrationRunner` 是命令/Git 执行边界。S8 增加 `PiHerdrExecutor`、`WorktreeManager` 和 scoped-context；P0 `src/host/` 将它们接到公开 herdr CLI、系统 git worktree 和 allowlisted verification process。完整 Planner/DAG、reviewer 模型与 integration coordinator 仍未接线。
- 角色的 tools/capabilities 仍只是策略数据，**不是**沙箱；真正的运行时权限强制必须在执行面另行实现和测试。

## Task Contract

`validateTaskContract(input: unknown)` 是任务进入图之前的唯一形状校验入口：

- exact-fields、稳定 ID、非空目标、字符串数组、重复/自引用依赖、验收标准、预算和重试参数都 fail closed；问题聚合为 `INVALID_CONTRACT`，包含 `code/message/path/issues`。
- `depends_on` 在契约层只校验形状，不要求引用已存在；引用存在性由图层检查。
- 成功结果是深度冻结副本；数组会复制，调用方输入不会被修改或冻结。
- `verification` 在 S2 Contract 中只作为命令字符串存储，S2 本身绝不执行。S4 将其复制为 mechanical verification 规划；S5 只有在调用方显式提供 runner 时才执行，并将结果绑定到 artifact revision；命令字符串本身不是执行授权。

## S4 Orchestration Gate

`planRoute(taskContract, gateOptions?)` 是规则版、可解释、可复现的路由估计器：不调用模型、不调 LLM、不创建 `TaskGraph`。它运行时先复用 S2 `validateTaskContract`，因此只接受经校验的 Task Contract；非法契约统一抛出带 `code/message/path/available`（并保留 issues）的结构化错误。它观察五类信号：

- `files_in_scope` 数量：默认 2 个进入 medium、5 个进入 complex；
- `acceptance_criteria` 数量：默认 3 / 6；
- `verification` 命令数量：0 个表示验证不确定并贡献 medium 信号，4 个进入 complex；
- 契约字符串总量（objective、context、files、criteria、verification、depends_on 的 UTF-16 字符数）：默认 500 / 2,000；
- `depends_on` 数量：默认 1 / 3。

每个 medium 信号计 1 分、complex 信号计 2 分；任一 complex 信号或达到默认 3 分即为 `complex`，有信号但未达到 complex 为 `medium`，否则为 `simple`。所有阈值和计划建议可通过 exact-fields 的 `GateConfig.thresholds` 覆盖，未知字段、Symbol、非 plain object、`null` 和无效枚举/整数均 fail closed。

路由是不变式而不是执行命令：`simple -> single`（一个 worker，机械验证规划始终保留）；`medium -> plan`（预计 2 个任务、并发建议 1）；`complex -> plan`（预计 4 个任务、并发建议 2）。`RoutePlan.maxConcurrency` 和 `expectedTaskCount` 只是 S3 Scheduler / 后续 S5 的消费建议，`complexScore` 与 `score` 会随计划保留以便 reviewer 门槛重算并校验跨字段一致性；S4 不修改 S3 行为、不自动拆 DAG。

`needsFreshReview` 的默认门槛是：`plan` 或 `complex` 必须 fresh review；`single + simple` 默认不需要；机械验证 `failed` 或 `uncertain` 时需要。`reviewer: 'always' | 'never'` 是同一结果中的消融开关；关闭 reviewer 不关闭 mechanical verification 规划。

`mode: 'auto' | 'force-single' | 'force-plan'` 用于 S9 对照实验。`force-*` 绕过路由选择，结果仍保留规则估计的 `complexity`、`forced` 标记、信号对应的 `reasons` 和路由解释 `decisionReasons`。所有返回的 `RoutePlan` 与 reviewer 决策都是深度冻结快照。

`needsFreshReview` 只做门槛决策，运行时严格校验传入的 `RoutePlan` 形状（plain object、exact-fields、枚举和嵌套 mechanical verification）；调用方必须传入未篡改的 `planRoute` 产物。形状合法不等于可证明来源，Gate 不提供对象 provenance 或执行授权。

## S5 验证环

S5 是对 S4 规划的纯核消费，不改 S4 路由或 S3 Scheduler 行为：

- `MechanicalVerifier.run(commands, ctx)` 只接受验证命令和包含 `taskId`、`attemptId`、`artifactRevision`、注入 `clock`/`runner` 的上下文。它逐条调用 runner，记录 `exitCode`、注入时钟测得的 `durationMs`、`timedOut` 和有界 `output`/`outputRef`，返回深度冻结的 `EvidenceBundle`。核心不调用 `Date.now()`、`Math.random()`，也不自行启动进程；测试 runner 是 fake。
- `decideVerdict(bundle, expectations)` 先验证 evidence 形状和 revision 绑定。所有命令 `exitCode === 0` 且未超时、并满足 `minimumCommands` 时返回 `{ verdict: 'passed', artifactRevision, reasons }`；任意非零/超时或期望未满足返回 artifact-bound `rejected`。bundle 缺 revision 是结构化 fail-closed 错误，不产生无绑定 verdict。输出摘要复用 `truncateForMessage` 的 160 UTF-16 code-unit 上界。
- `assembleReviewerBrief` 只复制 `spec.objective/acceptance_criteria/files_in_scope`、`diff.artifactRevision` 与可选有界 patch、以及 evidence 摘要。它用 exact-fields 拒绝额外的 `workerTranscript`、prompt 历史和完整日志字段，保持 fresh-context 隔离；不调用模型。
- `validateReviewVerdict` 只接受 `outcome: 'passed' | 'rejected'`、非空 `reasons` 和非空 `artifactRevision`。`decideFinalVerdict` 的矩阵是：机械 rejected → rejected；机械 passed 且 Gate 不要求 reviewer → passed；机械 passed 且 Gate 要求但尚无 review → needs_review；review rejected → rejected；review passed 只有在 revision 与机械 verdict 相同才通过。最终只把 `passed/rejected` 映射为 S2 的 verdict 输入，`settled` 仍停在 `VERIFYING`。公开的 `s2VerdictInput` 会在运行时拒绝 `needs_review` 等非 S2 值。
- S5 标识符有界：`taskId` 复用 S2 的 64 字符上限；`attemptId` 为 128 字符，足以容纳 S3 的 `${taskId}:attempt-${counter}`；`artifactRevision` 为 256 字符，覆盖 commit/diff hash 与适配器引用。超限统一结构化拒绝。

## S6 机械集成纯核

S6 增加 `src/core/integration.ts`，但不改 S2–S5 的行为。`IntegrationUnit` 绑定 `taskId`、branch、revision 和 S5 `VerificationVerdict`；只有 artifactRevision 匹配且 verdict 为 `passed` 的 unit 才能进入 `MergePlan`。`planIntegration(units, options)` 对 unknown 输入执行 plain-object、exact-fields、Symbol/非枚举字段、稀疏数组和数组方法覆盖检查；base/branch/revision 使用 S5 的 256 字符 revision 上界。

顺序规则是确定性的：没有依赖时使用输入顺序，`options.order` 可提供给定顺序；声明依赖时使用 Kahn 拓扑排序，给定顺序只作为同层节点的稳定 tie-breaker，依赖边优先。未知依赖、自依赖、重复依赖和环都 fail closed。计划同时复制最终验证命令，不执行它们。

`runIntegration(plan, runner, { clock })` 只调用注入的 `IntegrationRunner`：每个 unit 依次 rebase、merge，然后调用 command runner 做最终验证，再查询冲突和 status。每个阶段失败即止；成功 Git 操作若缺少非空 revision 不被视为成功，而是 `runner_error`。冲突报告 `outcome: 'conflict'`，验证失败报告 `verification_failed`，全通过报告 `merged`，runner 异常/畸形返回报告为 `runner_error` 并带 `IntegrationError` 结构（code/message/path/available）。没有 `Date.now()` / `Math.random()`，时钟只来自注入 `clock`；步骤详情和输出摘要有界，报告和最终 evidence/verdict 深度冻结。

`IntegrationReport.finalVerification` 是 S5 接线点：集成 runner 的 command 结果先组装成 S5 `EvidenceBundle`，再交给 S5 `decideVerdict`，报告同时保留 evidence 和 revision-bound `VerificationVerdict`。它不会把合并成功等同于任务验收。

`decideEscalation` 先重算 report 的关键一致性（outcome、steps、conflicts、finalVerification 和 error），包括用 S5 `decideVerdict` 从 evidence 重算 final verdict，拒绝伪造的 report，再按矩阵返回：`merged -> none`；`verification_failed -> mechanical-retry`（可参数化剩余次数）；`conflict -> integration-agent`；`runner_error -> human`。步骤必须遵守每个 unit 一次 rebase → merge，随后 verification → conflict-check → status 的严格前缀管线，禁止重复或重排。命令条目和冲突路径超过 256 UTF-16 code units 直接结构化拒绝；这是本切片选择的 fail-closed 边界策略，不做截断。Integration Agent 只定义 `assembleIntegrationAgentBrief` 的输入契约：冲突文件、base/unit revisions、双方 diff 摘要；不接模型。

S6 纯核测试全部使用 fake runner，未启动真实 git、命令、agent、worktree 或网络。P0 host adapters 位于 `src/host/`，不改变这些纯核契约；完整 acceptance vertical slice 尚未接线。

## S7 Durable State：日志权威、快照缓存

S7 增加 `src/core/durable-state.ts` 与 `src/core/recovery.ts`，但不改 S2–S6 的状态/调度行为。`DurableEvent` 的 schema version 当前只接受 `1`；envelope 固定包含 `runId`、从 1 连续递增的 `sequence`、`eventId`、`idempotencyKey`、注入 `clock` 的 `occurredAt`、`kind` 和受控 payload。event/run/attempt ID 上限为 128，task ID 沿用 S2 的 64，reference/revision 上限为 256，摘要与最终结构化错误 message 上限为 160 UTF-16 code units。unknown future version、未知字段（含 Symbol/非枚举）、稀疏/方法篡改/额外属性数组、gap/out-of-order、runId 不一致均 fail closed。

payload 只允许六类受控数据：Scheduler 事件摘要、TaskGraph lifecycle/attempt 投影、S5 evidence 引用与有界摘要、artifact-bound verdict、S6 integration report 引用与摘要、recovery action。完整 worker transcript、命令输出、终端日志不进入事件或 projection。canonical projection 严格校验 contract.id/taskId、合法 S2 from/current/to、attempt start/settle 的存在性与唯一性、evidence/verdict 的 task/attempt/artifactRevision binding，以及 PASSED 必须有同 revision 的 passed verdict 且无 active attempt；scheduler/recovery 事件仅保留审计，不直接改变 canonical task。`DurableProjectionState` 保存任务 contract/state/attempt、依赖、subtask、证据/裁决/集成摘要和 event identity index；它是恢复所需的 canonical durable projection，不是一个已 hydrate 的 `TaskGraph` 实例。

`EventStorePort.append(runId, expectedSequence, events)` 是唯一写入入口，使用 sequence CAS；一次 batch 先完整校验再提交，保证 all-or-nothing。旧 expected sequence 返回结构化 `SEQUENCE_CONFLICT`，空 batch 也不能绕过 stale CAS。幂等只接受完整 envelope（包括相同 `sequence`）的 eventId/idempotencyKey 重放；同 identity 的其他 sequence 或内容返回 conflict。`SnapshotStorePort.saveSnapshot` 同时校验 expected sequence/schema version；snapshot 带 integrity marker（非密码学签名，只用于普通篡改检测），篡改或 lastSequence 不一致拒绝。`recoverRun(snapshot, tail)` 只从 `snapshot.lastSequence + 1` replay，快照永远不能覆盖日志权威；snapshot 与 tail 合计最多 100,000 个事件，replay 使用 O(n) accumulator + Map/Set。`InMemoryDurableStore` 是复制/冻结的离线 fake，不是数据库或文件系统 adapter。

`planRecovery` / `reconcileRecovery` 是纯函数，不启动 executor：persisted RUNNING + observed running → `reattach`；+ terminal → `settle`（保留 outcome/resultRef）；+ missing → 默认 `mark-lost`，也可只记录 `retry-scheduler`，最终 attempt budget 仍由 S3 决定；persisted terminal + executor running → `cancel-stale`；无对应 persisted attempt 的 observed → `cancel-orphan`。稳定按 task/attempt 排序并要求 revision/attempt binding。start intent 已落盘但 executor 未启动、executor 已启动但 started event 未落盘、completion 已发生但 settlement 未落盘，都只能通过事件和 reconciliation action 留痕，**不得默认重启**。

## 架构不变式

- **deterministic mechanism first, LLM escalation second**：默认先走机械 rebase/merge/验证/冲突检查；只有冲突、机械验证失败或 runner/结构错误才进入声明的升级矩阵。

- **single-agent first**：简单任务不过 DAG，不因“可编排”就默认编排。
- **reviewer 按需**：fresh reviewer 只在中高复杂度、计划路由或验证结果失败/不确定时进入门槛。
- **机制可关闭**：路由与 reviewer 都有明确的 auto/force 开关，为 S9 消融保留可复现对照。
- **完成不等于验收**：Gate 只决定路由与门槛，不执行验证，也不把 agent/执行器完成文字当作 accepted。

## 九态状态机与 Attempt

状态为：`PENDING`、`READY`、`RUNNING`、`VERIFYING`、`PASSED`、`FAILED`、`RETRYING`、`BLOCKED`、`CANCELLED`。

- `RUNNING -> VERIFYING` 必须带当前 `attemptId` 和非空 `outcome`；仅 acceptance-eligible settlement 进入 `VERIFYING`，non-eligible settlement 直接走 rejected/retry/failed。
- `VERIFYING -> PASSED` 必须带 `verdict: passed`；`verdict: rejected` 会按 `attempts < max(1, max_attempts)` 进入 `RETRYING`，否则进入 `FAILED`。
- `RUNNING -> RETRYING/FAILED` 只允许通过 S3 的 `timeout` 或 `executor_error` 事件：Scheduler 先取消并关闭执行器 handle（start 抛错时没有 handle），再由状态机把当前 attempt 记录为 `CANCELLED`。预算有余量时任务等待 backoff，耗尽或达到 start 失败上限时进入 `FAILED`。
- `RUNNING -> BLOCKED/CANCELLED` 会关闭当前 attempt 并记录相应结束状态；所有 attempt 结束（包括 `BLOCKED` / `CANCELLED`）都会计入总预算。`PASSED`、`FAILED`、`CANCELLED` 是终态。
- 所有状态变化都经过 `task-state.ts` 的合法转移表；Scheduler 不复制一份任务状态。

## 动态任务图

`TaskGraph` 是可变的内存图，但所有对外查询都是深度冻结快照。依赖边方向为 `from -> to`，含义是 `from` 必须先 `PASSED`，`to` 才能就绪。

S2 选择 **addTask 的严格前置语义**：契约中的每个 `depends_on` ID 必须已经在图中。`addDependency` 要求两端存在，写入前检测环并返回完整环路径。

`insertSubtask(parent, child, { reblockDependents })` 允许 parent 正在 `RUNNING` 时发现 child。child 不隐式依赖正在运行的 parent；它作为 parent 现有 dependents 的额外 gate。默认开启 `reblockDependents`，取消传播是**阻塞而非取消级联**：依赖者必须显式取消。

## Scheduler：唯一调度权威

`Scheduler` 只持有以下瞬态控制数据：在飞 `AttemptHandle`、retry deadline、启动时间/最近活动时间和 stuck 已报告标记。任务的 `state/attempts/blocker/reason` 唯一来自 `TaskGraph` 快照；Scheduler 的每个生命周期操作都调用图的合法 API。

公开操作是：

- `tick()`：读取注入的时间，推进到期 retry，按图的 `readySet()` 和 `concurrency` 启动任务，轮询在飞 handle，提交 settled、timeout 和 stuck 处理。完成、取消或外部图变更释放的并发槽位只在下一次显式 `tick()` 中补位，不隐式启动任务。
- `submitVerdict(taskId, verdict)`：只接受独立调用方提供的 `passed/rejected`，驱动 `VERIFYING` 后续合法转移；settled 不会自动变成 accepted。
- `cancelTask(taskId, reason)`：撤销在飞 handle 并关闭它，图中任务走合法取消路径；依赖者变 `BLOCKED`，不级联 `CANCELLED`。
- `drain(maxTicks)`：重复同步 tick 直到没有新事件；不会推进注入的时钟，也不会忙等外部执行器。

执行器采用**轮询**而非回调：一次 `tick` 能在同一个注入时间观察并排序所有结果，避免隐式全局事件队列，也适合未来把真实事件适配成显式 poll。`AttemptHandle.poll()` 返回 pending（可声明本次有 activity）或 settled；settled 后 Scheduler 关闭 handle。

### retry/backoff

`retry.max_attempts` 是总 attempt 上限，Scheduler 不绕过状态机预算。verdict rejected 且仍有预算时，图进入 `RETRYING`，Scheduler 计算：

```text
baseMs * 2^(attemptsRecorded - 1) + rng() * jitterMs
```

显式 backoff 必须提供正整数 `baseMs`（空对象和缺失 `baseMs` 拒绝）；`jitterMs` 缺省为 0，`maxMs` 缺省为不封顶。配置 `maxMs` 时截断，因此测试默认确定性。`clock()` 和 `rng()` 都从构造参数注入，核心不直接调用 `Date.now()`、`Math.random()` 或其他全局时间/随机源。显式 `options` 必须是 exact plain object；`options === undefined` 使用无延迟、单并发、`clock: () => 0` 的离线默认值，`null` 或未知字段拒绝。

### timeout/stuck/cancel 处置

- contract 有 `budget.timeout_ms` 时，attempt 启动后 **超过**该时长且仍 pending：执行器先收到 cancel 并 close；状态机记录 `CANCELLED/timeout`。有余量转 `RETRYING` 并按 backoff 重排，没有余量转 `FAILED`，不会永久悬挂。
- 配置 `stallTimeoutMs` 后，pending 且从启动/最近 activity 超过阈值会产生一次 `stuck` 事件。默认只报告，不自动 kill、不改变任务状态；timeout 仍是独立的硬边界。
- 执行器 start 连续失败默认最多 3 次，可由 `maxStartFailures` 参数化；达到上限直接 `FAILED`，每次失败都经过合法 `executor_error` 转移，不会留下 RUNNING 无 handle 的任务。
- poll 只接受 exact 的 pending 结果，或带 structured settlement 的 settled 结果：settlement 必须包含 `conclusion`、`acceptanceEligible` 和 host-observed `artifact`；非法 transport 产生 `executor_error`，取消并关闭 handle，再按 attempt 预算重试或失败。non-eligible settlement 不进入可接受的验证路径，而是 Scheduler 立即记录 rejected 并按预算 retry/failed。
- 取消在飞任务会产生 `attempt_cancelled` 和 `task_cancelled`；图负责依赖者的 `task_blocked`。

## 结构化事件流

事件是深度冻结纯数据，`events()` 返回累计快照；成功的 `tick/submitVerdict/cancelTask` 返回本次新增事件，失败返回结构化错误。当前事件类型包括：

- `task_started { at, taskId, attemptId }`
- `attempt_settled { at, taskId, attemptId, outcome, settlement }`、`acceptance_blocked { settlement }`
- `verdict_recorded { at, taskId, attemptId, verdict }`
- `task_passed`、`task_failed`、`task_ready`、`task_blocked`
- `retry_scheduled { reason: rejected | policy_rejected | timeout | executor_error, delayMs, dueAt }`
- `timeout { elapsedMs }`、`stuck { elapsedMs }`
- `attempt_cancelled`、`task_cancelled`
- `executor_error { code, phase, message, path, available }`、`scheduler_error { code, message, path, available }`

任务 ID 限制为不超过 64 个字符：这是事件键、attempt ID 组合和图错误路径的工程上界；因此 `taskId/attemptId` 标识符有界。错误消息回显经 `truncateForMessage` 有界；事件 payload 的 `outcome/reason` 也有界，超限直接拒绝而不截断；`issues`、`available` 保留完整数据，属设计选择。事件流是 S7 事件日志的输入形状，但 S3 不持久化它。错误还带 `code/message/path/available`，状态错误带 `from/to`，不把模型声明、终端输出或完成文字当作工作流状态。

## S3/S4 已实现 / 未实现边界

已实现：轮询式 `ExecutorPort` 与离线 `FakeExecutor`、READY 选择、并发上限、依赖门控、settle/verdict 驱动、参数化 retry/backoff、注入时间和 RNG、超时处置、只报告的 stuck 检测、取消在飞 attempt、重试耗尽和冻结结构化事件流。

明确未实现：

- 没有真实数据库/文件系统持久化 adapter，也没有跨进程锁；S7 只定义端口与 `InMemoryDurableStore` fake，CAS 语义由后续 adapter 实现。
- S7 不直接 hydrate `TaskGraph`，不启动/重启/取消/reattach executor；恢复只返回 projection 与冻结 action。
- P0 `src/host/` 已提供真实 Pi/herdr CLI、git/worktree 与 allowlisted verification transport；acceptance coordinator、Planner/DAG、reviewer 模型和 integration coordinator 尚未接线。
- S4 Gate 仍只做规则估计、路由建议和 reviewer 门槛；S5 不接真实模型，reviewer 只消费隔离 brief 并返回结构化契约。
- 不验证模型在线可用性、认证或 OS 级工具沙箱；Catalog capability 声明不是安全边界。

## S8 adapters + P0 real host seams

S8 的纯适配器位于 `src/adapters/`，不改变 S3 的 `ExecutorPort` 语义；P0 real host 位于 `src/host/`，只调用公开 CLI/系统 git，不 import pier 私有源码。真实 schema/lifecycle 约束包括 strict JSON envelope、generation cancellation、safe env allowlist 和 artifact workspace/branch provenance：

- `assembleScopedContext` 只复制 task identity/objective/acceptance criteria/files_in_scope/verification commands、S1 preflight 产生的 worker role/model、base/artifact revision 和有界 evidence/reference summaries。exact-fields 会拒绝 `workerTranscript`、`fullLog`、`secrets`、`env` 等字段；输出和 deterministic prompt 都有单字段、总量、160 UTF-16 摘要边界，并深度冻结。
- `validateChangedPaths` 把 `src/` 这样的 scope 作为目录、其他条目作为精确文件匹配；它不使用字符串前缀猜测，拒绝 absolute、`..`、NUL、反斜杠逃逸和 `.git`。
- `WorktreePort` 是唯一 worktree/git host seam：`create(...)`、`bindSession({ taskId, attemptId, sessionId, roleId, modelProfileId, filesInScope, baseRevision, workspacePath, branch, ownershipToken, managedMarker })`、`verifyOwnership(...)`、`inspectChangedPaths(...)`、`remove(...)`。`WorktreeManager` 只生成绝对 containment 内的确定性、碰撞安全路径和 branch，并把每 attempt 绑定到冻结 `WorkspaceLease`。P0 `GitWorktreePort` 使用 `git worktree add -b ...`, NUL diff/status、HEAD/commit-count，并在 workspace 控制目录维护 0600 atomic ownership ledger；remove 会重新验证、拒绝 dirty worktree 且不使用 `--force`。成功 terminal 的 lease 由 `PiHerdrExecutor.finalizeArtifact` 显式释放。
- `HerdrSubagentPort` 是版本隔离 seam：`spawn` 接收 `cwd=lease.workspacePath`、明确 role/model、S2 contract 和 scoped prompt/context；`poll` 稳定映射 `running | idle | settled | failed | cancelled | lost`；另有 `interrupt`/`close`。transport 的 credentials、环境和全局 transcript 不会进入 payload，宿主可在端口内部按 capability 处理。
- terminal poll 先由 worktree port 观察 changed paths、artifact revision 和 diffRef，再做 scope gate；worker 自报 revision 不参与权威判断。越界、worker/transport/inspect failure 都产出带稳定 failure code 的 non-eligible settlement，Scheduler 权威阻断 acceptance；只有 eligible settlement 才进入 `VERIFYING`。terminal poll 重复返回同一冻结结果。
- `serializeHandle`/`restoreHandle` 校验 version、attempt/session、role/model、完整 `filesInScope` 和 lease 字段，但只做结构 codec；start 写入完整 host binding，`reattach` 必须由 host ledger 验证实际 task/attempt/session/role/model/scope/revision/path/branch/token/marker 后才注册并轮询已有 session。cleanup/close 失败保留公开 `lastError` 与 lease 引用，后续 poll/close 或 `retryPendingCleanup` 可重试。

下一步 runner 可使用 `src/host/index.ts` 的 `createRealHost(...)`，再按 README 的 `wireS8(catalog, graph, host)` 形状把真实 ports 接到既有 Scheduler；coordinator 应按 artifact workspace 创建 verifier。catalog 仍通过既有 `planDispatch` 做 role/model fail-closed 校验。P0 host 可启动进程/pane/worktree，但本仓库尚未提供完整 Planner/DAG。

S7 的 durable adapter（真实数据库/文件系统、跨进程 CAS）仍未实现；P0 host ledger 只负责 worktree ownership，不替代 S7 durable store；S8 的 handle codec 只是恢复边界数据。

## 后续路线

1. **Planner/DAG runner**：把 P0 real host ports 接入任务规划、Scheduler 和验收编排。
2. **真实 reviewer 适配**：在保留 brief 隔离与 revision 绑定的前提下接入模型调用。
3. **Durable adapter**：实现真实数据库/文件系统 durable event adapter，保留 S7 日志权威语义。
3. **Durable adapter**：实现真实数据库/文件系统 adapter，保留 S7 日志权威和 recovery 不盲目重启规则。
