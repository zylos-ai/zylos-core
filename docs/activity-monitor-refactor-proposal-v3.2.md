# Activity Monitor 重构方案 v3.2 — 📝 REVIEW DRAFT (v3.1 加 §预 onboarding + 故事式 §〇 + 失败模式 §一)

> 日期：2026-04-28（基于 v3.1 commit `9f770f6` 三轮重排版）
> 分支：`docs/activity-monitor-refactor-proposal`
>
> **本文件状态：📝 REVIEW DRAFT**
>
> v3.2 **不是新设计、也不是 v3.1 的 design 修订**——是基于 cold-reader audit（49 in-cluster 术语、12 处 v2.1 narrative anchor 丢失、4 处 top↔module 不一致）整改：v3.1 修了"密度"层但没修"vocabulary + narrative + motivation"层，导致新 reviewer 仍看不懂。**所有 design decision 与 v3.1 / v3 / v2.1 完全一致**——v2.1 baseline + zylos0t R6 两条窄 contract 修订（§六.H、§六.I）；R3+R4+R5 reply-resolution 整套不进 baseline（§六.G）。
>
> **本次相对 v3.1 的改动（按 cold-reader audit 三层 gap 整改）**：
>
> 1. **新增 §预 onboarding**（解决 vocabulary gap）——系统位置图 + 12 词 glossary + PR 史 mini-timeline；新 reviewer 进门所需的所有上下文都集中在这一节
> 2. **§〇 重写为故事式 TL;DR**（解决 mental model gap）——"用户发一条消息走过 AM 的一生"，4 路径走 happy / probe-recovers / probe-fails / OS-freeze→restart；每个模块在故事里自然出现，而不是光秃秃列名
> 3. **§一 重构为失败模式 + 痛点**（解决 motivation gap）——先列 7 种 runtime 失败模式（用户视角："runtime 怎么坏掉的"），再列 8 个结构性痛点（开发视角："现状代码为什么解决不了"），把"为什么要重构"讲在前面
> 4. **修复 4 处 audit 标的不一致**：§六.H "audit"措辞 / 模块数 12 vs 11 vs 9 / c4-send 是 outbound writer 顶层档显式 / §一 痛点数对齐 §〇
> 5. **5 处 ambiguity 显式标注 Phase 3 implementation TODO**——IPC socket 路径 / c4-receive catalog 访问 / StatusWriter write 语义 / unknown-5min 升级后 reset / c4-session-init scope（不再 silent gap）
>
> **历史版本归属**（review pass 后切到本文件作为 baseline 时一并升降级）：
> - v2.1 [`...-v2.1.md`](activity-monitor-refactor-proposal-v2.1.md) — **当前 IMPLEMENTATION BASELINE**，本文件 review pass 后转为 SUPERSEDED-by-content
> - v3 [`...-v3.md`](activity-monitor-refactor-proposal-v3.md) — v3.1 review pass 后转 SUPERSEDED；v3.2 review pass 后同样 SUPERSEDED（design 等同）
> - v3.1 [`...-v3.1.md`](activity-monitor-refactor-proposal-v3.1.md) — v3.2 review pass 后转 SUPERSEDED-by-content（design 等同，readability 进一步升级）
> - v2 / v1 — SUPERSEDED 不变

---

## §预、读者上下文（cold-start onboarding）

**为什么有这一节**：本文是 AM refactor 顶层方案。新 reviewer 没读过 zylos 整体架构 / 没跟过 PR #501 review 5 轮历史 / 不熟 c4-* / hook / tmux 这套词汇——直接读 §〇 TL;DR 会被 jargon 劝退。这一节给最小 onboarding：系统位置 + 12 个必备词 + PR 史。**已熟读 v2.1 / v3 系列方案的 reviewer 可跳过本节直接到 §〇。**

### §预.1 AM 在 zylos 系统中的位置

zylos 是一套 AI agent 自治平台——有自己的 memory / channels（Telegram / Lark / web-console / hxa-connect）/ communication bridge（C4）/ runtime（Claude Code / OpenAI Codex）/ scheduler 等。AM 是其中一个 PM2 长驻服务，**只管一件事：守护当前活跃的 runtime 进程**。

```
[ User ]
   │  发消息 ("hi")
   ▼
[ Channel daemon ]            ← 每平台一个长驻进程（lark-bot / telegram-bot / ...）
   │  poll 平台消息            poll API、收到消息后 spawn c4-receive
   ▼
[ c4-receive (per-msg script) ]  ← 短命脚本，每条消息一次
   │  ① 查 AM 健康状态 (IPC)
   │  ② 写 inbound 行到 c4 DB（SQLite）
   │  ③ 视健康状态决定下一步
   ├─ health=OK   → exit 0；c4-dispatcher 后台 poll DB 主队列接管
   └─ unhealthy   → 同时调 c4-send.js 写 outbound 状态文案 + spawn channel/send.js 投递
   │
   ▼ (OK 路径)
[ c4-dispatcher (long-running daemon) ]
   │  SELECT pending FROM conversations
   ▼
[ tmux send-keys ]            ← 唯一进入 runtime 的 IO 通道
   │
   ▼
┌─[ runtime (Claude / Codex) ] in tmux session ─────────────┐
│   ↑                                                        │
│   │ AM 守护这个进程：拉起 / 探活 / 错误识别 / 限流  │
│   │                                                        │
│ [ AM (PM2 long-running) ]                                  │
│   ├── Guardian (拉起决策)                                  │
│   ├── HealthEngine (健康状态机 + catalog dispatch)          │
│   ├── ProcSampler (OS 级冻结探测)                          │
│   ├── ToolPipeline / Watchdog (工具生命周期)                │
│   ├── TaskScheduler (定时任务)                             │
│   ├── SignalStore / StatusWriter (跨模块状态共享 + 对外发布) │
│   ├── MessageRouter (响应 c4-receive IPC 查询健康)           │
│   └── Adapter (Claude vs Codex 差异封装)                    │
│                                                            │
│ [ runtime 反向走 c4-send.js → c4 DB outbound → 投递 channel ] │
└────────────────────────────────────────────────────────────┘
```

**关键不变量**：

- C4 DB（SQLite at `~/zylos/comm-bridge/c4.db`）是消息可靠性边界——任何消息一旦 c4-receive 写入 inbound 行，就**不再丢失**（即使 runtime 崩 / restart / 长时间不可用）
- tmux 是唯一 IO 进 runtime 的通道——所有"agent 看到的内容"都通过 tmux send-keys 注入
- AM 跟 runtime 不是父子进程关系——AM 是 PM2 服务，runtime 在独立 tmux session；AM 用 PM2 / tmux 命令拉起 / 停止 runtime

### §预.2 12 词 glossary

