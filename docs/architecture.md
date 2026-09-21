# 架构（S3：Scheduler 内核纯核）

## 控制面 / 执行面分离

- **控制面（已实现）**：`Catalog`、`planDispatch`、Task Contract 校验、九态状态机、`TaskGraph` 与 `Scheduler`。它们都是内存纯核，无 I/O、网络、进程、worktree 或终端副作用。
- **执行面（S3 仅接口）**：`ExecutorPort` 是执行器边界，`FakeExecutor` 是离线测试 fake。它们不创建真实资源；Pi/herdr/进程适配器仍是后续切片。
- 角色的 tools/capabilities 仍只是策略数据，**不是**沙箱；真正的运行时权限强制必须在执行面另行实现和测试。

## Task Contract

`validateTaskContract(input: unknown)` 是任务进入图之前的唯一形状校验入口：

- exact-fields、稳定 ID、非空目标、字符串数组、重复/自引用依赖、验收标准、预算和重试参数都 fail closed；问题聚合为 `INVALID_CONTRACT`，包含 `code/message/path/issues`。
- `depends_on` 在契约层只校验形状，不要求引用已存在；引用存在性由图层检查。
- 成功结果是深度冻结副本；数组会复制，调用方输入不会被修改或冻结。
- `verification` 只作为命令字符串存储，本阶段绝不执行。它可以为空，表示没有机械验证，仍须后续 Gate/裁决逻辑决定是否接受。

## 九态状态机与 Attempt

状态为：`PENDING`、`READY`、`RUNNING`、`VERIFYING`、`PASSED`、`FAILED`、`RETRYING`、`BLOCKED`、`CANCELLED`。

- `RUNNING -> VERIFYING` 必须带当前 `attemptId` 和非空 `outcome`；执行结果只表示 settled。
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
- poll 只接受 exact 的 `{ status: 'pending', activity?: boolean }` 或 `{ status: 'settled', outcome: non-empty string }`；非法 status/outcome 产生 `executor_error`，取消并关闭 handle，再按 attempt 预算重试或失败。
- 取消在飞任务会产生 `attempt_cancelled` 和 `task_cancelled`；图负责依赖者的 `task_blocked`。

## 结构化事件流

事件是深度冻结纯数据，`events()` 返回累计快照；成功的 `tick/submitVerdict/cancelTask` 返回本次新增事件，失败返回结构化错误。当前事件类型包括：

- `task_started { at, taskId, attemptId }`
- `attempt_settled { at, taskId, attemptId, outcome }`
- `verdict_recorded { at, taskId, attemptId, verdict }`
- `task_passed`、`task_failed`、`task_ready`、`task_blocked`
- `retry_scheduled { reason, delayMs, dueAt }`
- `timeout { elapsedMs }`、`stuck { elapsedMs }`
- `attempt_cancelled`、`task_cancelled`
- `executor_error { code, phase, message, path, available }`、`scheduler_error { code, message, path, available }`

任务 ID 限制为不超过 64 个字符：这是事件键、attempt ID 组合和图错误路径的工程上界；因此 `taskId/attemptId` 标识符有界。错误消息回显经 `truncateForMessage` 有界；`issues`、`available`、事件 payload（包括完整的 `outcome/reason`）保留完整数据，属设计选择。事件流是 S7 事件日志的输入形状，但 S3 不持久化它。错误还带 `code/message/path/available`，状态错误带 `from/to`，不把模型声明、终端输出或完成文字当作工作流状态。

## S3 已实现 / 未实现边界

已实现：轮询式 `ExecutorPort` 与离线 `FakeExecutor`、READY 选择、并发上限、依赖门控、settle/verdict 驱动、参数化 retry/backoff、注入时间和 RNG、超时处置、只报告的 stuck 检测、取消在飞 attempt、重试耗尽和冻结结构化事件流。

明确未实现：

- 无持久化、恢复、跨进程并发协调或 S7 事件日志。
- 无真实 Executor；不接 Pi/herdr，不创建进程、pane、worktree、终端或网络连接。
- 无 S5 验证器/Gate，也没有 artifact revision 证据绑定；verdict 仍由调用方提交。
- 不验证模型在线可用性、认证或 OS 级工具沙箱；Catalog capability 声明不是安全边界。

## 后续路线

1. **验证与证据（S5）**：将 verdict 绑定到具体 artifact revision，并实现 Gate。
2. **事件日志（S7）**：持久化 Scheduler 事件和任务图快照，支持恢复与审计。
3. **Pi/herdr 适配（S8）**：在不污染纯核的前提下实现真实 ExecutorPort、进程和工作区策略。
