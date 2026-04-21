# Activity Monitor 重构方案 v2.1

> 基于 Howard 2026-04-19 direction comment 校准后的 v2
> 协作团队：zylos01（方案主笔）、zylos0t（信息补充与角度审查）
> 日期：2026-04-20
> 分支：`refactor/activity-monitor`

---

## 一、重构动机

### 1.1 Howard 的构想

Howard 提出一套清晰的双层状态模型，将"进程存活"与"功能健康"彻底解耦：

- **Activity State（活动状态）**：Offline / Stopped / Idle / Busy — 描述进程是否在运行
- **Health State（健康状态）**：OK / Unavailable / RateLimited / AuthFailed — 描述功能是否可用

### 1.2 核心原则（本次重构的六条锁死约束）

以下六条原则贯穿整份方案，任何实现细节必须与其一致：

1. **双层正交状态机**：ActivityState 与 HealthState 相互独立运行，且两者之间**没有直接的字段读或字段写路径**。跨模块协作分两类，各走各的通道：
   - **状态共享走 SignalStore**（§3.3 只读快照）——"当前持续值"类信息，例如限流冷却的解除时间戳（`rate-limit-state.json`）。写入方单向写、消费方只读，互不感知对方内部字段。
   - **事件触发走具名接口**——"一次性动作"类交互，例如 `engine.triggerRecovery()`（工具/消息触发一次健康探测）、`engine.setAuthFailed(reason)`（auth 探测失败通知）、`engine.onProcessRestarted()`（新进程拉起完成通知）、`engine.notifyUserMessage()`（用户消息到达）。每个接口语义明确收敛，不是通用的 `getHealth` / `setHealth`。
   
   一条检验规则：**Guardian 的决策闭环中不能出现对 HealthEngine 字段或方法的同步查询**。需要的"当前值"类信息（如是否在限流冷却期）必须通过 SignalStore 读取，HealthEngine 作为该信号的生产者而不是被查询对象。

2. **Offline → 无条件拉起**：进程不存在或 agent 未运行时，Guardian 立刻尝试拉起。Guardian 的拉起决策由 Guardian 自己组装（退避计数 + auth 冷却窗口 + 维护窗口锁 + SignalStore 的限流状态信号），**不调用 HealthEngine，不读 HealthState**。所有健康状态（Unavailable / RateLimited / AuthFailed）对 Guardian 都是透明的——HealthEngine 把需要 Guardian 感知的状态（如限流解除时间戳）写进 SignalStore，Guardian 按常规信号消费，不区分来源是哪个组件。

3. **recovering + down 合并为 Unavailable**：对外 `agent-status.json` 中只写 `health: "unavailable"`，不暴露子状态。"暂时恢复中" vs "需要人工介入" 的文案区分由消费端（c4-receive / web-console / UI）读 `unavailable_since` 时间戳自行判断（< 60min 稍后重试 / ≥ 60min 需管理员介入）。

4. **设计驱动实现调整**：c4-receive、c4-dispatcher 等下游模块按新架构适配，不以现状代码为约束。如果新设计更合理，下游改造就是本次重构的一部分。

5. **MessageRouter 事件驱动**：消息到达时由 c4-receive 调用 MessageRouter，不在主循环中 tick。并发聚合**只在 recovery check 阶段起作用**——OK 路径上每条消息独立走 C4 主链，不经 MessageRouter 聚合。

6. **SignalStore 只读快照、Adapter 依赖注入、TaskScheduler 注册式调度、Hook 路径不变**：四个架构基石，自 v1 保留不变。Hook 脚本文件路径不动，用户 `settings.json` 无需修改。

### 1.3 现状痛点

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态语义不清** | health 当前有 5 个值（ok/recovering/down/rate_limited/auth_failed），其中 recovering 和 down 本质是同一恢复流的两个退避阶段，不是独立健康状态 |
| 2 | **Guardian 与 HeartbeatEngine 紧耦合** | 共享 consecutiveRestarts / startupGrace / authRetrySuppressedUntil，跨模块直接读写字段，难独立测试 |
| 3 | **多套退避机制各自为政** | Guardian restart backoff、HealthEngine recovery backoff、auth retry suppression、user message cooldown、tool watchdog intervention 语义不一致 |
| 4 | **God Object**：activity-monitor.js 主入口把 Guardian、健康检查、watchdog 协调、信号聚合、状态写出、定时任务全塞在一个文件里，当前体量超过 2300 行 |
| 5 | **Watchdog 子系统游离于主架构** | PR #500 引入的 tool-lifecycle / tool-event-stream / tool-watchdog / session-foreground / claude-pid 体系在主循环中深度集成，但没有清晰的模块边界 |
| 6 | **定时任务 ad-hoc** | daily-upgrade / memory-commit / upgrade-check 各自用 DailySchedule，health-check 用时间戳对比，usage-monitor 又是另一套 |
| 7 | **信号消费散落** | hook 输出文件（api-activity.json / statusline.json / tool-events.jsonl 等）的读取和 freshness check 分散在主循环各处 |

---

## 二、状态模型

### 2.1 双层正交状态

```
┌─────────────────────────────────────────────────────┐
│  Activity State（进程层，由进程检测驱动）              │
│                                                      │
│  Offline ──→ Stopped ──→ Idle ←──→ Busy             │
│     ↑            ↑         ↑         ↑               │
│     └────────────┴─────────┴─────────┘               │
│         进程退出 / tmux 销毁 / 冻结 kill              │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Health State（功能层，由健康检查驱动）               │
│                                                      │
│  OK ←──→ Unavailable ←──→ RateLimited               │
│  ↑            ↑                 ↑                    │
│  └────────────┴─────────────────┘                    │
│        AuthFailed ←──→ OK                            │
│                                                      │
│  基础状态: OK, Unavailable                           │
│  特定状态: RateLimited, AuthFailed（可扩展）          │
└─────────────────────────────────────────────────────┘
```

