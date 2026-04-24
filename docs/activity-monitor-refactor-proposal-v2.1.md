# Activity Monitor 重构方案 v2.1

> 日期：2026-04-24
> 分支：`refactor/activity-monitor`
> 本文为 v2.1 最终方案，精简自 v2（详细设计/权衡档：`activity-monitor-refactor-proposal-v2.md`，750 行）。v1 初稿保留在 `activity-monitor-refactor-proposal.md`。

---

## 〇、TL;DR

`activity-monitor`（AM）是守护 runtime（Claude / Codex）的 PM2 长驻进程。现状是一个 2300+ 行的 God Object，6 大结构痛点。本方案：

- **模块化**：拆成 11 个职责清晰的模块，`monitor.js` 只做编排
- **两层正交状态机**：ActivityState（进程层）/ HealthState（功能层）互不读字段
- **两条通信通道**：状态走 SignalStore 只读快照，事件走具名接口，反向查询路径不存在
- **健康状态收敛**：5 种 → 4 种；对外不暴露子状态，用时间戳做区分
- **定时任务统一**：3 套 ad-hoc 调度器合并为 TaskScheduler 注册式调度
- **冷启动行为显式化**：保留 bypass-once 默认语义；operator 通过 marker 文件做显式全清零

---

## 一、现状痛点

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态语义不清** | health 5 值（ok/recovering/down/rate_limited/auth_failed），其中 recovering 和 down 本质是同一恢复流两阶段 |
| 2 | **Guardian ↔ HeartbeatEngine 紧耦合** | 共享 5 个字段，跨模块直接读写，难独立测试 |
| 3 | **多套退避机制各自为政** | Guardian restart / HealthEngine recovery / auth retry / user cooldown / tool watchdog 语义不一致 |
| 4 | **God Object** | `activity-monitor.js` 单文件 2300+ 行塞了 Guardian/health/watchdog/调度全部职责 |
| 5 | **Watchdog 子系统游离** | PR #500 引入的 tool-lifecycle / tool-event-stream / tool-watchdog 主循环中深度集成但无模块边界 |
| 6 | **定时任务 ad-hoc** | DailySchedule / 间隔 timestamp / 独立状态机 三套混用 |
| 7 | **信号消费散落** | 12+ 状态文件在主循环各处单独 readJSON，无统一快照层 |
| 8 | **AM 冷启动未区分重启前后文与故障重试** | 持久化长退避压制首次 probe，daily-upgrade 修好根因后仍要等退避到期 |

---

## 二、设计原则（6 条）

1. **双层正交状态机**：ActivityState / HealthState 之间**零字段互读**。跨模块协作只走两类通道——状态走 SignalStore 只读快照，事件走具名接口。
2. **Offline → 无条件拉起**：Guardian 只看 ActivityState，不读 HealthState。
3. **recovering + down 合并为 Unavailable**：对外不暴露子状态；消费端读 `unavailable_since` 时间戳自行判断文案（< 60min vs ≥ 60min）。
4. **设计驱动实现调整**：下游 c4-receive / dispatcher / Watchdog 按新架构适配，不以现状代码为约束。
5. **MessageRouter 事件驱动**：并发聚合仅在 recovery check 阶段起作用，OK 路径每条消息独立走 C4 主链。
6. **SignalStore 只读快照 / Adapter DI / TaskScheduler 注册式 / Hook 路径不变**：四块架构基石。用户 `settings.json` 无需修改。

---

## 三、架构总览

### 3.1 11 模块职责表

