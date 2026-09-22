# 人工观察记录（2026-09-22 基准实验期间）

本文只记录实验过程中人眼观察到的问题，不改代码，也不给出实现方案。所附证据来自同日的真机运行与基准实验，详见 [field-report-2026-09.md](field-report-2026-09.md) 和 [benchmark-2026-09-22.md](benchmark-2026-09-22.md)。

## 1. 子 agent 有时会触发 `ask_user_question`

**现象**：master 的 prompt 已写明“人不在场，不要提问”，worker/reviewer 仍会不时弹出 `ask_user_question`，pane 停在选择菜单上，等人回答。

**实例**：
- **mb1**：集成 reviewer 以“没有 shell，无法运行 git”为由请求授权。按脚本化策略用固定文本回复，并计为 1 次人工干预。
- **i7a**：locker reviewer 同样请求 shell。这个问题随后以“User declined to answer … aborted”结束，没有操作员参与。
- **R4（历史）**：Tlocker reviewer 请人代跑 `cmp` / `git diff`，由人在 pane 里回答“Both checks pass”。这条判决因此部分建立在人的陈述上，而非 host 证据。
- **2026-09-18 Pier-only 运行**：worker 也因需要人工决策而进入 BLOCKED。

**影响**：
- 运行卡住，需要人值守；无人值守的实验必须另写脚本代答。
- 人的回答（或代答）会混进 review 依据，无法区分哪些结论是 reviewer 自己读代码得出的。
- 触发的主要原因是只读 reviewer 角色没有 shell，却被要求“核实”；而 `ask_user_question` 仍在角色的工具列表里。

## 2. pane 总是上下扩展，可观察性下降

**现象**：每 spawn 一个 subagent，就在当前 tab 里上下切分出一个新 pane。并行任务、reviewer、revive 越多，pane 越窄，很快就看不清各 pane 的内容和状态。

**实例**：一次基准实验结束时，工作区里还留有 19 个 trial pane，其中包括已完成但未关闭的 worker/reviewer，以及 master 被杀后遗留的 pane。

**影响**：
- 人很难一眼看出谁在跑、谁已结算、谁在等提问；接管（takeover）的前提——“能看见”——被削弱。
- 已结算的 pane 不会自动收起，越积越多。
- 实验中不得不依赖 `herdr pane read` 和 ledger 脚本来判断状态，而不是直接看屏幕。

## 3. 主模型和子任务模型应能分别指定，从各自的模型池选择，并结合配额查询

**现象**：
- 模型写死在 role 文件的 `model` 字段里（如 `worker-kimi` → `kimi-coding/kimi-for-coding`），master 的模型则在启动命令里指定。
- 两者没有统一的“按角色选模型”的配置，也不会参考当前配额。

**实例**：
- 基准实验中 Kimi 的 5 小时配额被耗尽（98/100 used，14:34 重置）。实验只能人工暂停。
- 之后为每个 trial 复制并改写 role 文件，把最后一组实验手动切到 `openai-codex/gpt-5.6-luna`。
- 配额信息其实可以查到：Pi 的 `/usage` 显示各窗口剩余量和重置时间，状态栏也显示 `kimi N% 5h` / `codex N% 5h`。但编排流程完全没用到这些信息。

**期望（仅记录需求）**：
- master 和子任务（worker、reviewer 等）的模型可以分别指定。
- 各自从配置好的模型池里挑选，例如 master 池、worker 池、reviewer 池，每池列出若干候选及其优先级和成本档位。
- 选择时结合配额查询：配额不足时换到池中下一个模型，或提前提示，而不是跑到一半失败或人工改 role 文件。
- 换模型这件事本身应记录在任务证据里。本次实验 I8 换了模型，所以只能自己跟自己比。
