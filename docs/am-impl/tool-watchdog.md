# ToolWatchdog

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：检测工具调用是否超时，超时则通过 Adapter 执行干预动作（如中断当前工具）。

**输入**：snapshot、Adapter 提供的工具超时规则

**输出**：调用 Runtime Adapter 执行控制动作（中断/重启）

**相关决策**：
- **D-24**：ToolWatchdog 是有状态的干预系统（6 阶段状态机 + 持久化 + 主动按键中断），不是无状态健康检查，不归入 health-checks 子系统。
- **D-33**：移除 launchGracePeriod。tool-call 响应速度与 runtime 是否刚拉起无关，ToolWatchdog 不需要启动宽限期。

## 2. 组件设计

### 接口定义

```javascript
function evaluateToolWatchdogTransition({
  nowMs, foregroundIdentity, apiActivity, interactiveState,
  state, deps
}): { watchdog_phase: string, watchdog_block_reason: string | null, api_activity_dirty: boolean }
```

### 6 阶段状态机（D-24）

```
idle → observing      : 出现 watchdog 候选工具
observing → interrupt_sent     : 超时 + 发送中断成功
observing → interrupt_retry_wait : 超时 + 发送中断失败
interrupt_sent → interrupt_wait : 中断已发送，等待 grace
interrupt_wait → escalated     : grace 过期仍未恢复
interrupt_retry_wait → interrupt_sent : 重试冷却到期
任何阶段 → recovered           : 候选工具消失或 pane 恢复
任何阶段 → idle               : 前置条件不满足
```

### 前置条件（idle 原因）

| block_reason | 条件 |
|------|------|
| foreground_untrusted | foregroundIdentity.trusted != true |
| health_\<state\> | engineHealth != 'ok' |
| no_watchdog_candidate | 无候选工具 |
| watchdog_disabled | 规则的 watchdog.enabled = false |

### 行为变更（D-33）

移除 `launchGracePeriod` 检查。ToolWatchdog 不再有启动宽限期。

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

### 与其他组件的交互

- **ToolPipeline** → 消费 `api-activity.json` 获取 watchdog 候选工具
- **HealthEngine** → 读取 health 状态作为前置条件；升级时触发 HealthEngine 状态转移
- **Adapter** → 调用 `sendMessage()` 发送中断按键
- **Monitor Orchestrator** → 在 tick 编排中被调用

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| web_tool_watchdog_enabled | true | 是否启用 WebFetch/WebSearch watchdog |
| web_tool_timeout_sec | 3600 | 超时阈值 |
| web_tool_interrupt_grace_sec | 15 | 中断后等待时间 |
| web_tool_timeout_cooldown_sec | 60 | 重试冷却 |

## 3. 实施方案

**改动类型**：纯提取（已独立模块，仅移除 launchGracePeriod，D-33）

### 现有代码位置

已独立为 `scripts/tool-watchdog.js`。

### 实施步骤

1. 确认现有 `tool-watchdog.js` 接口与本文档定义对齐
2. 移除 `launchGracePeriod` 相关检查逻辑（D-33）
3. 确认 6 阶段状态机转换规则与现有代码一致