| 模块 | 所在文件 | 一句话职责 | tick 步骤 |
|------|---------|-----------|-----------|
| **monitor.js** | `scripts/monitor.js` | 入口 + 主循环编排 + MessageRouter 宿主进程 | - |
| **SignalStore** | `scripts/signal-store.js` | 每 tick 开头刷新一次，产出 immutable 信号快照 | 1 |
| **Guardian** | `scripts/guardian.js` | 进程存活守护 + 拉起决策 | 2 |
| **ProcSampler** | `scripts/proc-sampler.js` | OS 级冻结检测（context switch 采样）| 3 |
| **ToolPipeline** | `scripts/tool-pipeline.js` | 工具生命周期 + 事件流合成（物理合并 PR #500 lifecycle + stream）| 4 |
| **ToolWatchdog** | `scripts/tool-watchdog.js` | 工具超时检测与干预 | 5 |
| **HealthEngine** | `scripts/health-engine.js` | 健康状态机 + 主动探针编排 | 6 |
| **TaskScheduler** | `scripts/task-scheduler.js` | 统一定时任务调度器（注册式） | 7 |
| **StatusWriter** | `scripts/status-writer.js` | 写 `agent-status.json`（对外契约唯一发布者） | 8 |
| **MessageRouter** | `scripts/message-router.js` | 用户消息路由（事件驱动，**不在 tick 里**）| - |
| **Adapter** | `scripts/adapters/{claude,codex}.js` | 运行时差异封装（构造时依赖注入） | - |

### 3.2 3 种通信通道

| 通道 | 用途 | 实现 | 一致性 |
|------|------|------|--------|
| 🔵 **State via SignalStore** | 跨模块共享"当前持续值" | 生产者写文件，SignalStore 每 tick refresh；消费者读快照 | Eventual (≤ 1 tick ≈ 1s) |
| 🔴 **Event via 具名接口** | 跨模块触发"一次性动作" | 单向方法调用（`setAuthFailed` / `onProcessRestarted` / `triggerRecovery` / `notifyUserMessage`）| Synchronous |
| 🟢 **C4 主链** | 用户消息投递 | `c4-receive → DB → c4-dispatcher → tmux`（健康门控 + priority + require_idle）| - |

**关键不变量**：Guardian 决策闭环中**不同步查询**任何其他模块；HealthEngine 不对外暴露 getter；c4-dispatcher 独占 tmux 写入。

### 3.3 主循环 tick（每秒 8 步）

```
每秒 tick:
 ① signalStore.refresh()   ← 刷新快照（readJSON + 流式增量合一）
 ② guardian.tick()         ← 进程存活 + 拉起决策
 ③ procSampler.tick()      ← 冻结检测
 ④ toolPipeline.tick()     ← 工具生命周期 + 合成 api-activity.json
 ⑤ toolWatchdog.tick()     ← 工具超时检测
 ⑥ healthEngine.tick()     ← 健康状态机 + 主动探针
 ⑦ taskScheduler.tick()    ← 定时任务调度
 ⑧ statusWriter.write()    ← 写 agent-status.json
```

**顺序硬约束**：④ 在 ⑥ 前（健康判定要读工具活动视图）；⑤ 在 ④ 后 ⑥ 前（watchdog 干预可能触发 health 降级）；MessageRouter 不在 tick 里，由 c4-receive IPC 触发。

---

## 四、状态模型

### 4.1 ActivityState（3 种，无状态投射）

| 状态 | 条件 | 说明 |
|------|------|------|
| **Offline** | tmux session 不存在 **或** tmux 存在但 agent 进程未运行 | 需要拉起 |
| **Idle** | agent 运行，空闲 ≥ 3s | 可接收消息和控制命令 |
| **Busy** | agent 运行，`active_tools > 0` 或最近 < 3s 有活动 | 正在处理任务 |

**计算模型**：ActivityState 不是 FSM，而是**每 tick 结束时 StatusWriter 根据当下信号 snapshot 做的无状态投射**。无历史依赖，每 tick 从零算。

**决策规则**：
```
IF NOT tmux_alive OR NOT proc_alive: state = Offline
ELIF hook_fresh AND (active_tools > 0 OR inactive_sec < 3s): state = Busy
ELSE: state = Idle
```

**冻结的瞬态处理**：ProcSampler 判定冻结后直接 kill，**不写 frozen 状态**；下一 tick 自然投射为 Offline。实现细节不进契约。