**关键设计：两层正交**

- Guardian 只看 ActivityState：Offline / Stopped → 拉起进程
- MessageRouter 只看 HealthState：决定用户消息如何处理
- 状态共享走 SignalStore（只读快照）；事件触发走具名接口（`engine.setAuthFailed()` / `engine.triggerRecovery()` / `engine.onProcessRestarted()` / `engine.notifyUserMessage()`）——两条通道各司其职，互不读对方字段

### 2.2 ActivityState 定义

| 状态 | 条件 | 说明 |
|------|------|------|
| **Offline** | tmux session 不存在 | 需要拉起 |
| **Stopped** | tmux 存在，agent 进程未运行 | 需要拉起 |
| **Idle** | agent 运行，空闲 ≥ 3s | 可接收消息和控制命令 |
| **Busy** | agent 运行，active_tools > 0 或最近有活动 | 正在处理任务 |

**冻结的瞬态处理**：ProcSampler 检测到进程冻结（context switch 长期为零）后直接 kill，**不在 agent-status.json 写 frozen 状态**。下一 tick Guardian 看到进程消失 → 写 Offline → 拉起流程接管。冻结是实现层的瞬态，不进入对外 ActivityState 枚举（否则消费端要处理第 5 个状态，且会让"实现细节泄漏到契约"的反模式出现）。冻结事件走日志层（`activity.log` + metrics），不污染状态契约。

### 2.3 HealthState 定义

| 状态 | 触发条件 | 恢复路径 |
|------|----------|----------|
| **OK** | 健康检查通过 | — |
| **Unavailable** | 检查失败，未识别为特定原因 | 指数退避重试（60s → 300s → 1500s → 3600s cap），超过 60min 后转为固定 3600s 间隔 |
| **RateLimited** | 检测到限流文本 + 行为信号 | 冷却期到期后进入 Unavailable 恢复流程 |
| **AuthFailed** | 认证探测失败 | 180s 冷却后重试认证 |

### 2.4 Unavailable 的内部退避策略（对外不可见）

Unavailable 统一了当前的 recovering 和 down。内部用 **wall-clock 时间驱动**控制退避升级：

- 进入 Unavailable 时记录 `unavailable_since = Date.now()`
- 前 60 分钟：指数退避探测，间隔 60s → 300s → 1500s → 3600s cap
- 超过 60 分钟：固定 3600s 间隔重试

退避升级基于时间而非探测计数。理由：时间语义对用户更明确（"1 小时内密集重试，之后每小时重试一次"），不受探测耗时、网络延迟等因素影响。ToolWatchdog / MessageRouter 的 `triggerRecovery()` 在 `unavailable_since ≥ 60min` 时也**受同一门控拒绝**（见 §3.5），避免长故障下被事件反复触发探测 + restart 循环。

**对外只暴露 `"health": "unavailable"` 和 `"unavailable_since": <timestamp>`**，不写 `health_substate`。消费端读时间戳自行判断：

- `Date.now() - unavailable_since < 60min` → "稍后重试" 文案
- `Date.now() - unavailable_since ≥ 60min` → "需管理员介入" 文案

这样既统一了主状态机（从 5 种收敛为 4 种），又让消费端保有文案区分能力。HealthEngine 只写主状态和时间戳，不暴露内部子状态，不增加字段。

### 2.5 进程拉起后的初始健康状态

Guardian 拉起进程后，**HealthState 保留 `agent-status.json` 中持久化的健康值**（而非强制置为 Unavailable），同时启动两个 Grace 计时器。两层正交体现在这里：**进程拉起是 ActivityState 层的事件，不直接修改 HealthState；health 由 HealthEngine 的探测独立判定**。持久化回填的意义在于：崩溃后重启时，如果磁盘记录 `health: ok`，新进程起来后应当保持 OK 视图到下次探测推翻为止；如果记录 `health: unavailable`，则沿用既有退避计时，避免重启"重置"故障认知。

Grace 的两个计时器**作用域不同，不合并**：

| 参数 | 归属 | 默认 | 作用 |
|------|------|------|------|
| `startupGrace` | Guardian 层 | 30s | Guardian 的"本地锁"，允许判断 stopped — 防止 tmux session 尚未建立就触发第二次 `startAgent()` |
| `launchGracePeriod` | HealthEngine 层 | 180s | 抑制 HealthEngine 的主动探测，避免新进程初始化期间误判为 Unavailable |

两个参数的作用域完全不同：一个控制 Guardian 什么时候允许判断"stopped"，另一个控制 HealthEngine 什么时候开始主动探测。合并会导致 Guardian 等 180s 才敢判断进程不存在——30s 已足够且必要。两者均暴露为 per-runtime 配置项（Claude 可调 60s / 120s，Codex 保持 30s / 180s）。

Guardian 在 restart 流程中还负责：

- 显式 clear heartbeat-pending（防止旧 pending 超时误判）
- 调用 `engine.onProcessRestarted()`：HealthEngine 从 `agent-status.json` 读取持久化 health 回填内存状态、启动 launchGracePeriod、重置退避计时；**不强制修改 health**

---

## 三、组件架构

### 3.1 模块总览

