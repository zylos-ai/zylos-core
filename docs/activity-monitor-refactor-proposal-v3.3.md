# Activity Monitor 重构方案 v3.3 — 📝 REVIEW DRAFT (按 Simon Brown C4 model 4 层缩放重组)

> 日期：2026-04-28（基于 v3.2 commit `c4b123c` 按 C4 model 重组）
> 分支：`docs/activity-monitor-refactor-proposal`
>
> **本文件状态：📝 REVIEW DRAFT**——拟替换 v3.2.md
>
> ---
>
> ⚠️ **命名 collision——两个不同的 "C4"**：
>
> | 词 | 含义 |
> |---|---|
> | **C4 model** / **Level 1-4** | Simon Brown 软件架构 4 层缩放方法（Context / Containers / Components / Code）；本文用此组织顶层结构 |
> | **C4 主链** / **C4 DB** / **c4-receive** / **c4-send** / **c4-dispatcher** / **c4-session-init** | zylos comm-bridge 组件（component-numbering 系统中的 #4）；负责所有外部通信 |
>
> 行文中：用"C4 model"或"Level N"特指 Simon Brown 架构方法；用"zylos C4"或"C4 主链"特指 comm-bridge。
>
> ---
>
> **v3.3 是排版任务，不是 design 修订**——所有 design decision 与 v2.1 / v3 / v3.1 / v3.2 完全一致：v2.1 baseline + zylos0t R6 两条窄 contract 修订（§五.H、§五.I）；R3+R4+R5 reply-resolution 整套不进 baseline（§五.G）。
>
> **本次相对 v3.2 的结构改动（按 C4 model 4 层重组）**：
>
> | v3.2 节（旧） | v3.3 节（新）| 内容动作 |
> |---|---|---|
> | 〇 故事式 TL;DR | §〇 motivation（7 runtime 失败模式）+ §二 Level 2 dynamic flow | 故事拆开：失败模式归因 §〇；Sarah 发 hi 走 containers 的 dynamic 图归 §二 |
> | 一 失败模式 + 痛点 | §〇 motivation 保留 7 模式；8 痛点融入 §一 Context | - |
> | 二 目标 / 非目标 | §一 Context 中"AM 边界"+ §五 Trade-offs | 目标融入 Context；非目标融入边界声明 |
> | 三 核心设计原则 | §三 Components 引言 + §五 Trade-offs | 6 原则散到对应 components / trade-offs |
> | 四 总体架构 | §三 Level 3 Components | 模块全景 + tick 8 步 + 通信通道 + 状态模型全归 §三 |
> | 五 关键流程 | §二 Level 2 dynamic + §四 Level 4 Code 子节 | OK / Unhealthy / catalog / restart / bypass-once 5 流程按缩放层归位 |
> | 六 方案取舍 | §五 Trade-offs（renumber）| - |
> | 七 模块档索引 | §七 模块档索引（不变）| - |
> | 八 迁移 / 兼容 / 回滚 / TODOs | §六 Migration（renumber）| - |
>
> **历史版本归属**（review pass 后切到本文件作为 baseline 时一并升降级）：
> - v2.1 [`...-v2.1.md`](activity-monitor-refactor-proposal-v2.1.md) — **当前 IMPLEMENTATION BASELINE**，本文件 review pass 后转为 SUPERSEDED-by-content
> - v3 / v3.1 / v3.2 — design 等同的早期排版稿，review pass 后均 SUPERSEDED-by-content
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
- **bypass-once / marker**: AM 冷启动后给首次 probe 一次绕过持久化退避的机会（marker 文件 = operator 通过 `zylos am reset-backoff` CLI 创建的 one-shot 全清零标志）；详 §四.2、§五.C
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
 a711212)                   landed 9 modules + R6 两条窄 contract 修订（§五.H、§五.I）
                              │
v3.1 (9f770f6)         ──── 按 doc-coauthoring 工作流做 6 处密度修订（TL;DR 7→4 / 流程图拆分 / §五.G 压缩 等）
                              │
v3.2 (c4b123c)         ──── cold-reader audit 后整改 vocabulary + narrative + motivation gap：
                            §预 onboarding + 故事式 §〇 + 失败模式 §一 + audit 不一致修复
                              │
v3.3 (本文)            ──── 按 Simon Brown C4 model 4 层缩放重组：§一 Context / §二 Containers /
                            §三 Components / §四 Code；故事图归 §二 dynamic flow，模块全景归 §三，
                            FSM / signal inventory 等代码层归 §四