### 4.2 HealthState（4 种，FSM）

| 状态 | 触发条件 | 恢复路径 |
|------|----------|----------|
| **OK** | 健康检查通过 | — |
| **Unavailable** | 检查失败，未识别为特定原因 | 指数退避重试（60s → 300s → 1500s → 3600s cap），超 60min 转 3600s 固定间隔 |
| **RateLimited** | 检测到限流文本 + 行为信号 | 冷却到期后进入 Unavailable 恢复流程 |
| **AuthFailed** | 认证探测失败 | 180s 冷却后重试，用户消息到达时立即触发 |

**转换表**：

| 从 | 到 | 触发 |
|----|----|------|
| OK | Unavailable | heartbeat probe 失败 / api-error-check 命中 / triggerRecovery 判死 |
| OK | RateLimited | rate-limit-check 命中 |
| OK | AuthFailed | Guardian 调 `setAuthFailed(reason)` |
| Unavailable | OK | recovery probe 成功 |
| Unavailable | RateLimited | 恢复探测时识别出实为限流 |
| RateLimited | Unavailable | 冷却到期 |
| AuthFailed | OK | auth-check 成功 |
| 任意 | (本状态) | `onProcessRestarted()` 不改 health，只重置退避计时 |

**对外只暴露** `health` + `unavailable_since` 两个字段。不写 `health_substate`——子状态区分完全下放给消费端基于时间戳完成。

**Unavailable 对外文案差分**：
- `Date.now() - unavailable_since < 60min` → "稍后重试"
- `Date.now() - unavailable_since ≥ 60min` → "需管理员介入"

### 4.3 正交约束

- **Guardian 只看 ActivityState**：Offline → 拉起进程
- **MessageRouter 只看 HealthState**：决定用户消息如何处理
- **进程拉起 ≠ 健康变化**：Guardian 拉起后 HealthEngine 从 `agent-status.json` 回填持久化 health，不强制置 Unavailable。避免"重启重置故障认知"（§5.3 冷启动语义）

---

## 五、组件详解

### 5.1 SignalStore（信号聚合）

每 tick 开头刷新一次，产出一份**只读 snapshot** 供后续组件共享。概念上两层统一到一个接口：

- **快照层（readJSON）**：一次性读取所有状态文件冻结为 snapshot
- **流式层（JSONL incremental）**：有状态的增量读取器，读取 `tool-events.jsonl` 上次游标之后的新增事件

**信号清单**：

| 信号文件 | 写入者 | 消费者 |
|---------|--------|--------|
| `api-activity.json` | ToolPipeline（tick 合成）| HealthEngine / UI / StatusWriter |
| `statusline.json` | context-monitor.js（hook） | TaskScheduler（context-check）|
| `heartbeat-pending.json` | HealthEngine | HealthEngine（自消费）|
| `user-message-signal.json` | c4-receive.js | HealthEngine（加速探测）|
| `proc-state.json` | ProcSampler | Guardian / StatusWriter |
| `foreground-session.json` | session-foreground.js（hook） | ToolWatchdog |
| `rate-limit-state.json` | HealthEngine（RateLimited 进出时写/清）| Guardian（条件 #1）|
| `maintenance-state.json` | TaskScheduler（maintenance 任务进出时写/清）| Guardian（条件 #4）|
| `agent-status.json` | StatusWriter | MessageRouter / c4-receive / c4-dispatcher / web-console / HealthEngine 冷启动回填 |
| `tool-events.jsonl` | hook-activity.js | ToolPipeline（流式读）|

### 5.2 Guardian（进程守护）

只关心进程是否在运行，**不关心为什么不健康**。

**职责**：
- 每 tick 检查 tmux + agent 进程存活；不在运行则拉起
- 管理 restart 指数退避（5s → 10s → 20s → 40s → 60s cap），连续稳定 60s 自动归零
- 管理 `authRetrySuppressedUntil`（AuthFailed 后 180s 内抑制 restart）
- Launch 前观察 `maintenance-state.json`，最长等待 300s
- Restart 成功后 clear heartbeat-pending，调用 `engine.onProcessRestarted()`