```
activity-monitor/
├── scripts/
│   ├── monitor.js                # 入口 + 主循环编排层（同时是 MessageRouter 宿主进程）
│   ├── guardian.js               # 进程存活守护
│   ├── health-engine.js          # 健康状态机（替代 heartbeat-engine.js）
│   ├── message-router.js         # 用户消息路由（事件驱动）
│   ├── tool-pipeline.js          # 工具生命周期 + 事件流（合并 PR #500 tool-lifecycle / tool-event-stream）
│   ├── tool-watchdog.js          # 工具超时检测（PR #500 模块）
│   ├── signal-store.js           # 信号聚合读取（快照 + 流式）
│   ├── status-writer.js          # agent-status.json 写入
│   ├── task-scheduler.js         # 统一定时任务调度器
│   ├── proc-sampler.js           # 进程冻结检测（保留）
│   ├── hook-activity.js          # Hook 脚本（路径不变）
│   ├── hook-auth-prompt.js       # Hook 脚本（路径不变）
│   ├── context-monitor.js        # Hook 脚本（路径不变）
│   ├── session-start-prompt.js   # Hook 脚本（路径不变）
│   ├── session-foreground.js     # Hook 脚本（PR #500 新增）
│   ├── claude-pid.js             # 辅助：Claude PID 解析
│   ├── health-checks/
│   │   ├── heartbeat-check.js    # C4 控制消息 ack 检查
│   │   ├── rate-limit-check.js   # tmux 限流文本扫描
│   │   ├── auth-check.js         # CLI probe 认证检查
│   │   └── api-error-check.js    # tmux API 错误扫描
│   ├── tasks/                    # 注册式定时任务
│   │   ├── daily-upgrade.js
│   │   ├── daily-memory-commit.js
│   │   ├── upgrade-check.js
│   │   ├── health-check.js
│   │   ├── usage-monitor.js
│   │   └── context-check.js
│   └── adapters/                 # 运行时适配器（依赖注入）
│       ├── claude.js
│       └── codex.js
```

### 3.2 主循环编排（monitor.js）

精简为纯编排层，每秒 tick 一次，按固定顺序驱动各子系统：

```
每秒 tick:
1. signalStore.refresh()          ← 读取所有信号（快照 + 流式增量），生成 immutable snapshot
2. guardian.tick(signals)          ← 进程存活守护 + restart 决策
3. procSampler.tick(signals)       ← 冻结检测
4. toolPipeline.tick(signals)      ← 工具生命周期推进 + 合成 api-activity
5. toolWatchdog.tick(signals)      ← 工具超时检测与干预
6. healthEngine.tick(signals)      ← 健康状态机转换 + 主动探测编排
7. taskScheduler.tick(signals)     ← 定时任务调度
8. statusWriter.write(signals)     ← 写 agent-status.json
```

每个组件的 `tick()` 接收同一份 signals snapshot，组件之间不互相调用，顺序明确。三条序的硬约束：

- **toolPipeline 必须在 healthEngine 之前**：healthEngine 需要读 `api-activity` 判断工具活动
- **toolWatchdog 在 toolPipeline 之后、healthEngine 之前**：watchdog 基于 toolPipeline 合成的视图做超时判断，其干预动作可能触发 healthEngine 降级
- **MessageRouter 不在 tick 循环中**：事件驱动，由 c4-receive 在消息到达时调用

PR #500 引入的 tool-lifecycle / tool-event-stream / tool-watchdog / session-foreground / claude-pid 子系统在 v1 中完全缺席；v2.1 把它们作为**一等公民**接入主循环编排。

### 3.3 SignalStore（信号聚合）

SignalStore 在每 tick 开头刷新一次，产出一份 **只读 snapshot** 供后续组件共享。在概念上分为两层：

**快照层（readJSON）**

一次性读取所有状态快照文件，冻结为 snapshot。典型信号源包括：

| 信号 | 写入方 | 消费方 |
|------|--------|--------|
| `api-activity.json` | toolPipeline（tick 合成） | HealthEngine / UI |
| `statusline.json` | context-monitor.js（Claude statusLine hook） | TaskScheduler（context-check） |
| `heartbeat-pending.json` | HealthEngine / Guardian | HealthEngine |
| `user-message-signal.json` | c4-receive.js | HealthEngine（加速探测） |
| `proc-state.json` | ProcSampler | Guardian / HealthEngine |
| `foreground-session.json` | session-foreground.js | ToolWatchdog |
| `rate-limit-state.json` | HealthEngine（进入 RateLimited 时写 `{until: <timestamp>}`，退出时清空） | Guardian（restart 决策读）|
| `agent-status.json` | statusWriter | c4-receive / c4-dispatcher / web-console |

**流式层（JSONL incremental reader）**

针对 `tool-events.jsonl` 这类追加流（由 hook-activity.js 写入、toolPipeline 消费），SignalStore 提供一个有状态的增量读取器——每 tick 只读取上次游标之后新增的事件，交给 toolPipeline 处理。流式层内部维护读取进度，不是无状态的全量 readJSON。

两层在概念上合并到 SignalStore，对外只暴露一个 snapshot 接口。组件看到的永远是"当前 tick 的信号视图"，不关心底层是快照读还是增量读。

**重要澄清**：`api-activity.json` 不是 hook 直接产出，而是 toolPipeline 每 tick 合成的快照。hook-activity.js 只写原始事件流 `tool-events.jsonl`，toolPipeline 消费事件流后合成 `api-activity.json`。

### 3.4 Guardian（进程守护）

Guardian 只关心进程是否在运行，不关心为什么不健康。

职责：

- 每 tick 检查 tmux 和 agent 进程是否存活；若不在运行，调用 adapter 拉起
- 管理 restart 指数退避（5s → 10s → 20s → 40s → 60s cap）+ 连续稳定 60s 后自动重置（`BACKOFF_RESET_THRESHOLD`）
- 管理 `authRetrySuppressedUntil` 冷却窗口（AuthFailed 后 180s 内抑制 restart）
- Launch 前等待 TaskScheduler 的维护任务完成（daily-upgrade 等），最长等待 300s，防止维护脚本与 launch 并发冲突
- Restart 成功后显式 clear heartbeat-pending，并调用 `engine.onProcessRestarted()`

"能否拉起"的决策由 Guardian 自行组装，全部从 Guardian 自己的状态 + SignalStore 读取，**不查询 HealthEngine**。四个条件：