| 词 | 含义 |
|----|------|
| **runtime** | Claude Code（CLI）或 OpenAI Codex（CLI），跑在 tmux session 里的 LLM agent 长驻进程 |
| **agent** | 跑在 runtime 里的 LLM 实例（"agent 收到消息 → 自决策回复"中的 agent）|
| **channel daemon** | 每个外部消息平台对应的长驻 poller（lark / telegram / web-console / hxa-connect）；监听平台消息后 spawn `c4-receive` |
| **C4 / 主链** | Communication bridge（Component 4 in zylos）。包含 SQLite DB（c4.db）+ 几个相关脚本（c4-receive / c4-send / c4-dispatcher / c4-session-init）|
| **c4-receive** | 短命脚本，每条入站消息一次，由 channel daemon spawn；负责查 AM 健康 + 写 inbound + unhealthy 时调 c4-send 返状态文案 |
| **c4-send** | 短命脚本，由 runtime（agent reply）或 c4-receive（unhealthy 状态文案）调用；写 outbound 行 + spawn 对应 channel 的 `send.js` 实际投递 |
| **c4-dispatcher** | 长驻 daemon，poll c4 DB pending inbound → 健康门控 + priority + require_idle → tmux send-keys 注入 runtime |
| **c4-session-init** | 既有 hook，runtime 起新 session 时 inject "last checkpoint summary + recent unsummarized 对话"作为 startup context |
| **hook** | Claude Code 提供的 settings.json 机制，特定事件（session-start / pre-tool / post-tool）触发用户脚本；AM / c4 用的几条 hook 路径已固定 |
| **tick** | AM 主循环节奏单位 = 1 秒；每 tick 跑 8 步流水线（详 §四.3）|
| **probe** | "主动询问 runtime 是否健康"的检测动作。3 层：Layer 1 ProcSampler（10s OS 级）+ Layer 2 tmux scan（30s 文本扫）+ Layer 3 heartbeat（30min 端到端 C4 control ack）|
| **catalog** | Adapter 在构造时注入的"runtime 错误模式"清单——每条 entry 含 `{id, pattern, severity, recoveryAction, userMessage}`，HealthEngine 按 entry.recoveryAction 统一 dispatch |

**辅助词**（在文中第一次出现时若读不懂，回这里）：

- **Adapter**: 封装 Claude vs Codex 运行时差异的 DI 注入层
- **SignalStore**: 每 tick 开头刷新一次，把 ~13 个外部状态文件拍成 immutable snapshot 给所有模块只读消费
- **StatusWriter**: 每 tick 末尾写 `agent-status.json`（对外契约唯一发布者）
- **MessageRouter**: 响应 c4-receive IPC 查询的事件驱动模块（**不在 tick 里**，IPC 来一次跑一次）
- **bypass-once / marker**: AM 冷启动后给首次 probe 一次绕过持久化退避的机会（marker 文件 = operator 通过 `zylos am reset-backoff` CLI 创建的 one-shot 全清零标志）；详 §五.5、§六.C
- **inbound / outbound**: c4 DB `conversations` 表的 `direction` 字段值——`'in'` = 用户发给 bot，`'out'` = bot 发给用户
- **launchGrace**: 新 runtime session 起来后的"宽限期"（默认 180s）。这段时间 HealthEngine **不主动 probe**——避免对刚拉起还没暖好的 session 立刻发请求触发 false negative；只对外暴露被动 OK / Unavailable 状态。详 health-engine.md §4
- **priority / require_idle**: c4-dispatcher 决定哪条 pending inbound 下一个投递时的两个 gate：`priority` = inbound 表里 priority 列（高的先投），`require_idle` = 当前 runtime ActivityState 是否 Idle（避免打断 Busy 状态的 agent）
- **PM2**: 第三方 Node.js 进程管理器（process manager 2）；负责守护 long-running 服务（AM / channel daemon / dispatcher 等都是 PM2 进程）+ 提供 restart / log / cluster 等机制
- **tmux**: 终端复用器（terminal multiplexer）。在 zylos 中每个 runtime（Claude / Codex CLI）跑在一个独立 tmux session 里；外部要"输入"内容给 agent 只能通过 `tmux send-keys` 命令注入

### §预.3 PR #501 演进 mini-timeline

本文是 PR #501 的最新顶层方案稿。如果你看 review 群 / DM 里 ccb / zylos0t / howard.zhou 等人讨论 R3 / R6 / Direction D 等术语困惑，这里给最小 timeline：

```
v1 (草稿)              ──── 早期方案，混杂高低层；SUPERSEDED 不要据此实施
v2                     ──── 2026-04-22, 750 行详细设计档；SUPERSEDED
v2.1                   ──── 2026-04-24, 750 行 + Direction D walkback；当前 IMPLEMENTATION BASELINE
                            （Direction D = 不引入受害者 ledger / 不主动 broadcast / agent 自治续接 = "软错"哲学）
                              │
v3 R3 (c358ac5)        ──── R3 review 引入 reply-resolution 整套（terminal_status / reply_to_inbound_id /
                            claimed_at + reply command token-passing + C-Term-1~5 单调 invariant + bounded
                            pending exposure CLI + InputValidator）。把 v2.1 的"软错"升级为"硬错"机制
                              │
v3 R4 (e1f5cb9)        ──── R4 加 reply command token-passing 自动注入 `--reply-to-id`；C-SR-2a/2b 拆分
                              │
v3 R5 (9114ec5)        ──── R5 cleanup 收尾；69adcf5 final pass 把 v3 升 IMPLEMENTATION BASELINE
                              │
R6 production rollback ──── 2026-04-28, ccb 在 Lark 群质疑 v3 production validity（5 轮 review 全没抓到
(commit 3bbda42)            terminal_status × conversations.status 字段交互 blind spot）+ 反向 reframe
                            "v3 初衷是格式重组不是重设计"。Option B = 整套退回 v2.1，把 v3 整套 SUPERSEDED
                              │
v3 R7 重写 (4be23c6 →   ──── R7 整套重写 = v2.1 内容按 tech-doc-spec 顶层 + 9 模块档格式排版；
 a711212)                   landed 9 modules + R6 两条窄 contract 修订（§六.H、§六.I）
                              │
v3.1 (9f770f6)         ──── 按 doc-coauthoring 工作流做 6 处密度修订（TL;DR 7→4 / 流程图拆分 / §六.G 压缩 等）
                              │
v3.2 (本文)            ──── cold-reader audit 后整改 vocabulary + narrative + motivation gap：
                            §预 onboarding + 故事式 §〇 + 失败模式 §一 + audit 不一致修复
```

**Reviewer 标记**（在 PR #501 review 历史里你会看到）：

- `R3` / `R4` / `R5` = review round 3/4/5 时被引入的设计增量（已被 R6 全套 rollback）
- `R6` = production rollback，把 R3+R4+R5 增量退出 + 强制 v3 改回排版任务
- `Direction D` = v2.1 §5.3.2 收敛的"不引入受害者识别 ledger / 不主动 broadcast / 用户自治补答"哲学
- `zylos0t R6 TODO 1 / TODO 2` = R6 后 zylos0t 提的两条窄 contract 修订（详 §六.H、§六.I）

---

## 〇、TL;DR — 一条消息走过 AM 的一生

新 reviewer 友好的入口：用一个具体故事把 11 个模块串起来。先看故事再看抽象 design 原则会更顺。

### Sarah 在 Telegram 发了 "hi"——会发生什么？

**Path 1：runtime 健康（happy path）**

```
[T+0ms]   Sarah 发 "hi" → telegram-bot daemon 收到 update
[T+50ms]  daemon spawn c4-receive
          c4-receive → IPC 查 MessageRouter (within AM): "现在健康吗？"
          MessageRouter → 读 SignalStore 快照 → health=OK → 回 "yes"
[T+80ms]  c4-receive insertConv('in', 'telegram', '<chat_id>', 'hi', 'pending')
          c4-receive exit 0
[T+100ms] c4-dispatcher (long-running) 下次 SELECT pending 拿到这条 inbound
          → 健康门控（health=OK）+ priority 检查 + require_idle 检查
          → tmux send-keys 把 'hi' 注进 Claude session
[T+200ms] Claude agent 看到 'hi' → 决定回复 "Hi there!"
          → 调 c4-send.js 'telegram' '<chat_id>' "Hi there!"
[T+250ms] c4-send insertConv('out', ..., status='delivered') + spawn telegram/send.js
          telegram/send.js 调 Telegram Bot API → Sarah 收到回复
```