```

**Reviewer 标记**（在 PR #501 review 历史里你会看到）：

- `R3` / `R4` / `R5` = review round 3/4/5 时被引入的设计增量（已被 R6 全套 rollback）
- `R6` = production rollback，把 R3+R4+R5 增量退出 + 强制 v3 改回排版任务
- `Direction D` = v2.1 §5.3.2 收敛的"不引入受害者识别 ledger / 不主动 broadcast / 用户自治补答"哲学
- `zylos0t R6 TODO 1 / TODO 2` = R6 后 zylos0t 提的两条窄 contract 修订（详 §五.H、§五.I）

---

## 〇、Why AM refactor — 7 失败模式 + 8 结构痛点

### 0.1 7 种 runtime 失败模式（motivation A：AM 守的是什么）

| # | 失败模式 | 触发场景 | 用户感知 | AM 该做什么 (recoveryAction) |
|---|---------|---------|---------|------------|
| F1 | **进程死亡** | runtime 进程崩溃 / 被 kill / OOM | 没人回复 | 拉起新 session（Guardian, 不走 catalog）|
| F2 | **OS 级冻结** | 进程在但 CPU 不调度（死锁 / IO 卡死 / context switch 停摆）| 没人回复但进程"活着" | 检测后强 kill + 拉起（ProcSampler）|
| F3 | **Sticky 4xx**（context-poison）| 历史对话某条 input 触发 `APIError: 400` / `context_length_exceeded`，**同 session 不修内容永远报错** | 一直收到错误 | restart 新 session 让 c4-session-init 注入精简 context (`restart_session`) |
| F4 | **Transient 5xx**（暂时性过载）| API 临时 503 / overloaded_error | 暂时无法回复 | 不 restart，持续 probe + 同步给用户状态文案 (`probe_only`) |
| F5 | **Rate limit** | API 限流（运营商发的 limit 信号）| 暂时无法回复 + 知道何时恢复 | 进 RateLimited + 状态文案带恢复时间 (`mark_rate_limited`) |
| F6 | **Auth fail** | API key 过期 / 撤销 | 一直 401 | 进 AuthFailed + 通知 operator + 不消耗 token 重试 (`mark_auth_failed`) |
| F7 | **Content filter** | 响应被 policy 拦截 | 单次拒绝下次 OK | 不改 health，仅 log + 可选用户即时通知 (`notify_only`) |

每种模式都需要：(a) **检测路径**（probe 类型 / scan pattern），(b) **recovery 决策**（restart vs 等 vs mark），(c) **用户感知策略**（沉默 vs 同步状态文案）。AM 把这些抽成 catalog（每条 entry = `{pattern, recoveryAction, userMessage}`）让 7 种模式可统一 dispatch。

### 0.2 8 个结构性痛点（motivation B：现状代码为什么不够）

cover 这 7 种模式的逻辑现在全挤在单文件 `activity-monitor.js` 2300+ 行：

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态语义不清** | health 5 值（ok / recovering / down / rate_limited / auth_failed），其中 recovering 与 down 本质同一恢复流两阶段 |
| 2 | **Guardian ↔ HeartbeatEngine 紧耦合** | 共享 5 字段，跨模块直接读写，难独立测试 |
| 3 | **多套退避机制各自为政** | restart / recovery / auth retry / user cooldown / tool watchdog 语义不一致 |
| 4 | **God Object** | 单文件 2300+ 行塞 Guardian / 健康检查 / 工具 watchdog / 调度 |
| 5 | **Watchdog 子系统游离** | PR #500 引入的工具生命周期 + 事件流主循环深度集成但无模块边界 |
| 6 | **定时任务 ad-hoc** | DailySchedule / 间隔 timestamp / 独立状态机三套混用 |
| 7 | **信号消费散落** | 12+ 状态文件主循环各处 readJSON，无统一快照层 |
| 8 | **AM 冷启动不分重启前后文与故障重试** | 持久化长退避压制首次 probe；daily-upgrade 修好根因后仍要等退避到期 |

**不解决的代价**：每加一类 runtime 错误（往 §0.1 表里加一行）、每加一个定时任务、每改一个 health 子状态——都要碰 5 处；测试只能 E2E 不能单元。

### 0.3 一句话方案

抽 §0.1 的 7 模式 → catalog；解 §0.2 的 8 痛点 → 拆 11 模块 + 状态机正交。具体设计按 C4 model 4 层缩放展开：**§一 Context**（系统鸟瞰，AM 是 1 个 box）→ **§二 Containers**（zoom AM 周边 7 个 container + 4 路径 dynamic flow）→ **§三 Components**（zoom AM 内 11 modules + tick 8 步 + 通信通道）→ **§四 Code**（5 个关键 component 代码层细节）。

---

## 一、Level 1: System Context — AM 在 zylos 系统的位置

**这一层回答**：从最高空鸟瞰 AM。**不见模块名 / 不见 c4-* 内部 / 不见代码**——纯黑盒视角。

### 1.1 Context 图

```
                           ┌──────────────────┐
                           │   USER (Sarah)   │
                           │ via lark / TG /  │
                           │   web-console    │
                           └────────┬─────────┘
                                    │ 发消息 / 收消息
                                    ▼
                       ┌───────────────────────────┐
                       │  Channel daemon (long-run)│
                       │  lark-bot / telegram-bot /│
                       │  web-console-server / ... │
                       └─────────────┬─────────────┘
                                     │
                            (per-msg) spawn / API
                                     │
                                     ▼
   ┌─────────────┐         ┌─────────────────────┐         ┌───────────────────────┐
   │   PM2       │ manage  │   ACTIVITY MONITOR  │ 守护      │   Runtime              │
   │ (process    │────────►│   (this proposal)   │─────────►│  Claude / Codex CLI   │
   │  manager)   │         │   black box at L1   │ spawn /  │  in tmux session      │
   └─────────────┘         └─────────┬───────────┘ probe    └─────────┬─────────────┘
                                     │                                │
                              读写 PM2 / tmux                          │ runtime 反向
                              调 Adapter 命令                          │ 调 c4-send 投递
                                     ▼                                │ outbound
                            ┌────────────────┐                        │
                            │ OS / tmux /PM2 │                        │
                            └────────────────┘                        │
   ┌──────────────┐                          ┌──────────────────────┐ │
   │   C4 DB      │   c4-receive 写 inbound   │   zylos C4 主链       │ │
   │  (SQLite)    │◄─────────────────────────┤   (c4-receive,       │◄┘
   │ comm-bridge/ │   c4-send 写 outbound     │   c4-send,           │
   │   c4.db      │   c4-dispatcher SELECT    │   c4-dispatcher,     │
   └──────────────┘                          │   c4-session-init)   │
                                             └──────────────────────┘