**4 个拉起条件**（全部从 SignalStore 或 Guardian 自己的状态读取，**不查询其他模块**）：

1. `signals.rateLimitState == null || Date.now() >= signals.rateLimitState.until` — 限流冷却（SignalStore 读 HealthEngine 写）
2. `Date.now() >= authRetrySuppressedUntil` — Guardian 自己的 auth 冷却
3. `notRunningCount >= restartDelay` — Guardian 自己的 restart 退避
4. `signals.maintenanceState == null || !signals.maintenanceState.running` — 维护窗口锁（SignalStore 读 TaskScheduler 写）

**对 HealthEngine 的单向事件触发**（不走 SignalStore，因为事件是时间点动作）：
- `setAuthFailed(reason)`：auth-check 失败
- `onProcessRestarted()`：restart 成功

#### 冷启动行为：bypass-once + marker 重置

Guardian 4 字段（notRunningCount / consecutiveRestarts / restartDelay / authRetrySuppressedUntil）持久化到 `guardian-state.json`。AM 冷启动时分两路径：

**路径 A：默认（无 marker）** —— bypass-once：
- 从 `guardian-state.json` 恢复 4 字段（保留故障认知）
- **首次 probe 绕过条件 #1/#2/#3**（时间驱动退避），**不绕过 #4**（维护窗口互斥锁）
- 首次 probe 成功 → 清空 4 字段
- 首次 probe 失败 → 回到持久化退避水位（不退回 `initial_delay`）

**路径 B：operator 显式重置（marker 存在）**：
- marker 文件：`~/zylos/activity-monitor/.reset-request`
- 冷启动检测到 marker：清空 4 字段 + unlink marker（one-shot）+ 关闭 bypass-once
- CLI：`zylos am reset-backoff [--restart]`

**三场景语义矩阵**：

| 场景 | marker | Guardian 4 字段 | 首次探测 |
|------|--------|----------------|---------|
| `zylos am reset-backoff --restart` | ✅ 一次性 | **清零** | 从 `initial_delay` 开始 |
| daily-upgrade 完成后 AM 自重启 | ❌ | 保留持久化 | bypass-once 给 1 次机会 |
| PM2 auto-restart（AM 崩溃）| ❌ | 保留持久化 | bypass-once 给 1 次机会 |

### 5.3 HealthEngine（健康状态机）

#### 主流程：5 触发源 + 1 FSM + 3 输出

**5 触发源**：
| 触发 | 发起方 |
|------|--------|
| `tick(signals)` | 主循环每秒 |
| `onProcessRestarted()` | Guardian restart 成功后 |
| `setAuthFailed(reason)` | Guardian auth-check 失败 |
| `triggerRecovery()` | ToolWatchdog / MessageRouter |
| `notifyUserMessage()` | MessageRouter |

**tick() 6 步**：
```
tick(signals):
  ① drain pending events
  ② if inLaunchGrace: return         # 新进程起来 180s 内不主动探
  ③ 被动检测（tmux scan 零成本）
      - 限流文本 → 进 RateLimited + 写 rate-limit-state.json
      - API error → 进 Unavailable
  ④ 按当前 state 驱动主动检测
      - OK: 30min heartbeat 安全网
      - Unavailable: 指数退避 probe
      - RateLimited: 查冷却是否到期
      - AuthFailed: 180s 后或用户消息触发 auth-check
  ⑤ probe 结果回调更新 state
  ⑥ 若 state 变动：更新内存 + 写/清 rate-limit-state.json
```

#### 3 层健康监控（OK 状态下）

| 层 | 间隔 | 检测对象 | Token |
|---|------|---------|-------|
| Layer 1（ProcSampler） | 10s | 进程冻结（OS context switch）| 零 |
| Layer 2（tmux scan） | 30s | 限流 / API error / crash 文本 | 零 |
| Layer 3（heartbeat） | 30min | C4 control ack 端到端 | 极少 |

