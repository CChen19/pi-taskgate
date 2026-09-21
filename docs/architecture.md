# 架构（S2：Task Contract 与动态任务图纯核）

## 控制面 / 执行面分离

- **控制面（已实现）**：`Catalog`、`planDispatch`、Task Contract 校验、九态状态机与 `TaskGraph`。它们都是内存纯核，无 I/O、网络、进程、worktree 或终端副作用。
- **执行面（未实现）**：未来的 ExecutorPort 负责创建进程/worktree/pane 并施加运行时强制。角色工具声明只是策略数据，**不是**沙箱；真正的权限执行必须在执行面另行实现并测试。

## Task Contract

`validateTaskContract(input: unknown)` 是任务进入图之前的唯一形状校验入口：

- exact-fields、稳定 ID、非空目标、字符串数组、重复/自引用依赖、验收标准、预算和重试参数都 fail closed；问题聚合为 `INVALID_CONTRACT`，包含 `code/message/path/issues`。
- `depends_on` 在契约层只校验形状，不要求引用已存在；引用存在性由图层检查。
- 成功结果是深度冻结副本；数组会复制，调用方输入不会被修改或冻结。
- `verification` 只作为命令字符串存储，本阶段绝不执行。它可以为空，表示没有机械验证，仍须后续 Gate/裁决逻辑决定是否接受。

## 动态任务图

`TaskGraph` 是可变的内存图，但所有对外查询都是深度冻结快照。依赖边方向为 `from -> to`，含义是 `from` 必须先 `PASSED`，`to` 才能就绪。

### 依赖声明决策

S2 选择 **addTask 的严格前置语义**：契约中的每个 `depends_on` ID 必须已经在图中；不支持同批前置声明。这样可以在每次变更点确定图的完整引用集合，并让未知依赖 fail closed。需要批量构图的调用方按依赖拓扑顺序调用 `addTask`。

`addDependency` 要求两端存在，在写入前检测环并返回完整环路径，例如 `Ta -> Tb -> Ta`。任务进入图后，无依赖任务自动变为 `READY`；依赖全部 `PASSED` 后才由状态机转为 `READY`。

### 动态插入决策

`insertSubtask(parent, child, { reblockDependents })` 允许 parent 正在 `RUNNING` 时发现 child。child 不隐式依赖正在运行的 parent；它作为 parent 现有 dependents 的额外 gate。开启 `reblockDependents`（默认值）时，现有依赖者转为 `BLOCKED`，`blocker` 记录 child ID。依赖者只有在 parent 和所有已发现子任务均 `PASSED` 后才能回到 `READY`。这表达了“动态任务图是状态”，而不是把发现结果追加到一次性计划文本中。

取消传播是**阻塞而非取消级联**：`cancelTask(id)` 将依赖该任务的后代转为 `BLOCKED` 并记录 blocker，但不会替它们转为 `CANCELLED`。后代是否取消必须由调用方显式决定。

## 九态状态机与 Attempt

状态为：`PENDING`、`READY`、`RUNNING`、`VERIFYING`、`PASSED`、`FAILED`、`RETRYING`、`BLOCKED`、`CANCELLED`。

- `RUNNING -> VERIFYING` 必须带当前 `attemptId` 和非空字符串 `outcome`（S5 将定义更丰富的证据结构）。
- `VERIFYING -> PASSED` 必须带 `verdict: passed`；`verdict: rejected` 会按 `attempts < max(1, max_attempts)` 进入 `RETRYING`，否则进入终态 `FAILED`。`max_attempts` 的语义是总 attempt 上限；`0` 等价于 `max(1, 0)`，仍允许仅一次首次 attempt，但不允许重试。
- `TaskAttempt.status = SETTLED` 仅表示执行结果已提交，随后仍需验证裁决；从 `RUNNING` 进入 `BLOCKED` / `CANCELLED` 时，当前 attempt 会记录对应结束状态与 outcome，且这些结束状态同样计入总预算。预算耗尽时 `BLOCKED -> READY` 会直接转为带结构化原因的 `FAILED`，不会产生第三次 attempt；因此 **settled ≠ accepted**，且不会同时存在两个活动 attempt。
- 所有状态变化都经过 `task-state.ts` 的合法转移表；图层不旁路修改状态。`PASSED`、`FAILED`、`CANCELLED` 是终态。

## 三条不变式

1. **任务图是动态状态，而非一次性计划。** 执行中可以插入子任务，插入会更新 gate、阻塞状态和可就绪集合。
2. **settled ≠ accepted。** 执行结果只把任务带到 `VERIFYING`；只有独立验证裁决才会产生 `PASSED`。
3. **调度状态单一权威且转移由代码判定。** 模型声明、终端输出和“完成”文字都不是状态；唯一有效状态来自 `task-state.ts` 及其被 `TaskGraph` 调用的合法转移。

## S2 已实现 / 未实现边界

已实现：契约运行时校验、聚合结构化错误、深度冻结快照、九态状态机、Attempt 记录、依赖/环检测、ready/blocked 查询、动态子任务 gate、重试耗尽和取消阻塞传播。

明确未实现：

- 无 Scheduler、ExecutorPort、并发控制、时间/超时策略（后续 S3）。S2 不创建进程、不调用 shell，不接 Pi/herdr。
- 无持久化或事件日志（后续 S7）；图只存在于当前内存实例。
- 无验证器本体或 Gate 证据绑定（后续 S5）；`verification` 不执行，状态推进由调用方提交结构化事件。
- 不验证模型在线可用性、认证或 OS 级工具沙箱；Catalog 的 capability 声明不是安全边界。

## 后续路线

1. **ExecutorPort**：定义执行面接口与离线 fake，不做 production executor。
2. **Scheduler（S3）**：在状态机之上增加排队、并发、超时策略。
3. **验证与证据（S5）**：将 verdict 绑定到具体 artifact revision。
4. **事件日志（S7）**：持久化任务图和状态转移的审计记录。
