# ToolWatchdog

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：检测工具调用是否超时，超时则通过 Adapter 执行干预动作（如中断当前工具）。

**输入**：snapshot、Adapter 提供的工具超时规则

**输出**：调用 Runtime Adapter 执行控制动作（中断/重启）

**相关决策**：
- **D-23**：跨模块状态走 SignalStore，不直接读其他模块私有数据。ToolWatchdog 通过 snapshot 读取 health 状态，不直接持有 HealthEngine 引用。
- **D-24**：ToolWatchdog 是有状态的干预系统（6 阶段状态机 + 持久化 + 主动按键中断），不是无状态健康检查，不归入 health-checks 子系统。顶层设计记为 5 阶段——将 interrupt_sent 与 interrupt_retry_wait 视为同一「干预」阶段；本文档按实现拆分为 6 阶段，因两者退出条件不同（grace_deadline vs retry_after）需独立 phase 值驱动状态机。
- **D-33**：移除 launchGracePeriod。tool-call 响应速度与 runtime 是否刚拉起无关，ToolWatchdog 不需要启动宽限期。

### 当前实现状态

`scripts/tool-watchdog.js` 当前不是持有依赖和内部状态的 class，而是 pure transition function：`evaluateToolWatchdogTransition()`。它只计算 phase、block reason、state mutation intent 和是否需要刷新 api activity，不直接读写 `tool-watchdog-state.json`。

持久化和副作用由 `MonitorOrchestrator` 的 adapter glue 消费返回值后完成：
- `clearWatchdogState` → 调用注入的清理函数，并同步更新 in-memory state
- `nextWatchdogState` → 调用注入的写入函数，并同步更新 in-memory state
- `api_activity_dirty` → 触发 ToolPipeline 重新读取/生成 api activity snapshot
- `triggerRecovery()`、`enqueueInterrupt()`、synthetic clear hint 仍通过 deps 注入

该形态是本轮迁移刻意保留的安全边界，用来避免改变 ToolWatchdog restart/recovery 语义。后续若要提取 class，可在保持 transition 函数测试覆盖的前提下包一层状态持有器。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **前置检查** | 前台身份验证 | `foregroundIdentity.trusted != true` → idle（不操作不信任的 session） |
| | 健康状态检查 | `snapshot.health != 'ok'` → idle（从 snapshot 读取，D-23） |
| | 候选工具检查 | 无 `watchdog_candidate_tool` → idle |
| | 规则检查 | 候选工具的 `watchdog.enabled = false` → idle |
| **超时检测** | 运行时间计算 | `nowMs - candidate.started_at` vs `rule.watchdog.maxRuntimeSec` |
| | 观察阶段 | 未超时 → `observing`（持续监控） |
| **干预** | 发送中断 | `deps.enqueueInterrupt(interruptKey)` 向 tmux 发送按键（默认 Escape） |
| | 中断等待 | 发送成功后等待 `interruptGraceSec`（默认 15s） |
| | 中断重试 | 发送失败后等待 `cooldownSec`（默认 60s）后重试 |
| | pane 恢复检测 | `deps.canTreatPaneAsRecovered(interactiveState)` 检查 tmux 是否回到交互态 |
| | 升级（escalation） | grace 过期仍未恢复 → `deps.triggerRecovery()` → HealthEngine 标记 unavailable 并 stop session → Guardian 下一 tick 拉起 |
| **状态持久化** | watchdog-state.json | 写入当前 episode 状态，AM 冷启动恢复 |

### 6 阶段状态机

```
                        出现候选工具
                 ┌─────────────────────┐
                 │                     ▼
              ┌──┴──┐           ┌──────────┐
              │idle │           │observing  │
              └──┬──┘           └─────┬────┘
                 ▲                    │ 超时
    前置条件不满足 │                    │
    或候选工具消失 │              ┌─────┴─────┐
                 │              │           │
                 │         发送成功     发送失败
                 │              │           │
                 │              ▼           ▼
                 │    ┌──────────────┐ ┌─────────────────┐
                 │    │interrupt_sent│ │interrupt_retry   │
                 │    └──────┬───────┘ │_wait             │
                 │           │         └────────┬────────┘
                 │           ▼                  │ 冷却到期
                 │    ┌──────────────┐          │ → 重试发送
                 │    │interrupt_wait│◄─────────┘
                 │    └──────┬───────┘
                 │           │ grace 过期
                 │           ▼
                 │    ┌──────────┐
                 │    │escalated │ → triggerRecovery() → stop session
                 │    └──────────┘
                 │
                 │  ┌──────────┐
                 └──│recovered │ ← 候选消失或 pane 恢复
                    └──────────┘
```

