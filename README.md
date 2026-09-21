# agent-orchestrator

面向 Pi / herdr 的独立 orchestration 核心。当前包含 S8 纯核，以及 P0 real host adapters：公开 `herdr` CLI、系统 `git worktree`、进程验证 runner 和可组合 host factory。测试仍全部离线；本仓库不声称已经跑通完整 vertical slice。

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
- `task-state`：九态状态机与合法转移表；`max_attempts` 是总 attempt 上限，`0` 表示仅首次；任意 attempt 结束（包括 `BLOCKED` / `CANCELLED`）都会计入预算，eligible 执行结果进入 `VERIFYING`，而 non-eligible settlement 由 Scheduler 直接走 rejected/retry/failed。
- `TaskGraph`：内存纯核，支持严格前置依赖、环检测、ready/blocked 查询、动态子任务插入、重试与取消阻塞传播。
- `ExecutorPort` + `FakeExecutor`：执行器是轮询接口；S3 只提供按脚本返回结果、记录 start/cancel/close 的内存 fake，不创建真实执行资源。
- `Scheduler`：唯一调度权威；按并发上限选择 READY 任务，驱动 start/settle/verdict，支持注入时钟与 RNG 的 backoff、超时、一次性 stuck 报告、取消和冻结结构化事件流。每次 tick 对账外部图变更，撤销已非 RUNNING 的 handle；执行器协议错误和连续 start 失败均结构化处置。任务状态只由 `TaskGraph`/状态机持有。
- `planRoute` / `needsFreshReview`：S4 规则版 Orchestration Gate，运行时复用 S2 校验 Task Contract，并按范围文件、验收标准、验证命令、契约体量和依赖数确定 single/plan 路由；输出命中信号、理由、Scheduler 建议和 reviewer 门槛；不调用模型、不执行验证、不创建 DAG。
- `MechanicalVerifier` / `decideVerdict`：S5 机械验证纯核；只调用注入的 `runner` 和 `clock`，记录有界输出证据，所有 verdict 绑定 `artifactRevision`，不创建进程。
- `assembleReviewerBrief` / `validateReviewVerdict` / `decideFinalVerdict`：S5 fresh-context reviewer 契约；brief 只包含 spec、revision-bound diff 引用和 evidence 摘要，不包含 worker 转录或完整日志；不接真实模型。
- `planIntegration` / `runIntegration` / `decideEscalation`：S6 确定性机械集成；按拓扑/给定顺序执行注入式 rebase、merge、验证和冲突检查，失败止步并产出冻结报告；冲突只组装 Integration Agent brief，不调用模型。
- `durable-state` / `recovery`：S7 append-only 事件 envelope、schema 校验、事件日志与快照端口、CAS/原子 batch、幂等 replay、带完整性标记的 projection snapshot，以及不启动 executor 的崩溃恢复对账规划。`InMemoryDurableStore` 仅为测试 fake；日志权威，快照只是缓存。
- `adapters/scoped-context`：每次 worker 只收到 task objective、验收、scope、验证命令、已验证角色/模型、revision 和有界摘要；主会话转录、其他 worker 上下文、凭据、环境和全量日志被 exact-fields 拒绝。
- `adapters/worktree-manager`：每 attempt 通过 `WorktreePort` 申请唯一、受 containment 约束的 lease；恢复必须调用 host `verifyOwnership`，marker/token/base revision 不匹配时不会注册或 cleanup。
- `adapters/pi-herdr-executor`：实现现有 `ExecutorPort`，通过注入的 `HerdrSubagentPort`、`WorktreePort`、dispatch resolver 和 clock 适配 spawn/poll/interrupt/close；settlement 携带 host-observed artifact provenance，不信任 worker 自报 revision，失败 settlement 永不具 acceptance eligibility。
- 任务 ID 最长 64 个字符，用于约束图键、错误路径和事件中的 task/attempt 标识；`artifactRevision`、分支和 base revision 与 S5 一致限制为 256 字符；`outcome/reason` 等有界字段超限直接拒绝，不截断。

## S8 适配边界与 P0 real host

`src/host/` 是真实宿主边界，不 import pier 私有源码：`HerdrCliPort` 只调用公开 `herdr` CLI，`GitWorktreePort` 使用系统 git，`ProcessVerificationRunner` 只执行预先 allowlist 的验证命令。`PiHerdrExecutor` 的成功 terminal artifact 会保留 worktree，直到显式 `finalizeArtifact(taskId, attemptId)`；验证、reviewer、integration 完成后由主控调用该 API。失败、取消、越界或 dirty/no-commit artifact 不具 acceptance eligibility，可按 cleanup policy 清理。