Layer 1+2 覆盖 95% 故障；Layer 3 是"所有看起来正常但不响应 C4"的 safety net。三层结构源自 PR #351（2026-03-18），把原来每 3min 的 heartbeat 放宽到 30min。

#### triggerRecovery() 门控（防止事件反复触发 probe + restart 循环）

| 当前 state | 行为 |
|-----------|------|
| OK | no-op |
| RateLimited | 拒绝（返回预计解除时间）|
| Unavailable 且 `< 60min` | 接受（加入 waitingMessages 聚合）|
| Unavailable 且 `≥ 60min` | **拒绝**（退到 3600s 固定节奏，不被事件加速）|
| AuthFailed | 接受 |
| 已有 in-flight probe | 加入 waitingMessages 共享结果 |

#### 冷启动 health 回填（§4.3 呼应）

Guardian `onProcessRestarted()` 调用后，HealthEngine：
- 从 `agent-status.json` 读取持久化 `health` 回填内存状态（**不强制置 Unavailable**）
- 启动 `launchGracePeriod`（180s）抑制主动探测
- 重置退避计时，clear pending

**哲学**：如果磁盘记录 `health: unavailable` 则沿用既有退避计时，避免"重启重置故障认知"。

### 5.4 MessageRouter（消息路由）

事件驱动模块，**运行于 `monitor.js` 进程**，c4-receive 作为 per-message 脚本通过本地 IPC 询问路由决策。

**核心约束**：MessageRouter 不调 tmux——所有 tmux 写入由 c4-dispatcher 独占。C4 主链不可绕。

#### 路由决策流程

```
c4-receive 收消息
    ↓
MessageRouter 读 health（SignalStore 投射）
    ├─ OK              → c4-receive 写 DB → dispatcher 主链 → AI 真实回复
    ├─ Unavailable     ↴
    ├─ RateLimited     ├→ 聚合一次 recovery check，c4-receive 同步阻塞等
    └─ AuthFailed      ↲
         ↓
Probe 返回
    ├─ recovered=true  → c4-receive 写 DB → dispatcher → AI 真实回复
    └─ recovered=false → c4-receive 不写 DB，回 terminal 文案
```

#### 4 约束 C1~C4

**C1 DB 写入只在"将投递"路径**
`insertConversation` 仅在 OK 直投或 probe recovered 分支执行。STATUS 回复分支不写 DB，消息一次交互完结，不会被 dispatcher 再处理。

**C2 短 window + 30s timeout fallback**
Probe 自然时长 10-30s。c4-receive 硬超时 30s，超时回 STATUS degraded。MessageRouter 的 probe 继续跑，聚合池不被破坏。

**C3 MessageRouter 读 health 走 SignalStore**
读 `agent-status.json` + `rate-limit-state.json`，不直接调 HealthEngine 方法。

**C4 IPC 不可用时的降级**
c4-receive 连不上 MessageRouter（monitor.js crash）时：
- **不 `insertConversation`**——消息不进队列
- 回 terminal 文案："router 暂时不可用，请稍后重发"
- 用户凭文案自行重发

**"一次 c4-receive 一次真实答案" 不变量在所有路径下 100% 成立**。

#### 不变量对照

| 路径 | 用户消息数 | 守 1-reply 不变量？ |
|------|----------|---------------------|
| OK 直投 | 1（AI 回复）| ✓ |
| Probe recovered → 投递 | 1（AI 回复）| ✓ |
| Probe not recovered → STATUS | 1（terminal 文案）| ✓ |
| 硬超时 → STATUS degraded | 1（terminal 文案）| ✓ |
| IPC 降级 → terminal 文案（不入队）| 1（terminal 文案）| ✓ |

#### 并发聚合

仅在 recovery check 阶段起作用。短时间多条消息到达 Unavailable / AuthFailed 时，共享同一次 recovery probe。OK 路径不聚合——每条消息独立走 C4 主链，投递顺序由 DB priority + dispatcher 保证。