**这条 happy path 触及的模块**：

- **MessageRouter**：响应 c4-receive 的 IPC 查询（Unix domain socket）
- **SignalStore**：MessageRouter 读的健康快照来自这里
- **HealthEngine**：每 tick 第 6 步更新 SignalStore 里的 health 字段
- **(StatusWriter)**：把 SignalStore 投影到 `agent-status.json` 给外部消费

**注意 AM 不在这条 path 上做任何事**——只是 c4-receive 用 IPC 查了一下 health 状态。这是 design 哲学的核心：**OK 路径每条消息独立走 C4 主链，AM 不干涉**。

---

**Path 2：runtime 临时不可用，但 probe 期间恢复（probe-recovers）**

```
[T+0ms]   Sarah 发 "hi" → daemon → spawn c4-receive
          c4-receive → IPC 查 MessageRouter
          MessageRouter → SignalStore 快照 → health=Unavailable
          → 触发 recovery probe（聚合等待，最多 30s）
[T+5s]    probe 成功 → MessageRouter 回 c4-receive: "OK 了"
          c4-receive 走 happy path（同 Path 1 后续）
```

**模块新出现**：MessageRouter 的"recovery probe 聚合"机制。多个 c4-receive 同时来查同一个 unhealthy 状态时**只发 1 个 probe**，结果广播给所有等待者——避免 thundering herd。

---

**Path 3：runtime 真不可用，probe 也失败（probe-fails）**

```
[T+0ms]   Sarah 发 "hi" → daemon → spawn c4-receive
          c4-receive → IPC 查 MessageRouter → health=Unavailable
          → 触发 recovery probe → probe 失败
[T+30s]   MessageRouter 回 c4-receive: "still unhealthy, reason=transient_overload"
          c4-receive insertConv('in', ..., status='delivered')   ← 显式覆盖 default 'pending'
                                       ↑ 关键：dispatcher 主队列 SELECT pending 自然跳过这条 inbound
          c4-receive 调 c4-send.js 'telegram' '<chat_id>' "API 暂时繁忙，正在自动重试"
                     ↑ catalog.userMessage 文案
          c4-send insertConv('out', ..., status='delivered') + spawn telegram/send.js
          c4-receive exit 0
[T+30s]   Sarah 收到状态文案 → 知道现在系统忙
[T+30s+]  HealthEngine tick 持续探测 → API 恢复后转 health=OK
          → Sarah 凭刚才的状态文案判断要不要重发
```

**模块新出现**：

- **HealthEngine.catalog**：判定 transient_overload 这类 error 的 recoveryAction 是 `probe_only`（不 restart，等 probe）；catalog.userMessage = "API 暂时繁忙..."
- **inbound `status='delivered'` 的关键作用**：用既有 c4 DB 字段表达"这条 inbound 已经被状态文案 cover 了，dispatcher 别再尝试投递造成双答"——零新字段、零新机制。详 §六.H

---

**Path 4：sticky 4xx 触发 restart_session（catastrophic）**

时间锚点：Sarah 这次发 "hi" = `T=0`；之前一条消息（180 秒前）触发了 sticky API error。

```
[T-180s]  Sarah 之前一条消息让 Claude 触发 sticky API error（如 APIError: 400 corrupted context）
          → HealthEngine Layer 2 tmux scan 命中 catalog 'corrupted_context' pattern
          → recoveryAction = restart_session
          → Adapter.stop() + 进 health=Unavailable + 写 unavailable_reason
[T-179s]  Guardian 看 ActivityState=Offline → 拉新 session（PM2 命令）
[T-178s]  新 runtime session 起来 → c4-session-init hook 注入 startup context
          (last checkpoint summary + recent unsummarized 对话)
          → agent 看 context → 自决策是否补回复 Sarah 之前那条消息
[T-178s]  HealthEngine 进入 launchGrace 期：新 session 起来 180s 内不主动探（避免对刚拉起的 session 立刻发 probe 触发 false negative）
[T=0]     Sarah 发 "hi"
          c4-receive → IPC 查 MessageRouter → health 此时可能仍 Unavailable（launchGrace 还有 ~ -180s + 178s + Δ ≈ 几秒残余）
          → 走 Path 3（同步状态文案路径）
[T+几秒]  launchGrace 到期 → 第一次主动 probe → 成功 → health=OK
          → Sarah 后续 message 走 happy path
```

**模块新出现**：

- **Guardian**：守护进程存活——看 ActivityState=Offline 自动拉起新 session
- **Adapter.stop()**：Claude / Codex stop 命令的运行时差异封装
- **ActivityState（Offline / Idle / Busy）vs HealthState（OK / Unavailable / RateLimited / AuthFailed）**：两个状态机正交。Guardian 只看 ActivityState；MessageRouter 只看 HealthState；进程拉起 ≠ 健康变化（restart 后 HealthEngine 从持久化回填，不强制置 Unavailable）

**关键约束**：sticky API error 触发 session_restart **不算消息丢失**——既有 inbound 完整保留在 c4 DB，restart 后 c4-session-init 注入 context，agent 看 context 自治决定是否补 reply。**AM 不维护私有受害者识别 ledger**（这是 v2.1 Direction D + R6 rollback 的核心决断；详 §六.G）。

### 4 路径触及的全部 11 模块（first-mention checklist）

| 模块 | 在哪条 path 出现 | 一句话职责 |
|------|----------------|-----------|
| **MessageRouter** | 1/2/3/4 | 响应 c4-receive IPC 查询 + recovery probe 聚合（事件驱动，**不在 tick 里**）|
| **SignalStore** | 1/2/3/4 | 每 tick 开头刷新，给所有模块只读快照消费 |
| **StatusWriter** | 1 (隐含) | 每 tick 末尾写 `agent-status.json` 对外契约 |
| **HealthEngine** | 3/4 | 4-state FSM + 3 层主动监控 + catalog dispatch（5 recoveryAction）|
| **Guardian** | 4 | 进程存活守护 + 拉起决策 + bypass-once/marker 冷启动语义 |
| **ProcSampler** | (Path 4 sticky 之前隐含) | OS context-switch 采样检测进程冻结（最快层） |
| **ToolPipeline** | (Path 1 内部) | 工具生命周期 + 事件流合成（PR #500 集成）|
| **ToolWatchdog** | (Path 1 内部) | 工具超时检测与干预 |
| **TaskScheduler** | (背景) | 注册式定时任务调度（cleanup / heartbeat / usage-monitor 等）|
| **Adapter** | 4 (.stop()) | Claude / Codex 运行时差异 DI 注入 |
| **monitor** | - | 入口 + 8 步主循环编排（不算独立模块）|

### 设计概览（详见 §三）

**4 个核心动作**：

1. **状态机正交**：ActivityState / HealthState 零字段互读；跨模块走 SignalStore 只读快照 + 具名事件接口两条通道
2. **API error 出口治理 catalog 化**：Adapter 注入 catalog；HealthEngine dispatch 5 种 recoveryAction；**probe 失败不默认 restart**
3. **冷启动行为显式区分**：默认 bypass-once；operator 通过 marker 显式全清零
4. **对外契约向后兼容**：Hook 路径不变；状态文件加 schema_version