### 前置条件（idle 原因）

| block_reason | 条件 | 说明 |
|------|------|------|
| foreground_untrusted | `foregroundIdentity.trusted != true` | 不操作不信任的 session |
| health_\<state\> | `snapshot.health != 'ok'` | runtime 不健康时不干预（从 snapshot 读取，D-23） |
| no_watchdog_candidate | 无候选工具 | 没有需要监控的长时间工具 |
| watchdog_disabled | `rule.watchdog.enabled = false` | 规则禁用了 watchdog |
| interrupt_enqueue_failed | `enqueueInterrupt()` 返回失败 | tmux 中断发送失败 |

### 接口定义

```javascript
function evaluateToolWatchdogTransition({
  nowMs: number,
  foregroundIdentity: ForegroundIdentity,
  apiActivity: ApiActivity,
  interactiveState: InteractiveState | null,
  snapshot: {
    health: string,                  // 从 snapshot.agentStatus.health 读取（D-23）
    runtimeLaunchAtMs: number,
    watchdogState: WatchdogEpisode | null,  // 只读，不得修改（D-23 immutable snapshot）
  },
  deps: WatchdogDeps,
}): {
  watchdog_phase: string,
  watchdog_block_reason: string | null,
  api_activity_dirty: boolean,
  nextWatchdogState: WatchdogEpisode | null,  // 非 null 时由 Orchestrator 写入
  clearWatchdogState: boolean,                // true 时由 Orchestrator 清除
}
```

```javascript
interface WatchdogDeps {
  getRuleById(ruleId: string): ToolRule | null
  enqueueInterrupt(key: string): { ok: boolean, output?: string }
  canTreatPaneAsRecovered(interactiveState): boolean
  applySyntheticClearHint(sessionId, claudePid, reason, nowMs): void
  triggerRecovery(reason: string): void
  log(message: string): void
  // clearWatchdogState / writeWatchdogState 移出 deps：
  // evaluate() 通过返回值 clearWatchdogState / nextWatchdogState 表达意图，
  // 由 Orchestrator 负责实际的清除和写入（D-23：snapshot 不可变）
}
```

返回值中的 state mutation intent 必须由 Monitor Orchestrator 在同一 tick 内消费；ToolWatchdog 不负责持久化，也不直接修改 snapshot。

### Watchdog Episode 状态

```javascript
{
  version: 1,
  episode_key: string,          // = candidate.event_id
  session_id: string,
  claude_pid: number,
  tool_name: string,
  rule_id: string,
  started_at: number,           // ms, 工具开始时间
  first_timeout_at: number,     // ms, 首次超时检测时间
  interrupt_sent_at: number,    // ms, 最近一次中断发送时间（0 = 未发送）
  interrupt_key: string,        // 使用的按键
  interrupt_count: number,      // 累计中断次数
  grace_deadline_at: number,    // ms, grace 过期时间
  interactive_recovered_at: number, // ms, pane 恢复时间
  escalated_at: number,         // ms, 升级时间（0 = 未升级）
  escalation: string,           // 'restart'
  retry_after_at: number,       // ms, 重试冷却截止（0 = 无冷却）
  last_action_at: number,       // ms, 最近动作时间
}
```

### 工具规则格式

```javascript
{
  id: string,
  runtime: 'claude' | 'codex',
  tools: string[],
  watchdog: {
    enabled: boolean,
    maxRuntimeSec: number,         // default 3600
    interruptKey: string,          // default 'Escape'
    interruptGraceSec: number,     // default 15
    escalation: 'restart',
    cooldownSec: number,           // default 60
  }
}
```