```

### 1.2 各 actor 的职责

| Actor | 类型 | 跟 AM 的关系 |
|-------|------|------------|
| **User** | 外部人 | 间接交互——通过 channel 发消息；AM 仅在 unhealthy 时给用户返同步状态文案 |
| **Channel daemon** | long-running 进程 | 每条消息 spawn `c4-receive`；通过 c4-receive 间接查 AM 健康 |
| **Runtime (Claude / Codex)** | long-running CLI in tmux | AM 守护对象：拉起 / 健康检测 / 错误识别 / 限流监测 |
| **PM2** | 第三方服务管理器 | 守护 AM 自己 + channel daemon 等服务（reboot 后 resurrect 全部）|
| **OS / tmux** | 系统层 | runtime 跑在 tmux session；AM 通过 `tmux send-keys` / `capture-pane` 读写 |
| **C4 DB / 主链 (zylos C4)** | comm-bridge 组件 | 消息可靠性边界——c4-receive 接受写入即 durable；AM unhealthy 路径走 c4-send.js 同步返状态文案 |

### 1.3 AM 的边界（高层声明）

**AM 做**：

- 守护 runtime 进程（拉起 / 拒绝 / 探活 / 错误模式识别 / 限流认知）
- 把 runtime 健康状态发布给消费者（c4-receive / c4-dispatcher / web-console）
- 调度跟 runtime 相关的定时任务（cleanup / daily-upgrade / usage 监测）

**AM 不做**（关键 design boundary）：

- ❌ 不维护"消息是否已回复"业务语义（C4 DB 是消息可靠性边界，不重做；§五.G）
- ❌ 不维护私有受害者识别 ledger（agent 看 c4-session-init context 自治续接）
- ❌ 不主动 broadcast"我恢复了"（unhealthy 时已同步返状态文案；R6 rollback + Direction D）
- ❌ 不引入 reply correlation 强机制（terminal_status / token-passing / C-Term-1~5 等；§五.G）
- ❌ 不引入 InputValidator 入口校验（zylos 用 path-as-text，无 multimodal 自动注入；§五.G）

### 1.4 关键不变量（黑盒视角）

- **C4 DB 是消息可靠性边界**：c4-receive 接受写入即 durable，runtime 异常**不算消息丢失**
- **tmux 是唯一 runtime IO 通道**：所有给 agent 的输入只通过 `tmux send-keys` 注入
- **Hook 路径不变**：用户 settings.json 不需修改
- **进程拉起 ≠ 健康变化**：restart 后 HealthEngine 从持久化回填，不强制置 Unavailable

---

## 二、Level 2: Containers — AM 周边的容器视图

**这一层回答**：把 §一 的 "ACTIVITY MONITOR" 黑盒打开一格，看 AM 是哪些 deployment containers 组成；同时显示 AM 跟 zylos C4 几个脚本 / DB / runtime 之间的细节交互协议。**仍不见模块内部 / 仍不见代码**——只看 container 边界与协议。

### 2.1 Container 图

```
External (from §一)
│
├──► [Channel daemon: lark/telegram/...] ─spawn(per-msg)─► [c4-receive (per-msg script)]
│                                                              │
│                          IPC: are you healthy?               ▼
│                          ┌──────────────────────────────────────────┐
│                          │   AM PM2 service (long-running)          │
│                          │   ┌─────────────────────────────────┐    │
│                          │   │ monitor.js (orchestrator)        │    │
│                          │   │  tick = 1s, 8 steps              │    │
│                          │   │  + MessageRouter (IPC server)    │    │
│                          │   └─────────────────────────────────┘    │
│                          │   ┌─────────────────────────────────┐    │
│ MessageRouter            │   │ Persisted state files            │    │
│ Unix socket ─────────────┤   │ ~/zylos/activity-monitor/        │    │
│                          │   │  guardian-state.json             │    │
│                          │   │  agent-status.json               │    │
│                          │   │  rate-limit-state.json           │    │
│                          │   │  .reset-request (marker)         │    │
│                          │   │  …~13 files total                │    │
│                          │   └─────────────────────────────────┘    │
│                          └──────────┬──────────────┬────────────────┘
│                                     │              │
│                          Adapter.spawn /             │ 读写 (tmux)
│                          .stop / send-keys           │
│                                     ▼              ▼
│ [c4-receive] ─writes inbound─►              ┌────────────────────────┐
│             ─unhealthy: spawn c4-send       │ Runtime tmux session   │
│                                             │ (Claude/Codex CLI)     │
│ [c4-send] ─writes outbound─►                │  capture-pane (scan)   │
│           ─spawn channel/send.js─► User     │  send-keys (input)     │
│                                             └─────────┬──────────────┘
│                                                       │
│                                                       │ runtime 反向
│                                                       │ 调 c4-send.js
│                                                       │
│                                                       ▼
│  ┌──────────────────────┐               ┌────────────────────────┐
│  │   c4-dispatcher      │  poll pending │   C4 DB (SQLite)       │
│  │   (long-running)     │◄──────────────┤   conversations table  │
│  │   - 健康门控          │   inbound row │   direction (in/out)   │
│  │   - priority         │   inserts     │   status (pending /    │
│  │   - require_idle     │               │   running / delivered /│
│  │   - tmux send-keys   │               │   failed)              │
│  └──────────┬───────────┘               └────────────────────────┘
│             │
│ (OK 路径)   │ tmux send-keys 注入 inbound
│             ▼
└──────► [Runtime tmux session]
```

### 2.2 Container 清单

**AM 自身的 container**：

| Container | 类型 | 描述 |
|-----------|------|------|
| **AM PM2 service** | Node.js long-running 进程 | `monitor.js` 入口；tick 1s 8 步流水线 + MessageRouter IPC server。本提案的核心 |
| **MessageRouter IPC socket** | Unix domain socket | 监听 c4-receive 健康查询；事件驱动（不在 tick 里）。具体路径 / 序列化协议 Phase 3 决（§七.4 TODO #1）|
| **Persisted state files** | JSON / JSONL 文件 | `~/zylos/activity-monitor/` 下 ~13 状态档 |

**AM 交互的 container**（在 §一 Context 之下、§二 这层显式）：

| Container | 类型 | AM 跟它的关系 |
|-----------|------|------------|
| **c4-receive** | per-msg 短命脚本 | 通过 IPC 查 AM；AM 给"健康"回应；unhealthy 时 c4-receive 调 c4-send 返状态文案 |
| **c4-send** | per-call 短命脚本 | 不直接交互——c4-receive（unhealthy）和 runtime（agent reply）都调它 |
| **c4-dispatcher** | long-running daemon | 跟 AM 不直接 IPC——通过读 `agent-status.json`（StatusWriter 写）做健康门控 |
| **c4-session-init** | session-start hook | 跟 AM 不直接交互——runtime restart 后由 hook 自己跑，注入 startup context |
| **c4 DB (SQLite)** | 文件数据库 | AM 不直接读写；通过 c4-* 脚本间接落 inbound / outbound |
| **Runtime tmux session** | tmux session 内 CLI | AM 直接读写：tmux capture-pane / send-keys / Adapter spawn / Adapter stop |
| **Channel daemon** | long-running poller | AM 不直接交互——只通过 c4-receive 间接（每条消息）|
| **PM2 daemon** | system process manager | 守护 AM 自己；AM 不主动跟 PM2 交互 |

### 2.3 Container 层 dynamic：Sarah 发 "hi" 走 4 路径

把 §〇 的 7 失败模式 instantiate 到具体场景，在 container 层级走 4 条路径。

**Path 1 — happy path**（health=OK）

```
Sarah ─"hi"─► [Telegram daemon] ─spawn─► [c4-receive]
                                              │
                       IPC: health? ──────────►│
                                       [AM PM2] reply: yes
                                              │
                       insertConv('in',...,'pending') → [C4 DB]
                                              │
                       c4-receive exit 0      │
                                              │
                       poll pending ──────────│
                                              ▼
                                     [c4-dispatcher]
                                              │
                              健康门控 OK + priority + require_idle
                                              │
                                  tmux send-keys "hi"
                                              ▼
                               [Runtime tmux session]
                                              │
                               agent 回复 "Hi there!" 调 c4-send
                                              ▼
                                          [c4-send]
                                              │
                          insertConv('out',...,'delivered') + spawn telegram/send.js
                                              ▼
                                    [Telegram daemon] ──API──► Sarah
```

**Path 2 — probe-recovers**（health=Unavailable but recovers in <30s）

```
Sarah ─"hi"─► [Telegram daemon] ─spawn─► [c4-receive]
                                              │
                       IPC: health? ──────────►│
                                       [AM PM2] health=Unavailable
                                              │ MessageRouter 触发 recovery probe (聚合)
                                              │ ... 5s ...
                                              │ probe success
                                              ▼
                              IPC reply: "OK 了"
                                              │
                                              │ → 走 Path 1 后续
