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
| **InputValidator** | `scripts/input-validator.js` | runtime 入口治理：消费 c4-receive 写入的 validate-request 信号，调 adapter.validateInput()，写 validate-result | 2 |
| **Guardian** | `scripts/guardian.js` | 进程存活守护 + 拉起决策 | 3 |
| **ProcSampler** | `scripts/proc-sampler.js` | OS 级冻结检测（context switch 采样）| 4 |
| **ToolPipeline** | `scripts/tool-pipeline.js` | 工具生命周期 + 事件流合成（物理合并 PR #500 lifecycle + stream）| 5 |
| **ToolWatchdog** | `scripts/tool-watchdog.js` | 工具超时检测与干预 | 6 |
| **HealthEngine** | `scripts/health-engine.js` | 健康状态机 + 主动探针编排 + api-error catalog dispatch | 7 |
| **TaskScheduler** | `scripts/task-scheduler.js` | 统一定时任务调度器（注册式） | 8 |
| **StatusWriter** | `scripts/status-writer.js` | 写 `agent-status.json`（对外契约唯一发布者） | 9 |
| **MessageRouter** | `scripts/message-router.js` | 用户消息路由（事件驱动，**不在 tick 里**）| - |
| **Adapter** | `scripts/adapters/{claude,codex}.js` | 运行时差异封装（构造时依赖注入） | - |

### 3.2 3 种通信通道

| 通道 | 用途 | 实现 | 一致性 |
|------|------|------|--------|
| 🔵 **State via SignalStore** | 跨模块共享"当前持续值" | 生产者写文件，SignalStore 每 tick refresh；消费者读快照 | Eventual (≤ 1 tick ≈ 1s) |
| 🔴 **Event via 具名接口** | 跨模块触发"一次性动作" | 单向方法调用（`setAuthFailed` / `onProcessRestarted` / `triggerRecovery` / `notifyUserMessage`）| Synchronous |
| 🟢 **C4 主链** | 用户消息投递 | `c4-receive → DB → c4-dispatcher → tmux`（健康门控 + priority + require_idle）| - |

**关键不变量**：Guardian 决策闭环中**不同步查询**任何其他模块；HealthEngine 不对外暴露 getter；c4-dispatcher 独占 tmux 写入。

### 3.3 主循环 tick（每秒 9 步）

```
每秒 tick:
 ① signalStore.refresh()    ← 刷新快照（readJSON + 流式增量合一）
 ② inputValidator.tick()    ← 处理 validate-request 信号 → 写 validate-result
 ③ guardian.tick()          ← 进程存活 + 拉起决策
 ④ procSampler.tick()       ← 冻结检测
 ⑤ toolPipeline.tick()      ← 工具生命周期 + 合成 api-activity.json
 ⑥ toolWatchdog.tick()      ← 工具超时检测
 ⑦ healthEngine.tick()      ← 健康状态机 + api-error catalog dispatch
 ⑧ taskScheduler.tick()     ← 定时任务调度
 ⑨ statusWriter.write()     ← 写 agent-status.json
```

**顺序硬约束**：② 紧随 ① 之后（让 c4-receive 等的最少）；⑤ 在 ⑦ 前（健康判定要读工具活动视图）；⑥ 在 ⑤ 后 ⑦ 前（watchdog 干预可能触发 health 降级）；MessageRouter 不在 tick 里，由 c4-receive IPC 触发。

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
| `validate-request/<msgid>.json` | c4-receive（带 attachment 消息到达时写）| InputValidator（tick 处理）|
| `validate-result/<msgid>.json` | InputValidator（tick 处理完写，one-shot）| c4-receive（轮询读，处理后 unlink）|
| `pending-channels.jsonl` | HealthEngine（cold-restart 时记录被影响 channel，附 unavailable_reason）| AM 恢复后主动 broadcast 通知 |
| `unknown-api-errors.jsonl` | HealthEngine（catalog 未匹配的 API error 落库）| 人工 weekly review → 增补 catalog |
| `usage.json` | usage-monitor 任务（tier 计算结果） | usage-alerter / dashboard / web-console |
| `usage-alert-state.json` | usage-alerter 任务（已通知的 tier + ts，去重） | usage-alerter 自己（去重）|
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
  ③ 被动检测（tmux scan 零成本）— catalog-driven dispatch（详见 §5.3.1）
      - 限流文本 → 进 RateLimited + 写 rate-limit-state.json
      - API error catalog 命中 → 按 entry.action 分派
        ├─ session_restart → adapter.stop() + 进 Unavailable + 写 unavailable_reason
        ├─ unavailable_with_probe → 进 Unavailable
        ├─ rate_limit_cooldown → 进 RateLimited
        ├─ auth_failure → 进 AuthFailed
        └─ notify_only → 仅文案给用户，不改 health
  ④ 按当前 state 驱动主动检测
      - OK: 30min heartbeat 安全网
      - Unavailable: 指数退避 probe
      - RateLimited: 查冷却是否到期
      - AuthFailed: 180s 后或用户消息触发 auth-check
  ⑤ probe 结果回调更新 state
  ⑥ 若 state 变动：更新内存 + 写/清 rate-limit-state.json + 维护 pending-channels.jsonl
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