`HerdrCliPort` 的启动命令序列是 `herdr tab create --workspace ... --cwd ... --label ... --env ...`，随后异步 `herdr agent start ... -- -a -e <pier-ext> --provider ... --model ... --tui-mode fullscreen` 与 `herdr agent prompt <pane> <prompt> --wait ...`。CLI stdout 按单一 JSON envelope 严格解析：tab 使用 `result.root_pane.pane_id`，pane list 使用 `result.panes`（始终带 workspace），agent get 使用 `result.agent.agent_status`/`agent_session.value`。poll 只做缓存和快速探测；interrupt 使用公开 `agent send-keys <pane> ctrl+c`，close 只关闭 owned pane，不关闭共享 tab。request 中已验证的 provider/model 优先于 config fallback。

这仍不是完整 Planner/DAG、reviewer 模型接线或 integration coordinator；这些是下一项工作。

`WorktreePort` 同样是 host seam：`create(...)`、`bindSession({ taskId, attemptId, sessionId, roleId, modelProfileId, filesInScope, baseRevision, workspacePath, branch, ownershipToken, managedMarker })`、`verifyOwnership(...)`、`inspectChangedPaths(...)`、`remove(...)`。host 必须保存 binding ledger 并返回权威完整 binding；codec 自身不提供认证。fake 可直接返回 marker、changed paths、observed artifact revision 和 diff reference；P0 real host 由 `src/host/git-worktree-port.ts` 提供。连接示例：

```ts
function wireS8(
  catalog: Catalog,
  graph: TaskGraph,
  host: {
    repoRoot: string;
    workspaceRoot: string;
    idSource: () => string;
    clock: () => number;
    herdr: HerdrSubagentPort;
    worktree: WorktreePort;
  },
) {
  const manager = new WorktreeManager({ repoRoot: host.repoRoot, workspaceRoot: host.workspaceRoot, idSource: host.idSource });
  const executor = new PiHerdrExecutor({
    herdr: host.herdr,
    workspace: manager,
    worktreePort: host.worktree,
    dispatchResolver: (request) => planDispatch(catalog, request),
    roleId: 'implementer', modelProfileId: 'profile-fast',
    baseRevision: 'base-revision', clock: host.clock,
  });
  return new Scheduler(graph, executor, { concurrency: 1, clock: host.clock });
}
```

这里的 `host` 是宿主提供的端口集合；本示例函数本身不创建资源。P0 的真实端口可由 `createRealHost(...)` 构造，完整 runner 尚未接线。

以上变量表示宿主接线时提供的端口、catalog、graph 和注入时钟；示例不执行任何操作。

S8 不变式：scope 目录用 `src/` 形式表达，scope gate 按完整路径段匹配，拒绝任意 ASCII 大小写的 `.git`、absolute、`..`、反斜杠和 NUL；repo/workspace root 在构造阶段也拒绝 `.git` segment；每 attempt 独立 lease，cleanup 失败保留 lease 并可通过 `retryPendingCleanup` 重试；worker 的 artifact revision 永远不具权威性，必须由 adapter 观察；越界、worker failed/cancelled、session lost、malformed transport 和 inspect failure 都是 non-eligible settlement；恢复 codec 只做结构校验，start 先写入完整 host binding，reattach 再由 host 完整比对 task/attempt/session/role/model/scope/revision/path/token/marker，不 spawn、不 inspect、不 remove。S7 的 durable adapter 真实数据库/文件系统仍未实现。

- 完整 Planner/DAG、真实 reviewer 模型和 integration coordinator 尚未接线；`FakeExecutor` 仅用于离线测试。
- S7 不直接 hydrate `TaskGraph` 实例，也不启动、重启、cancel 或 reattach executor；它只恢复 canonical projection 并输出确定性 reconciliation actions。
- 没有真实数据库或文件系统 adapter；S7 只提供同步端口和 `InMemoryDurableStore` fake。Scheduler/S5/S6 的事件需要由适配层转换为受控 durable envelope 后写入日志。
- P0 host adapters 已实现真实 command/herdr/git/process 边界，但测试全部使用 fake；完整 acceptance coordinator、Planner、reviewer 和 integration vertical slice 是下一任务。
- 不验证模型在线可用性或认证；不执行任何 OS 级权限/沙箱强制；P0 host transport 只使用公开 CLI 与显式 runtime config。

## P0 host 命令

前置条件：Node 24、`herdr`（已配置 workspace）、`pi`、`git`，以及可解析的 pier extension 路径。命令不会在测试中执行，也不会打印凭据。