1. `signals.rateLimitState == null || Date.now() >= signals.rateLimitState.until` — 从 SignalStore 读 `rate-limit-state.json`。HealthEngine 探测到限流时写入 `{until: <timestamp>}`，退出 RateLimited 时清空。Guardian 只看这个信号的当前值，不感知它由哪个组件写入——等同于读 `proc-state.json` 等其他快照信号。
2. `Date.now() >= authRetrySuppressedUntil` — Guardian 自己维护的 auth 冷却窗口
3. `notRunningCount >= restartDelay` — Guardian 自己维护的 restart 指数退避
4. `!taskScheduler.isMaintenanceRunning()` — 维护窗口锁

四条条件全部解耦：Guardian 不读 HealthState 字段，不调 HealthEngine 方法。RateLimited 的冷却感知通过 SignalStore 这个第三方只读快照传递——HealthEngine 作为该信号的生产者，Guardian 作为消费者，两者之间**零直接调用**。这是 §1.2 原则 1 "状态共享走 SignalStore" 的直接应用。

Guardian 在 auth-check 失败时调用 `engine.setAuthFailed(reason)` 通知 HealthEngine——这属于"事件触发"类交互（§1.2 原则 1 的第二类通道），是一个收敛的具名接口，不是通用 `setHealth`。事件类交互不走 SignalStore 的理由：事件是时间点动作，不是持续状态值，用文件快照传递会丢失触发语义（"已发生一次 auth 失败"和"当前处于 auth 失败状态"是不同的语义层）。

### 3.5 HealthEngine（健康状态机）

HealthEngine 替代当前 HeartbeatEngine，核心变化：

| 维度 | 当前 HeartbeatEngine | 新 HealthEngine |
|------|---------------------|-----------------|
| 状态数 | 5（ok / recovering / down / rate_limited / auth_failed） | 4（ok / unavailable / rate_limited / auth_failed） |
| 退避管理 | recovering 与 down 分开管理 | Unavailable 内部统一（时间驱动） |
| 对外暴露 | 直接读 health 值 | 只读属性（`health` / `unavailable_since`）+ 事件类具名方法 + `rate-limit-state.json` 信号 |
| Grace 机制 | 两层合并混乱 | `startupGrace`（Guardian）+ `launchGracePeriod`（HealthEngine）作用域分明 |
| 依赖 | 直接 import adapter | 构造时注入 adapter |

**对外接口**（均为具名方法或只读属性，不暴露内部字段）：

- `health` — 当前健康状态：`'ok' | 'unavailable' | 'rate_limited' | 'auth_failed'`
- `unavailableSince` — 进入 Unavailable 的 wall-clock 时间戳，消费端据此判断文案
- `onProcessRestarted()` — Guardian 调用（事件）：从 `agent-status.json` 读取持久化 health 回填内存状态，启动 launchGracePeriod 抑制探测，重置退避计时，clear pending；**不强制修改 health**（两层正交，进程拉起 ≠ 健康变化）
- `setAuthFailed(reason)` — Guardian 调用（事件）：将状态切到 AuthFailed
- `triggerRecovery()` — ToolWatchdog / MessageRouter 调用（事件）：主动发起一次恢复检查（门控规则见下）
- `notifyUserMessage()` — MessageRouter 转发（事件）：用户消息到达信号，可加速 Unavailable 的恢复探测
- `tick(signals)` — 主循环每秒调用

**v2.1 → v2.2 变更**：移除 `isRestartBlocked()` 和 `getBackoffDelay()` 两个对外查询方法。限流冷却状态改写入 SignalStore 的 `rate-limit-state.json`（进入 RateLimited 时写 `{until: <timestamp>}`，退出时清空），Guardian 从 SignalStore 消费，不再同步查询 HealthEngine。这样 Guardian 和 HealthEngine 之间只剩"事件类"单向调用（Guardian → HealthEngine 的 `setAuthFailed` / `onProcessRestarted`；ToolWatchdog / MessageRouter → HealthEngine 的 `triggerRecovery` / `notifyUserMessage`），**反向查询路径完全消除**。

**`triggerRecovery()` 的门控规则**（避免长故障阶段被事件反复触发 probe + restart 循环）：

| 当前状态 | 门控行为 |
|---------|---------|
| `health === 'ok'` | 返回 no-op（不需要恢复）|
| `health === 'rate_limited'` | **拒绝**——冷却期内探测无意义，返回当前 health + 预计解除时间 |
| `health === 'unavailable'` 且 `Date.now() - unavailable_since < 60min` | **接受**——启动 recovery check（或加入 in-flight probe 的 waitingMessages）|
| `health === 'unavailable'` 且 `Date.now() - unavailable_since ≥ 60min` | **拒绝**——退到 tick 的固定 3600s 节奏，不被事件加速；返回当前 health 给调用方 |
| `health === 'auth_failed'` | **接受**（auth 恢复通常靠用户消息触发）|
| 已有 in-flight probe | **加入 waitingMessages**，共享探测结果（§3.6 并发聚合）|

拒绝场景下 `triggerRecovery()` 仍返回当前 health，c4-receive / ToolWatchdog 据此决定回复文案或 metric 记录。

**三层健康监控（OK 状态下）**：

| 层级 | 间隔 | 检测内容 | Token 消耗 |
|------|------|----------|------------|
| Layer 1 | 10s | ProcSampler — 进程冻结检测（context switch 采样） | 零 |
| Layer 2 | 30s | tmux pane scan — 限流 / API error / crash 文本信号 | 零 |
| Layer 3 | 30min | Heartbeat probe — C4 control ack 端到端检查 | 极少（一次 ack） |

Layer 1 + Layer 2 覆盖绝大部分故障场景且零 token。Layer 3 是 safety net。

HealthEngine 只写主状态（`health`）和时间戳（`unavailable_since`），**不写 `health_substate`**。子状态区分完全在消费端基于时间戳完成。

### 3.6 MessageRouter（消息路由）

