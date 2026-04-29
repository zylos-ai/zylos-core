# 顶层补充：关键链路 Contract

> 对应：AM 技术方案（activity-monitor-design.md）Spec 1 Review
> 分支：docs/activity-monitor-design
> 状态：Draft

## 概述

AM 技术方案和 am-impl 子模块文档 review 发现若干关键链路 contract 未定义完整。本文档作为顶层方案的补充，记录分析过程和结论，定义需要补充的 contract 规格，并列出受影响的子模块文档对齐点。

顶层方案（activity-monitor-design.md）不做修改。本文档中定义的 contract 作为顶层方案的补充约束。

### 与顶层设计的关系

本文不修改顶层设计决策，只补齐顶层未展开的实施 contract。对应顶层约束：

- D-7 / D-8 / D-10：MessageRouter recovery probe、unhealthy routing、Health 持久化与 fallback。
- D-16 / D-18：heartbeat probe 与 sticky restart 语义。
- D-23 / D-24：immutable snapshot 与 ToolWatchdog 持久化状态。

当子模块文档与本文冲突时，以本文为准；若本文需要改变顶层决策，必须先更新顶层设计。

---

## 1. Dispatcher Delivery-Result 事件源分析

### 1.1 Review 提出的问题

顶层 §3.5 定义 OK → 非 OK 检测时机为"c4-dispatcher **成功**将 user message 投递给 runtime agent → 异步调用 HealthEngine"。只覆盖了投递成功的情况。

如果 dispatcher 投递失败（tmux send error、submit verification failed、runtime 不可提交），HealthEngine 没有事件入口，health 保持 OK，用户收不到 unhealthy 文案。

### 1.2 分析

检查实际场景后，delivery failure 的触发范围比预期窄：

**常见故障场景下 delivery 通常成功：**

- **Rate limit**：runtime 显示 rate limit 错误，但 tmux send-keys 正常执行（文本进了 tmux），submit verification 通常通过（runtime 接受输入后再次报错）。`onUserMessageDelivered()` 正常触发，pane scan 检测到 rate limit。
- **Auth failure**：类似，send-keys 和 verify 通常成功。现有机制够用。
- **Sticky error**（corrupted image 等）：类似。runtime 仍在运行，仍接受输入。
- **Runtime 崩溃**：pid 不存在 → Guardian 检测并拉起。不需要 HealthEngine 介入。
- **Runtime 冻结**：ProcSampler 检测 context switch 异常 → kill → Guardian 拉起。

**delivery failure 实际发生的窄场景：**

runtime 进程活着、tmux session 存在，但 runtime 处于不接受正常输入的卡死态（tmux send-keys 成功但 submit verification 失败），且 ProcSampler 无法通过 context switch 检测到冻结（进程仍有 CPU 活动）。

这是一个 edge case，不是常见故障模式。

### 1.3 结论

**保持顶层 §3.5 设计不变。** "投递成功 → pane scan"的事件驱动机制覆盖了常见故障场景（rate limit、auth failure、sticky error）。delivery failure 的 edge case 作为已知限制记录。

**不新增 `onDeliveryFailed()` 方法。** 扩展事件源模型会改变顶层 §3.5 的设计边界，而收益有限。

### 1.4 Guardian auth precheck 检测闭环

Review 同时指出：D-20 删除 Guardian auth precheck 后，auth failure 的发现依赖 user message delivered 后 pane scan。分析如下：

auth failure 的发现路径：
1. 用户消息 → dispatcher 成功投递 → `onUserMessageDelivered()` → pane scan 识别 auth failed → `checkAuth()` 二次确认 → 转 AuthFailed
2. runtime 启动即退出（auth error）→ Guardian 退避重启。下次用户消息到达时 → 路径 1

路径 2 在无用户消息时不会触发 HealthEngine，但影响有限：没有用户消息时不需要发 unhealthy 文案。第一条用户消息到达后走路径 1 检测。

**结论：现有机制足够。** Guardian auth precheck 删除后的检测闭环由 §3.5 的 delivered-success 路径覆盖。

---

## 2. Heartbeat Control Contract

### 2.1 问题

HealthEngine 使用 heartbeat probe 作为 recovery 的核心探测手段（RateLimited / Unavailable 的 recovery 都依赖 heartbeat ack）。但 heartbeat control 消息从 HealthEngine 写入 c4.db 到 runtime heartbeat control 规则消费并 ack 的完整链路没有定义。

关键风险：如果 heartbeat control 被 unhealthy gate 拦截（dispatcher 在 health != OK 时不投递 control），recovery probe 永远失败，系统无法自愈。

### 2.2 Contract 定义