#### 5.3.1 Catalog-driven api-error-check（出口治理）

Layer 2 tmux scan 检测 API error 时，**不硬编码 pattern + action**——通过 adapter 注入 **catalog**，HealthEngine 统一 dispatch。

**Catalog Entry 结构**（adapter 通过 `getApiErrorPatterns()` 返回数组）：

```js
{
  id: 'corrupted_context',                    // 唯一标识，落 unavailable_reason
  pattern: /APIError: 400|invalid_request_error/,
  severity: 'sticky' | 'transient' | 'permanent',
  action: 'session_restart' | 'unavailable_with_probe'
        | 'rate_limit_cooldown' | 'auth_failure' | 'notify_only',
  debounce: 2,                                // 连续 N 次命中才动手
  scanInterval: 30,                           // 秒，可被加速（heartbeat pending 时）
  userMessage: '消息或图片格式有问题，session 已重置——请检查后重发'
}
```

**5 种 action 对应路径**：

| Action | HealthEngine 行为 | 适用场景 |
|--------|-------------------|---------|
| `session_restart` | 调 `adapter.stop()` + 进 Unavailable + 写 `unavailable_reason: <id>` | sticky context-poison（图片 400 / context_length 等）|
| `unavailable_with_probe` | 仅 transition Unavailable + 写 `unavailable_reason` | transient overload（503 / 500）|
| `rate_limit_cooldown` | 进 RateLimited + 写 rate-limit-state.json | 限流文本（既有路径）|
| `auth_failure` | 进 AuthFailed | auth error 文本 |
| `notify_only` | 仅写 pending-channels 通知 + log，不改 health | 轻量级警告（content filter 等可恢复非 sticky 类）|

**初始 catalog（PR #501 落地范围）**：

| id | pattern 关键字 | severity | action | userMessage |
|----|---------------|----------|--------|-------------|
| `corrupted_context` | `APIError: 400` / `invalid_request_error` / `422 bad request` | sticky | session_restart | "消息或附件触发 API 错误，session 已重置——如包含图片请检查规格后重发" |
| `context_too_long` | `context_length_exceeded` / `prompt is too long` | sticky | session_restart | "对话历史超长，session 已重置——请精简后重发" |
| `transient_overload` | `overloaded_error` / `503 Service Unavailable` | transient | unavailable_with_probe | "API 暂时繁忙，正在自动重试" |
| `content_filter` | `content_filter_violation` / `harmful` | permanent | notify_only | "请求内容被策略拦截，请调整后重试" |

**Unknown error fallback**（catalog 未匹配但匹配通用 `Error/FATAL/Exception`）：
- 默认走 `unavailable_with_probe`（保守，不强 restart 避免误杀）
- 同时写 `unknown-api-errors.jsonl`：`{ts, pane_snippet, current_state}`
- 后续人工 weekly review jsonl → 增补 catalog → 下次同类有专属 entry
- 用户文案 fallback：「session 因未识别的运行时错误已重置，请重发——如能描述问题将帮助定位原因」

**渐进可知**：catalog 不是一次性写死，是**活的知识库**。今天的 unknown 通过 jsonl 累积 + review，明天就是 known + 精确文案。

#### 5.3.2 Cold-restart 用户通知（pending-channels 增强）

current main 分支已有 `pending-channels.jsonl` 机制（sticky error 期间被拒收的 channel/user 记录，session 恢复后 broadcast"我恢复了"），但**不附原因**。

v2.1 把它增强为**带诊断的恢复通知**：

