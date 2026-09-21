# 架构（第一阶段：纯核心）

## 控制面 / 执行面分离

- **控制面（当前已实现）**：`Catalog` + `planDispatch`。纯内存、纯函数、无 I/O。所有派发意图在此统一校验：角色真实性、委派资格、模型路由、请求形状。
- **执行面（未实现）**：未来的 ExecutorPort 适配器负责创建进程/worktree/pane 并施加运行时强制。控制面的工具声明只是策略数据，**不是**沙箱；真正的权限执行必须在执行面另行实现并测试。

## 任务统一入口

herdr、subagent、terminal 等多入口的历史痛点是绕过生命周期。本核心要求所有派发请求（unknown 输入）都经过 `planDispatch` 这一个入口做 preflight，产出唯一可审计的 `DispatchPlan`。任何执行面实现都应只接受已生成的计划，而不是再次自行解释原始请求。

## Role 与 ModelProfile 分离

- 角色描述"做什么、声明哪些工具"；模型 profile 描述"用哪个 provider 的哪个模型"（`id` / `provider` / `model` 三字段分离）。
- 模型 ID 是不透明字符串，保留完整斜杠与冒号（如 `nex-agi/nex-n2.5-pro:free`），绝不按 `/` 或 `:` 切分。
- 路由（ModelRoute）按角色声明 default 与 allowedProfiles；任务级 override 必须在 allowedProfiles 内。未知 profile 与不允许的 profile 返回不同的结构化错误码。
- 本核心不验证在线可用性或认证，也不缓存任何凭据。

## Agent settled ≠ accepted

子 Agent 报告完成（settled）不等于任务被接受。未来的安全验收要求：证据绑定到具体 artifact 修订（如 commit / 文件哈希），由 reviewer 角色或外部验收逻辑判定。当前阶段没有任何验收实现，也不要把模型或终端输出当作权威工作流状态。

## 后续路线（按依赖排序）

1. **ExecutorPort**：执行面接口（如 `start(plan, workspace)` / `collectEvidence()`），先定义接口与 fake 实现供测试，不做假 production executor。
2. **Scheduler**：基于 Catalog 与 ExecutorPort 的任务排队、并发与超时策略。
3. **持久化**：任务/计划/证据的存储与审计记录。
4. **安全验收**：证据绑定 artifact 修订、reviewer 流程、接受/拒绝判定。
5. **运行时强制**：工具声明 → 执行面权限检查、workspace 隔离（与声明解耦，独立测试）。