```

**Path 3 — probe-fails**（health=Unavailable, probe also fails）

```
Sarah ─"hi"─► [Telegram daemon] ─spawn─► [c4-receive]
                                              │
                       IPC: health? ──────────►│
                                       [AM PM2] probe 失败 (≤30s timeout)
                                              ▼
                       IPC reply: "still unhealthy, reason=transient_overload"
                                              │
                       insertConv('in',...,'delivered')      ← 显式 'delivered'
                                              │                  覆盖 default 'pending'
                                              ▼                  (dispatcher SELECT pending 自然跳过)
                                          [C4 DB]
                                              │
                       c4-receive 调 c4-send "API 暂时繁忙..."
                                              ▼
                                          [c4-send]
                                              │
                          insertConv('out',...,'delivered') + spawn telegram/send.js
                                              ▼
                                    [Telegram daemon] ──API──► Sarah 收到状态文案
```

**Path 4 — sticky 4xx → restart_session**（catastrophic）

时间锚点：Sarah 这次发 "hi" = `T=0`；之前 180 秒前一条消息触发 sticky API error。

```
[T-180s] [Runtime tmux session] 触发 sticky APIError: 400
         → AM HealthEngine Layer 2 tmux scan 命中 catalog 'corrupted_context'
         → recoveryAction = restart_session
         → AM 调 Adapter.stop() 让 runtime tmux session 退出
         → AM Guardian 看 ActivityState=Offline 拉新 session

[T-179s] [新 Runtime tmux session] 启动
         → c4-session-init hook 自动跑，注入 startup context
         → agent 看 context 自决策是否补回复

[T-178s] HealthEngine 进入 launchGrace 期（180s 内不主动 probe）

[T=0]    Sarah ─"hi"─► [Telegram daemon] ─spawn─► [c4-receive]
         → IPC 查 health → 此时仍 Unavailable（launchGrace 几秒残余）
         → 走 Path 3（同步状态文案）

[T+几秒] launchGrace 出 → 第一次 probe 成功 → health=OK
         → Sarah 后续 message 走 Path 1
```

### 2.4 Container 层关键不变量

- **C4 DB 是 unique 持久化点**：所有 inbound/outbound 都通过 c4-* 脚本进 SQLite；AM 不直接写 c4 DB
- **c4-send 是 outbound 唯一 writer**：runtime（agent reply）和 c4-receive（unhealthy 状态文案）都调它；AM scope 内不直接管 channel 投递
- **tmux 是 unique runtime 输入通道**：c4-dispatcher（OK 路径）和 Adapter spawn（restart 路径）都通过 `tmux send-keys`；AM scope 内不绕过
- **MessageRouter IPC 是 unique 健康查询通道**：c4-receive 不读 `agent-status.json`（避免 read-time race），统一走 IPC；c4-dispatcher 因 long-running 才读 file（异步消费 OK）

---

## 三、Level 3: Components — AM 内的 11 个 component

**这一层回答**：打开 §二 的 "AM PM2 service" 容器，看里面 11 个 component 各自是什么 / 怎么协作。**见模块名 / 见接口 / 见 tick 顺序 / 不见代码细节**。

### 3.1 Component 全景图

```
              ┌──────────────────────────────────────────────────────┐
              │   AM PM2 service (single Node.js process)            │
              │                                                      │
              │   monitor.js (orchestrator)                          │
              │   ├─ DI: 构造时注入 Adapter → 各 module               │
              │   ├─ tick loop (1Hz, 8 steps fixed order)            │
              │   └─ host MessageRouter IPC server (not in tick)     │
              │                                                      │
              │   ┌────────────────────────────────────────────┐    │
              │   │ tick 序列 (每秒 8 步, 顺序硬约束):           │    │
              │   │   ① SignalStore.refresh                    │    │
              │   │   ② Guardian.tick                          │    │
              │   │   ③ ProcSampler.tick                       │    │
              │   │   ④ ToolPipeline.tick                      │    │
              │   │   ⑤ ToolWatchdog.tick                      │    │
              │   │   ⑥ HealthEngine.tick                      │    │
              │   │   ⑦ TaskScheduler.tick                     │    │
              │   │   ⑧ StatusWriter.write                     │    │
              │   └────────────────────────────────────────────┘    │
              │                                                      │
              │   MessageRouter (event-driven, NOT in tick)          │
              │   Adapter (DI 一次性注入，stateless)                  │
              │                                                      │
              └──────────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────┐
   │ 跨模块协作的 only path（two communication channels）：              │
   │                                                                   │
   │ 🔵 State via SignalStore — 跨模块共享"当前持续值"                 │
   │     ① 生产者写 file → ② SignalStore.refresh 拍 snapshot →         │
   │     ③ 消费者读 immutable snapshot                                  │
   │     上界 1 tick (≈1s), eventual consistency                        │
   │                                                                   │
   │ 🔴 Event via 具名接口 — 跨模块触发"一次性动作"                    │
   │     单向方法调用：                                                  │
   │       Guardian → HealthEngine: onProcessRestarted, setAuthFailed  │
   │       ToolWatchdog → HealthEngine: triggerRecovery                │
   │       MessageRouter → HealthEngine: triggerRecovery,              │
   │                                     notifyUserMessage             │
   │     synchronous, 调用方等返回                                       │
   │                                                                   │
   │ 不存在反向查询路径——Guardian 决策时不同步问 HealthEngine            │
   └──────────────────────────────────────────────────────────────────┘