MessageRouter 是**事件驱动**模块，运行于 `monitor.js` 进程（PM2 长驻进程）内长期持有。c4-receive 作为 per-message 脚本通过本地通信机制向 MessageRouter 请求路由决策——通信细节（socket 等）属于实现层，不在本架构文档展开。

**核心约束：MessageRouter 不调 tmux**

所有 tmux 写入由 **c4-dispatcher 独占**。保留 DB priority 排序、`require_idle` 门控、`agentState.health === 'ok'` 门控的全部现有约束。MessageRouter 的职责限定在**健康协调层**——回答"当前健不健康"、在 recovery 阶段聚合并发探测——而不是**投递层**。

> **C4 主链原则**：任何外部进入的消息都必须走 `c4-receive → DB → c4-dispatcher → tmux` 主链，不允许绕开 DB 或 dispatcher 直接投递。MessageRouter 既不 direct-to-tmux，也不改写投递顺序。

**路由决策**：

```
c4-receive 收到用户消息
    ↓
询问 MessageRouter 健康视图
    ↓
读取 HealthEngine.health
    ├─ OK             → 正常主链（DB → dispatcher → tmux）
    ├─ Unavailable    → 在 MessageRouter 聚合一次 recovery check，按结果回复用户
    ├─ RateLimited    → 按冷却时间回复用户
    └─ AuthFailed     → 触发 auth recovery，按结果回复用户
```

**并发聚合只在 recovery check 阶段起作用**：

在 Unavailable / AuthFailed 状态下，短时间内可能有多条消息到达。此时多个请求共享同一次 recovery check，避免重复探测。OK 路径上不聚合——每条消息独立走 C4 主链，投递顺序由 DB priority + dispatcher 保证。

具体实现（`#pendingCheck` + `#waitingMessages` 的进程内变量管理，以及临界区顺序）属于实现层，不在架构文档展开。

### 3.7 不健康状态下消息进入（Howard direction fix）

v1 / v2 早期方案在 Grace 期间有一条隐含的错误路径：c4-receive 看到 health 非 OK 时直接 `emitError() → process.exit(1)`，导致 Grace 窗口内的用户消息丢失。v2.1 修正后，c4-receive 在 health 非 OK 时走**入队 + 触发 check 并列**的双动作路径：

1. **正常入队**：消息写入 SQLite 队列（现有 `insertConversation` 路径），不 exit、不绕 Unavailable——保证不丢
2. **触发一次 recovery check**：同步通知 MessageRouter 发起一次健康探测（异步执行，不阻塞入队返回）；多条并发消息共享同一次 check（并发聚合见 §3.6）——加速恢复感知，不必等 tick 的定期探测
3. **回复用户一条提示**：按 health + `unavailable_since` 决定文案（Grace/ Unavailable 初期"消息已入队，等恢复后处理"；`unavailable_since ≥ 60min` 走"需管理员介入"）
4. **c4-dispatcher 按现有 `health === 'ok'` + priority + `require_idle` 门控**在健康恢复后投递

两个动作（入队 / 触发 check）**并列发生，不是二选一**：入队保证消息不丢，触发 check 保证 recovery 被消息驱动（不只是 tick 驱动）。**消息丢失的修复职责落在 c4-receive 自己**，不由 MessageRouter 的 fallback 承担——MessageRouter 即便通信不可用，入队仍然执行，消息进 C4 DB 后 dispatcher 在 health 恢复后投递，下限是等 HealthEngine 的 tick 定期探测。DB audit、priority ordering、门控约束全链路保留。

### 3.8 ToolPipeline（物理合并 PR #500 tool-lifecycle + tool-event-stream）

PR #500 引入了一套完整的工具生命周期子系统。v2.1 将其中相关的两个文件**物理合并**为 **`tool-pipeline.js`**（不是仅概念合并），作为主循环的一等公民：

- 消费 `tool-events.jsonl` 的增量事件——**通过 SignalStore 流式层读取**，不直接读 JSONL 文件（PR #500 的 `tool-event-stream.js` 的 offset / inode / 轮转 drain 逻辑并入 SignalStore §3.3 流式层，符合 §3.3 "SignalStore 对外只暴露一个 snapshot 接口"的约束）
- 维护多 session 的工具生命周期内存状态（原 `tool-lifecycle.js` 内容）
- 每 tick 合成 `api-activity.json`，供 HealthEngine 和 UI 消费

对外暴露工具活动视图，供 ToolWatchdog 做超时判断使用。内部可自由切分 session tracking / event consumption / state projection 三部分，但对外只有 `.tick(signals)` 一个入口。

**边界调整意图**：PR #500 的函数签名 / 事件 schema / session 字段完全保留，只是把两文件并成一个、把 JSONL 读取委托给 SignalStore。属于边界适配，不是重写。

### 3.9 ToolWatchdog（PR #500 语义保留，边界适配）

ToolWatchdog 检测前台 session 的工具超时，超时后发出中断信号并记录。超时事件会通过 `engine.triggerRecovery()` 这个具名接口通知 HealthEngine——工具卡死在产品语义上等价于功能不可用，健康状态应该如实反映。这是 §1.2 具名接口交互的应用：通过明确收敛的接口名暴露，不扩展为通用写接口。

**内部语义保留**（PR #500 线上稳定跑了两个月，不动）：

- **5-stage 状态机**：Start → Running → Timeout → Intervention → Completed（每 session 每工具独立跟踪）
- **工具分类规则**：不同工具的超时阈值（Bash / Edit / Write / MCP 等各自阈值）
- **intervention 按键序列**：超时触发时通过 `adapter.sendMessage()` 发出中断信号（§五）
- **`tool-watchdog-state.json` 字段结构**：session × tool 的 pending intervention 状态

**边界适配**（v2.1 新增约束）：