**核心边界**：

- C4 DB 是消息可靠性边界（accepted = durable，runtime 异常不算丢失）
- AM 不维护私有 ledger / 不记录"消息是否已回复"业务语义（R6 rollback 决断；§六.G）
- Unhealthy 时 c4-receive 同步通过既有 c4-send.js 接口返状态文案——**跟 agent 正常 reply 同路径**
- restart 后 best-effort continuation——不承诺 unresolved-inbound completeness（§六.I）

**明确不做**（R3+R4+R5 reply-resolution 整套退出）：

不引入 `terminal_status` / `reply_to_inbound_id` / `claimed_at` 字段；不引入 reply command token-passing；不引入 C-Term-1~5 单调 invariant；不引入 InputValidator；不引入 cron 解析器；不主动 broadcast"我恢复了"。详 §二.2、§六.G。

---

## 一、为什么要做：runtime 失败模式 + 现状代码痛点

本节回答两个问题：(1)**runtime 实际怎么失败的**（用户视角——需要 AM 守的是什么）；(2)**现状代码为什么解决不了**（开发视角——为什么必须 refactor）。

### 1.1 7 种 runtime 失败模式（AM 必须守的事）

| # | 失败模式 | 触发场景 | 用户感知 | AM 该做什么 |
|---|---------|---------|---------|------------|
| F1 | **进程死亡** | runtime 进程崩溃 / 被 kill / OOM | 没人回复 | 拉起新 session（Guardian） |
| F2 | **OS 级冻结** | 进程在但 CPU 不调度（死锁 / IO 卡死 / context switch 停摆）| 没人回复但进程还"活着" | 检测后强 kill + 拉起（ProcSampler）|
| F3 | **Sticky 4xx**（context-poison） | 历史对话里某条 input 触发 `APIError: 400` / `context_length_exceeded`，**同一 session 不修内容永远报错** | 一直收到错误，没法自然恢复 | restart 新 session 让 c4-session-init 注入精简 context（HealthEngine `restart_session` action）|
| F4 | **Transient 5xx**（暂时性过载） | API 临时 503 / overloaded_error | 暂时无法回复 | 不 restart，持续 probe + 同步给用户状态文案（HealthEngine `probe_only` action）|
| F5 | **Rate limit** | API 限流（运营商发的 limit 信号）| 暂时无法回复 + 知道何时恢复 | 进 RateLimited + 状态文案带恢复时间 (`mark_rate_limited`) |
| F6 | **Auth fail** | API key 过期 / 撤销 | 一直 401 | 进 AuthFailed + 通知 operator + 不消耗 token 重试 (`mark_auth_failed`) |
| F7 | **Content filter** | 响应被 policy 拦截 | 单次拒绝，下次 OK | 不改 health，仅 log + 可选用户即时通知 (`notify_only`) |

每种模式都需要：(a) 一个**检测路径**（probe 类型 / scan pattern），(b) 一个**recovery 决策**（restart vs 等待 vs 限流标记 vs auth 标记 vs 忽略），(c) 一个**用户感知策略**（沉默 vs 状态文案 vs broadcast）。本方案的核心 design 动作（catalog 化 / probe / restart 解耦 / unhealthy 状态文案路径）是为 cover 这 7 种模式协同工作。

### 1.2 现状代码 8 个结构性痛点（开发视角）

cover 上述 7 种失败模式的逻辑现在全挤在单文件 2300+ 行的 `activity-monitor.js` 里：

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态语义不清** | health 5 值（ok / recovering / down / rate_limited / auth_failed），其中 recovering 与 down 本质是同一恢复流两阶段 |
| 2 | **Guardian ↔ HeartbeatEngine 紧耦合** | 共享 5 个字段，跨模块直接读写，难独立测试 |
| 3 | **多套退避机制各自为政** | restart / recovery / auth retry / user cooldown / tool watchdog 语义不一致 |
| 4 | **God Object** | 单文件 2300+ 行塞了 Guardian / 健康检查 / 工具 watchdog / 调度全部职责 |
| 5 | **Watchdog 子系统游离** | PR #500 引入的工具生命周期 + 事件流主循环深度集成但无模块边界 |
| 6 | **定时任务 ad-hoc** | 三套调度方式混用（DailySchedule / 间隔 timestamp / 独立状态机） |
| 7 | **信号消费散落** | 12+ 状态文件在主循环各处单独 readJSON，无统一快照层 |
| 8 | **AM 冷启动未区分重启前后文与故障重试** | 持久化长退避压制首次 probe；daily-upgrade 修好根因后仍要等退避到期 |

**不解决的代价**：每加一类 runtime 错误（往 §1.1 表里加一行）、每加一个定时任务、每改一个 health 子状态——**都要碰 5 处**；测试只能 E2E 不能单元；增量 ship 难度高。F3 / F4 区分（restart vs probe）今天就写在不同的 if 分支里，没有抽象——这是 catalog 化的直接 motivation。

### 1.3 本方案怎么解（一句话）

把 §1.1 的 7 种失败模式抽象成 catalog（每条 entry = `{pattern, recoveryAction, userMessage}`）；把 §1.2 的 8 个结构性痛点解开成 11 个职责清晰的模块；把"进程是否活"和"runtime 是否可用"拆为两个正交状态机让模块独立可测。具体 design 见 §三 / §四 / §五。

---

## 二、目标 / 非目标

### 2.1 目标（解决什么）

1. **God Object 拆分**：业务职责模块化，主循环退化为编排器
2. **状态机正交**：ActivityState / HealthState 互不读字段，跨模块通过 SignalStore 只读快照 + 具名事件接口
3. **健康状态收敛**：5 → 4 种，子状态用时间戳差分而非枚举值
4. **三层健康监控**：OS 级冻结（10s）+ tmux scan（30s）+ heartbeat probe（30min）按成本/覆盖率分层
5. **API error 出口治理 catalog 化**：错误模式 + recovery 路径由 Adapter 注入；probe 与 restart 解耦
6. **冷启动行为显式化**：bypass-once 默认 + marker 显式重置两路径
7. **定时任务统一**：3 套合并为 TaskScheduler 注册式调度
8. **Usage 监测与告警拆分**：本地观测（零 token）与主动告警（消耗 token）由两个独立 gate 控制

### 2.2 非目标（明确不做）

| # | 不做的事 | 原因 |
|---|---------|------|
| N1 | **不在 AM 内重做 c4 DB 已覆盖的可靠性** | C4 DB 是消息可靠性边界（accepted-message durability）；AM 不私有受害者识别 ledger |
| N2 | **不记录"消息是否已回复"业务语义** | group / multi-msg / agent 主动消息 / 跨 session 等场景 C4 纯机械层无法稳定判断；维持 v2.1 决断不引入 `terminal_status` / `reply_to_inbound_id` 等字段 |
| N3 | **不引入 reply correlation 强机制（reply command token-passing 等）** | agent 手写 / 复制 / 跨 thread / 主动补充等场景 reply command discipline 易破，配对错从软错（agent 自决策错）变硬错（系统机制错）；R6 production rollback 决断 |
| N4 | **不引入 InputValidator 入口校验** | zylos 当前 multimodal 通过 path-as-text 投递（channel daemon 把附件下载本地后只把路径塞进 c4-receive content），不存在自动 multimodal 注入路径，sticky 4xx 链路不成立 |
| N5 | **不引入 cron 解析器** | `dailyHour` + `intervalSeconds` 覆盖当前需求；最小化外部依赖与测试面 |
| N6 | **不主动 broadcast"我恢复了"** | unhealthy 路径已在 c4-receive 同步返回状态文案；restart 后 agent 看 context 自决策续接；事后再发广播会造成双通知与语义冗余；main 旧的 `pending-channels` 异步恢复路径在本方案下废弃 |
| N7 | **不在 PR #501 同时上 pending exposure 强保证** | 任何"在 c4-session-init 显式注入 unresolved-inbound 列表 + bounded subset + continuation CLI"是产品语义而非 AM refactor 必要前置；不绑入本 PR scope |