```

### 3.2 Component 清单（11 个 + monitor.js 编排者）

| # | Component | 职责（一句话）| Tick 步 | 持久化文件 / IPC | 关键事件接口（消费方）|
|---|-----------|-------------|--------|-----------------|---------------------|
| 0 | **monitor.js** | 入口 + DI 注入 + tick 编排 + host MessageRouter IPC server | drives ①-⑧ | (无) | (调度其他)|
| 1 | **SignalStore** | 每 tick 开头刷新一次，~13 状态文件拍 immutable snapshot | ① | 读 ~13 文件 | `refresh()` `get()` |
| 2 | **Guardian** | 进程存活守护 + 4 拉起条件 + bypass-once / marker 冷启动语义 | ② | `guardian-state.json`, `.reset-request` | `tick(signals)`, `coldStart()` |
| 3 | **ProcSampler** | OS 级冻结检测（context-switch 60s 滑动窗判死）| ③ | 写 `proc-state.json` | `tick(signals)` |
| 4 | **ToolPipeline** | 工具生命周期 + 事件流合成（PR #500 物理合并）| ④ | 读 `tool-events.jsonl`，写 `api-activity.json` | `tick(signals)`, `getPendingInterventions()` |
| 5 | **ToolWatchdog** | 5-stage 工具超时 FSM + 干预 + 事件触发 recovery | ⑤ | `tool-watchdog-state.json` | `tick(signals)`; 调 `engine.triggerRecovery()` |
| 6 | **HealthEngine** | 4-state FSM + 3 层主动监控 + catalog dispatch（5 recoveryAction）| ⑥ | 写 `agent-status.json`（through StatusWriter）/ `rate-limit-state.json` / `unknown-api-errors.jsonl` | `tick`, `onProcessRestarted`, `setAuthFailed`, `triggerRecovery`, `notifyUserMessage` |
| 7 | **TaskScheduler** | 注册式调度器 + 7+1 任务 + maintenance window | ⑦ | 写 `maintenance-state.json` | `register(taskDef)`, `tick(signals)` |
| 8 | **StatusWriter** | tick 末尾写 `agent-status.json`（对外 schema 唯一发布者）| ⑧ | 写 `agent-status.json` (atomic .tmp+rename) | `write(signals, healthEngine)` |
| 9 | **MessageRouter** | 响应 c4-receive IPC + recovery probe 聚合（事件驱动）| **不在 tick** | Unix domain socket | IPC `route(channel,endpoint,priority)` → `{recovered, reason}` |
| 10 | **Adapter** | Claude / Codex 运行时差异 DI 注入（6 类接口；stateless）| **不在 tick** | (各 runtime 实现 `scripts/adapters/<runtime>.js`) | `launch`, `stop`, `isRunning`, `checkAuth`, `getApiErrorPatterns`, `sendMessage`, `getToolRules` 等 |
| 11 | **(跨模块契约)** | session-restart-continuation：3 句契约规范 restart 后续接 | **不是 module** | (复用既有 c4-session-init.js hook) | (无新接口) |

### 3.3 Tick 顺序硬约束

- **④ 在 ⑥ 前**：HealthEngine 要读 ToolPipeline 写的 `api-activity.json` 判 health
- **⑤ 在 ④ 后 ⑥ 前**：watchdog 干预可能触发 health 降级（通过 `triggerRecovery`），需在 HealthEngine.tick 前完成
- **MessageRouter 不在 tick**：由 c4-receive IPC 触发，事件驱动；通过 SignalStore 读 health（避免反向 query HealthEngine）

### 3.4 状态模型

**ActivityState（3 值，无状态投射）**：Offline / Idle / Busy。每 tick ⑧ 末尾根据 SignalStore 当下信号投射，无历史依赖。投射规则（伪码）：

```
IF NOT tmux_alive OR NOT proc_alive: Offline
ELIF hook_fresh AND (active_tools > 0 OR inactive_sec < 3s): Busy
ELSE: Idle
```

**HealthState（4 值，FSM）**：OK / Unavailable / RateLimited / AuthFailed。对外只暴露 `health` + `unavailable_since` 两字段；不写子状态——消费端读时间戳自行判断文案差分（< 60min 转 ≥ 60min 文案不同）。

**正交性**：Guardian 只看 ActivityState；MessageRouter 只看 HealthState；进程拉起 ≠ 健康变化。

### 3.5 通信通道补充

**State channel** （SignalStore snapshot 一致性保证）：

- 每 tick ① 刷新；同 tick 内所有 module 读到同一份 snapshot
- 不变量 C-SS-1：tick-internal snapshot consistency
- 不变量 C-SS-2：单 publisher of `agent-status.json`（仅 StatusWriter 写）
- 不变量 C-SS-3：所有写都用 atomic `.tmp` + rename 模式

**Event channel**（具名接口调用规则）：

- 全部单向（caller → callee）；callee 不返回查询结果给 caller
- HealthEngine 不暴露 getter——所有"查 health"路径走 SignalStore
- Guardian 决策不同步查任何模块（不变量 C-G-1）
- MessageRouter 读 SignalStore 而非 HealthEngine（不变量 C-MR-3）

### 3.6 Component 层级 dynamic：unhealthy 路径

```
[c4-receive] ──IPC──► [MessageRouter (in AM PM2)]
                              │
                              │ MessageRouter:
                              │   1. 读 SignalStore.get().health
                              │   2. if Unavailable && no in-flight probe:
                              │        engine.triggerRecovery() (单向事件)
                              │      else if in-flight probe exists:
                              │        加入 waitingMessages 共享结果
                              │   3. 等 probe 完成 (≤30s)
                              │
                              ▼
                       [HealthEngine.triggerRecovery()]
                              │
                              │ engine 内部:
                              │   - 入 waitingMessages 队列
                              │   - 启动 / 复用 in-flight probe
                              │   - probe 通过 Adapter.checkAuth() / heartbeat
                              │   - 结果回填 SignalStore (next tick refresh)
                              │
                              ▼
                       [SignalStore.refresh] (next tick ①)
                              │
                              │ snapshot 更新 health=OK / 仍 Unavailable
                              │
                              ▼
                  [MessageRouter] 读 SignalStore 拿到 probe 结果
                              │
                              ▼
                       IPC reply to [c4-receive]:
                          {recovered: bool, reason: ...}
