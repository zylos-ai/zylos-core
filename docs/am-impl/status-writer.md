# StatusWriter

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：tick 末尾汇总当前 ActivityState、HealthState 及各组件状态，写入对外状态文件。

**输入**：snapshot、HealthEngine 当前状态

**输出**：`agent-status.json`（Operator 和 MessageRouter 消费）

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。StatusWriter 同时写入两层状态。
- **D-2**：HealthState 诊断信息通过 `agent-status.json` 的 `unavailable_reason` 字段暴露。
- **D-10**：Health 状态持久化到 agent-status.json，AM 冷启动时恢复。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **状态投射** | ActivityState 计算 | 无状态投射：activeTools > 0 → busy; inactiveSeconds < 3s → busy; else → idle |
| | 活动时间来源 | 优先级：conversation file mtime → tmux activity → default → api hook |
| | idle 时间计算 | busy → idle 转换时记录 idleSince，计算 idleSeconds |
| **状态聚合** | HealthState | 从 HealthEngine 读取 `health` 字段 |
| | 诊断信息（D-2） | 非 OK 状态附加 `unavailable_reason`；ok 时清空 |
| | rate limit 附加信息 | health=rate_limited 时附加 `rate_limit_reset` + `cooldown_until` |
| | Tool watchdog 状态 | 从 ToolPipeline/ToolWatchdog 聚合工具监控信息 |
| | Foreground identity | 从 ToolPipeline 获取前台会话身份 |
| **输出** | 原子写入 | write tmp → rename，避免其他进程读到半写状态 |
| | offline/stopped 状态 | Guardian 检测到不在线时也调用 StatusWriter（携带 since, message） |

### 状态写入流程

```
write(snapshot, healthEngine, extra)
  │
  ├─ Running 路径（Guardian 确认进程存活）
  │   │
  │   ├─ 1. 确定活动时间来源
  │   │     ├─ adapter.getConversationMtime()（非 null 时最高优先级，D-5/D-38）
  │   │     ├─ tmux window activity
  │   │     ├─ 当前时间（default fallback）
  │   │     └─ api hook timestamp（如果 active=true 且更新）
  │   │
  │   ├─ 2. 计算 ActivityState
  │   │     activeTools > 0           → busy
  │   │     inactiveSeconds < 3s      → busy
  │   │     else                      → idle
  │   │
  │   ├─ 3. 聚合字段
  │   │     ├─ state, thinking, last_activity, active_tools
  │   │     ├─ idle_seconds, inactive_seconds, source
  │   │     ├─ runtime_launch_at
  │   │     ├─ active_tool_name, active_tool_running_seconds, active_tool_summary
  │   │     ├─ watchdog_phase, watchdog_block_reason, watchdog_episode_key
  │   │     ├─ foreground_session_source, foreground_session_observed_at
  │   │     └─ health 附加字段（from HealthEngine，按状态分支写入）：
  │   │        ok:           清空所有附加字段
  │   │        unavailable:  unavailable_since + unavailable_reason
  │   │        rate_limited: unavailable_reason + rate_limit_reset + cooldown_until
  │   │        auth_failed:  unavailable_reason
  │   │
  │   └─ 4. atomicWriteJson(agent-status.json)
  │
  └─ Offline/Stopped 路径（Guardian 检测到进程不在）
      │
      ├─ state = 'offline' 或 'stopped'
      ├─ since, not_running_seconds, message
      ├─ health（from HealthEngine）
      └─ atomicWriteJson(agent-status.json)
```

### 接口定义

```javascript
class StatusWriter {
  write(snapshot: Snapshot, healthEngine: HealthEngine, extra: StatusExtra): void
}
```

```javascript
interface StatusExtra {
  // Running 路径
  state: 'idle' | 'busy' | 'offline' | 'stopped',
  thinking?: boolean,
  last_activity?: number,                // epoch seconds
  last_api_activity?: number,            // epoch seconds
  activeTools?: number,
  idleSeconds?: number,
  inactiveSeconds?: number,
  source?: string,
  runtimeLaunchAtMs?: number,

  // Tool 相关（Running 路径）
  active_tool_name?: string | null,
  active_tool_running_seconds?: number,
  active_tool_summary?: object | null,
  active_tool_rule_id?: string | null,
  active_tool_session_id?: string | null,
  watchdog_episode_key?: string | null,
  watchdog_phase?: string,
  watchdog_last_action_at?: number | null,
  watchdog_block_reason?: string | null,
  foreground_session_source?: string | null,
  foreground_session_observed_at?: number,

  // Offline/Stopped 路径
  notRunningSeconds?: number,
  since?: number,
  message?: string,
}
```

### agent-status.json 完整输出 Schema

见 [signal-store.md](signal-store.md) 的 agent-status.json Schema。

StatusWriter 是该文件的唯一写入方，其他组件通过 SignalStore 读取。

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **HealthEngine** | 读取 | `health`, `healthReason`, `rateLimitResetTime`, `cooldownUntil` | 写入 health 及附加信息（D-2） |
| **ToolPipeline** | 读取 | `getActiveTools()`, foreground identity, watchdog 状态 | 写入工具相关字段 |
| **ToolWatchdog** | 读取 | `watchdog_phase`, `watchdog_block_reason` | 写入 watchdog 状态 |
| **Monitor Orchestrator** | 调用 | `write()` | tick 末尾调用 |
| **Guardian** | 调用 | `write()` | offline/stopped 路径也写状态 |
| **SignalStore** | 消费方 | `agent-status.json` | 下次 tick 读取（冷启动恢复 health） |
| **MessageRouter** | 消费方 | `agent-status.json` | 查询状态做路由决策 |
| **外部（Operator）** | 消费方 | `agent-status.json` | 监控面板展示 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| IDLE_THRESHOLD | 3s | inactiveSeconds < 3s → busy |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `activity-monitor.js:666-678` | `writeStatusFile()` |
| `activity-monitor.js:660-664` | `atomicWriteJson()` |
| `activity-monitor.js:2044-2071` | running 路径的状态聚合 + 写入 |
| `activity-monitor.js:1821-1829` | offline 路径的状态写入 |
| `activity-monitor.js:1876-1884` | stopped 路径的状态写入 |
| `activity-monitor.js:1954-1965` | 活动时间来源计算 |
| `activity-monitor.js:2028-2042` | ActivityState 判断 + idle 时间 |

### 实施步骤

1. 创建 `scripts/status-writer.js`
2. 提取 `writeStatusFile()` + `atomicWriteJson()`
3. 提取活动时间来源计算逻辑（conversation file → tmux → default → api hook）
4. 提取 ActivityState 投射逻辑（纯函数）
5. 提取状态聚合逻辑（tool 字段、watchdog 字段、foreground 字段）
6. running / offline / stopped 三条路径统一到 `write()` 方法