### 5.5 StatusWriter

tick 第 8 步。**唯一**写 `agent-status.json` 的组件。做两件事：

1. 读 signals snapshot
2. 按 §4.1 决策规则投射 ActivityState + 读 HealthEngine 只读属性 → 写文件

不持有历史，不维护状态变量。无状态投射保证"重启 AM 后第一 tick 就写出真值"。

### 5.6 ProcSampler

每 10 秒采样进程 context switch 计数（Linux `/proc/<pid>/status`；macOS `top -l 1 -pid <pid> -stats pid,csw`）。

**判定规则**：`isActive == true`（hook fresh 且 active_tools > 0）AND `delta == 0 连续 60 秒` → frozen。

判死后不写 Frozen 状态——直接 `adapter.stop()` + 写 `proc-state.json`。下一 tick Guardian 看进程消失 → Offline → 拉起。

PR #351（2026-03-18）引入；是三层健康监控的 Layer 1。

### 5.7 ToolPipeline + ToolWatchdog

**ToolPipeline**（物理合并 PR #500 tool-lifecycle + tool-event-stream）：
- 消费 `tool-events.jsonl` 的增量事件（通过 SignalStore 流式层）
- 维护多 session 工具生命周期内存状态
- 每 tick 合成 `api-activity.json`

**ToolWatchdog**（PR #500 内部语义完全保留，边界适配）：
- 5-stage 状态机（Start → Running → Timeout → Intervention → Completed）
- 工具分类规则（通过 Adapter DI 注入，不硬编码）
- 独立 owner 写 `tool-watchdog-state.json`
- 超时触发 → `adapter.sendMessage()` 发中断 + `engine.triggerRecovery()` 通知健康层

### 5.8 TaskScheduler

**注册式调度器**，不用 cron。任务声明：

| 字段 | 含义 |
|------|------|
| `interval` / `dailyHour` | 固定间隔秒 或 每日固定小时 |
| `condition` | 执行前置条件（读 signals 的函数） |
| `execute` | 执行体 |
| `maintenance` | 布尔；为 true 时进出执行时自动写 `maintenance-state.json`（Guardian 条件 #4 消费） |
| `skipOnStart` | 避免服务启动立即执行 daily 任务 |

**现有任务**（6 个）：`daily-upgrade` / `daily-memory-commit` / `upgrade-check` / `health-check` / `usage-monitor` / `context-check`。新增只需 `tasks/` 下新建文件 + 注册。

**不引入 cron 解析器**：`dailyHour` + `intervalSeconds` 覆盖当前全部需求；cron 库增加依赖 + 测试面。

---

## 六、Adapter 依赖注入

运行时差异封装为 Adapter，构造时注入 Guardian / HealthEngine / ToolWatchdog / health-checks。

**接口（架构层概述）**：

- **标识**：`runtimeId` / `heartbeatEnabled` / `supportsHooks`
- **进程管理**：`launch()` / `stop()` / `isRunning()` / `getProcessPid()`
- **健康检查**：`checkAuth()` / `getHeartbeatDeps()`
- **运行时差异**：`getContextMonitor()` / `getUsageStateFile()` / `getToolRules()`
- **消息写入**：`sendMessage(text, opts)`
- **tmux**：`getTmuxTarget()` / `getSessionName()`

测试传入 mock adapter 实现完全隔离的单元测试。

---

## 七、Hook 兼容策略

所有 Hook 脚本物理路径不变，用户 `settings.json` 无需修改。按交互方式分两类：

**Signal Hooks（write-only，经 SignalStore 消费）**：

| Hook | 写入 | 用途 |
|------|------|------|
| `hook-activity.js` | `tool-events.jsonl` | 工具生命周期事件流 |
| `context-monitor.js` | `statusline.json` | Claude statusLine，token 使用记录 |
| `session-foreground.js` | `foreground-session.json` | 前台 session |
| `claude-pid.js` | `claude-pid.json` | Guardian PID 定位 |