1. **工具规则通过 Adapter DI**：`tool-rules.js` 作为默认值；Adapter 通过 `getToolRules()`（§五）提供 runtime-specific 覆盖。Claude runtime 用默认规则，Codex runtime 传入自己的规则集——ToolWatchdog 构造时 `adapter.getToolRules() ?? defaultToolRules`，不直接 import tool-rules.js
2. **独立 owner**：ToolWatchdog 自己管 `tool-watchdog-state.json` 的写入和读取（StatusWriter 只负责 `agent-status.json`，不碰 watchdog 状态——符合 §3.1 单一职责）
3. **对外收敛到两个接口**：`.tick(signals)` + `.getPendingInterventions()`（UI / 状态查询用），内部 5-stage 状态机对外 opaque；任何外部可见的副作用通过 `engine.triggerRecovery()` 发出
4. **Intervention 发送走 Adapter**：超时中断通过 `adapter.sendMessage(keySequence)` 执行（§五），不直接调 tmux——保证 Codex runtime 下可扩展

这 4 条都是**边界 / DI / 接口面**调整，PR #500 的 5-stage 状态机、rules 数值、intervention 按键序列完全保留。属于 §1.2 原则 4 "设计驱动实现调整" 的同一套逻辑——下游 c4-receive 要改，Watchdog 的边界也要改，不做例外。

### 3.10 TaskScheduler（统一定时任务调度器）

所有定时任务注册到 TaskScheduler，主循环每秒 tick 时统一调度。注册时声明：

- `interval`：固定间隔（秒）或 `dailyHour`（每日固定小时）
- `condition`：执行前置条件（读 signals 的函数）
- `execute`：执行体
- `maintenance`：布尔，标记为维护任务（供 Guardian 查询 `isMaintenanceRunning()`）
- `skipOnStart`：布尔，避免服务启动时立即执行 daily 任务

新增任务只需在 `tasks/` 下新建文件 + 注册，无需修改主循环。

**不引入 cron 解析器**：`dailyHour` + `intervalSeconds` 覆盖当前所有任务（daily-upgrade 固定小时、memory-commit 固定小时、health-check 24h 间隔、usage-monitor 秒级间隔、context-check 秒级间隔）。

**context-check 与 context-monitor 的分工**：

- `context-monitor.js`（Hook 脚本）：Claude 的 statusLine hook，每次 turn 结束后写 `statusline.json`（事件驱动，零轮询）
- `tasks/context-check.js`（定时任务）：Codex 运行时的上下文轮询（30s 间隔），以及 Claude 侧的二次判断（读 `statusline.json` → 判断是否触发 new-session / early memory sync）

后者消费前者的输出，不重复采集。

### 3.11 退避机制（5 + 1 统一视图）

当前散落的多套退避在 v2.1 中有明确的归属与参数，合并视图如下：

| # | 机制 | 归属 | 参数 | 说明 |
|---|------|------|------|------|
| 1 | Guardian restart backoff | Guardian | 5s → 10s → 20s → 40s → 60s cap | 进程重启指数退避 |
| 2 | HealthEngine recovery（前 60min） | HealthEngine | 60s → 300s → 1500s → 3600s cap | Unavailable 内部主动探测 |
| 3 | HealthEngine recovery（60min 后） | HealthEngine | 固定 3600s | 超过 60min 降级为每小时 |
| 4 | Auth retry suppression | Guardian | 固定 180s | AuthFailed 后对 restart 的抑制 |
| 5 | User message cooldown | HealthEngine | 60s | 防止用户消息触发重复探测 |
| 6 | Tool watchdog intervention | ToolWatchdog | 规则化超时阈值 | 工具卡死后的中断 / 降级 |
| R | `BACKOFF_RESET_THRESHOLD` | Guardian | 连续稳定 60s 归零 restart counter | 对 #1 的重置条件，非独立机制 |

"5 + 1" 的说法：5 套主动退避 + 1 个重置阈值。v1 漏了 tool watchdog 一条与重置阈值；v2.1 合并在同一张表里，便于审计与调参。

---

## 四、健康检查策略

### 4.1 检查类型

每种健康检查独立为一个模块，放在 `health-checks/` 目录：

| 检查 | 触发场景 | 方法 | Token | 耗时 |
|------|---------|------|-------|------|
| **heartbeat-check** | Layer 3（30min）+ 恢复重试 | C4 control 消息 enqueue → 等待 ack | 极少 | 2-120s |
| **rate-limit-check** | Layer 2（30s）+ 恢复检查 | tmux capture-pane → regex 匹配 | 零 | <100ms |
| **auth-check** | 进程启动后 + AuthFailed 恢复 | `claude -p ping` / `codex --version` | 零 | 1-5s |
| **api-error-check** | Layer 2（30s），heartbeat pending 时 | tmux capture-pane → API error pattern | 零 | <100ms |

### 4.2 检查编排

HealthEngine 在不同状态下调用不同的检查组合：

```
OK 状态（后台监控）:
  Layer 1 (10s):   ProcSampler
  Layer 2 (30s):   rate-limit-check + api-error-check
  Layer 3 (30min): heartbeat-check

Unavailable 状态（恢复探测）:
  按退避间隔执行 heartbeat-check
  持续执行 rate-limit-check（识别是否实为限流）

RateLimited 状态（等待冷却）:
  定期执行 rate-limit-check（检测限流是否解除）
  冷却到期后转 Unavailable，走恢复流程

AuthFailed 状态（等待认证恢复）:
  180s 冷却后 auth-check
  用户消息到达时立即触发 auth-check
```

---

## 五、Adapter 依赖注入

运行时差异通过 adapter 封装，构造时注入 Guardian 和 HealthEngine：

```
adapter = runtime === 'codex' ? new CodexAdapter(config) : new ClaudeAdapter(config);
guardian = new Guardian(adapter, healthEngine, taskScheduler);
healthEngine = new HealthEngine(adapter, config);
```

Adapter 接口（架构层概述，完整签名在实现阶段定稿）：