```bash
npm run host:doctor
node src/host/cli.ts git-smoke --repo /path/to/repo --workspace-root /path/to/workspaces --base HEAD
```

`git-smoke` 会真实创建、inspect 并清理一个 git worktree；workspace root 必须是专用目录，`--base` 必须是 repo 中可解析的 revision。要接线下一步 runner，可从 `src/host/index.ts` 导入 `createRealHost(...)`，并显式提供 `herdrBinary`、`piExtension`、provider/model、workspaceId、role manifests/bases、timeouts 与验证 allowlist。coordinator 应使用 `createVerificationRunner(artifact.workspacePath, commands)`，不要在 repo root 复用 verifier。同步验证 timeout 是 Node spawnSync 的 best-effort 限制；异步 command 才提供 POSIX process-group grace/kill。

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
src/core/verification.ts   # S5 注入 runner 的机械验证、证据与 verdict
src/core/reviewer-brief.ts # S5 fresh-context brief、review verdict 与最终合并
src/core/integration.ts   # S6 rebase/merge/验证/冲突检查纯核与升级 brief
src/core/durable-state.ts # S7 事件 envelope、CAS store/snapshot port、replay/projection
src/core/recovery.ts      # S7 纯函数崩溃恢复对账与审计 action
src/adapters/scoped-context.ts      # S8 bounded fresh worker context 与 diff scope gate
src/adapters/worktree-manager.ts     # S8 injectable WorktreePort 与 per-attempt lease
src/adapters/pi-herdr-executor.ts    # S8 injectable HerdrSubagentPort ExecutorPort adapter
src/host/command-runner.ts           # injectable sync/async child-process seam
src/host/herdr-cli-port.ts           # public herdr CLI transport
src/host/git-worktree-port.ts        # git worktree + ownership ledger
src/host/process-verification-runner.ts # allowlisted bash -lc verification
src/host/index.ts                    # createRealHost factory
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

S4 的架构不变式是 **single-agent first**：小任务默认 `single`，不因形式完整就创建 DAG；mechanical verification 的规划永远保留。

## S7 Durable State 边界

S7 把控制面状态拆成 **append-only event log → canonical projection → optional snapshot cache**。`DurableEvent` 固定 `schemaVersion=1`、`runId`、从 1 连续递增的 `sequence`、`eventId`、`idempotencyKey`、注入时钟产生的 `occurredAt`、受控 `kind/payload`；未知版本、gap/out-of-order、Symbol/非枚举字段、稀疏/方法篡改数组、超长标识和完整 transcript/log 都 fail closed。Scheduler、TaskGraph 生命周期、S5 evidence/verdict 与 S6 integration 只保存有界摘要和 reference，不保存完整日志。

`EventStorePort.append(runId, expectedSequence, events)` 是 CAS 且原子 all-or-nothing；并发 writer 的旧 sequence 返回结构化 conflict。幂等只接受完整 envelope（包括相同 `sequence`）的 event identity 重放；同 identity 的其他 sequence 或内容、以及空 batch 的 stale CAS 都拒绝。`SnapshotStorePort.saveSnapshot` 同时比较 sequence/schema version，snapshot 带 projection integrity marker（非密码学签名，只用于检测普通篡改）；恢复永远 replay `lastSequence + 1` 的 tail，不能让 snapshot 覆盖日志权威。canonical projection 严格校验 contract/task、合法 S2 from/current/to、attempt start/settle 唯一性、evidence/verdict 的 task/attempt/artifactRevision 绑定以及 PASSED verdict 前置条件；scheduler/recovery 事件仅作审计，不绕过这些 helper。projection 含任务 contract/state/attempt、依赖、证据/裁决/集成的有界引用；它是恢复计划数据，不是假装已经恢复了 S2 `TaskGraph` 实例。replay 使用 accumulator + Map/Set，snapshot 与 tail 合计最多 100,000 个事件。

`planRecovery` / `reconcileRecovery` 只比较持久化 attempt 与 observed executor state：RUNNING + running → `reattach`，+ terminal → `settle`，+ missing → 默认 `mark-lost`（也可只记录 `retry-scheduler`，最终由 S3 budget 决定），terminal + running → `cancel-stale`，无对应日志的 observed → `cancel-orphan`。start-intent 已落盘但未启动、已启动但 started event 丢失、completion 已发生但 settlement 丢失，都通过事件/对账动作留痕；默认绝不盲目重启。真实 DB/fs/executor adapter 属于 S8。

## S6 机械集成边界