**核心原则**：HealthEngine recovery heartbeat 是真实 runtime liveness probe。它必须绕过 health gate，在任何 HealthState 下都能被投递到 runtime，并且不得由 dispatcher auto-ack。

**适用 phase**：
- `recovery`：MessageRouter / HealthEngine recovery probe 使用。
- `post_restart`：Guardian 拉起 runtime 后的恢复确认 probe 使用。

如果历史上存在 periodic / primary heartbeat auto-ack，它不能和 recovery heartbeat 混用。`phase='recovery' | 'post_restart'` 的 heartbeat 只有 runtime heartbeat control 规则显式 ack 才能变为 `done`。

#### 投递链路

```
HealthEngine → enqueueHeartbeat(phase) → c4.db control 表
                                              │
                                              ▼
                               c4-dispatcher 轮询 control 表
                               （独立于 user message 投递循环）
                                              │
                                              ▼
                                     tmux send-keys 注入
                                              │
                                              ▼
                               runtime heartbeat control 规则消费
                                              │
                                              ▼
                                  UPDATE status = 'done'
```

Heartbeat 不经过 MessageRouter / c4-receive。由 HealthEngine 直接写入 c4.db control 表，c4-dispatcher 负责投递。

#### c4-dispatcher control 投递规则

| 规则 | 说明 |
|------|------|
| 独立投递循环 | control 消息和 user message 使用独立的投递循环（或同一循环中 control 优先处理），确保 control 不被 user message 队列阻塞 |
| 无 health gate | recovery heartbeat 必须绕过 dispatcher health gate；推荐由 `enqueueHeartbeat()` 写入 `bypass_state=1`，dispatcher 看到 bypass 后跳过 health gate |
| 优先投递 | 同一 poll cycle 中 control 消息优先于 user message 投递 |
| 单条投递 | 每次 poll 最多投递一条 control 消息，避免 tmux 输入冲突 |

#### enqueueHeartbeat control 字段

`enqueueHeartbeat(phase)` 必须写入一条 bypass control。字段名按现有 C4 control 表实现调整，但语义必须等价：

```javascript
{
  type: 'heartbeat',
  content: `Heartbeat check. [phase=${phase}]`,
  phase: 'recovery' | 'post_restart',
  status: 'pending',
  bypass_state: 1,              // 必须绕过 health gate
  priority: 0,                  // 高于普通 user/control 消息
  ack_deadline_seconds: 25,     // 对齐 PROBE_TIMEOUT
  append_ack_suffix: true,      // 必须附带 ack via control_id，供 runtime heartbeat control 规则显式 ack
}
```

**content 格式**：`content` 必须以 `Heartbeat check.` 开头，并包含 `[phase=recovery]` 或 `[phase=post_restart]`。runtime heartbeat control 规则使用该前缀识别 heartbeat control，并解析 `[phase=...]` 判断 probe 类型。

**ack suffix**：recovery heartbeat 不得传 `--no-ack-suffix`。C4 必须在投递内容后附加当前 `control_id` 的 `ack via: node ... c4-control.js ack --id <id>` 后缀，runtime heartbeat control 规则通过该后缀执行显式 ack。`无 auto-ack` 指 dispatcher 不得自行把 heartbeat 标记为 done，不代表去掉 ack suffix。

如果实现选择 control 投递循环天然不检查 agent health，仍建议保留 `bypass_state=1` 作为可审计 contract。

#### status 生命周期

```
pending ─── dispatcher 取出并投递 ──▶ running
                                        │
                          ┌──────────────┴──────────────┐
                          │                             │
                runtime control 规则 ack            超时未 ack
                          │                             │
                          ▼                             ▼
                        done                     HealthEngine
                                                 poll 超时判定
```

| 状态转移 | 执行者 | 条件 |
|---------|--------|------|
| pending → running | c4-dispatcher | dispatcher 成功 send-keys 到 tmux |
| running → done | runtime heartbeat control 规则 | 识别 heartbeat 内容，处理完毕后 UPDATE |
| pending/running → 超时 | HealthEngine | `sendHeartbeatProbe()` poll 循环超过 PROBE_TIMEOUT(25s) |

**超时语义**：HealthEngine 在 `sendHeartbeatProbe()` 的 poll 循环中判定超时（`Date.now() > deadline`），返回 `{ ack: false, reason: 'heartbeat_timeout' }`。DB 中 status 可能仍为 pending 或 running——stale entries 由 TaskScheduler maintenance 清理，不影响 probe 判定。

#### ack 机制

