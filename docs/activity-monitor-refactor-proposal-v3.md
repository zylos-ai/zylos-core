# Activity Monitor 重构方案 v3 — ✅ IMPLEMENTATION BASELINE（唯一真源）

> 日期：2026-04-28
> 分支：`refactor/activity-monitor`
> 类型：**总方案文档**——面向 review 与跨角色共识，不深入代码 / 字段 / 函数 / 文件路径 / 测试 case。具体落地见模块实施档（[§7 模块索引](#七模块索引)）。
>
> 历史稿（已 SUPERSEDED）：
> - `activity-monitor-refactor-proposal-v2.1.md`
> - `activity-monitor-refactor-proposal-v2.md`
> - `activity-monitor-refactor-proposal.md`
>
> 模块实施档目录：[`docs/activity-monitor/modules/`](activity-monitor/modules/)

---

## 〇、TL;DR

`activity-monitor`（AM）是守护 runtime（Claude / Codex）的 PM2 长驻进程。现状是一个 2300+ 行的 God Object，多个紧耦合状态机 + 散落的信号消费 + ad-hoc 调度。

v3 核心命题：

- **C4 DB 是消息可靠性边界**——AM 不维护私有受害者识别 ledger，session 重启后靠既有 c4-session-init 注入 context + agent 自治续接
- **两层正交状态机**：进程层（Activity）与功能层（Health）零字段互读
- **API error 出口治理 catalog 化**：runtime 错误模式 + 处理路径由 Adapter 注入；probe 与 restart 解耦
- **结构上**：拆出 11 个职责清晰的模块，主循环只做编排
- **对外契约保持向后兼容**：Hook 路径不变，对外状态文件加 schema 版本号 + 字段向后兼容

---

## 一、背景与问题

AM 在过去一年随需求演进，积累了多重结构性债务：

| 类型 | 现象 | 影响 |
|---|---|---|
| **状态语义不清** | health 5 值（ok/recovering/down/rate_limited/auth_failed），其中 recovering 和 down 本质是同一恢复流两阶段 | 消费端难以判断该展示什么文案；rate_limited / auth_failed 跟 down 在转换语义上不正交 |
| **God Object** | 单一活动监控源文件 2300+ 行塞了进程守护 / 健康检查 / 工具 watchdog / 调度全部职责 | 难独立测试；加新功能要碰 5 处 |
| **跨模块紧耦合** | Guardian ↔ HeartbeatEngine 共享 5 字段直读直写 | 改一个模块要联动改另一个 |
| **多套退避机制语义不一致** | restart / recovery / auth retry / user cooldown / tool watchdog 各自一套退避策略 | 故障期行为难预测；调试困难 |
| **Watchdog 子系统游离** | PR #500 引入的工具相关组件主循环中深度集成但无清晰模块边界 | 工具相关 bug 牵扯到主循环每一步 |
| **定时任务 ad-hoc** | 三套并行调度器混用 | 加新任务找不到 single owner |
| **信号消费散落** | 12+ 状态文件在主循环各处单独读取 | 一份信号消费不一致；难做统一快照 |
| **冷启动语义模糊** | AM 重启时不区分 "operator 显式重置" vs "auto-restart"——前者应该清退避，后者应保留故障认知 | 修好根因后仍要等持久化退避到期 |
| **错误处理粗暴** | API error / 限流 / auth 失败统一走"probe 失败 → restart"单一路径 | 限流 / auth 失败触发 restart 没意义；sticky context-poison 不被识别 |
| **消息可靠性边界模糊** | 现有异步恢复广播路径在多次故障下出现双通知 / 语义冗余；AM 历史多次尝试维护私有"受害者识别 ledger"，但跟 c4 DB 既有职责重叠 | 既有 race；也是历史多次 walkback 的根源 |

不解决的风险：debt 持续累积，新需求每次落地都要 patch 多个紧耦合状态机；故障期用户体验不一致；AI 实现者在加载这份代码时上下文污染严重，误读概率高。

---

## 二、目标 / 非目标

### 目标

1. **单一职责的模块拆分**——每个模块一份模块实施档，AI 与 reviewer 可按需加载
2. **状态语义正交化**——进程层 / 功能层零字段互读；对外状态 schema 收敛
3. **C4 DB 是消息可靠性边界**——AM 不重做 c4 DB + c4-session-init 已经覆盖的事；不引入私有受害者识别 ledger
4. **probe / restart 解耦**——按错误类型决定是否 restart；限流 / auth / transient overload 不一律 restart
5. **catalog 化错误处理**——runtime-specific 错误模式 + 处理路径由 Adapter 注入，HealthEngine 统一 dispatch
6. **冷启动行为显式化**——operator 重置 vs auto-restart 用 marker 文件区分，bypass-once 默认语义保护
7. **对外契约向后兼容**——Hook 路径不变，对外状态 schema 加版本号

### 非目标（v3 明确不做）

1. **不做入口前置校验（InputValidator）**——zylos 当前架构下用户消息附件走 path-as-text，agent 用 Read 工具自取；不存在自动 multimodal 注入路径，也不存在"坏附件直接送进 API"的链路。详 §6 取舍 H
2. **不引入 cron 解析器**——`dailyHour` + `intervalSeconds` 已覆盖全部需求
3. **不重做 PR #500 ToolWatchdog 内部语义**——只做边界适配，5-stage 状态机 / 规则值 / intervention 按键序列完全保留
4. **不引入 multi-agent 协同 / 多 runtime 并发**——v3 仍是"一个 AM 守一个 runtime instance"
5. **不做受害者识别 ledger / cold-restart broadcast**——session restart 后让 agent 看 context 自决策是否补答，不主动 broadcast"我恢复了"
6. **不动 c4 协议 / channel daemon 协议**——任何会触发"channel daemon / c4-receive 接口变更"的能力（如附件 schema 升级）都不在本 PR scope

---

## 三、核心设计原则

### 原则 1：C4 DB 是消息可靠性边界

所有 accepted 消息都在 c4 DB 持久化（inbound 记录）；AM 不维护私有受害者识别 ledger。session 重启后靠既有 c4-session-init 注入 last checkpoint summary + recent unsummarized 对话作为 startup context，agent 自决策是否补答。

**推论**：delivered-but-unanswered（已入 DB 但 runtime 异常后未回复）**不算消息丢失**——在 user 视角等同 "agent 反应慢"，session restart 后 agent 看 context 自治续接。

### 原则 2：两层正交状态机

| 状态机 | 关心什么 | 由谁决策 |
|---|---|---|
| **ActivityState** | 进程是否在运行（Offline / Idle / Busy） | Guardian 只看这个 |
| **HealthState** | 功能是否可用（OK / Unavailable / RateLimited / AuthFailed） | MessageRouter 只看这个 |

**两个状态机零字段互读**。跨模块协作只走两类通道——状态走只读快照，事件走具名接口（详 §4 总体架构）。

### 原则 3：probe 与 restart 解耦

**heartbeat / probe 失败 ≠ 一定 restart**。Adapter 通过 catalog 显式声明每种 error 类型的处理路径（共 5 种 recovery action）：

- 重启会话类：sticky context-poison（图 400 / context_length 超长等）→ 停 runtime + 拉新 session
- 持续探测类：transient overload（503 / 500）→ 进 Unavailable 持续探测，不重启进程
- 限流标记类 / auth 失败标记类：进对应 health state，不重启
- 仅通知类：内容策略拦截等 → 仅 log + 可选用户通知，不改 health

具体 5 种 action 的语义、用户文案、HealthState 转换、c4 DB 记录路径详见模块档 [`health-engine.md`](activity-monitor/modules/health-engine.md)。

### 原则 4：state 走只读快照 / event 走具名接口

- **State (持续值)**：生产者写状态文件，每 tick 开头由 SignalStore 刷新一次产出只读快照；消费者读快照
- **Event (时间点动作)**：单向具名方法调用（如 auth 失败、进程重启、触发 recovery、通知用户消息），synchronous

**禁止**：跨模块 getter 反向查询；跨模块共享可变内存状态。

state 路径上界一致性 ≤ 1 tick (≈ 1s)——是消除"反向同步查询"的代价，但收益是模块独立可测试 + 跨模块依赖只能正向。

### 原则 5：Adapter DI 隔离 runtime 差异

Claude / Codex 的差异（进程命令 / heartbeat 文件名 / API error 模式 / 工具规则等）全部封装为 Adapter，构造时注入业务模块。业务模块不写 `if (claude) ... else ...`。

未来加新 runtime 只需新写一个 adapter 模块，业务层零改动。

---

## 四、总体架构

### 4.1 System Context（AM 在系统里的位置）

```
┌───────────────────────────────────────────────────────────────────┐
│                          Zylos System                              │
│                                                                    │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────────────┐  │
│  │ Channels │ ─→ │  C4 Comm     │ ─→ │ Runtime Agent (tmux)    │  │
│  │ (Lark/TG │    │  Bridge      │    │  Claude / Codex         │  │
│  │  HXA/Web)│ ←─ │  (DB ledger) │ ←─ │                         │  │
│  └──────────┘    └──────┬───────┘    └────────┬────────────────┘  │
│                         │                     │                    │
│                         │ status / control    │ hooks (signals)    │
│                         ↓                     ↓                    │
│              ┌──────────────────────────────────────┐             │
│              │       Activity Monitor (AM)          │             │
│              │  PM2 长驻 / 守护 runtime instance    │             │
│              └──────────────────────────────────────┘             │
└───────────────────────────────────────────────────────────────────┘
```

AM 的对外契约：
- **发布对外状态**：作为唯一发布者写"对外状态文件"，C4 主链 / web-console 消费
- **提供路由决策 IPC**：c4-receive 通过本地 IPC 询问消息路由决策（健康判定 + 路径选择）
- **消费 Hook signals**：runtime 进程的 hook 文件（工具事件 / context / 前台 session / PID）以 signal 文件形式被 AM 消费

### 4.2 Container（AM 内部模块拼图）

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Activity Monitor                              │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                  monitor.js (编排)                              │ │
│  │  每秒 8 步 tick + MessageRouter 宿主进程 + IPC server          │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌────────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │ SignalStore│  │ Guardian │  │ ProcSampler│  │ ToolPipeline    │  │
│  │ (signals   │  │ (进程   │  │  (冻结    │  │  + ToolWatchdog │  │
│  │  snapshot) │  │  守护)   │  │  检测)    │  │                 │  │
│  └────────────┘  └──────────┘  └────────────┘  └─────────────────┘  │
│                                                                      │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐   │
│  │ HealthEngine   │  │ TaskScheduler  │  │ StatusWriter         │   │
│  │ (4-state FSM   │  │ (注册式定时   │  │ (对外状态唯一发布者) │   │
│  │  + catalog     │  │  任务)        │  │                      │   │
│  │  dispatch)     │  │                │  │                      │   │
│  └────────────────┘  └────────────────┘  └──────────────────────┘   │
│                                                                      │
│  ┌────────────────┐  ┌────────────────────────────────────────────┐ │
│  │ MessageRouter  │  │ Adapter (Claude / Codex) — DI 注入业务模块 │ │
│  │ (事件驱动 IPC) │  │  (进程管理 / 健康检查 / API error catalog) │ │
│  └────────────────┘  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

11 个模块（10 业务 + 1 Adapter DI），主循环只做编排。各模块通过 SignalStore 共享 state 快照，通过具名方法触发跨模块 event。

### 4.3 Component Interaction（模块间协作总览）

| 协作链 | 大致路径 | 性质 |
|---|---|---|
| **状态共享** | 任意模块写 signal → 下一 tick SignalStore refresh → 消费者读 snapshot | 异步，eventual ≤ 1s |
| **事件触发** | Guardian → 具名方法 → HealthEngine | 同步具名调用 |
| **工具异常** | ToolWatchdog → 具名方法 → HealthEngine | 同步具名调用 |
| **用户消息路由** | c4-receive → 本地 IPC → MessageRouter → 决策 (健康判定 + 路径) | 同步 IPC |
| **决策落盘** | StatusWriter → 写对外状态文件 → C4 主链 / web-console 消费 | tick 末尾原子写 |

**关键不变量**：
- Guardian 决策闭环中**不同步查询**任何其他模块
- HealthEngine 不对外暴露 getter（只通过 SignalStore 暴露 read-only 字段）
- c4-dispatcher **独占**对 tmux 的写入（C4 主链不可绕）
- MessageRouter 不直接调 tmux

### 4.4 主循环 tick

每秒 1 次，固定 8 步顺序：

```
① signals refresh           ← 刷新只读快照（state + 流式增量合一）
② 进程存活守护              ← 决定是否拉起
③ OS 级冻结检测             ← context switch 采样
④ 工具生命周期 + 事件流合成 ← 合成工具活动视图
⑤ 工具超时检测 + 干预       ← 超时工具的 stop / interrupt
⑥ 健康状态机 + catalog 分派 ← OK / Unavailable / RateLimited / AuthFailed
⑦ 定时任务调度              ← 注册式 tasks
⑧ 写对外状态文件            ← 唯一发布者
```

**顺序硬约束**：④ 必须在 ⑥ 前（健康判定要读工具活动视图）；⑤ 在 ④ 后 ⑥ 前（watchdog 干预可能触发 health 降级）。MessageRouter **不在 tick 里**，由 c4-receive 通过 IPC 触发。

每步具体接口签名 / 实现细节见对应模块档。

---

## 五、关键流程

四条 critical path——reviewer 不看代码也能判断方案是否闭环。具体接口 / 字段 / 持久化路径见模块档。

### 5.1 OK 直通（happy path）

用户发消息 + AM 健康正常时的全链路：

```
[用户] 发消息 (Lark / TG / HXA / Web)
   ↓ channel daemon 收事件
[c4-receive] 通过本地 IPC 询问 MessageRouter 路由决策
   ↓
[MessageRouter] 读只读快照投射的 health
   ├── health=OK
   ↓
[c4-receive] 写 inbound 记录到 c4 DB（持久化）
   ↓
[c4-dispatcher] 按 priority + 空闲门控投递 → tmux
   ↓
[Runtime Agent] 处理消息 → 写回复
   ↓
[c4-dispatcher / channel daemon] 把回复送回用户
```

**不变量**：消息进入 c4 DB inbound 即视为持久化成功；后续 runtime 异常不算"消息丢失"（详 §5.3）。

### 5.2 Unhealthy 路由（degraded path）

AM 健康异常（Unavailable / RateLimited / AuthFailed）时：

```
[c4-receive] 询问 MessageRouter
   ↓
[MessageRouter] 读 health ≠ OK
   ↓ 触发一次 recovery probe（短窗口聚合，多消息共享同一次 probe）
   │  c4-receive 同步阻塞等待（硬超时 30s）
   ↓
[Probe 返回]
   ├── recovered=true → 走 §5.1 OK 直通
   └── recovered=false →
        [c4-receive] 同步写两条 c4 DB 记录：
                    1) inbound 记录（消息持久化）
                    2) outbound 状态文案
                       (来源：catalog 当前 reason 的 user-facing 文案，
                        如 "限流冷却中" / "auth 失败" / "服务暂时不可用")
        [用户] 立即收到状态回复（不留 silent gap）
```

**关键**：unhealthy 路径**同步**返回 outbound 状态文案——保证用户立即感知系统状态。**不需要**事后异步发"我恢复了"广播（避免双通知）。

### 5.3 Session restart 后的对话续接

Catalog 命中"重启会话"类 error（如图 400 / context_length 超长）时：

```
[HealthEngine] catalog 命中 → recoveryAction = 重启会话
   ↓
[Adapter] 停 runtime 进程
   ↓
[Guardian] 下一 tick 看进程消失 → 拉新 session
   ↓
[c4-session-init.js] 既有 hook 注入 startup context
   • last checkpoint summary
   • recent unsummarized 对话（或最近 N 条）
   ↓
[Runtime Agent] 启动后看到 context（含恢复前可能未回复的 inbound）
   ↓ agent 自决策（LLM core capability）
   ├── 判断需要补答 → 主动回复
   └── 判断已经在新 context 下闭环 → 不回复
```

**边界声明**：
- **不主动 broadcast** "我恢复了"——unhealthy 时用户已同步收到状态文案
- **AM 不维护**任何受害者识别 ledger——靠 c4 DB 既有 inbound 持久化 + c4-session-init 既有 context 注入
- **C4 DB 是消息可靠性边界**——message persistence 在 c4 层完成，AM 不重做

详见 [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md)。

### 5.4 Cold start：bypass-once + marker 重置

AM 重启时分两路径，由一个 marker 文件区分 operator 显式 opt-in vs 系统 auto-restart：

```
AM 启动
   ↓
检测 reset marker 文件
   ├── marker 存在（operator 显式 opt-in）
   │     ↓ 路径 B
   │     • 清空 Guardian 持久化退避状态
   │     • unlink marker（one-shot 防误重置）
   │     • 关闭 bypass-once
   │     • 首次 probe 从初始 delay 开始
   │
   └── marker 不存在（默认 auto-restart）
         ↓ 路径 A：bypass-once
         • 从持久化文件恢复 Guardian 退避状态（保留故障认知）
         • 首次 probe 绕过时间驱动退避，但不绕过维护窗口锁
         • 首次 probe 成功 → 清空退避状态
         • 首次 probe 失败 → 回到持久化退避水位（不退回初始 delay）
```

**三场景语义**：

| 场景 | marker | 退避状态 | 首次探测 |
|---|---|---|---|
| operator 显式 reset-backoff | ✅ one-shot | 清零 | 初始 delay |
| daily-upgrade 完成后 AM 自重启 | ❌ | 保留 | bypass-once 给 1 次机会 |
| auto-restart（AM 崩溃 / PM2 拉起） | ❌ | 保留 | bypass-once 给 1 次机会 |

详见 [`guardian.md`](activity-monitor/modules/guardian.md)。

---

## 六、方案取舍

### A. 为什么 HealthState 合并 recovering / down 为 Unavailable

recovering 是"暂时重试中"，down 是"长期失败"——本质是同一恢复流两阶段，60min 阈值是 HealthEngine 的**内部退避升级时机**，却被暴露为对外状态枚举导致消费端难以理解。合并后用 unavailable_since 时间戳替代子状态，消费端保有文案差分能力（"稍后重试" vs "需管理员介入"），契约更简洁。

### B. 为什么状态共享走"快照 + eventual" 而不是"内存 + getter"

代价：消除 Guardian → HealthEngine 反向查询路径。原始路径是 O(1) 内存读，新通道是"写文件 → 下一 tick refresh → 读快照"三跳，上界 1 tick (≈ 1s)。换来同步调用路径完全消除——模块独立可测试 / 跨模块依赖反向 / AI 加载某个模块时不必 follow 链路上其他模块。1s 的延迟在限流解除等场景代价可控。

### C. 为什么 bypass-once 不是 "所有 cold start 清零"

简单"所有清零"无法区分 operator 显式重试（应清零）与 auto-restart（应保留故障认知）。后者每次从初始 delay 重爬会对外部 API 产生持续脉冲。marker 文件做 operator 显式 opt-in，两边取到合适语义。marker 用完即焚（one-shot）防止退化为"所有清零"。

### D. 为什么 IPC 降级不入队

原设计 IPC 降级时 c4-receive 仍写 inbound + "消息已入队"文案是"不丢消息优先"的妥协，代价是一条 receive 可能产出 2 条回复（interim error + 后续 AI），违反"一次 c4-receive 一次真实答案"不变量。新设计选择"不做假入队承诺"，文案诚实告知 operator 需要重发。不变量 100% 成立，IPC 降级是 monitor.js 进程崩溃级别的罕见异常场景，可接受。

### E. 为什么 ActivityState 是无状态投射而不是 FSM

ActivityState 无历史依赖——任何 tick 看到同样信号都得出同样 state。FSM 会引入"从自己写的对外状态文件恢复状态"的反向依赖，重启 AM 后可能与现实信号不一致。无状态投射下第一 tick 就直接算出真值。

### F. 为什么 probe 跟 restart 解耦

历史曾把 probe 失败一律 trigger restart。但限流 / auth 失败 / transient overload 不是 sticky context 问题——restart 没意义只徒增脉冲。catalog 把每种 error 的处理路径显式声明，HealthEngine 按 dispatch table 分派，避免一刀切。

### G. 为什么 C4 DB 是消息可靠性边界（哪些机制被砍）

历史上多次尝试在 AM 层维护私有受害者识别 ledger，最终全部 walk back：

| 曾设计但被砍 | 砍掉原因 |
|---|---|
| 受害者识别滚动日志 | c4-session-init 已注入 recent context，重做无收益 |
| 异步恢复广播（升级既有 pending-channels） | unhealthy 路径已同步返 outbound 状态文案，不需要事后异步广播 |
| 重启 intake barrier | C4 DB 已是消息可靠性边界，不需要 atomic snapshot |
| 文件互斥锁 | 不维护 shared mutable file 就没有 race |
| activity-driven 日志清理 | 不维护 ledger 就不需要 cleanup |
| Cold-restart broadcast 受害者通知 | agent 自治补答替代 |
| sticky-trigger context taint 标记 | 难可靠判定，引入新 ledger 复杂度无收益 |

**根本原因**：这些机制都建立在错误前提"session_restart 后消息丢失"上。实际 c4 DB inbound 持久化 + 既有 c4-session-init context 注入已经覆盖 silent loss 担忧。AM 重做即引入 race / lock / barrier 复杂度而无对应收益。

**main 既有的异步恢复广播路径在 v3 下废弃**——Phase 5 legacy 清理项明列（c4-receive 写入分支 + AM drain 职责）。

### H. 为什么不做 InputValidator（不在 v3 baseline 也不在任何模块文档）

zylos 当前架构下用户消息附件走 path-as-text：channel daemon 把附件下载本地后只把**文件路径作为字符串**塞进 c4-receive，c4 DB 持久化层只有 TEXT 列，**不存在自动 multimodal 注入路径**。

坏图永远不会自动进入 Claude API user turn——agent 看到的是文本里的路径，**由 agent 自己决定调 Read 工具加载**。Read 工具自带边界（size / format），超限直接返 error → agent 在对话里告诉用户重发，不触发 sticky API 错误链。原 problem statement（拦下 90% 已知规格违规避免 60-70s 出口治理 latency）的前提不成立。

未来如新增 multimodal 直接注入路径（如 base64 content block 注入），正确的入口校验位置是该注入点（runtime-aware by design），不是独立 AM module。

### I. 为什么不引入 cron 解析器

依赖最小化 + 可测试。cron 库约 50KB 代码，表达式解析有 bug 历史。当前两字段（`dailyHour` + `intervalSeconds`）语义明确，测试只需 mock 时间。

### J. 为什么 ProcSampler 是独立模块而不是 Guardian 一部分

时间维度不同。Guardian 是 1s 级 boolean 检查；ProcSampler 是 10s 采样 + 60s 滑动窗口状态机。合进 Guardian 会让 Guardian 维护独立时序状态机违反单一职责。

---

## 七、模块索引

11 个模块（10 业务 + 1 Adapter DI），按职责聚合为 8 份模块实施档。每份独立可加载，按需读取。

| 模块实施档 | 覆盖模块 | 核心职责 |
|---|---|---|
| [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md) | SignalStore / StatusWriter | 信号聚合（每 tick 只读快照）+ 唯一对外契约发布者 |
| [`guardian.md`](activity-monitor/modules/guardian.md) | Guardian | 进程存活守护 + 拉起条件 + bypass-once + marker 重置 |
| [`health-engine.md`](activity-monitor/modules/health-engine.md) | HealthEngine | 4-state FSM + 触发源 + tick 内部步骤 + 3 层监控 + catalog-driven api-error-check + recoveryAction × HealthState 矩阵 + unknown error 持续性升级 |
| [`message-router.md`](activity-monitor/modules/message-router.md) | MessageRouter | 用户消息路由 + 4 约束 C1~C4 + 不变量对照 + 并发聚合 + IPC 协议 |
| [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) | (跨模块契约) | C4 DB 可靠性边界声明 + delivered-but-unanswered ≠ 丢失 + c4-session-init 注入契约 |
| [`tool-pipeline-watchdog-procsampler.md`](activity-monitor/modules/tool-pipeline-watchdog-procsampler.md) | ToolPipeline / ToolWatchdog / ProcSampler | PR #500 边界适配 + 5-stage 工具状态机 + 60s 滑动窗冻结检测 |
| [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md) | TaskScheduler | 注册式调度 + 任务清单 + usage 监测/告警双 gate 拆分 |
| [`runtime-adapter.md`](activity-monitor/modules/runtime-adapter.md) | Adapter (Claude / Codex) | 接口分类 + DI 模型 + Claude / Codex 差异封装 |

每份模块档按统一 8 项结构（详 [`tech-doc-spec` 规范](../../.claude/skills/tech-doc-spec/SKILL.md)）：模块职责与边界 / 输入输出契约 / 数据结构与状态机 / 关键接口 / 错误处理与恢复 / 迁移策略 / 测试策略 / 模块依赖。

---

## 八、迁移路线图

按 Phase 推进，每 Phase 独立可 ship + 可回滚。具体每模块的迁移步骤见对应模块档。

| Phase | 主题 | 关键交付 |
|---|---|---|
| **Phase 0** | Watchdog 边界适配（PR #500 内部语义不动） | 工具相关组件模块边界对齐；E2E golden 等价 |
| **Phase 1** | 基础设施 | SignalStore / StatusWriter / TaskScheduler / ToolPipeline 新建；feature flag 挂接 |
| **Phase 2** | 状态模型 + 组件拆分 | Guardian / HealthEngine 新建（含 catalog-driven api-error-check + recoveryAction dispatch + unknown 5min 升级）；新 monitor 8 步 tick |
| **Phase 3** | 消息路由 + c4-receive 适配 | MessageRouter 新建；c4-receive 改造（同步等 MessageRouter + unhealthy 路径写状态文案 + IPC 降级 terminal 文案不入队）；c4-dispatcher 适配新 health 值域 |
| **Phase 4** | 对外 schema + 下游文案 | 对外状态文件加 schema_version + 新增可选字段；下游消费端按时间戳差分文案；web-console 适配 |
| **Phase 5** | 收尾 | 删除 legacy 分支 / 旧 heartbeat-engine / **main 既有异步恢复广播路径（c4-receive 写入分支 + AM drain 职责）**；全量回归 |

---

## 九、兼容性 + 回滚保证

### 兼容性

- **Hook 路径完全不变**：所有 hook 脚本物理路径不变，用户 settings 无需修改。Hook 分两类（write-only signal hooks / control hooks）详见 [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md)
- **对外状态加 schema 版本号**：字段向后兼容，消费端遇到未知 reason 退化到通用文案不报错
- **配置文件保留**：新增 per-runtime grace 参数 + 新增 usage 双 gate（详 [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md)）
- **comm-bridge / activity-monitor 同版发布**（monorepo 单包），无需灰度兼容

### 回滚

- 旧 monitor 实现保留为 legacy 入口，PM2 启动参数切换新旧
- Phase 5 之前任何 Phase 出现严重问题，可单独回滚启动参数
- Phase 5 删除 legacy 是观察 1 周稳定后的最后步骤

---

*v3 由 zylos101 主笔。设计经多轮 review 演进至当前形态，跨 zylos01 / zylos0t / howard.zhou / ccb981c2 协作。文档结构遵循 howard.zhou 下发的"两层文档规范"（顶层方案 + 模块实施档分层），规范全文与 actionable 提炼见 zylos `tech-doc-spec` skill。详细设计演进与 review 历史见 v2.1 / v2 / v1 SUPERSEDED 文档与 PR #501 git history。*