```
HealthEngine 触发 session_restart 时：
  ↓
写 pending-channels.jsonl entry：
  { channelId, userId, msgId, ts,
    unavailable_reason: '<catalog.id>',
    userMessage: '<catalog.userMessage>' }
  ↓
adapter.stop() → Guardian 拉新 session → launchGracePeriod 通过
  ↓
HealthEngine 在 OK 转换时 drain pending-channels：
  逐条调 c4-control enqueue 走主链通知用户：
    "[catalog.userMessage]"
```

**关键点**：
- 通知**走 C4 主链**（c4-control enqueue），保留 audit trail，priority 最高
- 即使 `unavailable_reason` 是 fallback `unknown` 也通知（generic 文案胜过完全静默）
- channel-aware：仅通知**真正在 sticky window 期间发过消息的 user/channel**，不打扰其他人
- 通知触发条件可配置（per-channel 默认 on，可关）

**用户视角的 UX 改善**：

| 错误类型 | 当前 main 用户体验 | v2.1 (A+) 用户体验 |
|---------|------------------|-------------------|
| 已知 sticky（图片 400） | 60s 静默 + 无解释 + 原消息丢 | 60-70s 静默 + **精确诊断通知**（"图片规格问题"）+ 原消息丢但知道原因 |
| Unknown 4xx | 60s 静默 + 完全无解释 | 60-70s 静默 + **generic 通知**（"运行时错误已重置"）+ 至少知道发生过 |
| 完全无 pattern 匹配（理论极罕见）| 永久卡死 | heartbeat 30min 安全网兜底 + generic Unavailable 文案 |

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

### 5.5 InputValidator（runtime 入口治理）

tick 第 2 步。**runtime-specific 输入校验**，配合 §5.3.1 的出口治理形成**双层防御**——前线拦截已知规格违规，兜底处理意外漏过的。

#### 设计原则

- **runtime 知识属于 runtime 守护层**：Claude Vision API 限制（8000px / 32MB / 20 张 / 格式集）是 Claude-specific，**不能下沉到 c4-core 通用网关**。规则归 `ClaudeAdapter.getInputRules()` / `validateInput()`。
- **Tick-based 通信**：c4-receive 写 `validate-request/<msgid>.json` signal；InputValidator 下个 tick 处理；写 `validate-result/<msgid>.json`；c4-receive 轮询读结果。**不引入新 IPC endpoint**，复用 SignalStore 通道。
- **Channel 端零改动**：channel（telegram/lark/web/...）只需把 message + attachments 原样转给 c4-receive，不参与校验逻辑。新增 channel 自动享受。

#### 调用链

```
[Channel: telegram / lark / web-console / ...]
   ↓ 原样转发（channel 零改动）
[c4-receive 收到 message with attachments]
   ↓ 写 validate-request/<msgid>.json
   ↓ 阻塞等 validate-result/<msgid>.json（轮询，timeout ≈ 1.5s）
[AM monitor.js tick]
   ① signalStore.refresh()      ← 看到新的 validate-request
   ② inputValidator.tick()      ← 处理：调 adapter.validateInput() → 写 validate-result
[c4-receive 看到 result]
   ├─ valid=true  → insertConversation → dispatcher → Claude（正常路径）
   └─ valid=false → 不写 DB，回 channel 错误文案（来自 result.userMessage）
        ↓ via channel reply 路径
[用户 ≈1-1.5s 内看到] "图片 45MB 超过 32MB 限制，请压缩后重发"
```

#### Validator 规则（adapter 注入）

`adapter.getInputRules()` 返回 runtime-specific 限制对象，`adapter.validateInput(attachments)` 执行校验：

```js
// adapters/claude.js
getInputRules() {
  return {
    image: {
      maxDimensionPx: 8000,
      maxSizeBytes: 32 * 1024 * 1024,
      maxCountPerMessage: 20,
      supportedFormats: ['jpeg', 'png', 'gif', 'webp']
    },
    // 未来加文本长度 / 其他 attachment 类型
  };
}

async validateInput(attachments) {
  const rules = this.getInputRules();
  for (const att of attachments) {
    if (att.type === 'image') {
      // 用 sharp / image-size 检测
      const meta = await readImageMeta(att.path);
      if (meta.size > rules.image.maxSizeBytes) {
        return {
          valid: false,
          reason: 'image_too_large',
          userMessage: `图片 ${formatMB(meta.size)} 超过 ${formatMB(rules.image.maxSizeBytes)} 限制，请压缩后重发`
        };
      }
      // ... 检查 dimension / format / count
    }
  }
  return { valid: true };
}
```