```

---

## 四、Level 4: Code — 5 个关键 component 的代码细节

**这一层回答**：选 5 个对生产 contract / 实施风险最关键的 component 下钻——FSM 转换表 / 数据结构 / 文件路径 / 接口签名 / 不变量编号。

### 4.1 HealthEngine: 4-state FSM + 5-recoveryAction × DB 路径矩阵

**FSM 转换表**（精确，详见 health-engine.md §3）：

| From → To | 触发 | 备注 |
|----------|------|------|
| OK → Unavailable | catalog hit recoveryAction in {restart_session, probe_only} OR triggerRecovery | 写 `unavailable_since` + `unavailable_reason` |
| OK → RateLimited | catalog hit `mark_rate_limited` OR Layer 2 scan 命中限流文本 | 写 `rate-limit-state.json` |
| OK → AuthFailed | Guardian.setAuthFailed(reason) | 设 `authRetrySuppressedUntil = now + 180s` |
| Unavailable → OK | probe 成功 | 清 `unavailable_since` |
| Unavailable → RateLimited | catalog hit | (罕见 race) |
| RateLimited → Unavailable | rate-limit cooldown 到期 | 重 probe |
| AuthFailed → OK | adapter.checkAuth() 成功 | - |
| any → same | onProcessRestarted | 不强制变 health；HealthEngine 从持久化回填 |

**5 recoveryAction × DB 路径矩阵**（详见 health-engine.md §4，跟 §五.H 对齐）：

| recoveryAction | HealthState 变更 | 是否 adapter.stop() | DB 记录路径 | 用户感知 |
|----------------|-----------------|--------------------|------------|----------|
| `restart_session` | OK → Unavailable | ✅ 是 | inbound 既有保留；session 重启后 c4-session-init 注入 context | session 重启 + agent 看 context 自治补答 |
| `probe_only` | OK → Unavailable | ❌ 否 | inbound + 立即 outbound 状态文案（c4-receive unhealthy 路径）| 立即收到 "暂不可用，正在重试" |
| `mark_rate_limited` | OK → RateLimited | ❌ 否 | inbound + 立即 outbound 限流文案 | 立即收到 "限流冷却中, 预计 X 时间恢复" |
| `mark_auth_failed` | OK → AuthFailed | ❌ 否 | inbound + 立即 outbound auth 文案 | 立即收到 "auth 失败" |
| `notify_only` | 无变化 | ❌ 否 | 不影响 DB | 仅 log + 可选用户即时通知 |

**关键 backoff 节奏**：

- Unavailable 自适应退避：`60s → 300s → 1500s → 3600s` cap
- ≥ 60min Unavailable：固定 3600s 节奏（不再加速）
- launchGrace：新 session 起来 180s 内不主动 probe
- AuthFailed 冷却：180s 不消耗 token 重试

**Unknown 升级路径**：catalog 未匹配但通用 `Error/FATAL/Exception` 命中 → 默认 `probe_only` 兜底 + 写 `unknown-api-errors.jsonl`；同一 unknown 错误**连续 5min 命中**（10 × 30s）→ 强制升级 `restart_session` 自愈，防退避卡死。

### 4.2 Guardian: 4 拉起条件 + bypass-once + marker 3 场景

**4 拉起条件**（必须全部满足才 launch；详见 guardian.md §3）：

| # | 条件 | 信号源 |
|---|------|--------|
| 1 | `signals.rateLimitState == null \|\| Date.now() >= signals.rateLimitState.until` | SignalStore（HealthEngine 写）|
| 2 | `Date.now() >= authRetrySuppressedUntil` | Guardian 自身 |
| 3 | `notRunningCount >= restartDelay` | Guardian 自身（指数退避：5s → 10s → 20s → 40s → 60s cap，60s 稳定运行后归 5s）|
| 4 | `signals.maintenanceState == null \|\| !signals.maintenanceState.running` | SignalStore（TaskScheduler 写）|

**Marker 文件**：路径 `~/zylos/activity-monitor/.reset-request`；operator CLI `zylos am reset-backoff [--restart]` 创建。

**bypass-once + marker 3 场景**：

| 场景 | marker 文件 | Guardian 4 字段 | 首次 probe |
|------|------------|----------------|----------|
| `zylos am reset-backoff --restart` | ✅ one-shot | 清零 | 从 initial_delay 开始（保守）|
| daily-upgrade 后 AM 自重启 | ❌ | 保留持久化 | bypass-once 给 1 次机会（绕条件 #1/#2/#3）|
| AM 崩溃 / PM2 auto-restart | ❌ | 保留持久化 | bypass-once 给 1 次机会（绕条件 #1/#2/#3）|

**关键不变量**：bypass-once **不绕条件 #4 维护窗口**（operator 显式 maintenance 语义不能绕）。

### 4.3 MessageRouter: 4 不变量 C1-C4 + 5-path 表

**4 invariants**（详见 message-router.md §3）：

| # | 不变量 |
|---|--------|
| C1 | C4 DB 是消息可靠性边界——所有 accepted message 都进 DB（OK 路径 'pending'，unhealthy 路径 'delivered'）|
| C2 | c4-receive 30s hard timeout fallback——MessageRouter 不可达或 probe 超时，c4-receive 走 IPC-down 路径 |
| C3 | MessageRouter 读 health 必须经 SignalStore snapshot，不直接读 HealthEngine getter（保持单向事件 channel）|
| C4 | IPC 不可达时 c4-receive 不 insertConversation——返回 terminal 文本告知 operator 重发，不做"假入队"承诺 |

**5-path 表**（"一次 c4-receive 一次真实答案"不变量，详见 message-router.md §5 + c4-receive-adaptation.md §5）：

| Path | DB 状态 | 用户感知 |
|------|---------|---------|
| OK | inbound 'pending' → dispatcher 拿走 → tmux → agent reply → outbound 'delivered' | 收到 agent 真实回复 |
| Probe-recovered | 同 OK | 同 OK |
| Probe-not-recovered | inbound 'delivered' (覆盖 default) + outbound 'delivered' (catalog.userMessage) | 立即收到状态文案 |
| 30s 硬超时 | inbound 'delivered' + outbound 'delivered' (通用 "服务暂时不可用") | 立即收到通用文案 |
| IPC-down | **无 DB 写**，c4-receive STDERR 返终端文本 | operator 凭 channel daemon 终端文本知道要重发 |

**显式不引入清单**（grep-validated 0 hits）：

- ❌ `terminal_status` 字段
- ❌ `reply_to_inbound_id` 字段
- ❌ `claimed_at` 字段
- ❌ reply command token-passing (`--reply-to-id` arg)
- ❌ `pending-channels.jsonl`（main 异步恢复广播）
- ❌ `recent-inbound.jsonl` 受害者识别 ledger

详 §五.G 取舍说明 + §五.H zylos0t R6 TODO 1 落点。

### 4.4 SignalStore: 13 信号文件清单 + StatusWriter 对外 schema

**13 信号文件清单**（详见 signal-store-and-status-writer.md §2）：

| 文件 | 写入方 | 主要消费方 |
|------|--------|---------|
| `api-activity.json` | ToolPipeline | HealthEngine, StatusWriter |
| `statusline.json` | runtime（既有 hook）| TaskScheduler (context-check)|
| `heartbeat-pending.json` / `codex-heartbeat-pending.json` | runtime（既有 hook，runtime-specific via Adapter.getHeartbeatDeps()）| HealthEngine Layer 3 |
| `user-message-signal.json` | c4-receive | HealthEngine 加速探测 |
| `proc-state.json` | ProcSampler | Guardian, StatusWriter |
| `foreground-session.json` | runtime（既有 hook）| ToolWatchdog |
| `rate-limit-state.json` | HealthEngine | Guardian (条件 #1), StatusWriter |
| `maintenance-state.json` | TaskScheduler | Guardian (条件 #4), StatusWriter |
| `unknown-api-errors.jsonl` | HealthEngine | (人工 weekly review)|
| `usage.json` | TaskScheduler usage-monitor | TaskScheduler usage-alerter, StatusWriter |
| `usage-alert-state.json` | TaskScheduler usage-alerter | StatusWriter |
| `agent-status.json` | StatusWriter（**唯一 publisher**）| MessageRouter, c4-receive, c4-dispatcher, web-console, HealthEngine 冷启动回填 |
| `tool-events.jsonl` | runtime (PR #500) | ToolPipeline (streaming) |

**`agent-status.json` schema v2**：

```
{
  "schema_version": 2,
  "state": "offline" | "busy" | "idle",         // ActivityState
  "health": "ok" | "unavailable" | "rate_limited" | "auth_failed",
  "unavailable_since": <ms timestamp> | null,    // (long Unavailable 凭此时间戳做文案差分)
  "unavailable_reason": "<catalog id>" | null   // (open enum from Adapter.getApiErrorPatterns)
}
```

**migration 兼容**：v1 schema（无 `schema_version`）的消费端遇 unknown reason 退化通用文案不报错；旧 `recovering` / `down` 值 → 统一映射为 `unavailable` + `unavailable_since` 时间戳差分。

### 4.5 Session restart continuation: best-effort 3 句契约（zylos0t R6 TODO 2 落点）

**3 句契约**（详见 session-restart-continuation.md §2，§五.I 落点）：

1. **C4 DB 保 accepted-message durability**：已 `insertConv('in', ..., 'pending')` 的 inbound 不丢，runtime 异常 / restart / 长不可用都不影响
2. **restart 后 best-effort continuation**：通过既有 `c4-session-init.js` hook 注入 last-checkpoint summary + `SESSION_INIT_RECENT_COUNT=6` 条 recent unsummarized 对话作为 startup context；agent 看 context 自决策是否补 reply
3. **不承诺 unresolved-inbound completeness**：100+ pending 时受 token 预算约束 startup context 可能截断；接受 residual UX risk（user 凭 unhealthy 时已收到的状态文案重发是兜底）

**显式不引入**（grep-validated 0 hits in module docs）：

- ❌ `recent-inbound.jsonl` 受害者识别滚动日志
- ❌ `pending-channels.jsonl` 异步恢复广播（main 既有，Phase 5 删除）
- ❌ `restart-in-progress.json` intake barrier
- ❌ `recent-inbound.lock` 文件互斥锁
- ❌ `lastSafeIdleTs` activity-driven cleanup
- ❌ Cold-restart broadcast 受害者通知
- ❌ Sticky-trigger context taint 标记
- ❌ 显式 "unanswered inbound" 注入 session-init context（"是否已回复"难判定，group / multi-msg 假阳性）

5 边界 case（详见 session-restart-continuation.md §5）：restart-during-message / restart-then-OK / in-flight-missed-reply / consecutive-restarts / restart-then-still-non-OK——每条 case 都用 c4-session-init context + agent 自治 cover，不增 mechanism。

## 五、方案取舍 / Decisions

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

PR #501 早期 R3+R4+R5 演进路径尝试在 C4 DB 引入 reply-resolution 整套（`terminal_status` / `reply_to_inbound_id` / `claimed_at` 字段 + reply command token-passing + C-Term-1~5 单调 invariant + hard/soft 两层校验 + bounded pending exposure CLI），R6 production trade-off 评估后整套退出 baseline——核心五点：(1) **违背 prior decision**：早期讨论已明确"C4 不记录消息已回复状态"，R3 把 C4 纯机械层升级为业务语义；(2) **discipline 假设过强**：token-passing 假设 agent / dispatcher / channel daemon 都按规矩玩，agent 手写命令 / 跨 thread 回复 / 主动补充任一场景 break 即出现 stale/missing/mismatch，配对错从 v2.1 的"软错"（agent 自决策）变"硬错"（系统机制写错 DB）；(3) **state 矩阵未拼完**：R3+R4 引入字段跟既有 `conversations.status`（pending / running / delivered / failed）交互**完全未讨论**，5 轮 review 未抓到 blind spot；(4) **大机制解小问题**：unhealthy status reply 真正需求是"状态文案返回后 inbound 不进 dispatcher 主队列"——用既有 `status='delivered'` 显式覆盖即解（§五.H），无需 terminal_status 全套；(5) **scope 蔓延**：pending exposure 是产品语义不是 AM refactor 必要前置，塞进 PR #501 会让 refactor 变成 C4 reply ledger 重构。

R6 决断保留 v2.1 已收敛的所有有效产物（catalog-driven api error / probe-restart 解耦 / 11 模块拆分 / bypass-once+marker / usage 双 gate），仅退出 R3+R4+R5 增量。本 v3.1 在此决断基础上做 spec 化 + 落地 §五.H、§五.I 两条窄修订。

### H. zylos0t R6 TODO 1：Unhealthy inbound 用 status='delivered' 表达非待投递（精确措辞）

**问题**：v2.1 多处描述 unhealthy 路径写入 `insertConv('in') + insertConv('out', 状态文案)`，但**没有显式声明**这条 inbound 在 dispatcher 视角的处理状态——理论上 dispatcher 看 inbound queue 仍可能尝试再次投递，造成双答（status outbound 已发 + dispatcher 又投递 → agent 又答一次）。

**精确收敛**：用既有 `conversations.status` 字段（不引入新字段），c4-receive 调 `insertConversation('in', channel, endpoint, content, 'delivered')`——第 5 个参数**显式覆盖 default 'pending'**，dispatcher SQL `getNextPending: WHERE direction='in' AND status='pending'`（c4-db.js:140）自然跳过这条 inbound。

**为什么用 `'delivered'` 而不是新 enum 值**：DB 双行（inbound + outbound 都 `status='delivered'`）保留完整 DB 留痕——dispatcher 不需要任何额外判断逻辑（既有 `WHERE status='pending'` 自然跳过 inbound），**零新概念**。`'delivered'` 是 c4-db.js:107 outbound default 已经在用的值，复用不增 enum。模块档（message-router.md §4 / c4-receive-adaptation.md §5）描述 DB 留痕时用 "audit trail" 是中性技术术语，不是 status 字段值。

**outbound 走 c4-send.js 既有接口**：c4-receive 调用 `c4-send.js` 投递 catalog.userMessage——c4-send.js 内部完成 outbound DB 行写入（status='delivered' 默认）+ spawn `<channel>/scripts/send.js` 实际投递。**不发明新接口**——AM scope 内不直接管 channel 投递；用户感知统一为"bot 发的消息"，跟 agent 正常 reply 同路径。

**为什么不引入 terminal_status**：`terminal_status` 把"是否已回复"做成 C4 业务语义，而 group / multi-msg / agent 主动消息等场景这件事 C4 纯机械层无法稳定判断（参 §五.G #1）。本 TODO 用既有 queue status + 既有 c4-send 接口的窄修订，避免再次进入 reply-resolution scope。

**落点**：[`message-router.md`](activity-monitor/modules/message-router.md) §3 不变量 + §5 c4-receive 适配（含调 c4-send.js 流程）；[`health-engine.md`](activity-monitor/modules/health-engine.md) §3 catalog × HealthState × DB 路径矩阵；Phase 3 c4-receive 改造说明（§六）。

### I. zylos0t R6 TODO 2：Session restart continuation 降级 best-effort

**问题**：v2.1 §5.3.2 表述"c4 DB + c4-session-init 已经覆盖正确性边界"过强——v2.1 明确不做 unanswered-inbound 注入，只靠 c4-session-init 的 checkpoint summary + unsummarized / recent context。但 recent context 受 token 预算约束（典型 6 条），100+ pending 时不能完整暴露。

**收敛**：把 contract 拆为 3 句：

1. **C4 DB 保 accepted-message durability**——已 insertConv 的 inbound 不丢
2. **restart 后 best-effort continuation**——c4-session-init recent / unsummarized + agent 自治
3. **不承诺 unresolved-inbound completeness**——接受 residual UX risk（user 凭 unhealthy 时已收到的状态文案重发是兜底）

**为什么不补 unresolved-inbound 完整注入**：要求 100% 完整性等于回到 R3 引入 terminal_status / pending exposure 整套（参 §五.G #5）。本 TODO 走"诚实声明边界"的窄修订，把 production trade-off 写在 contract 里，避免假装承诺。

**落点**：[`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) §2 不变量 + §5 边界声明；本文件 §三.5。