runtime 的 heartbeat control 规则识别投递到 runtime 的 `Heartbeat check. [phase=...]` 文本，且 `phase in ('recovery', 'post_restart')`、消息带有当前 control id 的 ack suffix 时，执行 suffix 中的 `c4-control.js ack --id <id>`，使 control 状态变为 `done`。这个规则由 runtime/system prompt 或等价 runtime 控制处理保证，不对应 `hooks.md` 中列出的 4 个代码 hook 文件。

**无 auto-ack**。heartbeat 的 ack 必须由 runtime heartbeat control 规则显式完成。原因：heartbeat 的目的是验证 runtime 是否响应，auto-ack 会导致 "runtime 已死但 heartbeat 显示 done" 的假阳性。

#### enqueueHeartbeat / getHeartbeatStatus 语义明确

```javascript
// deps.enqueueHeartbeat(phase)
//   写入 c4.db control 表：{
//     type: 'heartbeat',
//     content: `Heartbeat check. [phase=${phase}]`,
//     phase,
//     status: 'pending',
//     bypass_state: 1,
//     append_ack_suffix: true,
//     ...
//   }
//   phase: 'recovery' | 'post_restart' — 标识 probe 阶段，供日志/调试
//   返回 control_id（成功）或 false（DB 写入失败）

// deps.getHeartbeatStatus(controlId)
//   读取 c4.db 该 control_id 的 status
//   返回值：'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'not_found'
//   HealthEngine poll 循环根据返回值决定继续等待或终止
```

### 2.3 子模块影响

| 文档 | 变更 |
|------|------|
| health-engine.md | `enqueueHeartbeat()` / `getHeartbeatStatus()` 的 deps 注释更新为本 contract 定义的完整语义 |
| c4-changes.md | c4-dispatcher 需实现 recovery heartbeat bypass health gate、无 auto-ack、优先投递规则 |
| hooks.md | 说明 heartbeat ack 是 runtime control 行为，不是新增代码 hook；确认显式 ack、无 auto-ack |

---

## 3. Sticky Restart Health Semantics

### 3.1 问题

health-engine.md 的 sticky error 处理（D-18）在 `stop()` 后保持 health=OK：

```javascript
this.deps.stop()
// 设计决策：不改 health，保持 OK。
// 原因：sticky error 是 session 级问题，不是 runtime 级健康问题。
```

在 restart 窗口内（stop → Guardian 检测 offline → 拉起新 session，约 5-10s）：
- MessageRouter 认为 health=OK → 路由消息到 pending
- dispatcher 投递到正在重启的 runtime → 失败（tmux session 刚被 kill）
- 用户不会收到 unhealthy 状态文案
- D-8（unhealthy 即时文案）和 D-37（single real answer）在此场景下不生效

### 3.2 Contract 定义

**原则**：任何导致 runtime 被 stop 的场景，health 都应转入非 OK 状态。sticky restart 不例外。

**sticky error 处理流程（修订）**：

```
连续 2 次命中 sticky error（30s 间隔防抖，D-18）
  │
  ├─ setHealth('unavailable', 'sticky_context_restart')
  │   // 先标记 unavailable，再 stop
  │
  ├─ deps.stop()
  │   // kill tmux session
  │
  ├─ Guardian 下一 tick 检测到 offline → 拉起新 session
  │
  ├─ Orchestrator 调 onProcessRestarted()
  │   // restartFailureCount = 0
  │   // 安排 CHECK_DELAY 后 probe
  │
  └─ probe 成功（heartbeat ack）
      → setHealth('ok')
```

**与原方案的区别**：

| | 原方案（health=OK） | 修订（health=unavailable） |
|---|---|---|
| restart 窗口内 MessageRouter 行为 | 路由到 pending，dispatcher 投递失败 | 返回 unhealthy 文案给用户 |
| D-8 unhealthy 即时文案 | 不生效 | 生效 |
| D-37 single real answer | 不成立 | 成立 |
| 连续 sticky error | 每次 OK→stop→restart，用户无感知 | 第一次进入 unavailable，后续 probe 失败则退避 |
| post-restart recovery | health=OK，`onProcessRestarted()` 直接 return | `onProcessRestarted()` 安排 probe，成功后回 OK |

**reason 命名**：`sticky_context_restart`。MessageRouter 映射用户文案时，reason 前缀 `sticky_` 标识"session 级问题，通常换 session 可恢复"，消费端可据此选择较温和的文案（如"正在切换会话，请稍等"而非"系统不可用"）。

### 3.3 health-engine.md 修订

`onUserMessageDelivered()` 的 sticky error 分支修订：