Codex / Bedrock / Vertex 各自维护 adapter，不同 runtime 限制独立。

#### Fail-open 容错

c4-receive 等结果时若 timeout（≈1.5s）或 monitor.js crash 导致 validate-result 永远不写出现：

- **Fail-open**：直接放行 → insertConversation → dispatcher → Claude
- 漏过的坏图触发 sticky API error → 走 §5.3.1 catalog A+ 兜底（adapter.stop + 重启）
- 退化到当前 main 分支行为，**不阻断主链路**

**理由**：input-validator 是优化层而非阻塞层。AM 临时不可用时主路径仍工作，否则用户被 false-block 影响更大。

#### One-shot signal 生命周期

- c4-receive 写 `validate-request/<msgid>.json` → 等结果
- InputValidator 处理后写 `validate-result/<msgid>.json` 并 unlink request
- c4-receive 读取 result 后 unlink result（用完即焚）
- 异常情况（c4-receive crash）：定时清理任务（在 TaskScheduler 注册一个 5min 间隔任务，扫超过 30s 未消费的 stale signal 文件）

#### 与出口治理（§5.3.1）的协作

```
用户发图
   ↓
[InputValidator 入口治理]  ← 拦下 90% 已知规格违规
   ├─ 拦截 → 1-1.5s 精确诊断 ✅
   └─ 通过
        ↓
[insertConversation → dispatcher → Claude]
   ↓
[99% 工作正常 / 1% 触发未预知 4xx]
   ↓
[catalog A+ 出口兜底]      ← 漏过的 edge case
   ├─ catalog 已知 → 60-70s + 精确诊断通知
   └─ unknown → 60-70s + generic 通知（同时落 jsonl 累积）
```

入口快但只覆盖**已知可预防**；出口慢但覆盖**未预知**。两层组合是**完整防御**。

### 5.6 StatusWriter

tick 第 9 步。**唯一**写 `agent-status.json` 的组件。做两件事：

1. 读 signals snapshot
2. 按 §4.1 决策规则投射 ActivityState + 读 HealthEngine 只读属性 → 写文件

不持有历史，不维护状态变量。无状态投射保证"重启 AM 后第一 tick 就写出真值"。

### 5.7 ProcSampler

每 10 秒采样进程 context switch 计数（Linux `/proc/<pid>/status`；macOS `top -l 1 -pid <pid> -stats pid,csw`）。

**判定规则**：`isActive == true`（hook fresh 且 active_tools > 0）AND `delta == 0 连续 60 秒` → frozen。

判死后不写 Frozen 状态——直接 `adapter.stop()` + 写 `proc-state.json`。下一 tick Guardian 看进程消失 → Offline → 拉起。

PR #351（2026-03-18）引入；是三层健康监控的 Layer 1。

### 5.8 ToolPipeline + ToolWatchdog

**ToolPipeline**（物理合并 PR #500 tool-lifecycle + tool-event-stream）：
- 消费 `tool-events.jsonl` 的增量事件（通过 SignalStore 流式层）
- 维护多 session 工具生命周期内存状态
- 每 tick 合成 `api-activity.json`

**ToolWatchdog**（PR #500 内部语义完全保留，边界适配）：
- 5-stage 状态机（Start → Running → Timeout → Intervention → Completed）
- 工具分类规则（通过 Adapter DI 注入，不硬编码）
- 独立 owner 写 `tool-watchdog-state.json`
- 超时触发 → `adapter.sendMessage()` 发中断 + `engine.triggerRecovery()` 通知健康层

### 5.9 TaskScheduler

**注册式调度器**，不用 cron。任务声明：

| 字段 | 含义 |
|------|------|
| `interval` / `dailyHour` | 固定间隔秒 或 每日固定小时 |
| `condition` | 执行前置条件（读 signals 的函数） |
| `execute` | 执行体 |
| `maintenance` | 布尔；为 true 时进出执行时自动写 `maintenance-state.json`（Guardian 条件 #4 消费） |
| `skipOnStart` | 避免服务启动立即执行 daily 任务 |

**现有任务**（7 个，含 usage 拆分）：`daily-upgrade` / `daily-memory-commit` / `upgrade-check` / `health-check` / **`usage-monitor`** / **`usage-alerter`** / `context-check`。新增只需 `tasks/` 下新建文件 + 注册。

