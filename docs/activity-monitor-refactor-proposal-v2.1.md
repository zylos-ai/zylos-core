# Activity Monitor 重构方案 v2.1

> 日期：2026-04-24
> 分支：`refactor/activity-monitor`
> 本文为 v2.1 最终方案，精简自 v2（详细设计/权衡档：`activity-monitor-refactor-proposal-v2.md`，750 行）。v1 初稿保留在 `activity-monitor-refactor-proposal.md`。

---

## 〇、TL;DR

`activity-monitor`（AM）是守护 runtime（Claude / Codex）的 PM2 长驻进程。现状是一个 2300+ 行的 God Object，6 大结构痛点。本方案：

- **模块化**：拆成 12 个职责清晰的模块（含 Adapter，业务模块 11 个），`monitor.js` 只做编排
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

### 3.1 模块职责表（12 项：11 业务模块 + 1 Adapter DI）

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
| `heartbeat-pending.json` (Claude) / `codex-heartbeat-pending.json` (Codex) — runtime-specific 文件名通过 `adapter.getHeartbeatDeps().pendingKey` 注入 | HealthEngine | HealthEngine（自消费）|
| `user-message-signal.json` | c4-receive.js | HealthEngine（加速探测）|
| `proc-state.json` | ProcSampler | Guardian / StatusWriter |
| `foreground-session.json` | session-foreground.js（hook） | ToolWatchdog |
| `rate-limit-state.json` | HealthEngine（RateLimited 进出时写/清）| Guardian（条件 #1）|
| `maintenance-state.json` | TaskScheduler（maintenance 任务进出时写/清）| Guardian（条件 #4）|
| `validate-request/<msgid>.json` | c4-receive（带 attachment 消息到达时写）| InputValidator（tick 处理）|
| `validate-result/<msgid>.json` | InputValidator（tick 处理完写，one-shot）| c4-receive（轮询读，处理后 unlink）|
| `pending-channels.jsonl` | c4-receive（health=非 OK 拒收时记录，**main 既有路径不变**）| AM 恢复后主动 broadcast 通用 "我恢复了" 文案（main 既有路径不变）|
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
      - API error catalog 命中 → 按 entry.recoveryAction 分派（probe / restart 解耦）
        ├─ restart_session → adapter.stop() + 进 Unavailable + 写 unavailable_reason（session 重启后 c4-session-init 注入 context，agent 自治续接，详 §5.3.2）
        ├─ probe_only → 进 Unavailable + 写 unavailable_reason（**不 stop**，等 probe）
        ├─ mark_rate_limited → 进 RateLimited（不 stop）
        ├─ mark_auth_failed → 进 AuthFailed（不 stop）
        └─ notify_only → 仅 log + 可选用户即时通知，不改 health（不写 pending-channels）
  ④ 按当前 state 驱动主动检测
      - OK: 30min heartbeat 安全网
      - Unavailable: 指数退避 probe（按 catalog recoveryAction 决定 probe 失败是否触发 restart）
      - RateLimited: 查冷却是否到期
      - AuthFailed: 180s 后或用户消息触发 auth-check
  ⑤ probe 结果回调更新 state
  ⑥ 若 state 变动：更新内存 + 写/清 rate-limit-state.json + Unavailable→OK 时 drain pending-channels.jsonl 触发 main 既有通用 broadcast"我恢复了"
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
  recoveryAction: 'restart_session' | 'probe_only'
                | 'mark_rate_limited' | 'mark_auth_failed' | 'notify_only',
  debounce: 2,                                // 连续 N 次命中才动手
  scanInterval: 30,                           // 秒，可被加速（heartbeat pending 时）
  userMessage: '消息或图片格式有问题，请检查后重发'
}
```

**核心设计：probe 跟 restart 解耦**——`recoveryAction` 字段显式声明每个 error 类型的处理路径。**heartbeat/probe 失败 ≠ 一定 restart**——只有 `restart_session` 路径的 error 触发 restart；`probe_only` / `mark_rate_limited` / `mark_auth_failed` 探测失败时仅保持 unhealthy state + 文案，restart 没意义。

**5 种 recoveryAction 对应路径**：

| recoveryAction | HealthEngine 行为 | DB 记录 | 适用场景 |
|---|---|---|---|
| `restart_session` | 调 `adapter.stop()` + 进 Unavailable + 写 `unavailable_reason: <id>` | 既有 inbound 保留；session 重启后 c4-session-init 注入 context | sticky context-poison（图片 400 / context_length 等）+ unknown 持续升级 |
| `probe_only` | 进 Unavailable + 写 `unavailable_reason`；持续 probe 等恢复，**不 restart** | inbound + 立即 outbound 状态文案 | transient overload（503 / 500）|
| `mark_rate_limited` | 进 RateLimited + 写 rate-limit-state.json，**不 restart** | inbound + 立即 outbound 限流文案 | 限流文本（既有路径）|
| `mark_auth_failed` | 进 AuthFailed，**不 restart** | inbound + 立即 outbound auth 文案 | auth error 文本 |
| `notify_only` | 仅 log + 可选用户即时通知，不改 health，**不 restart** | 不影响 | 轻量级警告（content filter 等可恢复非 sticky 类）|

**初始 catalog（PR #501 落地范围）**：

| id | pattern 关键字 | severity | recoveryAction | userMessage |
|----|---------------|----------|---|-------------|
| `corrupted_context` | `APIError: 400` / `invalid_request_error` / `422 bad request` | sticky | restart_session | "消息或附件触发 API 错误，请检查后重发" |
| `context_too_long` | `context_length_exceeded` / `prompt is too long` | sticky | restart_session | "对话历史超长——请精简后重发" |
| `transient_overload` | `overloaded_error` / `503 Service Unavailable` | transient | probe_only | "API 暂时繁忙，正在自动重试" |
| `content_filter` | `content_filter_violation` / `harmful` | permanent | notify_only | "请求内容被策略拦截，请调整后重试" |

**Unknown error fallback**（catalog 未匹配但匹配通用 `Error/FATAL/Exception`）：
- 默认走 `probe_only`（保守，不强 restart 避免误杀）
- 同时写 `unknown-api-errors.jsonl`：`{ts, pane_snippet, current_state}`
- 后续人工 weekly review jsonl → 增补 catalog → 下次同类有专属 entry
- 用户文案 fallback：「服务暂时不可用，正在自动重试探测——请稍候」

**持续未匹配升级（防卡死兜底，作为 health action 决策）**：
- 同一 unknown error pattern **连续 10 次扫描命中**（30s × 10 = 5min）→ **升级 recoveryAction 为 `restart_session`**
- 触发原因：probe 在 sticky context 下永远失败（context 没换 → 同样错误反复 → 退避 60s→300s→1500s→3600s 长期 stuck）；5min 持续命中 = 大概率 sticky 而非 transient → 强制 restart 自愈
- 升级后流程同 `restart_session`：`adapter.stop()` + Guardian 拉新 session + c4-session-init 注入 context + agent 自治续接（参 §5.3.2）
- 计数：`unknownErrorStreakCount` 在 HealthEngine 内存累积；**任一 catalog hit / 状态转出 Unavailable / OK probe 成功时重置**
- 升级是兜底**不替代增量学习**——仍写 `unknown-api-errors.jsonl`，weekly review 流程不变

**渐进可知**：catalog 不是一次性写死，是**活的知识库**。今天的 unknown 通过 jsonl 累积 + review，明天就是 known + 精确文案。

#### 5.3.1.1 recoveryAction × Health State + DB 记录路径矩阵

不同 `recoveryAction` 对**HealthState 转换**和**c4 DB 记录路径**有不同蕴含。这张表是 §5.3.1 catalog 设计的隐含逻辑显性化——避免出现"action=A 但 DB 行为按 action=B 写"的不对齐：

| recoveryAction | HealthState 变更 | DB 记录路径 | 用户感知 |
|---|---|---|---|
| `restart_session` | OK → Unavailable + adapter.stop() | inbound 既有保留；session 重启后 c4-session-init 注入 context | session 重启 + agent 看 context 自治补答；不主动 broadcast 受害者 |
| `probe_only` | OK → Unavailable | inbound + 立即 outbound 状态文案（c4-receive unhealthy 路径） | 用户立即收到 "暂不可用，正在重试" |
| `mark_rate_limited` | OK → RateLimited | inbound + 立即 outbound 限流文案 | 用户立即收到 "限流冷却中，预计 X 时间恢复" |
| `mark_auth_failed` | OK → AuthFailed | inbound + 立即 outbound auth 文案 | 用户立即收到 "auth 失败，请检查凭证" |
| `notify_only` | 无变化 | 不影响 DB | 仅 log + 可选用户即时通知 |
| `unknown` (fallback, < 5min) | = `probe_only` 行 | 同 | 同 |
| `unknown` (escalated, ≥ 5min) | = `restart_session` 行 | 同（context 注入） | 同（agent 自治补答）|

**核心约束**：
- **OK 直通路径**消息靠 c4 DB inbound 记录持久化；runtime 后续异常 ≠ 数据丢失（详 §5.3.2 + §5.4）
- **Unhealthy 路径**消息进 DB 时**立即同步写一条 outbound 状态文案**——保证用户立即感知系统状态，不留 silent gap
- **Probe 跟 restart 解耦**：只有 `restart_session` 触发进程重启；其他 action 即使 probe 失败也不 restart（restart 没意义）
- **不引入受害者识别 ledger**：session restart 后靠 c4-session-init 既有 context 注入恢复；agent 自治补答替代主动 broadcast

#### 5.3.2 Session 恢复后的对话续接（c4-session-init 既有机制 + delivered-but-unanswered 边界声明）

main 已有 `pending-channels.jsonl` 机制（c4-receive 在 health 非 OK 时记录被拒收的 channel/user，session 恢复后通用 broadcast"我恢复了"）—— **v2.1 保留这个 main 既有路径不动**。本节不引入新的受害者识别 ledger，而是**显式声明数据完整性 + 用户体验的 boundary 边界**，以及 session 恢复后的对话续接机制。

##### 关键认知：delivered-but-unanswered 不算消息丢失

如果 c4-receive 在 health=OK 时已经 `insertConversation('in', ...)` 把消息记入 c4 DB，**这条消息就持久化了，不会丢**。即使 dispatcher 已经 submit 到 tmux 后 runtime 触发 sticky API error 导致 session_restart：

- C4 DB 既有 inbound 记录**完全保留**（c4-receive 是消息可靠性边界，§3.2 🟢 C4 主链）
- session 重启后 `c4-session-init.js`（既有 hook，路径见 `skills/comm-bridge/scripts/c4-session-init.js`）注入 last checkpoint summary + unsummarized 对话或最近 `SESSION_INIT_RECENT_COUNT=6` 条作为 startup context
- 重启后的 agent 看到这段 context **自行判断**是否补回复——LLM agent 的核心 capability 就是看 context 自决策

**所以这种场景不是"消息丢失"——是"runtime 异常后未回复"**，跟"agent 临时反应慢"在 user 视角无本质区别。

**AM 不需要维护一套受害者识别 ledger（如曾经设计的 `recent-inbound.jsonl`）+ 主动 broadcast 通知重发**——那是把 c4 DB 已经做的事在 AM scope 重做一遍，且引入 race / lock / barrier 复杂度而无 corresponding 收益。

##### Healthy / Unhealthy 路由 contract

| 路径 | c4-receive 行为 | DB 记录 | 用户感知 |
|---|---|---|---|
| **OK 直通** | insertConv('in') → MessageRouter → dispatcher → tmux | inbound | runtime 异常后未回复 = "agent 反应慢"，session restart 后 c4-session-init 注入 context，agent 自行判断是否补 reply |
| **Unhealthy（health 非 OK）** | MessageRouter 触发 recovery probe；如果仍异常：c4-receive `insertConv('in')` + 立即 `insertConv('out', "<状态文案>")` | inbound + status outbound | 立即收到状态回复（"rate limit 直到 X 时间" / "auth 失败" / "服务暂时不可用" 等，文案根据 catalog `userMessage` 决定）|
| **Probe 恢复** | health 转 OK → 重走 OK 直通路径 | 同 OK | 同 OK |

##### 不引入的机制（早期 v2.1 草案被砍）

下列机制**经多轮 review walk back**，因为它们建立在错误前提"session_restart 后消息丢失"上——实际 c4 DB 是 source of truth + c4-session-init 既有 context 注入已经覆盖 silent loss 担忧：

- ❌ `recent-inbound.jsonl` 受害者识别滚动日志（c4-session-init 已注入 recent context）
- ❌ `pending-channels.jsonl` 从 recent-inbound 升级为 broadcast 目标（agent 自治补答替代）
- ❌ `restart-in-progress.json` intake barrier（不需要 atomic snapshot 因为没有 snapshot）
- ❌ `recent-inbound.lock` 文件互斥锁（no shared mutable file → no race）
- ❌ `lastSafeIdleTs` activity-driven cleanup（不维护 ledger 就不需要 cleanup）
- ❌ Cold-restart broadcast 受害者通知（agent 自治补答替代）
- ❌ Sticky-trigger context taint 标记（难以可靠判定 + 引入新 ledger 复杂度，未来生产数据显示 loop 高发再 incremental 引入）
- ❌ 显式 "unanswered inbound" 注入到 session-init context（"是否已回复"难以可靠判定，group / multi-msg 假阳性）

main 既有的 pending-channels broadcast（c4-receive 在 health 非 OK 时记的 C 类用户通用恢复通知）**保留**，没改没增强。

##### 对外的最终行为

session_restart 触发后：
1. `adapter.stop()` → Guardian 拉新 session（Phase 0 行为不变）
2. `c4-session-init.js` 注入 last checkpoint summary + recent unsummarized conversations（既有机制不变）
3. agent 看到 startup context（包括恢复前可能未回复的 inbound）→ **agent 自行判断**是否补 reply
4. main 既有 pending-channels.jsonl drain 通用 broadcast"我恢复了"——保留 main 既有行为

**v2.1 在 error 处理上的真正贡献**：把 health state 模型 + dispatcher action 分类做扎实（§5.3.1 catalog with `recoveryAction`），而不是构造受害者识别 ledger。**复杂度从 AM 私有文件机制转回 c4 DB 这个已有可靠账本**。

### 5.4 MessageRouter（消息路由）

事件驱动模块，**运行于 `monitor.js` 进程**，c4-receive 作为 per-message 脚本通过本地 IPC 询问路由决策。

**核心约束**：MessageRouter 不调 tmux——所有 tmux 写入由 c4-dispatcher 独占。C4 主链不可绕。

#### 路由决策流程

```
c4-receive 收消息
    ↓