非目标会在 §六 方案取舍中给出更详细的 reasoning。

---

## 三、核心设计原则

### 1. 双层正交状态机

ActivityState（进程层）与 HealthState（功能层）之间**零字段互读**。跨模块协作只走两类通道——状态走 SignalStore 只读快照，事件走具名事件接口（如 `setAuthFailed` / `onProcessRestarted` / `triggerRecovery` / `notifyUserMessage`）。

**Guardian 只看 ActivityState**（Offline → 拉起进程，不读 HealthState）。**MessageRouter 只看 HealthState**（决定用户消息处理路径）。**进程拉起 ≠ 健康变化**（restart 后 HealthEngine 从持久化状态回填，不强制置 Unavailable，避免"重启重置故障认知"）。

### 2. C4 DB 是消息可靠性边界

c4-receive 在 health=OK 时把消息写入 c4 DB inbound 即视为 accepted；后续 runtime 异常（包括 sticky API error 触发的 session restart）**不算消息丢失**——既有 inbound 完整保留。AM **不**维护私有受害者识别 ledger（不在 AM scope 重做 c4 DB 已经做的事）。

### 3. 出口治理 catalog 化（probe / restart 解耦）

Layer 2 tmux scan 检测到 API error 时**不硬编码 pattern + action**——通过 Adapter 注入 catalog，HealthEngine 统一 dispatch 到 5 种 recoveryAction（`restart_session` / `probe_only` / `mark_rate_limited` / `mark_auth_failed` / `notify_only`）。**heartbeat / probe 失败不默认 trigger restart**：只有 `restart_session` 路径触发进程重启；其他 action 即使 probe 失败也不 restart（restart 没意义）。

Catalog 是**活的知识库**：unknown error 走 `probe_only` 兜底 + 写入 unknown-error 日志，weekly review 增补 catalog；同时设持续未匹配升级（连续 5 分钟命中）→ 强制 `restart_session` 自愈，避免在 sticky context 下退避永远卡死。

### 4. Unhealthy 路径同步返回状态文案（用既有 c4 接口闭环）

c4-receive 在 health 非 OK 时同步给用户返回状态文案，**全部用既有 c4 接口完成**——既不引入新字段（不引入 `terminal_status` 等）也不发明新投递路径，跟 agent 正常 reply 走同一条 c4-send 路径。

精确机制（DB 双行 / dispatcher 跳过策略 / c4-send spawn 协议）见 §五.2 流程图与 §六.H 取舍——**§六.H 是本约束的唯一权威落点**（zylos0t R6 TODO 1 精确措辞）。

### 5. Session restart continuation 是 best-effort

session_restart 触发后流程：

1. `adapter.stop()` → Guardian 拉新 session
2. c4-session-init 注入 last checkpoint summary + recent unsummarized 对话作为 startup context（既有机制）
3. agent 看 startup context（包括恢复前可能未回复的 inbound）→ **自行判断**是否补 reply
4. **不**主动 broadcast"我恢复了"——unhealthy 时用户已经同步收到状态文案

**Continuation 的 contract 边界**：

- C4 DB 承诺 **accepted-message durability**（已写入的 inbound 不丢）
- restart 后由 c4-session-init recent / unsummarized context + agent 自治做 **best-effort continuation**
- **不承诺 unresolved-inbound completeness**（例如 100+ pending 时 startup context 受 token 预算约束可能截断）
- 接受由此产生的 **residual UX risk**（restart 时刚到达但未投递的消息可能被 agent 漏答；user 凭文案重发是兜底机制）

详 §六.I 取舍说明（zylos0t R6 TODO 2 落点）。

### 6. Hook 路径不变 / 对外契约向后兼容

所有 Hook 脚本物理路径不变，用户 settings 无需修改。对外状态文件加 schema 版本号；新增字段保持向后兼容（消费端遇未知 reason 退化到通用文案不报错）。

---

## 四、总体架构

### 4.1 模块全景（11 业务模块 + 1 Adapter）

按职责划分 11 个业务模块 + 1 个 Adapter DI 层。每模块的具体实现见对应 [模块实施档](activity-monitor/modules/)：

| 模块 | 一句话职责 | 实施档 |
|------|-----------|--------|
| **monitor** | 入口 + 主循环编排 + MessageRouter 宿主进程 | (索引在主循环, 不独立成档) |
| **SignalStore** | 每 tick 开头刷新一次，产出 immutable 信号快照 | [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md) |
| **StatusWriter** | 写对外状态文件（对外契约唯一发布者） | 同上 |
| **Guardian** | 进程存活守护 + 拉起决策 + bypass-once / marker 重置 | [`guardian.md`](activity-monitor/modules/guardian.md) |
| **ProcSampler** | OS 级冻结检测（context switch 采样） | [`tool-pipeline-watchdog-procsampler.md`](activity-monitor/modules/tool-pipeline-watchdog-procsampler.md) |
| **ToolPipeline** | 工具生命周期 + 事件流合成 | 同上 |
| **ToolWatchdog** | 工具超时检测与干预 | 同上 |
| **HealthEngine** | 健康状态机 + 主动探针编排 + api-error catalog dispatch | [`health-engine.md`](activity-monitor/modules/health-engine.md) |
| **TaskScheduler** | 统一定时任务调度器（注册式 + usage 双 gate） | [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md) |
| **MessageRouter** | 用户消息路由（事件驱动，**不在 tick 里**）+ unhealthy queue-status 处理 | [`message-router.md`](activity-monitor/modules/message-router.md) |
| **Adapter** | 运行时差异封装（构造时依赖注入） | [`runtime-adapter.md`](activity-monitor/modules/runtime-adapter.md) |
| **(跨模块契约)** | session restart 后续接 contract + 边界声明 | [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) |

### 4.2 三种通信通道

| 通道 | 用途 | 实现 | 一致性 |
|------|------|------|--------|
| 🔵 **State via SignalStore** | 跨模块共享"当前持续值" | 生产者写文件，SignalStore 每 tick refresh；消费者读快照 | Eventual（≤ 1 tick ≈ 1s） |
| 🔴 **Event via 具名接口** | 跨模块触发"一次性动作" | 单向方法调用 | Synchronous |
| 🟢 **C4 主链** | 用户消息投递 | c4-receive → DB → c4-dispatcher → tmux（健康门控 + priority + require_idle） | — |

**关键不变量**：Guardian 决策闭环中**不同步查询**任何其他模块；HealthEngine 不对外暴露 getter；c4-dispatcher 独占 tmux 写入。

### 4.3 主循环 tick（每秒 8 步）