**不引入 cron 解析器**：`dailyHour` + `intervalSeconds` 覆盖当前全部需求；cron 库增加依赖 + 测试面。

#### 5.9.1 Usage 监测与告警拆分（双 gate 设计）

main 分支当前 `maybeCheckUsage()` 用单一 `usage_monitor_enabled` 开关同时控制**本地监测**（读 statusline / usage.json snapshot 计算 tier，零 token 成本）和**主动告警**（达阈值时 C4 control enqueue 让 agent 发警告，**消耗 runtime token**）。两件性质不同的事被一刀切——想保持本地 state 新鲜（dashboard / 诊断用）必须接受 token 消耗；想避免 token 消耗就连本地 state 也丢。

v2.1 拆为两个独立任务 + 两个独立 config gate：

| 任务 | 控制 gate（默认值） | 行为 | 写出 state |
|------|--------------------|------|-----------|
| `usage-monitor` | `usage_monitor_enabled`（**新 default `true`**）| 读 statusline / usage 计算 tier，零 token | `usage.json` |
| `usage-alerter` | `usage_alert_enabled`（**新增**，default `false`）| 读 monitor 写出的 state，达阈值时 C4 enqueue alert + 去重 | `usage-alert-state.json` |

**4 种语义矩阵**：

| monitor | alert | 行为 |
|---------|-------|------|
| `true` | `false` | ✅ **新 default**：本地 state 新鲜，零 token 消耗 |
| `true` | `true` | ✅ 监测 + 告警都开（=main 当前 `usage_monitor_enabled=true` 行为）|
| `false` | `false` | ✅ 完全关（=main 当前默认行为）|
| `false` | `true` | ❌ 矛盾——alerter 依赖 monitor 的 state；启动日志 warning，alerter 自动 no-op |

**任务执行顺序**：tick 第 ⑧ 步 TaskScheduler 按注册顺序，monitor 在前刷 state，alerter 在后读最新 state 决定告警——单 tick 内时序正确。

**State 文件分工**：
- `usage.json`：tier / window / 监测元数据（写入：usage-monitor；读取：usage-alerter / dashboard / web-console）
- `usage-alert-state.json`（新增）：已通知的 tier + 时间戳，alerter 自己写自己读做去重

**升级兼容性策略（路径 B）**：
- 旧 config 只有 `usage_monitor_enabled=true` 时，新版 default `usage_alert_enabled=false`——**告警关闭**（保守，避免不必要 token 消耗）
- 启动时检测 legacy config 输出明显 warning：
  ```
  ⚠️  Detected legacy config: usage_monitor_enabled=true with no usage_alert_enabled.
       v2.1 默认不发 usage alert（避免 runtime token 消耗）。
       如需恢复旧行为，请显式配置：usage_alert_enabled=true
  ```
- 鼓励老用户**主动 opt-in** 告警，把"是否消耗 runtime token"决策权交还给 user
- Release notes 单独一节标注此变更

**为什么不走"保留旧行为"路径 A**：拆分的核心目的就是分离两件性质不同的事；如果升级时自动把 `alert` 也设 true，等于把 user 永远绑在"只能两个一起开"的旧默认上，违背拆分初衷。短期 friction（user 可能要补一行 config）换来长期清晰。

---

## 六、Adapter 依赖注入

运行时差异封装为 Adapter，构造时注入 Guardian / HealthEngine / ToolWatchdog / health-checks。

**接口（架构层概述）**：

- **标识**：`runtimeId` / `heartbeatEnabled` / `supportsHooks`
- **进程管理**：`launch()` / `stop()` / `isRunning()` / `getProcessPid()`
- **健康检查**：`checkAuth()` / `getHeartbeatDeps()`
- **API error catalog（§5.3.1）**：`getApiErrorPatterns()` 返回 catalog 数组，每 entry 含 `{id, pattern, severity, action, debounce, scanInterval, userMessage}`。HealthEngine 读取后在 Layer 2 tmux scan 中 dispatch
- **Input validation（§5.5）**：`getInputRules()` 返回 runtime-specific 限制对象（image dimension/size/count/format 等）；`validateInput(attachments)` 执行同步校验，返回 `{valid: boolean, reason?: string, userMessage?: string}`
- **运行时差异**：`getContextMonitor()` / `getUsageStateFile()` / `getToolRules()`
- **消息写入**：`sendMessage(text, opts)`
- **tmux**：`getTmuxTarget()` / `getSessionName()`

