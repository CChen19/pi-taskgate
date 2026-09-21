# agent-orchestrator

面向 Pi / herdr 的独立 orchestration 核心。当前处于**第二阶段（S2）：纯核心注册表、派发前校验、Task Contract 与动态任务图**，不含任何进程、worktree、终端、持久化或网络副作用。

## 目标

- 统一任务入口：任何派发（herdr / subagent / terminal 等）都必须先经过同一个 preflight 校验，不能绕过生命周期。
- 角色真实存在：模型编造的角色（幻觉）在派发前即被拒绝，且 coordinator 不能被当作 worker 派发。
- 任务级模型路由：角色默认 profile + 任务级显式 override，override 必须在角色允许列表内；provider / model / profile 三者分离，模型 ID 保留完整斜杠（如 `nex-agi/nex-n2.5-pro:free`），不做错误切分。
- 失败即关闭（fail closed）：未知字段（如 `allowed_tools`、`command`）与空字符串一律拒绝；`depends_on` 引用存在性由图层 `addTask` 拒绝，契约层只校验其形状，不静默降级。
- 主 Agent 只做规划与审查：coordinator 仅声明编排/证据工具，代码由 worker 角色实现。

## 当前已实现

- `Catalog`：角色（RoleDefinition）、模型 profile（ModelProfile）、模型路由（ModelRoute）的内存注册表；构造时全量校验（重复/空 ID、未知引用、default 不在 allowlist、worker 缺路由），无效配置在启动时即抛 `CatalogConfigError` 拒绝。
- `planDispatch(catalog, request: unknown)`：对 unknown 输入做严格运行时验证（只接受 4 个已知字段、非空字符串），区分未知角色 / coordinator 派发 / 未知 profile / 不允许的 profile，返回冻结的只读派发计划与 `routingReason`。
- 默认角色定义：`coordinator`、`explorer`、`implementer`、`reviewer`（工具仅为声明性策略数据，不是沙箱）。
- 纯核心、无 I/O；配置、计划、契约、状态与任务图快照均为深度冻结视图，防外部突变。
- `validateTaskContract`：对 `unknown` Task Contract 做 exact-fields、格式、依赖形状、预算与重试校验；`depends_on` 引用存在性在图层拒绝（契约层只查形状）；错误聚合为 `INVALID_CONTRACT`，成功返回深度冻结副本。
- `task-state`：九态状态机与合法转移表；`max_attempts` 是总 attempt 上限，`0` 表示仅首次；任意 attempt 结束（包括 `BLOCKED` / `CANCELLED`）都会计入预算，执行结果先进入 `VERIFYING`，验证裁决才决定 `PASSED` / `RETRYING` / `FAILED`。
- `TaskGraph`：内存纯核，支持严格前置依赖、环检测、ready/blocked 查询、动态子任务插入、重试与取消阻塞传播。

## 明确未实现

- 不接 Pi / herdr，不创建进程、pane 或 worktree。
- 无 ExecutorPort、Scheduler、任务持久化、并发、时间/超时策略；S2 的状态推进必须由调用方提交结构化事件。
- `verification` 只存契约中的命令字符串，本阶段不执行命令，也没有 S5 验证器/Gate 本体；Agent settled 仍不等于 accepted。
- 不验证模型在线可用性或认证；不执行任何 OS 级权限/沙箱强制；不接 Pi / herdr。
- 无事件日志（S7），无证据绑定 artifact revision 的安全验收实现。

## 安装与检查

```bash
npm install --ignore-scripts
npm run check   # typecheck + node:test
```

## 结构

```
src/core/contracts.ts   # 全部类型契约（角色、模型、路由、计划、错误码）
src/core/validate.ts    # 共享运行时验证小工具
src/core/catalog.ts     # createCatalog：配置校验 + 冻结注册表
src/core/defaults.ts    # 默认角色定义（coordinator + 三种 worker）
src/core/preflight.ts      # planDispatch：派发前校验，产出 DispatchPlan
src/core/task-contract.ts  # Task Contract 运行时校验与冻结快照
src/core/task-state.ts    # 九态任务状态机与 Attempt 记录
src/core/task-graph.ts    # 动态任务图纯核
tests/                    # node:test + assert，全部离线，无真实模型/Agent
```

## 短用例

```ts
import { createCatalog } from './src/core/catalog.ts';
import { planDispatch } from './src/core/preflight.ts';

const catalog = createCatalog(configFromDeployment); // 无效配置在此直接抛错
const result = planDispatch(catalog, {
  description: 'Add a README section',
  instructions: 'Write the section under docs/.',
  roleId: 'implementer',
  // modelProfileId: 'profile-fast', // 可选任务级 override
});
if (result.ok) {
  result.plan.model;        // 实际使用的 profile（含完整斜杠模型 ID）
  result.plan.routingReason; // 'role-default' | 'task-override'
} else {
  result.error.code;        // 如 'UNKNOWN_ROLE' / 'MODEL_PROFILE_NOT_ALLOWED'
  result.error.available;   // 相关可选 ID，便于恢复
}
```

模型 profile / 账号属于部署数据，不入库、不入测试（测试仅用 fixture 字符串）。