```
每秒 tick:
 ① SignalStore.refresh         ← 刷新快照
 ② Guardian.tick               ← 进程存活 + 拉起决策
 ③ ProcSampler.tick            ← 冻结检测
 ④ ToolPipeline.tick           ← 工具生命周期 + api-activity 合成
 ⑤ ToolWatchdog.tick           ← 工具超时检测
 ⑥ HealthEngine.tick           ← 健康状态机 + api-error catalog dispatch
 ⑦ TaskScheduler.tick          ← 定时任务调度
 ⑧ StatusWriter.write          ← 写对外状态文件
```

**顺序硬约束**：④ 在 ⑥ 前（健康判定要读工具活动视图）；⑤ 在 ④ 后 ⑥ 前（watchdog 干预可能触发 health 降级）；MessageRouter 不在 tick 里，由 c4-receive IPC 触发。

### 4.4 状态模型

**ActivityState（3 种，无状态投射）**：Offline / Idle / Busy。每 tick 结束时根据当下信号 snapshot 投射，无历史依赖。冻结的瞬态由 ProcSampler 判死后直接 kill，下一 tick 自然投射为 Offline。

**HealthState（4 种，FSM）**：OK / Unavailable / RateLimited / AuthFailed。对外只暴露 `health` + `unavailable_since` 两个字段；不写子状态——消费端读时间戳自行判断文案差分（< 60min 转 ≥ 60min 文案不同）。

详细转换表 / 决策规则 / 字段定义见 [`health-engine.md`](activity-monitor/modules/health-engine.md)。

---

## 五、关键流程

### 5.1 OK 直通路径

```
user → c4-receive (insertConv 'in') → MessageRouter (health=OK) → dispatcher → tmux → agent 实回复
```

agent 看消息回复；DB 既有 inbound 与后续 outbound 完整持久化。runtime 后续异常**不算消息丢失**（参 §三.2、§三.5）。

### 5.2 Unhealthy 同步状态文案路径

进入 c4-receive 后，先经一次 MessageRouter IPC 聚合的 recovery probe，再分 3 路径走。

**Path A — Probe recovers**（API 已恢复）：

```
user → c4-receive → MessageRouter IPC (probe agg)
                                       ↓ recovered=true
                            → 重走 §5.1 OK 直通路径
```

**Path B — Probe fails**（unhealthy 核心路径）：

```
user → c4-receive → MessageRouter IPC (probe agg) → recovered=false
                            ↓
       insertConv('in', ..., status='delivered')   ← 显式覆盖 default 'pending'
                            ↓                       (dispatcher SELECT pending 自然跳过)
       c4-receive 调 c4-send.js (catalog.userMessage)
                            ↓ c4-send 内部：
                              ├── insertConv('out', ..., status='delivered')
                              └── spawn <channel>/scripts/send.js
                            ↓
       user 收到 "bot 状态消息"（跟 agent reply 同路径）
                            ↓
       c4-receive exit 0
```

**Path C — IPC degraded**（MessageRouter 不可达，monitor crash 级罕见异常）：c4-receive 不做"假入队"承诺，文案诚实告知 operator 需要重发。详 §六.D。

**关键约束**（zylos0t R6 TODO 1 精确落点）：

- inbound `status='delivered'` 是显式覆盖 c4-db.js:107 的 default `'pending'`——dispatcher SQL `WHERE status='pending'`（c4-db.js:140）自然跳过这条 inbound
- outbound 通过 c4-send.js 既有接口投递——跟 agent 正常 reply 同路径，**不发明新 path**
- 全程**不引入新字段** `terminal_status`、**不引入 reply correlation token**、**不引入新表 / 新接口**

### 5.3 API error catalog dispatch 路径

```
Layer 2 tmux scan 命中 API error pattern
  → catalog entry lookup
  → 按 entry.recoveryAction 分派：
     ├── restart_session   → adapter.stop + 进 Unavailable + 等 Guardian 拉新 session
     ├── probe_only        → 进 Unavailable + 持续 probe（**不 stop**）
     ├── mark_rate_limited → 进 RateLimited（**不 stop**）
     ├── mark_auth_failed  → 进 AuthFailed（**不 stop**）
     └── notify_only       → 仅 log + 可选用户即时通知（不改 health, 不 stop）
```

5 种 recoveryAction × HealthState 转换 × DB 记录路径的完整矩阵见 [`health-engine.md`](activity-monitor/modules/health-engine.md) §3。

**Unknown 升级路径**：catalog 未匹配但通用 Error/FATAL 命中 → 默认 `probe_only` 兜底 + 写未知错误日志；同一 unknown 错误连续 5min 命中 → 强制升级为 `restart_session` 自愈，防退避永远卡死。

### 5.4 Session restart continuation 路径

```
restart_session 触发
  → adapter.stop
  → Guardian 看 ActivityState=Offline → 拉新 session
  → c4-session-init 注入 startup context (last checkpoint + recent unsummarized)
  → agent 看 context → 自决策是否补 reply
```

**Contract**（zylos0t R6 TODO 2 落点）：

- C4 DB 保 accepted-message durability
- restart 后 best-effort continuation
- 不承诺 unresolved-inbound completeness
- 接受 residual UX risk（user 凭 unhealthy 时已收到的状态文案重发是兜底）

详 [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) §2。

### 5.5 Guardian 冷启动 bypass-once 路径

Guardian 拉起 4 条件（详 [`guardian.md`](activity-monitor/modules/guardian.md) §3）：#1 rate limit / #2 auth retry suppress / #3 restartDelay（指数退避计时器）/ #4 维护窗口互斥锁。"4 字段持久化状态" = 这 4 条件涉及的退避水位与失败计数。

```
AM 冷启动
  ├── marker 文件存在  → 清空 4 字段持久化状态 + unlink marker (one-shot)
  │                      → 关闭 bypass-once → 走 initial_delay
  └── marker 不存在    → 从持久化恢复 4 字段（保留故障认知）
                        → 首次 probe bypass 时间驱动退避（条件 #1/#2/#3）
                        → **不绕** #4 维护窗口（operator 显式语义不能绕）
                        → 成功 → 清空 4 字段
                        → 失败 → 回到持久化退避水位（不退回 initial_delay）
```

详 [`guardian.md`](activity-monitor/modules/guardian.md) §5。

---

## 六、方案取舍

### A. 为什么 HealthState 合并 recovering / down 为 Unavailable

老 health 5 值里 `recovering` 是"暂时重试中"、`down` 是"长期失败"——本质同一恢复流两阶段。`60min` 是 HealthEngine 内部"退避节奏从指数升级到 3600s 固定"的时机阈值（来自历史经验：60min 内还没恢复 = 大概率 sticky / 长期问题，再用快节奏 probe 没意义），却被错误暴露为对外状态枚举值。合并后用 `unavailable_since` 时间戳替代子状态区分——消费端按需做文案差分（< 60min 转 ≥ 60min 时切到"长时间不可用"措辞），对外契约从 5 值收敛到 4 值更简洁。

### B. 为什么 SignalStore 采用 eventual consistency

Guardian → HealthEngine 反向查询路径被消除的代价。原同步内存查询是 O(1) strong consistency；新通道是"写文件 → SignalStore refresh → 读快照"三跳，上界 1 tick (≈1s)——限流解除后 Guardian 最多慢 1s 拉起，代价可控；收益是同步调用路径完全消除，模块独立可测。

### C. 为什么 bypass-once 不是"所有 cold start 清零"