---

## 六、模块实施档索引

每份模块档按 [`tech-doc-spec`](../.claude/skills/tech-doc-spec/SKILL.md) 8 项结构（职责边界 / 输入输出契约 / 数据结构 / 关键接口 / 错误处理 / 迁移策略 / 测试策略 / 跨模块依赖）独立可加载。本节给出索引；具体实施细节去对应模块档读。

| # | 模块档 | 涵盖模块 | 一句话核心 |
|---|--------|---------|----------|
| 1 | [`runtime-adapter.md`](activity-monitor/modules/runtime-adapter.md) | Adapter | DI 注入入口 + 6 类运行时接口（标识 / 进程 / 健康 / catalog / 差异 / 消息）；加新 runtime 流程 |
| 2 | [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md) | SignalStore + StatusWriter | 13 状态文件统一快照层 + 对外 schema（含 `schema_version` / `unavailable_since`）|
| 3 | [`guardian.md`](activity-monitor/modules/guardian.md) | Guardian | 4 拉起条件 + 指数退避；bypass-once + marker 三场景 |
| 4 | [`health-engine.md`](activity-monitor/modules/health-engine.md) | HealthEngine | 4-state FSM + 3 层健康监控；catalog-driven dispatch × 5 recoveryAction × DB 路径矩阵；unknown 5min 升级 |
| 5 | [`tool-pipeline-watchdog-procsampler.md`](activity-monitor/modules/tool-pipeline-watchdog-procsampler.md) | ProcSampler + ToolPipeline + ToolWatchdog | 三模块物理共置；5-stage watchdog；60s 滑动窗冻结判定 |
| 6 | [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md) | TaskScheduler | 注册式调度 + 7 任务清单；usage-monitor / usage-alerter 双 gate 拆分 |
| 7 | [`message-router.md`](activity-monitor/modules/message-router.md) | MessageRouter | 4 约束 C1~C4；4 路径（OK / Unhealthy / Probe-recovered / IPC-down）；**unhealthy `status='delivered'` + c4-send.js 投递**（§五.H 落点）|
| 8 | [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) | (跨模块契约) | restart 后 startup context 注入 + agent 自治续接边界；**best-effort 三句契约**（§五.I 落点）|
| 9 | [`c4-receive-adaptation.md`](activity-monitor/modules/c4-receive-adaptation.md) | (跨组件契约：comm-bridge) | c4-receive Phase 3 改造范围 + vs main 路径精确对比；MessageRouter IPC + c4-send spawn 协议 |