```javascript
// 优先级 3：sticky error（D-18：连续 2 次命中防抖，30s 间隔）
if (result.stickyError) {
  this.stickyErrorConsecutiveHits++
  this.rateLimitConsecutiveHits = 0
  if (this.stickyErrorConsecutiveHits === 1) {
    this.lastStickyErrorHitAt = Date.now()
  }
  if (this.stickyErrorConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
    if ((Date.now() - this.lastStickyErrorHitAt) < STICKY_ERROR_MIN_INTERVAL) {
      return  // 间隔过短
    }
    this.stickyErrorConsecutiveHits = 0
    this.lastStickyErrorHitAt = 0
    this.deps.log(`sticky error 2x: ${result.pattern}, killing session (D-18)`)
    this.setHealth('unavailable', 'sticky_context_restart')  // 修订：先进入 unavailable
    this.deps.stop()
    // Guardian 下一 tick 拉起 → Orchestrator 调 onProcessRestarted()
    // → 安排 probe → 成功回 OK
  }
  return
}
```

### 3.4 子模块影响

| 文档 | 变更 |
|------|------|
| health-engine.md | sticky error 分支：删除"不改 health，保持 OK"注释和代码，改为 `setHealth('unavailable', 'sticky_context_restart')` + `stop()` |
| message-router.md | reason catalog 新增 `sticky_context_restart` → 用户文案映射 |

---

## 4. ToolWatchdog State Handoff Contract

### 4.1 问题

ToolWatchdog 的 `evaluate()` 已按 D-23 改为不修改 immutable snapshot，而是返回 `nextWatchdogState` / `clearWatchdogState`。但必须定义谁负责消费这些 state mutation intent，否则执行者可能只处理 phase 字段，漏掉 episode 持久化。

### 4.2 Contract 定义

ToolWatchdog 不直接写文件，不修改 snapshot。它只返回状态意图：

```javascript
{
  watchdog_phase,
  watchdog_block_reason,
  api_activity_dirty,
  nextWatchdogState,
  clearWatchdogState,
}
```

Monitor Orchestrator 是 ToolWatchdog episode 状态的落盘责任方：

1. `clearWatchdogState === true` → 清除 `tool-watchdog-state.json`，并将本 tick 后续聚合使用的 watchdog state 置为 `null`。
2. `nextWatchdogState != null` → atomic write `tool-watchdog-state.json`，并将本 tick 后续聚合使用的 watchdog state 置为该值。
3. `api_activity_dirty === true` → 在 synthetic clear hint 后重建 apiActivity。
4. StatusWriter 使用上述处理后的最终 phase / block reason / watchdog state 写入 `agent-status.json`。

状态意图必须在同一 tick 内消费，避免 interrupt episode 丢失导致重复 interrupt 或无法进入 grace/escalated。

### 4.3 子模块影响

| 文档 | 变更 |
|------|------|
| tool-watchdog.md | 明确返回的 mutation intent 必须由 Orchestrator 同 tick 消费 |
| monitor-orchestrator.md | Tick 编排补充 clear/write `tool-watchdog-state.json` 和 StatusWriter 输入 |

---

## 5. 子模块修改汇总

### 5.1 本 contract 驱动的子模块修改

| 文档 | 修改内容 | 来源 |
|------|---------|------|
| health-engine.md | `enqueueHeartbeat` / `getHeartbeatStatus` deps 注释对齐完整语义 | Contract §2 |
| health-engine.md | sticky error 分支改为进入 unavailable | Contract §3 |
| c4-changes.md | dispatcher control 消息独立投递 + 无 health gate + 优先投递 | Contract §2 |
| message-router.md | reason catalog 新增 `sticky_context_restart` | Contract §3 |
| hooks.md | 说明 heartbeat ack 是 runtime control 行为（显式 ack，无 auto-ack），不是新增代码 hook | Contract §2 |
| monitor-orchestrator.md | 消费 ToolWatchdog state mutation intent 并落盘 | Contract §4 |
| tool-watchdog.md | 明确自身只返回状态意图，不负责持久化 | Contract §4 |

### 5.2 Review 同时发现的子模块独立修改

这些问题不需要顶层 contract 补充，直接在子模块文档内修改：

| 文档 | 修改内容 | 原因 |
|------|---------|------|
| tool-watchdog.md | `evaluate()` 不直接改 `snapshot.watchdogState`，改为返回 `nextWatchdogState` / `clearWatchdogState`，由 Orchestrator 写入 | 违反 D-23 snapshot immutable |
| task-scheduler.md §3 | 改动类型从"纯提取"改为"提取 + 行为变更"，补 D-26/D-27 migration 说明 | 标注不准确 |
| README.md | TaskScheduler 改动类型从"纯提取"改为"提取 + 行为变更" | 同上 |
| monitor-orchestrator.md | 初始化流程"DailySchedule × 3" → TaskScheduler 统一注册 | 表述未统一 |