简单"所有清零"无法区分 operator 意图重试（应清零）与 PM2 auto-restart（应保留故障认知）。后者每次从 initial_delay 重爬会对外部 API 产生持续脉冲。marker 文件做 operator 显式 opt-in，两端取得合适语义；marker 用完即焚（one-shot）防止退化为"所有清零"。

### D. 为什么 IPC 降级不入队

原设计 IPC 降级时仍 insertConversation + "消息已入队" 文案是"不丢消息优先"妥协，代价是一条 receive 可能产出 2 条回复（interim error + 后续 AI），违反"一次 c4-receive 一次真实答案"不变量。新设计选择"不做假入队承诺"，文案诚实告知 operator 需要重发。不变量 100% 成立；IPC 降级是 monitor crash 级罕见异常场景，可接受。

### E. 为什么 ActivityState 是无状态投射而不是 FSM

ActivityState 无历史依赖——任何 tick 看到同样信号都得同样 state。FSM 会引入"从自己写的对外状态文件恢复状态"的反向依赖，重启 AM 后可能与现实信号不一致。无状态投射下第一 tick 直接算出真值，契合"进程拉起 ≠ 健康变化"哲学。

### F. 为什么不引入 cron 解析器

依赖最小化 + 可测试。cron 库约 50KB 代码，表达式解析有 bug 历史。`dailyHour` + `intervalSeconds` 两字段语义明确，测试只需 mock 时间。未来如有"每周三 03:00"需求加 `weeklySchedule` 字段即可。

### G. 为什么不引入 reply-resolution / terminal_status / token-passing 整套（R6 production rollback 决断）

PR #501 早期 R3+R4+R5 演进路径尝试在 C4 DB 引入 reply-resolution 整套（`terminal_status` / `reply_to_inbound_id` / `claimed_at` 字段 + reply command token-passing + C-Term-1~5 单调 invariant + hard/soft 两层校验 + bounded pending exposure CLI），R6 production trade-off 评估后整套退出 baseline——核心五点：(1) **违背 prior decision**：早期讨论已明确"C4 不记录消息已回复状态"，R3 把 C4 纯机械层升级为业务语义；(2) **discipline 假设过强**：token-passing 假设 agent / dispatcher / channel daemon 都按规矩玩，agent 手写命令 / 跨 thread 回复 / 主动补充任一场景 break 即出现 stale/missing/mismatch，配对错从 v2.1 的"软错"（agent 自决策）变"硬错"（系统机制写错 DB）；(3) **state 矩阵未拼完**：R3+R4 引入字段跟既有 `conversations.status`（pending / running / delivered / failed）交互**完全未讨论**，5 轮 review 未抓到 blind spot；(4) **大机制解小问题**：unhealthy status reply 真正需求是"状态文案返回后 inbound 不进 dispatcher 主队列"——用既有 `status='delivered'` 显式覆盖即解（§六.H），无需 terminal_status 全套；(5) **scope 蔓延**：pending exposure 是产品语义不是 AM refactor 必要前置，塞进 PR #501 会让 refactor 变成 C4 reply ledger 重构。

R6 决断保留 v2.1 已收敛的所有有效产物（catalog-driven api error / probe-restart 解耦 / 11 模块拆分 / bypass-once+marker / usage 双 gate），仅退出 R3+R4+R5 增量。本 v3.1 在此决断基础上做 spec 化 + 落地 §六.H、§六.I 两条窄修订。

### H. zylos0t R6 TODO 1：Unhealthy inbound 用 status='delivered' 表达非待投递（精确措辞）

**问题**：v2.1 多处描述 unhealthy 路径写入 `insertConv('in') + insertConv('out', 状态文案)`，但**没有显式声明**这条 inbound 在 dispatcher 视角的处理状态——理论上 dispatcher 看 inbound queue 仍可能尝试再次投递，造成双答（status outbound 已发 + dispatcher 又投递 → agent 又答一次）。

**精确收敛**：用既有 `conversations.status` 字段（不引入新字段），c4-receive 调 `insertConversation('in', channel, endpoint, content, 'delivered')`——第 5 个参数**显式覆盖 default 'pending'**，dispatcher SQL `getNextPending: WHERE direction='in' AND status='pending'`（c4-db.js:140）自然跳过这条 inbound。

**为什么用 `'delivered'` 而不是新 enum 值**：DB 双行（inbound + outbound 都 `status='delivered'`）保留完整 DB 留痕——dispatcher 不需要任何额外判断逻辑（既有 `WHERE status='pending'` 自然跳过 inbound），**零新概念**。`'delivered'` 是 c4-db.js:107 outbound default 已经在用的值，复用不增 enum。模块档（message-router.md §4 / c4-receive-adaptation.md §5）描述 DB 留痕时用 "audit trail" 是中性技术术语，不是 status 字段值。

**outbound 走 c4-send.js 既有接口**：c4-receive 调用 `c4-send.js` 投递 catalog.userMessage——c4-send.js 内部完成 outbound DB 行写入（status='delivered' 默认）+ spawn `<channel>/scripts/send.js` 实际投递。**不发明新接口**——AM scope 内不直接管 channel 投递；用户感知统一为"bot 发的消息"，跟 agent 正常 reply 同路径。

**为什么不引入 terminal_status**：`terminal_status` 把"是否已回复"做成 C4 业务语义，而 group / multi-msg / agent 主动消息等场景这件事 C4 纯机械层无法稳定判断（参 §六.G #1）。本 TODO 用既有 queue status + 既有 c4-send 接口的窄修订，避免再次进入 reply-resolution scope。

**落点**：[`message-router.md`](activity-monitor/modules/message-router.md) §3 不变量 + §5 c4-receive 适配（含调 c4-send.js 流程）；[`health-engine.md`](activity-monitor/modules/health-engine.md) §3 catalog × HealthState × DB 路径矩阵；Phase 3 c4-receive 改造说明（§八）。

### I. zylos0t R6 TODO 2：Session restart continuation 降级 best-effort

**问题**：v2.1 §5.3.2 表述"c4 DB + c4-session-init 已经覆盖正确性边界"过强——v2.1 明确不做 unanswered-inbound 注入，只靠 c4-session-init 的 checkpoint summary + unsummarized / recent context。但 recent context 受 token 预算约束（典型 6 条），100+ pending 时不能完整暴露。

**收敛**：把 contract 拆为 3 句：

1. **C4 DB 保 accepted-message durability**——已 insertConv 的 inbound 不丢
2. **restart 后 best-effort continuation**——c4-session-init recent / unsummarized + agent 自治
3. **不承诺 unresolved-inbound completeness**——接受 residual UX risk（user 凭 unhealthy 时已收到的状态文案重发是兜底）

**为什么不补 unresolved-inbound 完整注入**：要求 100% 完整性等于回到 R3 引入 terminal_status / pending exposure 整套（参 §六.G #5）。本 TODO 走"诚实声明边界"的窄修订，把 production trade-off 写在 contract 里，避免假装承诺。