- **标识**：`runtimeId`（`'claude' | 'codex'`）/ `heartbeatEnabled` / `supportsHooks`
- **进程管理**：`launch()` / `stop()` / `isRunning()` / `getProcessPid()`
- **健康检查**：`checkAuth()` / `getHeartbeatDeps()`
- **运行时差异**：`getContextMonitor()`（仅 Codex 实现）/ `getUsageStateFile()` / `getToolRules()`
- **消息写入**：`sendMessage(text, opts)`
- **tmux**：`getTmuxTarget()` / `getSessionName()`

**`getHeartbeatDeps()`**：返回 runtime-specific 心跳探测依赖集，至少包含 `probe()`（发起一次心跳检查并返回 `Promise<result>`）、`timeout` 默认值、`pendingKey`（pending 状态持久化键）。HealthEngine 构造时通过 adapter 注入，不硬编码任何 runtime 细节。Claude 实现走 C4 control enqueue + 等 ack；Codex 实现按自身探测路径组装。

**`sendMessage(text, opts)`**：runtime-specific 消息/按键发送路径。Claude 走 tmux keys，Codex 走 CLI 注入或其他机制。ToolWatchdog 的中断（Ctrl-C 按键序列）、MessageRouter 的恢复文案、以及 auth recovery 的交互提示，均通过此接口，避免直接调 tmux 绕过 adapter 抽象。

`supportsHooks` 用于让 SignalStore 在 Codex 下正确跳过 hook-only 的信号源（如 `tool-events.jsonl`，Codex 下不存在）。

测试时传入 mock adapter，实现完全隔离的单元测试。

---

## 六、Hook 兼容策略

### 6.1 路径不变

所有 Hook 脚本在 `scripts/` 目录下的物理路径保持不变：

```
scripts/hook-activity.js          ← UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification
scripts/hook-auth-prompt.js       ← PermissionRequest
scripts/context-monitor.js        ← statusLine
scripts/session-start-prompt.js   ← SessionStart（startup / clear / compact）
scripts/session-foreground.js     ← SessionStart（PR #500 新增）
scripts/claude-pid.js             ← 辅助 PID 解析
```

用户的 `~/.claude/settings.json` 无需任何修改。

### 6.2 两类 Hook 契约

Hook 脚本按交互方式分为两类。区分两类很关键：如果只把 Hook 设计成"写文件"，会漏掉权限弹窗自动确认与新会话启动提示注入两条控制面链路。

**Signal Hooks（write-only，经 SignalStore 消费）**

| Hook | 写入 | 用途 |
|------|------|------|
| `hook-activity.js` | `tool-events.jsonl` | 工具生命周期事件流，由 toolPipeline 消费后合成 `api-activity.json` |
| `context-monitor.js` | `statusline.json` | Claude statusLine hook，记录 token 使用与上下文占用 |
| `session-foreground.js` | `foreground-session.json` | 记录当前前台 session，供 ToolWatchdog 使用 |
| `claude-pid.js` | `claude-pid.json` | 供 Guardian 定位 Claude PID |

这类 hook 只做文件写入，由主进程通过 SignalStore 读取，不直接调用主进程、不入 C4 队列。

**Control Hooks（直接 c4-control enqueue）**

| Hook | 动作 | 用途 |
|------|------|------|
| `hook-auth-prompt.js` | `c4-control enqueue [KEYSTROKE]Enter --bypass-state` | 权限弹窗自动确认 |
| `session-start-prompt.js` | `c4-control enqueue --content <startup-prompt>` | 向新会话注入启动提示 |

这类 hook 通过 `c4-control` 向 C4 控制队列入队操作建议，**仍然经过 C4 主链**——DB audit / priority / `require_idle` 门控照走。入口是 hook 而不是外部消息，但走的是同一条链路，不违反"C4 主链原则"。

### 6.3 Hook 输出消费

Signal Hooks 写入的文件通过 SignalStore 统一读取。Hook 脚本本身不需要知道新架构的存在——它们的契约是"写文件"（Signal 类）或"入 C4 控制队列"（Control 类），消费端是谁不影响它们。

---

## 七、agent-status.json Schema

### 7.1 字段变更

| 字段 | v1（当前） | v2.1（新） |
|------|-----------|------------|
| `state` | offline / stopped / busy / idle | 不变 |
| `health` | ok / recovering / down / rate_limited / auth_failed | **ok / unavailable / rate_limited / auth_failed** |
| `unavailable_since` | （无） | **进入 Unavailable 的时间戳**（仅 `health === 'unavailable'` 时出现） |
| `schema_version` | （无） | **2** |

核心变化：`recovering + down` 合并为 `unavailable`，同时新增 `unavailable_since` 让消费端可以自行区分"暂时不可用"与"需管理员介入"。**不新增 `health_substate`**——时间戳足以承担区分职责，子状态字段会让内部实现细节泄漏到对外契约上。

### 7.2 下游影响

| 消费者 | 改动 | 归属 Phase |
|--------|------|----------|
| c4-receive | 原有 `health === 'down'` 分支改为读 `unavailable_since`：与当前时刻差 < 60min 走 HEALTH_RECOVERING 文案，≥ 60min 走 HEALTH_DOWN 文案；Grace / Unavailable 期间消息正常入队（不 exit）**并并列触发一次 recovery check**（§3.7） | Phase 4 |
| c4-dispatcher | `health !== 'ok'` 仍然 defer 投递，无需区分 substate；值域变化仅 recovering/down → unavailable | Phase 5 |
| web-console | 显示健康状态，可选地用 `unavailable_since` 区分显示文案 | Phase 5（文案） |

activity-monitor 和 comm-bridge 同版发布（monorepo 单包），不存在单独升级的场景，不需要灰度兼容。未来若拆包再引入 `schema_version` 检查。

---

## 八、迁移计划

### Phase 0（前置）：Watchdog 边界适配（内部语义不动）