S6 的架构不变式是 **deterministic mechanism first, LLM escalation second**：默认路径只执行纯核可描述的 rebase → merge → final verification → conflict/status check。`IntegrationRunner` 的 `gitOps` 与 `commandRunner` 全部由调用方注入；本项目不启动真 git/命令，不创建 worktree，不接模型。成功 rebase/merge 缺少非空 revision 会进入 `runner_error`，不会被当作合并成功。`IntegrationReport.finalVerification` 复用 S5 的 `EvidenceBundle` 与 artifactRevision-bound `VerificationVerdict`，最终裁决仍由 S5 `decideVerdict` 规则产生。

`decideEscalation` 矩阵固定为：`merged → none`；`verification_failed → mechanical-retry`（可传剩余次数）；`conflict → integration-agent`；runner/结构错误 → `human`。report 校验会用 S5 `decideVerdict` 从 evidence 重算 verdict，并要求严格的 rebase → merge → verification → conflict-check → status 管线，拒绝重复或重排步骤。命令条目和冲突路径超过 256 UTF-16 code units 直接拒绝（fail closed，不截断）。Integration Agent 当前只有纯数据契约：冲突文件、base/unit revisions 和双方 diff 摘要；它不是模型调用授权，也不会改变 S2–S5 行为。S6 只写内存冻结快照，不持久化报告。P0 host adapters 位于纯核之外，可复用这些端口；完整 acceptance coordinator 尚未接线。

`reviewer` 只在 `plan` / `complex` 或验证失败、不确定时启用，且可用 `reviewer: 'always' | 'never'` 做消融。`mode: 'auto' | 'force-single' | 'force-plan'` 可绕过路由估计，结果仍记录 `forced`、估计复杂度、信号 `reasons` 与路由 `decisionReasons`。Gate 输出的 `maxConcurrency` 与 `expectedTaskCount` 是供 S3 Scheduler / 后续 S5 消费的建议，不会改变 S3 行为。

模型 profile / 账号属于部署数据，不入库、不入测试（测试仅用 fixture 字符串）。

## S5 验证环边界

S5 把“验收”拆成两个显式阶段：`MechanicalVerifier` 通过调用方注入的 `runner` 执行 S4 规划的命令，并通过注入的 `clock` 记录开始/结束时间；runner 返回退出码、超时和有界输出摘要/引用。测试只使用 fake runner，绝不启动真实进程。`decideVerdict` 仅在所有命令成功且满足 `minimumCommands` 等期望时返回 `verdict: 'passed'`，否则返回 artifact-bound `rejected`；缺少 `artifactRevision` 直接结构化拒绝。

`assembleReviewerBrief` 的 fresh-context 输入严格只有 `spec`、revision-bound `diff` 和 evidence 摘要。worker 会话转录、prompt 历史和完整日志既不进入 brief，也不作为 reviewer 状态来源；多余字段（包括 `workerTranscript`）按 exact-fields 规则拒绝。reviewer 只定义 `passed/rejected` 契约，不调用模型。`decideFinalVerdict` 的矩阵是：机械 rejected → rejected；机械 passed 且 Gate 不需 reviewer → passed；机械 passed 且需 reviewer、尚未收到裁决 → needs_review；收到 rejected review → rejected；通过的 review 必须匹配同一 artifact revision 才能 passed。

S5 只产出可映射到 S2 的 `verdict: 'passed' | 'rejected'` 输入；`settled` 仍只是 `VERIFYING`，不会自动变成 `PASSED`。`taskId` 复用 S2 的 64 字符上限；`attemptId` 限制为 128 字符（容纳最长 S2 task ID、S3 的 `:attempt-` 前缀和计数器）；`artifactRevision` 限制为 256 字符（容纳 commit/diff hash 及适配器引用）。`s2VerdictInput` 对运行时输入再次校验，只允许 `passed/rejected`。S4 的 `mechanicalVerification.required/commands` 与 `needsFreshReview` 行为不被 S5 改写。

S3 的 backoff 公式为 `baseMs * 2^(attemptsRecorded - 1) + rng() * jitterMs`；显式 backoff 必须提供正整数 `baseMs`，`jitterMs` 缺省为 0，`maxMs` 缺省为不封顶，配置 `maxMs` 时截断。`maxStartFailures` 默认 3 次，达到上限转 `FAILED`。显式 options 必须是 exact plain object；options 为 `undefined` 时使用离线默认值（单并发、`clock: () => 0`、无延迟），`null` 和未知字段拒绝。时间始终来自注入的 `clock()`，不会直接调用 `Date.now()` 或 `Math.random()`；错误消息回显经 `truncateForMessage` 有界，issues/available/事件 payload 保留完整数据。