**移除的模块档**（R3+R4+R5 引入，R6 production rollback 决断后退出）：

- ❌ `c4-reliability-contract.md` — 三层契约（durability + terminal_status + unresolved-inbound exposure）整套；本方案下 durability 由 §一.4 + 模块档 7 cover，terminal_status / unresolved-inbound exposure 不进 baseline

---

## 七、迁移路线图 + 兼容性 + 回滚

### 7.1 落地阶段

| Phase | 范围 | 关键改动 |
|-------|------|---------|
| **Phase 0** | Watchdog 边界适配 | 内部语义不动；ToolPipeline 物理合并；Adapter DI 接管工具规则 |
| **Phase 1** | 基础设施 | 新建 SignalStore / StatusWriter / TaskScheduler + 7 任务文件；feature flag 挂接，独立可 ship |
| **Phase 2** | 状态模型 + 组件拆分 | 新建 Guardian + HealthEngine + 新主循环；catalog-driven dispatch + unknown 5min 升级；保留 legacy 入口作回滚路径 |
| **Phase 3** | 消息路由 + c4-receive 适配 | MessageRouter IPC；c4-receive 同步等 + unhealthy 路径 `insertConv('in', ..., 'delivered')` 显式覆盖 + spawn c4-send 投递 catalog.userMessage（§五.H 落地，详 [`c4-receive-adaptation.md`](activity-monitor/modules/c4-receive-adaptation.md)）；c4-dispatcher 适配新 health 值域 |
| **Phase 4** | Schema + 下游文案 | 对外状态文件 schema_version；c4-receive 按 unavailable_since 差分文案；web-console |
| **Phase 5** | 收尾 | 观察 1 周稳定后删除 legacy 入口；全量回归 |

具体每 Phase 的任务列表 / 测试矩阵 / 验收标准下放到对应 [模块实施档](activity-monitor/modules/) §6 迁移策略 + §7 测试策略。

### 7.2 兼容性

- **Hook 路径完全不变** → 用户 settings 无需修改
- **对外状态文件加 schema_version**，新增字段保持向后兼容；消费端遇未知 reason 退化通用文案不报错
- **AM 与 comm-bridge 同版发布**（monorepo 单包），无需灰度兼容窗口
- **config 保留旧字段** + 新增 per-runtime Grace 参数；usage 拆分采升级兼容路径 B（旧 config `usage_monitor_enabled=true` 时新版 default `usage_alert_enabled=false`，启动 warning 鼓励 opt-in）

### 7.3 回滚

PM2 启动参数切换回 legacy 入口即可，无需代码回滚。Phase 2 起 legacy 入口与新入口共存，Phase 5 才删除 legacy。

### 7.4 Phase 3 实施期待决议项（cold-reader audit 标的 ambiguity）

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

*主笔 zylos01；代码层细节 / 设计审查 zylos0t。本文件按 [`tech-doc-spec`](../.claude/skills/tech-doc-spec/SKILL.md) 两层格式（PR #501 R1 review 后规范）产出；按 [`doc-coauthoring`](https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring) 工作流做了三轮 readability 升级；v3.3 按 Simon Brown C4 model 4 层缩放重组顶层结构（§一 Context → §二 Containers → §三 Components → §四 Code）。*

*v2.1 是面向 reviewer 的详细稿；本 v3.3 是规范化的顶层方案档（去除字段 / 接口 / 测试细节，下放到 [模块实施档](activity-monitor/modules/)）。design decision 与 v2.1 / v3 / v3.1 / v3.2 完全一致。*