MessageRouter 读 health（SignalStore 投射）
    ├─ OK              → c4-receive insertConv('in') → dispatcher 主链 → tmux → AI 真实回复
    ├─ Unavailable     ↴
    ├─ RateLimited     ├→ 聚合一次 recovery check，c4-receive 同步阻塞等
    └─ AuthFailed      ↲
         ↓
Probe 返回
    ├─ recovered=true  → c4-receive insertConv('in') → dispatcher → AI 真实回复
    └─ recovered=false → c4-receive insertConv('in') + insertConv('out', "<状态文案>") → 立即返回
                         （DB 同时持久化 inbound + outbound；catalog.userMessage 决定文案）
```

#### 4 约束 C1~C4

**C1 C4 DB 是消息可靠性边界——所有 accepted 消息都进 DB**
- OK 直通：`insertConv('in')`，dispatcher 主链投递；runtime 后续异常**不算丢失**（详 §5.3.2 delivered-but-unanswered 边界声明）
- Unhealthy + probe 仍异常：`insertConv('in')` **+** 立即 `insertConv('out', <catalog.userMessage>)` —— 用户立即收到状态回复，DB 同时记录两端
- 仅 IPC 降级（C4）才不写 DB（属 monitor.js crash 级罕见异常）

**C2 短 window + 30s timeout fallback**
Probe 自然时长 10-30s。c4-receive 硬超时 30s，超时回 STATUS degraded（同样写 inbound + outbound 状态文案，§5.4 C1 路径）。MessageRouter 的 probe 继续跑，聚合池不被破坏。

**C3 MessageRouter 读 health 走 SignalStore**
读 `agent-status.json` + `rate-limit-state.json`，不直接调 HealthEngine 方法。

**C4 IPC 不可用时的降级**
c4-receive 连不上 MessageRouter（monitor.js crash）时：
- **不 `insertConversation`**——消息不进队列
- 回 terminal 文案："router 暂时不可用，请稍后重发"
- 用户凭文案自行重发

**"一次 c4-receive 一次真实答案" 不变量在所有路径下 100% 成立**。

#### 不变量对照

| 路径 | DB 记录 | 用户感知 | 守 1-reply 不变量？ |
|------|---|---|---|
| OK 直投 | inbound | 后续 AI 回复（runtime 异常时 c4-session-init 注入 context 让 agent 自治补答）| ✓ |
| Probe recovered → 投递 | inbound | 后续 AI 回复 | ✓ |
| Probe not recovered → status reply | inbound + outbound 状态文案 | 立即收到状态文案（"暂不可用" / "限流" / "auth 失败"等）| ✓ |
| 硬超时 → STATUS degraded | inbound + outbound | 立即收到 degraded 文案 | ✓ |
| IPC 降级 → terminal 文案（不入队）| 不入队 | 立即收到"router 暂时不可用，请稍后重发" | ✓ |

#### 并发聚合

仅在 recovery check 阶段起作用。短时间多条消息到达 Unavailable / AuthFailed 时，共享同一次 recovery probe。OK 路径不聚合——每条消息独立走 C4 主链，投递顺序由 DB priority + dispatcher 保证。

### 5.5 InputValidator（runtime 入口治理，**可选增强 / Optional Enhancement**）

> **范围说明**：本节是 v2.1 的**可选增强层**，**不作为核心正确性依赖**。即使完全不实施 InputValidator，§5.3.1 catalog 出口治理 + §5.3.2 c4-session-init context 注入也已经覆盖正确性。InputValidator 的价值在于**减少已知规格违规走 60-70s 出口治理的 latency**——把"图大 / 格式错"等 90% 已知 case 在 1.5s 内入口拦下，提升 user 体验。

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
   ├─ valid=true  → insertConversation → dispatcher → Claude（正常路径，完整路径见 §5.4）
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
- 漏过的坏图触发 sticky API error → 走 §5.3.1 catalog-driven 出口治理兜底（adapter.stop + 重启）
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
[catalog-driven 出口治理兜底]   ← 漏过的 edge case
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
| **InputValidator + Adapter `getInputRules`/`validateInput`**（**可选增强**）| | **✅ 新建** | | | | |
| Guardian / HealthEngine | | | ✅ 新建 | | | |
| **HealthEngine catalog-driven api-error-check + Adapter `getApiErrorPatterns`（含 recoveryAction 字段）** | | | **✅ 新建** | | | |
| **Unknown error 持续性升级（5min → recoveryAction 升级 restart_session）** | | | **✅** | | | |
| 新 `monitor.js` 编排 | | | ✅ 新建 | | | |
| MessageRouter | | | | ✅ 新建 | | |
| c4-receive 适配（同步等 MessageRouter + 写 validate-request 等结果 + unhealthy 路径写 outbound 状态文案）| | | | ✅ | | |
| c4-dispatcher 值域 | | | | ✅ | | |
| `agent-status.json` schema（含 `unavailable_reason`）| | | | | ✅ | |
| web-console 文案 | | | | | ✅ | |
| legacy 清理 | | | | | | ✅ |

**注**：早期 v2.1 草案曾设计 `recent-inbound.jsonl` + `pending-channels` 升级 + `restart-in-progress.json` barrier + `recent-inbound.lock` + `lastSafeIdleTs` activity-driven cleanup + cold-restart broadcast 整套受害者识别链路，经多轮 review walkback 后**全部砍掉**——理由详见 §5.3.2。main 既有 `pending-channels.jsonl`（health 非 OK 拒收时写）+ `c4-session-init.js` (unsummarized context 注入) 已经覆盖正确性边界。

### Phase 0：Watchdog 边界适配（内部语义不动）

PR #500 已在 main 跑 2 个月。内部状态机/规则值/intervention 按键序列**完全保留**。只做 5 项边界适配：

1. `tool-event-stream` 并入 SignalStore 流式层
2. 物理合并 `tool-lifecycle.js` + `tool-event-stream.js` → `tool-pipeline.js`
3. `tool-rules.js` 改为 Adapter DI 覆盖
4. ToolWatchdog 独立持有 `tool-watchdog-state.json`
5. 对外接口收敛为 `.tick(signals)` + `.getPendingInterventions()`

**测试要求**：以现有行为为 golden，适配前后 E2E 行为必须等价。

### Phase 1：基础设施

新建 `signal-store.js` / `status-writer.js` / `task-scheduler.js` / `tool-pipeline.js` / **`input-validator.js`**（可选增强模块）+ `tasks/` 目录（6 任务独立文件 + 1 stale-signal 清理任务）。Adapter 接口扩展 `getInputRules()` / `validateInput()`。旧 `activity-monitor.js` 仍在，新模块通过 feature flag 挂接，独立可 ship。

### Phase 2：状态模型 + 组件拆分

新建 `guardian.js` + `health-engine.js` + 新 `monitor.js`。实现：
- HealthEngine Unavailable wall-clock 时间驱动退避
- Guardian 自组装 4 拉起条件（不查询其他模块），bypass-once + marker 重置
- 新 `monitor.js` **9 步 tick**（含 InputValidator 第 2 步）
- **HealthEngine catalog-driven api-error-check（§5.3.1）**：Adapter `getApiErrorPatterns()` 返回 catalog 数组（含 `recoveryAction` 字段）+ dispatch 到 5 种 health action（`restart_session` / `probe_only` / `mark_rate_limited` / `mark_auth_failed` / `notify_only`）+ unknown-api-errors.jsonl 累积学习
- **Probe / restart 解耦**：HealthEngine probe 失败不**默认** trigger restart——按 catalog `recoveryAction` 决定。`restart_session` 才 stop+restart；其他 action 仅保持 unhealthy state + 文案
- **Unknown error 持续性升级（§5.3.1）**：连续 10 次扫描命中（5min）→ 升级 recoveryAction 为 `restart_session`；防 unknown fallback 在 sticky context 下自困死
- 保留 `activity-monitor.legacy.js` 作为回滚路径
- PM2 通过启动参数切换新旧入口

### Phase 3：消息路由 + c4-receive 适配

- monitor.js 进程内实例化 MessageRouter，暴露本地 IPC
- c4-receive 改造：
  - 按 §5.4 流程同步等 MessageRouter 响应
  - **OK 路径**：`insertConv('in')` → dispatcher 主链投递（不引入 recent-inbound 等额外信号）
  - **Unhealthy 路径（probe 后仍异常）**：`insertConv('in')` **+** 立即 `insertConv('out', <catalog.userMessage>)` —— DB 同时记录两端，立即给用户状态文案
  - **IPC 降级（C4）**：terminal 文案 + 不入队
  - **可选** 带 attachment 消息先走 InputValidator (`validate-request/<msgid>.json`)（fail-open timeout ≈ 1.5s）；不实施 InputValidator 时跳过此步直接进 MessageRouter
- c4-dispatcher：适配新 health 值域（不掺和受害者识别）
- 测试：并发聚合 / IPC 降级（terminal 文案 + 不入队）/ 硬超时 30s / C1~C4 不变量 / **probe / restart 解耦（rate_limit/auth_failed probe 失败不 restart；只有 restart_session 触发 stop）** / **unhealthy 路径 inbound + outbound 双写 DB** / **session_restart 后 c4-session-init 注入 context + agent 自治补答 E2E** / **unknown 5min recoveryAction 升级路径 E2E** / **catalog 各 recoveryAction × HealthState 转换 + DB 路径 §5.3.1.1 矩阵** / **InputValidator 拦截路径 / fail-open 路径**（仅当 InputValidator 实施时）

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