**落点**：[`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) §2 不变量 + §5 边界声明；本文件 §三.5。

---

## 七、模块实施档索引

每份模块档按 [`tech-doc-spec`](../.claude/skills/tech-doc-spec/SKILL.md) 8 项结构（职责边界 / 输入输出契约 / 数据结构 / 关键接口 / 错误处理 / 迁移策略 / 测试策略 / 跨模块依赖）独立可加载。本节给出索引；具体实施细节去对应模块档读。

| # | 模块档 | 涵盖模块 | 一句话核心 |
|---|--------|---------|----------|
| 1 | [`runtime-adapter.md`](activity-monitor/modules/runtime-adapter.md) | Adapter | DI 注入入口 + 6 类运行时接口（标识 / 进程 / 健康 / catalog / 差异 / 消息）；加新 runtime 流程 |
| 2 | [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md) | SignalStore + StatusWriter | 13 状态文件统一快照层 + 对外 schema（含 `schema_version` / `unavailable_since`）|
| 3 | [`guardian.md`](activity-monitor/modules/guardian.md) | Guardian | 4 拉起条件 + 指数退避；bypass-once + marker 三场景 |
| 4 | [`health-engine.md`](activity-monitor/modules/health-engine.md) | HealthEngine | 4-state FSM + 3 层健康监控；catalog-driven dispatch × 5 recoveryAction × DB 路径矩阵；unknown 5min 升级 |
| 5 | [`tool-pipeline-watchdog-procsampler.md`](activity-monitor/modules/tool-pipeline-watchdog-procsampler.md) | ProcSampler + ToolPipeline + ToolWatchdog | 三模块物理共置；5-stage watchdog；60s 滑动窗冻结判定 |
| 6 | [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md) | TaskScheduler | 注册式调度 + 7 任务清单；usage-monitor / usage-alerter 双 gate 拆分 |
| 7 | [`message-router.md`](activity-monitor/modules/message-router.md) | MessageRouter | 4 约束 C1~C4；4 路径（OK / Unhealthy / Probe-recovered / IPC-down）；**unhealthy `status='delivered'` + c4-send.js 投递**（§六.H 落点）|
| 8 | [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) | (跨模块契约) | restart 后 startup context 注入 + agent 自治续接边界；**best-effort 三句契约**（§六.I 落点）|
| 9 | [`c4-receive-adaptation.md`](activity-monitor/modules/c4-receive-adaptation.md) | (跨组件契约：comm-bridge) | c4-receive Phase 3 改造范围 + vs main 路径精确对比；MessageRouter IPC + c4-send spawn 协议 |

**移除的模块档**（R3+R4+R5 引入，R6 production rollback 决断后退出）：

- ❌ `c4-reliability-contract.md` — 三层契约（durability + terminal_status + unresolved-inbound exposure）整套；本方案下 durability 由 §三.2 + 模块档 7 cover，terminal_status / unresolved-inbound exposure 不进 baseline

---

## 八、迁移路线图 + 兼容性 + 回滚

### 8.1 落地阶段

| Phase | 范围 | 关键改动 |
|-------|------|---------|
| **Phase 0** | Watchdog 边界适配 | 内部语义不动；ToolPipeline 物理合并；Adapter DI 接管工具规则 |
| **Phase 1** | 基础设施 | 新建 SignalStore / StatusWriter / TaskScheduler + 7 任务文件；feature flag 挂接，独立可 ship |
| **Phase 2** | 状态模型 + 组件拆分 | 新建 Guardian + HealthEngine + 新主循环；catalog-driven dispatch + unknown 5min 升级；保留 legacy 入口作回滚路径 |
| **Phase 3** | 消息路由 + c4-receive 适配 | MessageRouter IPC；c4-receive 同步等 + unhealthy 路径 `insertConv('in', ..., 'delivered')` 显式覆盖 + spawn c4-send 投递 catalog.userMessage（§六.H 落地，详 [`c4-receive-adaptation.md`](activity-monitor/modules/c4-receive-adaptation.md)）；c4-dispatcher 适配新 health 值域 |
| **Phase 4** | Schema + 下游文案 | 对外状态文件 schema_version；c4-receive 按 unavailable_since 差分文案；web-console |
| **Phase 5** | 收尾 | 观察 1 周稳定后删除 legacy 入口；全量回归 |

具体每 Phase 的任务列表 / 测试矩阵 / 验收标准下放到对应 [模块实施档](activity-monitor/modules/) §6 迁移策略 + §7 测试策略。

### 8.2 兼容性

- **Hook 路径完全不变** → 用户 settings 无需修改
- **对外状态文件加 schema_version**，新增字段保持向后兼容；消费端遇未知 reason 退化通用文案不报错
- **AM 与 comm-bridge 同版发布**（monorepo 单包），无需灰度兼容窗口
- **config 保留旧字段** + 新增 per-runtime Grace 参数；usage 拆分采升级兼容路径 B（旧 config `usage_monitor_enabled=true` 时新版 default `usage_alert_enabled=false`，启动 warning 鼓励 opt-in）

### 8.3 回滚

PM2 启动参数切换回 legacy 入口即可，无需代码回滚。Phase 2 起 legacy 入口与新入口共存，Phase 5 才删除 legacy。

### 8.4 Phase 3 实施期待决议项（cold-reader audit 标的 ambiguity）

下列 5 处 design decision 在本顶层方案 + 当前模块档中**有意未钉死**——属于"实施时按 production reality 决"的范畴，不是 spec gap。Phase 3 commit 时由实施者拍板并把决议落到对应模块档：

| # | 待决议项 | 落点模块档 | 决议范围 |
|---|---------|-----------|---------|
| 1 | **MessageRouter IPC socket 路径 + 连接契约** | `message-router.md` §4 | Unix domain socket 具体路径（候选：`~/zylos/activity-monitor/router.sock`）；连接超时；序列化协议（JSON / msgpack） |
| 2 | **c4-receive 怎么拿到 `catalog.userMessage` 文案** | `c4-receive-adaptation.md` §3 | 候选：(a) MessageRouter IPC 响应里附带 catalog entry / (b) c4-receive 自己 import `runtime-adapter.js` 拿 catalog / (c) 通过 `agent-status.json` 的 `unavailable_reason` 字段查 catalog 副本 |
| 3 | **StatusWriter 是 unconditional write 还是 change-only** | `signal-store-and-status-writer.md` §4 | tick 末尾每次都 fsync 写 `agent-status.json`（每秒 1 次小 IO）vs 仅 changed 字段 diff 后写（节省 IO 但增加 diff 复杂度）|
| 4 | **unknown 5min 升级为 `restart_session` 后再 OK 时 reset 节奏** | `health-engine.md` §3 | 升级是 in-memory `unknownErrorStreakCount` 触发的临时 action override；OK probe 成功后是立即 reset 计数，还是冷却几个 tick 防 flapping |
| 5 | **`c4-session-init` 触发 scope** | `session-restart-continuation.md` §2 | 既有 hook 是每个 tmux session start 都跑，还是只在 specific restart kind 下跑；本方案不改这个 hook 但 startup context 注入行为依赖此 scope |

这些 ambiguity 不是 design 问题——是"现在过早钉死会制造 churn / 实施时按一手代码 reality 选"的 deliberate deferral。明确记在这里避免 reviewer 误以为是 spec gap。

---

*主笔 zylos01；代码层细节 / 设计审查 zylos0t。本文件按 [`tech-doc-spec`](../.claude/skills/tech-doc-spec/SKILL.md) 两层格式（PR #501 R1 review 后规范）产出；按 [`doc-coauthoring`](https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring) 工作流做了三轮 readability 升级（v3 → v3.1 密度修订 → v3.2 cold-reader audit 后整改 vocabulary + narrative + motivation 三层 gap）。*

*v2.1 是面向 reviewer 的详细稿；本 v3.2 是规范化的顶层方案档（去除字段 / 接口 / 测试细节，下放到 [模块实施档](activity-monitor/modules/)）。design decision 与 v2.1 / v3 / v3.1 完全一致。*