### 状态转移伪代码

```javascript
function evaluateToolWatchdogTransition({ nowMs, foregroundIdentity, apiActivity, interactiveState, snapshot, deps }) {
  const candidate = apiActivity?.watchdog_candidate_tool || null
  const phase = { watchdog_phase: 'idle', watchdog_block_reason: null, api_activity_dirty: false, nextWatchdogState: null, clearWatchdogState: false }

  // ── 前置条件检查：任一不满足 → idle ──

  if (!foregroundIdentity?.trusted) {
    phase.clearWatchdogState = true
    phase.watchdog_block_reason = foregroundIdentity?.blockReason || 'foreground_untrusted'
    return phase
  }

  // D-23: health 从 snapshot 读取（行为变更：原为直接读 HealthEngine 内存字段）
  if (snapshot.health !== 'ok') {
    phase.clearWatchdogState = true
    phase.watchdog_block_reason = `health_${snapshot.health}`
    return phase
  }

  // D-33: 移除 launchGracePeriod 检查（行为变更）

  if (!candidate) {
    phase.clearWatchdogState = true
    phase.watchdog_block_reason = 'no_watchdog_candidate'
    return phase
  }

  const rule = deps.getRuleById(candidate.rule_id)
  if (!rule?.watchdog?.enabled) {
    phase.clearWatchdogState = true
    phase.watchdog_block_reason = 'watchdog_disabled'
    return phase
  }

  // ── 超时判断 ──

  const maxRuntimeMs = rule.watchdog.maxRuntimeSec * 1000
  if ((nowMs - candidate.started_at) < maxRuntimeMs) {
    // 未超时：observing
    if (snapshot.watchdogState?.episode_key !== candidate.event_id) {
      phase.clearWatchdogState = true   // 候选工具切换，清除旧 episode
    }
    phase.watchdog_phase = 'observing'
    return phase
  }

  // ── 已超时：检查现有 episode 状态 ──

  if (snapshot.watchdogState?.episode_key === candidate.event_id) {
    // 候选工具消失 → recovered
    if (!apiActivity.watchdog_candidate_tool) {
      phase.clearWatchdogState = true
      phase.watchdog_phase = 'recovered'
      return phase
    }

    // pane 已回到交互态 → recovered（注入 synthetic clear hint 让 ToolPipeline 清除 episode）
    if (deps.canTreatPaneAsRecovered(interactiveState)) {
      deps.applySyntheticClearHint(foregroundIdentity.sessionId, foregroundIdentity.claudePid, 'interactive_recovered', nowMs)
      phase.clearWatchdogState = true
      phase.watchdog_phase = 'recovered'
      phase.api_activity_dirty = true       // 通知 Orchestrator 重建 apiActivity
      return phase
    }

    // 中断已发送且 grace 未过期 → interrupt_wait
    if (snapshot.watchdogState.interrupt_sent_at && nowMs <= snapshot.watchdogState.grace_deadline_at) {
      phase.watchdog_phase = 'interrupt_wait'
      return phase
    }

    // 中断发送失败，冷却未到期 → interrupt_retry_wait
    if (!snapshot.watchdogState.interrupt_sent_at
      && snapshot.watchdogState.retry_after_at
      && nowMs < snapshot.watchdogState.retry_after_at) {
      phase.watchdog_phase = 'interrupt_retry_wait'
      return phase
    }

    // 已升级 → 保持 escalated
    if (snapshot.watchdogState.escalated_at) {
      phase.watchdog_phase = 'escalated'
      return phase
    }
  }

  // ── 需要动作：发送中断 或 升级 ──

  // 条件：无 episode / episode 切换 / 中断未发送（含重试）
  if (!snapshot.watchdogState
    || snapshot.watchdogState.episode_key !== candidate.event_id
    || !snapshot.watchdogState.interrupt_sent_at) {

    const result = deps.enqueueInterrupt(rule.watchdog.interruptKey)

    // 构建新 episode 状态（不修改 snapshot，通过返回值传递）
    phase.nextWatchdogState = {
      version: 1,
      episode_key: candidate.event_id,
      session_id: foregroundIdentity.sessionId,
      claude_pid: foregroundIdentity.claudePid,
      tool_name: candidate.name,
      rule_id: candidate.rule_id,
      started_at: candidate.started_at,
      first_timeout_at: snapshot.watchdogState?.episode_key === candidate.event_id
        ? snapshot.watchdogState.first_timeout_at : nowMs,
      interrupt_sent_at: result.ok ? nowMs : 0,
      interrupt_key: rule.watchdog.interruptKey,
      interrupt_count: (snapshot.watchdogState?.episode_key === candidate.event_id
        ? snapshot.watchdogState.interrupt_count : 0) + 1,
      grace_deadline_at: result.ok ? (nowMs + rule.watchdog.interruptGraceSec * 1000) : 0,
      interactive_recovered_at: 0,
      escalated_at: 0,
      escalation: rule.watchdog.escalation,
      retry_after_at: result.ok ? 0 : (nowMs + rule.watchdog.cooldownSec * 1000),
      last_action_at: nowMs,
    }

    phase.watchdog_phase = result.ok ? 'interrupt_sent' : 'interrupt_retry_wait'
    if (!result.ok) phase.watchdog_block_reason = 'interrupt_enqueue_failed'
    return phase
  }

  // ── 兜底：grace 过期仍未恢复 → escalation ──

  deps.triggerRecovery(`tool_timeout_${candidate.name}`)
  phase.nextWatchdogState = {
    ...snapshot.watchdogState,
    escalated_at: nowMs,
    last_action_at: nowMs,
  }
  phase.watchdog_phase = 'escalated'
  return phase
}
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **ToolPipeline** | 消费 | `apiActivity.watchdog_candidate_tool` | 获取候选超时工具 |
| **ToolPipeline** | 消费 | `foregroundIdentity` | 前台身份验证 |
| **Snapshot input** | 读取 | `snapshot.health` | 前置条件检查（D-23：通过 snapshot，不直接读 HealthEngine）。当前 snapshot 由 Orchestrator adapter glue 构造 |
| **HealthEngine** | 调用 | `triggerRecovery()` | escalation 时触发 HealthEngine（显式接口调用，D-23 允许） |
| **Adapter** | 调用 | `sendMessage()` (via `enqueueInterrupt`) | 发送中断按键 |
| **Monitor Orchestrator** | 调用 + 落盘 | `evaluateToolWatchdogTransition()`；消费 `clearWatchdogState` / `nextWatchdogState` | tick 中被调用；负责清除或 atomic write `tool-watchdog-state.json` |
| **StatusWriter** | 提供 | `watchdog_phase`, `watchdog_block_reason` | 写入 agent-status.json |

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| web_tool_watchdog_enabled | true | 是否启用 WebFetch/WebSearch watchdog |
| web_tool_timeout_sec | 3600 | 超时阈值 |
| web_tool_interrupt_grace_sec | 15 | 中断后等待时间 |
| web_tool_timeout_cooldown_sec | 60 | 重试冷却 |

## 3. 实施方案

**改动类型**：行为变更（移除 launchGracePeriod D-33 + health 改从 snapshot 读取 D-23）

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `scripts/tool-watchdog.js`（145行） | `evaluateToolWatchdogTransition()` 完整状态机 |
| `scripts/tool-rules.js`（99行） | `getToolRules()` 规则定义 |
| `activity-monitor.js:1983-1995` | Orchestrator 调用入口 + dirty flag 处理 |
| `activity-monitor.js:840-850` | `writeWatchdogState()` |

### 实施步骤

1. 确认现有 `tool-watchdog.js` 接口与本文档定义对齐 — **已对齐**
2. **移除 `launchGracePeriod` 相关检查逻辑**（D-33）：删除 `withinLaunchGrace` 判断和 `launch_grace` block_reason，从参数中移除 `launchGracePeriodSec`
3. **`engineHealth` 改从 snapshot 读取**（D-23）：不再直接读 HealthEngine 内存字段，改为从 `snapshot.agentStatus.health` 获取
4. 确认 6 阶段状态机转换规则与现有代码一致
