# agent-orchestrator

面向 Pi / herdr 的独立 orchestration 核心。当前处于**第四阶段（S4）：Orchestration Gate 纯核**，不含任何真实进程、worktree、终端、持久化或网络副作用。

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
- `ExecutorPort` + `FakeExecutor`：执行器是轮询接口；S3 只提供按脚本返回结果、记录 start/cancel/close 的内存 fake，不创建真实执行资源。
- `Scheduler`：唯一调度权威；按并发上限选择 READY 任务，驱动 start/settle/verdict，支持注入时钟与 RNG 的 backoff、超时、一次性 stuck 报告、取消和冻结结构化事件流。每次 tick 对账外部图变更，撤销已非 RUNNING 的 handle；执行器协议错误和连续 start 失败均结构化处置。任务状态只由 `TaskGraph`/状态机持有。
- `planRoute` / `needsFreshReview`：S4 规则版 Orchestration Gate，运行时复用 S2 校验 Task Contract，并按范围文件、验收标准、验证命令、契约体量和依赖数确定 single/plan 路由；输出命中信号、理由、Scheduler 建议和 reviewer 门槛；不调用模型、不执行验证、不创建 DAG。
- 任务 ID 最长 64 个字符，用于约束图键、错误路径和事件中的 task/attempt 标识；`outcome/reason` 等事件 payload 不截断。

## 明确未实现

- 不接 Pi / herdr，不创建进程、pane 或 worktree；`FakeExecutor` 不是生产执行器。
- 无任务持久化或 S7 事件日志；Scheduler 的事件目前只在内存中提供给调用方。
- 无 S5 验证器：执行器 settled 只进入 `VERIFYING`，调用方仍须显式提交 verdict；S4 Gate 只规划 mechanical verification 与 fresh reviewer 门槛，不运行命令或产生证据，settled 不等于 accepted。
- 不验证模型在线可用性或认证；不执行任何 OS 级权限/沙箱强制；不接 Pi / herdr。
- 无证据绑定 artifact revision 的安全验收实现。

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
src/core/task-graph.ts      # 动态任务图纯核
src/core/executor-port.ts   # ExecutorPort、轮询 AttemptHandle 与 FakeExecutor
src/core/scheduler.ts       # 注入时钟/RNG 的纯核调度器与事件流
src/core/gate.ts            # S4 复杂度路由、reviewer 门槛与消融开关
tests/                    # node:test + assert，全部离线，无真实模型/Agent
```

## S4 可运行短用例

在项目根目录逐字运行以下命令即可；示例自备合法 Task Contract，不依赖未定义的部署配置：

```sh
node --input-type=module <<'EOF'
import { needsFreshReview, planRoute } from './src/core/gate.ts';

const taskContract = {
  id: 'Treadme-gate-example',
  objective: 'Add a short S4 explanation to the README',
  depends_on: [],
  files_in_scope: ['README.md'],
  acceptance_criteria: ['The README explains the route and reviewer decision'],
  verification: ['npm run check'],
};

const routePlan = planRoute(taskContract); // 只接受经 S2 校验的契约；不执行命令
const reviewer = needsFreshReview(routePlan, { status: 'passed' });
console.log({ mode: routePlan.mode, complexity: routePlan.complexity, reviewer });
EOF
```

S4 的架构不变式是 **single-agent first**：小任务默认 `single`，不因形式完整就创建 DAG；mechanical verification 的规划永远保留。`reviewer` 只在 `plan` / `complex` 或验证失败、不确定时启用，且可用 `reviewer: 'always' | 'never'` 做消融。`mode: 'auto' | 'force-single' | 'force-plan'` 可绕过路由估计，结果仍记录 `forced`、估计复杂度、信号 `reasons` 与路由 `decisionReasons`。Gate 输出的 `maxConcurrency` 与 `expectedTaskCount` 是供 S3 Scheduler / 后续 S5 消费的建议，不会改变 S3 行为。

模型 profile / 账号属于部署数据，不入库、不入测试（测试仅用 fixture 字符串）。

S3 的 backoff 公式为 `baseMs * 2^(attemptsRecorded - 1) + rng() * jitterMs`；显式 backoff 必须提供正整数 `baseMs`，`jitterMs` 缺省为 0，`maxMs` 缺省为不封顶，配置 `maxMs` 时截断。`maxStartFailures` 默认 3 次，达到上限转 `FAILED`。显式 options 必须是 exact plain object；options 为 `undefined` 时使用离线默认值（单并发、`clock: () => 0`、无延迟），`null` 和未知字段拒绝。时间始终来自注入的 `clock()`，不会直接调用 `Date.now()` 或 `Math.random()`；错误消息回显经 `truncateForMessage` 有界，issues/available/事件 payload 保留完整数据。