**Control Hooks（走 C4 主链）**：

| Hook | 动作 | 用途 |
|------|------|------|
| `hook-auth-prompt.js` | `c4-control enqueue [KEYSTROKE]Enter` | 权限弹窗自动确认 |
| `session-start-prompt.js` | `c4-control enqueue --content <prompt>` | 新会话注入启动提示 |

两类 hook 的契约不同但都经过 C4 审计 + priority gating。

---

## 八、对外 Schema (`agent-status.json`)

| 字段 | 当前 | 新 |
|------|-----|-----|
| `state` | offline / stopped / busy / idle | **offline / busy / idle**（合并 stopped → offline）|
| `health` | ok / recovering / down / rate_limited / auth_failed | **ok / unavailable / rate_limited / auth_failed** |
| `unavailable_since` | （无）| 进入 Unavailable 的时间戳（仅 `health=unavailable` 时出现）|
| `schema_version` | （无）| `2` |

**下游影响**：

| 消费者 | 改动 | Phase |
|--------|------|-------|
| c4-receive | `health === 'down'` 分支改为读 `unavailable_since` 时间差判文案 | Phase 4 |
| c4-dispatcher | `health !== 'ok'` 仍 defer，不区分子状态 | Phase 5 |
| web-console | 显示健康状态，可选用 `unavailable_since` 差分文案 | Phase 5 |

activity-monitor 和 comm-bridge 同版发布（monorepo 单包），无需灰度兼容。

---

## 九、迁移计划

### 落地矩阵

| 模块 | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| ToolPipeline / ToolWatchdog | ✅ 边界 | | | | | |
| SignalStore / StatusWriter | | ✅ 新建 | | | | |
| TaskScheduler（含 6 任务迁移） | | ✅ 新建 | | | | |
| Guardian / HealthEngine | | | ✅ 新建 | | | |
| 新 `monitor.js` 编排 | | | ✅ 新建 | | | |
| MessageRouter | | | | ✅ 新建 | | |
| c4-receive 适配 | | | | ✅ | | |
| c4-dispatcher 值域 | | | | ✅ | | |
| `agent-status.json` schema | | | | | ✅ | |
| web-console 文案 | | | | | ✅ | |
| legacy 清理 | | | | | | ✅ |

### Phase 0：Watchdog 边界适配（内部语义不动）

PR #500 已在 main 跑 2 个月。内部状态机/规则值/intervention 按键序列**完全保留**。只做 5 项边界适配：

1. `tool-event-stream` 并入 SignalStore 流式层
2. 物理合并 `tool-lifecycle.js` + `tool-event-stream.js` → `tool-pipeline.js`
3. `tool-rules.js` 改为 Adapter DI 覆盖
4. ToolWatchdog 独立持有 `tool-watchdog-state.json`
5. 对外接口收敛为 `.tick(signals)` + `.getPendingInterventions()`

**测试要求**：以现有行为为 golden，适配前后 E2E 行为必须等价。

### Phase 1：基础设施

新建 `signal-store.js` / `status-writer.js` / `task-scheduler.js` / `tool-pipeline.js` + `tasks/` 目录（6 任务独立文件）。旧 `activity-monitor.js` 仍在，新模块通过 feature flag 挂接，独立可 ship。

### Phase 2：状态模型 + 组件拆分

新建 `guardian.js` + `health-engine.js` + 新 `monitor.js`。实现：
- HealthEngine Unavailable wall-clock 时间驱动退避
- Guardian 自组装 4 拉起条件（不查询其他模块），bypass-once + marker 重置
- 新 `monitor.js` 8 步 tick
- 保留 `activity-monitor.legacy.js` 作为回滚路径
- PM2 通过启动参数切换新旧入口

### Phase 3：消息路由 + c4-receive 适配

