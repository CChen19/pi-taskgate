# pi-taskgate

A quality gate for AI coding agents: work is accepted only after clean-room verification and an independent review of the exact revision. A Pi extension built on [Pier](https://github.com/July24/pier) (Pi + herdr subagents).

> 命名说明：本项目原名 `agent-orchestrator`。为兼容历史 session 与实验证据，以下落盘标识保留旧名、暂不改动：Pi session 事件类型 `agent-orchestrator.task-event`、配置文件 `agent-orchestrator.json`、环境变量 `AGENT_ORCHESTRATOR_CONFIG`、worktree 所有权目录 `.agent-orchestrator/ledger`。

给 Pi 主会话（Pier master）用的 deterministic orchestration primitives。**主 Pi agent 是唯一的语义 orchestrator 和人机入口**：它负责拆解任务、决定并行、动态重规划、何时问人。本项目只提供事实和约束：结构化 task state、宿主观察的 git artifact、files_in_scope、allowlist 机械验证、绑定 revision 的 fresh review。worker/reviewer 由主 agent 通过 Pier 的 `subagent` 工具在真实 pane 中启动，人随时可以进入 pane 接管。

> 架构调整（2026-09）：早期的"外层 coordinator + 独立 planner 进程"路线已移到分支 `legacy/vertical-slice`，不再继续开发。其中正确的机制（artifact 真相、完成≠验收、worktree 隔离、scope、allowlist、fresh reviewer）被复用到下面的主会话扩展里。

## Pier 提供什么，本项目补什么

| | Pier（原样使用，只走公开接口） | 本项目（companion extension）补充的 |
|---|---|---|
| 启动 agent | `subagent` 在 herdr pane 里起 worker/reviewer，人可接管，可 revive，结算通知 | 不 spawn；只给出精确的 spawn 参数 |
| 角色 | role 文件（tools/permissions） | 每次 review 前检查 reviewer role 对所有写/执行类工具显式 deny |
| 谁跑了什么 | delegation ledger（pane、cwd、role、状态、收尾输出、`revivedFrom`） | 只读 ledger：绑定 worker 与 worktree、判断是否结算、直接取 reviewer 自己的 verdict |
| 工作区 | 每个 subagent 一个 cwd | 每个 attempt 一个 host 创建的 git worktree + 分支，基于精确 base revision |
| 任务状态 | todo（自由文本） | 事件溯源的 task board：contract、依赖、attempt、check、candidate revision、review、verdict |
| “做完了吗” | 子 agent 自己说 | host 读 git、scope 检查、clean-room 里跑 allowlist 命令、绑定 revision 的 fresh review |
| 合并 | — | 精确 revision 的 cherry-pick 集成 → clean-room 验证 → fresh 集成 review |
| 恢复 | session 文件、`--session` resume | 从 session 自身的事件条目回放 task board |

两条流程：

- **单个任务**：`task_plan` → `task_start` → spawn worker → `task_bind` → 结算后 `task_verify`（失败记 check，主 agent 可 `subagent send` 让 worker 修）→ `task_review_brief` → spawn 全新只读 reviewer → `task_review_record` → PASSED，或 RETRYING → 新 attempt（预算用完则 FAILED）。
- **集成**：`task_integrate`（只收 PASSED + fresh review 绑定精确 revision 的 candidate，按顺序 cherry-pick 到精确 base，冲突即 FAILED）→ `task_verify`（clean room + 历史核对）→ fresh 集成 reviewer → `task_review_record`。合并到 master 由人做，从不 push。

Fail-closed 守卫的完整列表、状态机和 session 恢复见 [docs/architecture.md](docs/architecture.md)。首轮真机运行中实际拦下的问题（残留 `build/`、Release 下失效的 `assert()`、格式错误和 revived 的 reviewer、CMake 集成冲突、超大 review diff、session resume）见 [docs/field-report-2026-09.md](docs/field-report-2026-09.md)。与“只用 Pier”的对比实验设计见 [docs/evaluation.md](docs/evaluation.md)，第一轮结果（14 次试验，含 4 种故障注入）见 [docs/benchmark-2026-09-22.md](docs/benchmark-2026-09-22.md)。

## 主会话扩展（P0/P1 已实现，2026-09-22 已在 TinyWebServer 上真机运行）

`src/pi-extension/index.ts` 是一个与 Pier 并列加载的 Pi extension，只在主会话中注册 9 个工具，不 spawn 任何 agent：

| 工具 | 由代码保证的事实 |
|---|---|
| `task_status` | task board：state、未满足依赖、attempts、绑定的 Pier agent、worktree、失败的 check、candidate revision、review、verdict、READY 列表，以及 `DELIVERABLE`：最近一个 PASSED 的集成 revision；board 上只有一个非集成任务时是它的 PASSED revision；否则为 none 并给出原因。这是唯一应交付的结果 |
| `task_plan` | 原子地加入 TaskContract（全部校验通过才写入）：id 唯一、依赖存在且无环、`files_in_scope` 非空、verification 命令必须逐字在 host allowlist 中；`review_required` 默认 true；**规划规则**：可以并行的任务（彼此之间没有 depends_on 路径）的 `files_in_scope` 不能重叠（含目录前缀）。唯一例外：该路径在人写配置的 `sharedPaths` 里，且两个任务都在 `planned_overlap` 里声明了它。`planned_overlap` 只能引用 `sharedPaths` 中的路径，不能新增（G3，2026-09-26）；拒绝文案只给出 depends_on 或拆分文件两条出路 |
| `task_start` | 任务必须 READY/RETRYING 且依赖已 PASSED；host 从主 checkout 的 HEAD（或某个已 PASSED 依赖的 revision）建独立 worktree+branch，返回 worker prompt 和 `subagent` spawn 参数；`reuse_worktree` 在同一分支上开下一个 attempt |
| `task_bind` | 通过 Pier ledger 确认该 agent 确实在该 worktree 中启动 |
| `task_verify` | 要求 worker 在 Pier ledger 中已不是 running；host 检查 HEAD、changed paths、clean、commits ahead、scope，然后在**该 revision 的全新临时 checkout**（`<workspaceRoot>/.verify/`，只由 git 对象生成，事后删除）中跑 allowlist 命令，worker worktree 里被 ignore 的构建产物不会被复用；并拒绝测试代码中**新增**的 `assert(`（Release/`-DNDEBUG` 会把它编译掉；只检查新增行，忽略注释、字符串和 `static_assert`）；失败只记一次 check（attempt 不消耗，超过 `maxChecksPerAttempt` 才判 attempt 失败），通过则 settle 为 candidate（不需要 review 时直接 PASSED） |
| `task_review_brief` | 先确认 reviewer role 对所有写/执行类工具显式 deny，且 candidate 仍是 HEAD 且干净；把绑定 revision + 一次性 review id 的完整 brief（目标、验收标准、scope、验证证据、patch）写到 host 所有的 `<workspaceRoot>/.briefs/<reviewId>.md`（在所有 worktree 之外），并在 `review_requested` 事件里记录它的 sha256 和签发的 spawn prompt。返回给主 agent 的只是 4 行 spawn prompt，指向这个文件；主 agent 无法删减、摘要或追加 brief 内容 |
| `task_review_record` | 从 **Pier ledger** 读取 reviewer 的收尾输出（不采信主 agent 转述）；要求 reviewer ≠ implementer、role 正确、非 revived、在 brief 之后启动、review id 与 revision 都匹配、worktree 未变，然后 PASSED 或 RETRYING/FAILED。**2026-09-26 起还读取 reviewer 自己的 Pi session 文件**（ledger 行的 `sessionFile`），并要求：恰好一条 user 消息（运行中被 `subagent send` 催促或代答会多出消息，G1）；这条消息与签发的 spawn prompt 除空白外完全相同；以上两项不满足返回 `REVIEWER_NOT_INDEPENDENT`。brief 文件的 hash 未变，否则返回 `BRIEF_CHANGED`。reviewer 自己的 `read` 结果按行号逐字覆盖了 brief 的每一行，否则返回 `BRIEF_NOT_READ`。session 文件缺失或读不了一律拒绝。旧 session 里没有 brief 文件的 review 只核对 review id。回放第一轮真实数据：G1 部分拒绝 mb1 与 i8b 的 4 条被催促或代答的 verdict，其余 14 条不受影响 |
| `task_integrate` | P1：把精确的已验收 candidate revision（PASSED + clean-room 验证 + fresh review，并在 Pier ledger 里复核 reviewer verdict）按给定顺序 cherry-pick（`-x`）到基于**精确 base revision** 的新集成 worktree/分支；candidate 可以建在 base 上，也可以叠在更早的输入之上（如前置的 wiring 任务），只 pick 它自己的 commit；跨会话的 candidate 需要提供其 Pi session 文件作为证据（沿当前分支回放）。冲突即 abort、记录冲突文件并 FAILED，绝不自动解决。成功后集成任务走与普通任务相同的 `task_verify`（额外校验：集成历史与声明的源 commit 逐个 patch-id 相同且带 `-x` 来源）→ fresh reviewer → `task_review_record` |
| `task_abandon` | 主 agent 放弃当前 attempt（受 retry 预算约束）或取消任务（依赖方变 BLOCKED） |

**主 agent 的 git 写保护（G2，2026-09-26 实现）。** 扩展同时挂在 Pi 的 `tool_call` 事件上。board 上一旦有任务，主 agent 通过 `bash` 在 `repoRoot` 或 `workspaceRoot` 下执行的 git 写操作都会被拦下，返回 `GIT_WRITE_BLOCKED`。拦截范围包括 `commit`、`merge`、`cherry-pick`、`rebase`、`reset`、`revert`、`am`、`apply`、`push`、`pull`、`update-ref`、`switch`、移动分支的 `checkout`，以及强制、删除、改名分支的 `branch`。命令解析识别引号、分隔符、`$(...)`、heredoc、`cd`、`git -C`、`sh -c` 和 `eval`；解析不出目标目录的，一律拦截。只读 git 命令和 `--abort`/`--quit` 放行。board 为空时不拦截，主 agent 仍可自己做不需要委派的小任务。这是基于字符串的策略检查，不是沙箱：别名、脚本或其他语言里调用 git 都能绕过。真正的保证是交付规则：只认 `DELIVERABLE`。

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
  "defaultMaxAttempts": 3,
  "sharedPaths": []
}
```

`sharedPaths`（可选，默认空）列出允许并行任务同时修改的仓库相对路径，只能由人写入；为空时，任何并行重叠都必须用 `depends_on` 排序或拆成各自的文件。

`workspaceRoot` 必须很短：Pier 为每个 subagent 创建 `/tmp/pi-herdr-<编码后的 cwd>-<pane>.sock`，Unix socket 路径上限约 108 字节，`/` 编码后占 3 字节。配置加载时和每次 `task_start` 都会检查，超长时 fail closed；worktree 使用紧凑命名 `<task≤12>-a<n>-<hash>`，分支为 `ao/...`。

2. 在 Pier 的角色目录（`<主会话 cwd>/.pi-herdr/roles/`）放一个只读 reviewer 角色：对 `edit`/`write`/`bash`/`pwsh`/`subagent`/`terminal` 显式 `deny`。
3. 在 herdr pane 中启动主会话，同时加载 Pier 与本扩展：

```bash
pi -e /path/to/pier/packages/pier-ext/src/index.ts -e /path/to/pi-taskgate/src/pi-extension/index.ts
```

不需要委派的小任务不走 task 工具，主 agent 直接做并跑检查；复杂或可并行的任务才走 task board。board 上一旦有任务，主 agent 就不能再在仓库或 task worktree 里写 git 历史，交付的是 `task_status` 中的 `DELIVERABLE` revision，由人合并。

### 已知限制

- 真机运行只有 2026-09-22 的五轮（TinyWebServer，deepseek-flash 与 kimi-for-coding），不是对照实验；离线测试覆盖真实 git worktree、真实 allowlist 进程、fake Pier ledger。
- reviewer 没有 shell，需要命令结果时可能通过 `ask_user_question` 问人；这种回答不是 host 证据（见 field report）。它以 tool result 的形式进入 reviewer session，不是 user 消息，所以 G1 检查不拦它。
- 第一轮里 brief 由主 agent 作为 `subagent` 参数转写，19 个 reviewer 收到的文本全都与签发版本不同（10 个的 patch 被截断，1 个被换成主 agent 的摘要）。现在 brief 改为文件传递并逐行核对（见 `task_review_record`）；第一轮数据无法回放这一检查，它的真机效果要看第二轮。reviewer 读了 brief 不等于认真审了，这一点只能靠结果指标衡量。
- `task_verify` 依赖 Pier ledger 的 `running` 状态判断 worker 是否结束；如果 `subagent send` 之后 Pier 没有写新的 running 行，过早 verify 可能看到半成品并记一次失败 check。
- Pier 的 todo 自动对账会在 subagent settle 时勾掉描述匹配的 todo；task 状态只以 `task_status` 为准，建议 spawn description 用 `T1:impl` 这类不与 todo 重合的形式（工具返回的就是这种）。
- integration 只做机械 cherry-pick，冲突时 fail closed，不提供冲突解决；worktree 和分支不自动清理；git 检查是同步调用，verification 命令是异步调用。
- git 写保护只检查主 agent 的 `bash` 命令字符串，`edit`/`write` 仍可改文件，别名、脚本或其他语言里调用 git 也拦不住；它挡的是常见的绕路，不是沙箱。交付是否可信取决于人只接受 `DELIVERABLE`。
- 没有内建 metrics；field report 的数字是从 session 文件手工抽取的（方法见 docs/evaluation.md）。

## Legacy

早期的外层 vertical slice（外部 planner、scheduler、herdr CLI port 等）已从 `main` 移除，完整代码与测试保留在分支 `legacy/vertical-slice`；第一轮 benchmark 时的状态是 tag `v0.1-bench1`。

## 检查

```bash
npm run check
```

130 项测试：真实临时 git repo + worktree + allowlist 进程，fake Pier ledger/role/session；不调用真实模型、Herdr、Pi 或网络。