`getApiErrorPatterns()` 和 `getInputRules()` 共享同一份底层规则源（adapter 内部常量），让"runtime 限制"概念在 input/output 两侧表达一致——避免双处维护漂移。

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
| `unavailable_reason` | （无）| **可选字段**：catalog entry id（`corrupted_context` / `context_too_long` / `transient_overload` / `unknown` 等）；让消费端做差异化文案 |
| `schema_version` | （无）| `2` |

`unavailable_reason` 是**开放枚举**——v2.1 内置 4 种值（见 §5.3.1 初始 catalog），未来 catalog 增补新 entry 自动加入值域。消费端遇到未知 reason 应**退化到通用 unavailable 文案**（不报错）。

**下游影响**：

| 消费者 | 改动 | Phase |
|--------|------|-------|
| c4-receive | `health === 'down'` 分支改为读 `unavailable_since` 时间差判文案；可选读 `unavailable_reason` 给精确文案 | Phase 4 |
| c4-dispatcher | `health !== 'ok'` 仍 defer，不区分子状态 | Phase 5 |
| web-console | 显示健康状态，可选用 `unavailable_since` + `unavailable_reason` 做诊断 UI | Phase 5 |

activity-monitor 和 comm-bridge 同版发布（monorepo 单包），无需灰度兼容。

---

## 九、迁移计划

### 落地矩阵

| 模块 | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| ToolPipeline / ToolWatchdog | ✅ 边界 | | | | | |
| SignalStore / StatusWriter | | ✅ 新建 | | | | |
| TaskScheduler（含 7 任务迁移，**含 usage-monitor 拆分为 monitor+alerter 两任务**）| | ✅ 新建 | | | | |
| **InputValidator + Adapter `getInputRules`/`validateInput`** | | **✅ 新建** | | | | |
| Guardian / HealthEngine | | | ✅ 新建 | | | |
| **HealthEngine catalog-driven api-error-check + Adapter `getApiErrorPatterns`** | | | **✅ 新建** | | | |
| **pending-channels 通知增强（unavailable_reason + userMessage）** | | | **✅** | | | |
| 新 `monitor.js` 编排 | | | ✅ 新建 | | | |
| MessageRouter | | | | ✅ 新建 | | |
| c4-receive 适配（同步等 MessageRouter + 写 validate-request 等结果）| | | | ✅ | | |
| c4-dispatcher 值域 | | | | ✅ | | |
| `agent-status.json` schema（含 `unavailable_reason`）| | | | | ✅ | |
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

新建 `signal-store.js` / `status-writer.js` / `task-scheduler.js` / `tool-pipeline.js` / **`input-validator.js`** + `tasks/` 目录（6 任务独立文件 + 1 stale-signal 清理任务）。Adapter 接口扩展 `getInputRules()` / `validateInput()`。旧 `activity-monitor.js` 仍在，新模块通过 feature flag 挂接，独立可 ship。

### Phase 2：状态模型 + 组件拆分

新建 `guardian.js` + `health-engine.js` + 新 `monitor.js`。实现：
- HealthEngine Unavailable wall-clock 时间驱动退避
- Guardian 自组装 4 拉起条件（不查询其他模块），bypass-once + marker 重置
- 新 `monitor.js` **9 步 tick**（含 InputValidator 第 2 步）
- **HealthEngine catalog-driven api-error-check（§5.3.1）**：Adapter `getApiErrorPatterns()` + dispatch + unknown-api-errors.jsonl + pending-channels.jsonl 增强（含 unavailable_reason + userMessage）
- 保留 `activity-monitor.legacy.js` 作为回滚路径
- PM2 通过启动参数切换新旧入口

### Phase 3：消息路由 + c4-receive 适配

- monitor.js 进程内实例化 MessageRouter，暴露本地 IPC
- c4-receive 改造：
  - 按 §5.4 流程同步等 MessageRouter 响应；STATUS 文案路径不 `insertConversation`
  - **带 attachment 消息先写 `validate-request/<msgid>.json` 等 InputValidator 结果**（fail-open timeout ≈ 1.5s），再决定 insertConversation 或 reply user reject
- c4-dispatcher 适配新 health 值域
- 测试：并发聚合 / IPC 降级（terminal 文案 + 不入队）/ 硬超时 30s / C1~C4 不变量 / **InputValidator 拦截路径 / fail-open 路径 / 与 catalog A+ 配合的双层防御 E2E**

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