- monitor.js 进程内实例化 MessageRouter，暴露本地 IPC
- c4-receive 改造：按 §5.4 流程同步等 MessageRouter 响应；STATUS 文案路径不 `insertConversation`
- c4-dispatcher 适配新 health 值域
- 测试：并发聚合 / IPC 降级（terminal 文案 + 不入队）/ 硬超时 30s / C1~C4 不变量

### Phase 4：Schema + 下游文案

更新 `agent-status.json` schema；c4-receive 按 `unavailable_since` 差分文案；SKILL.md 文档；web-console。

### Phase 5：收尾

观察 1 周稳定后删除 `activity-monitor.legacy.js` 和旧 `heartbeat-engine.js`；全量回归。

### 兼容性保证

- Hook 路径完全不变 → 用户 `settings.json` 无需修改
- `agent-status.json` 加 `schema_version`，字段向后兼容
- config.json 保留 + 新增 per-runtime Grace 参数
- 回滚：PM2 启动参数切换回 legacy 入口即可，无需代码回滚

---

## 十、附录：关键决策与权衡

### A. 为什么 HealthState 合并 recovering/down 为 Unavailable

recovering 是"暂时重试中"，down 是"长期失败"——本质是同一恢复流两阶段，60min 阈值是 HealthEngine 的内部退避升级时机，却被暴露为对外状态枚举。合并后用 `unavailable_since` 时间戳替代子状态区分，消费端保有文案差分能力，契约更简洁。

### B. 为什么 SignalStore 采用 eventual consistency

Guardian → HealthEngine 反向查询路径被消除的代价。原 `isRestartBlocked()` 是 O(1) 内存读（strong consistency），新通道是 "写文件 → SignalStore refresh → 读快照" 三跳。上界 1 tick (≈1s)——限流解除后 Guardian 最多慢 1s 拉起，代价可控；收益是同步调用路径完全消除。同契约约束 `maintenance-state.json`。

### C. 为什么 bypass-once 不是"所有 cold start 清零"

简单"所有清零"无法区分 operator 意图重试（应清零）与 PM2 auto-restart（应保留故障认知）。后者每次从 `initial_delay` 重爬会对外部 API 产生持续脉冲。marker 文件做 operator 显式 opt-in，两边取到合适语义。marker 用完即焚（one-shot）防止退化为"所有清零"。

### D. 为什么 IPC 降级不入队

原设计 IPC 降级 `insertConversation` + "消息已入队" 文案是"不丢消息优先"的妥协，代价是一条 receive 可能产出 2 条回复（interim error + 后续 AI），违反 "一次 c4-receive 一次真实答案" 不变量。新设计选择"不做假入队承诺"，文案诚实告知 operator 需要重发。不变量 100% 成立，IPC 降级是 monitor.js crash 级别的罕见异常场景，可接受。

### E. 为什么 ActivityState 是无状态投射而不是 FSM

ActivityState 无历史依赖——任何 tick 看到同样信号都得出同样 state。FSM 会引入"从自己写的 agent-status.json 恢复状态"的反向依赖，重启 AM 后可能与现实信号不一致。无状态投射下第一 tick 就直接算出真值，契合 §4.3 "进程拉起 ≠ 健康变化" 的哲学。

### F. 为什么不引入 cron 解析器

依赖最小化 + 可测试。cron 库约 50KB 代码，表达式解析有 bug 历史。`dailyHour` + `intervalSeconds` 两字段语义明确，测试只需 mock 时间。未来如果有 "每周三 03:00" 这种需求，加 `weeklySchedule` 字段即可。

### G. 为什么 ProcSampler 是独立模块而不是 Guardian 一部分

时间维度不同。Guardian 是 1s 级 boolean 检查；ProcSampler 是 10s 采样 + 60s 滑动窗口状态机。合进 Guardian 会让 Guardian 维护独立时序状态机违反单一职责。拆出来 Guardian 保持 O(1) 决策。

---

*文档由 zylos01 主笔，zylos0t 提供代码层面信息补充和设计角度审查。v2.1 是面向 reviewer 的精简版，详细设计档见 v2。*