PR #500 的 watchdog 子系统已在 main 上运行两个月，**内部状态机 / 规则数值 / intervention 按键序列完全保留**。但边界（文件组织、接口面、依赖注入点）按 v2.1 架构适配——避免出现"下游 c4-receive 按新架构改、Watchdog 却豁免"的原则 4 矛盾。

本 Phase 的 5 项适配工作：

1. **tool-event-stream 的增量读取并入 SignalStore 流式层**：offset / inode / 轮转 drain 逻辑由 SignalStore §3.3 流式层统一管理；ToolPipeline 通过 SignalStore 消费结构化事件，不直接读 JSONL
2. **物理合并 tool-lifecycle.js + tool-event-stream.js → tool-pipeline.js**：对外只暴露 `.tick(signals)`；内部可按 session tracking / event consumption / state projection 切分
3. **tool-rules.js 从硬编码改为 Adapter DI 覆盖**：默认值保留，Adapter 的 `getToolRules()`（§五）提供 runtime 特定覆盖；ToolWatchdog 构造时 `adapter.getToolRules() ?? defaultToolRules`
4. **ToolWatchdog 独立持有 `tool-watchdog-state.json`**：StatusWriter 只写 `agent-status.json`；Watchdog 状态不经 StatusWriter 路径
5. **ToolWatchdog 对外接口收敛为 `.tick(signals)` + `.getPendingInterventions()`**：内部 5-stage 状态机不暴露；副作用走 `engine.triggerRecovery()` + `adapter.sendMessage()`

**保留的内部语义**（反例清单，避免误改）：
- 5-stage 状态机（Start / Running / Timeout / Intervention / Completed）
- 工具分类规则的具体阈值（Bash / Edit / Write / MCP 等）
- intervention 按键序列（Ctrl-C 序列等）
- `tool-watchdog-state.json` 字段结构
- tool 生命周期 event 的 JSONL schema

**测试要求**：以现有 watchdog 行为（超时判定 / intervention 触发 / recovery 通知）为 golden，适配前后 E2E 行为必须等价；单元测试覆盖 4 条边界适配（SignalStore 流式读取 / Adapter DI 覆盖 / watchdog-state 独立持久化 / 接口收敛）。

Phase 0 完成后进入 Phase 1 基础设施搭建。

### Phase 1: 基础设施

1. 新建 `signal-store.js`（快照层 + 流式层）、`status-writer.js`、`task-scheduler.js`、`tool-pipeline.js`
2. DailySchedule 逻辑迁移到 TaskScheduler（保留旧实现至 Phase 5）
3. 新建 `tasks/` 目录，每个定时任务独立文件
4. TaskScheduler / SignalStore 单元测试覆盖

Phase 1 完成后旧 activity-monitor.js 仍在，新模块通过 feature flag 挂接，独立可 ship。

### Phase 2: 状态模型 + 组件拆分（合并）

合并原 Phase 2 / 3 为单阶段，避免新旧混合的中间态：

1. 新建 `guardian.js` + `health-engine.js` + 新 `monitor.js`
2. HealthEngine 实现 Unavailable 的 wall-clock 时间驱动退避；对外只暴露 `health` + `unavailable_since`，不写子状态
3. Guardian 自组装"能否拉起"的复合决策（退避 + auth 冷却 + 维护锁 + SignalStore 读 `rate-limit-state.json`），**不查询 HealthEngine**；HealthEngine 在 RateLimited 进出时写 `rate-limit-state.json`
4. 新 `monitor.js` 实现 8 步 tick（signalStore / guardian / procSampler / toolPipeline / toolWatchdog / healthEngine / taskScheduler / statusWriter）
5. 保留 `activity-monitor.legacy.js`（当前主文件的完整拷贝）作为回滚路径
6. PM2 配置通过启动参数切换新旧入口
7. 测试：HealthEngine 状态转换（含 PM2 重启恢复）、Guardian 单元测试、新旧对照集成测试

### Phase 3: 消息路由 + c4-receive 适配

1. 在 monitor.js 进程内实例化 MessageRouter，暴露本地通信入口
2. c4-receive 改造：Grace / Unavailable 期间**正常入 C4 队列**（现有 `insertConversation` 路径）**并并列触发一次 recovery check**（通知 MessageRouter 异步探测），不 `exit(1)`；按 health + `unavailable_since` 回复用户对应文案
3. MessageRouter 实现 recovery check 阶段的并发聚合（OK 路径不聚合）
4. c4-dispatcher 适配新 health 值域
5. 测试：并发聚合测试（多消息共享一次探测）、MessageRouter 降级测试（通信不可用时消息不丢、不 direct-to-tmux、dispatcher 按现有 gating 投递）、Grace 期间消息入队测试

### Phase 4: Schema + 下游文案

1. 更新 `agent-status.json` schema（加 `schema_version: 2`、`unavailable_since`）
2. 更新 c4-receive 文案分支（基于 `unavailable_since` 时间差选择 HEALTH_RECOVERING / HEALTH_DOWN）
3. 更新 SKILL.md 文档
4. 更新 web-console 状态显示

### Phase 5: 收尾

1. 观察 1 周稳定后，删除 `activity-monitor.legacy.js` 和旧 heartbeat-engine.js
2. tool-lifecycle / tool-event-stream 内部实现合并整理（如需）
3. 全量回归测试

### 兼容性保证

- Hook 脚本路径完全不变 → 用户 settings.json 无需修改
- agent-status.json 增加 `schema_version`，字段向后兼容
- config.json 配置项保留 + 新增 per-runtime Grace 参数
- 回滚方案：Phase 2 ship 后若发现问题，改 PM2 启动参数切换回 legacy 入口即可，无需代码回滚

---

*本文档由 zylos01 主笔，zylos0t 提供代码层面的信息补充和设计角度审查。基于 Howard 2026-04-19 direction comment 在 v2 基础上校准而成。*
