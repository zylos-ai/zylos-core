# StatusWriter

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：tick 末尾汇总当前 ActivityState、HealthState 及各组件状态，写入对外状态文件。

**输入**：snapshot、HealthEngine 当前状态

**输出**：`agent-status.json`（Operator 和 c4-receive fallback 消费）

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。StatusWriter 同时写入两层状态。
- **D-2**：HealthState 诊断信息通过 `agent-status.json` 的 `unavailable_reason` 字段暴露。
- **D-10**：Health 状态持久化到 agent-status.json，AM 冷启动时恢复。

### 当前实现状态

`scripts/status-writer.js` 已提取为薄函数模块，当前职责是：
- 读取初始 `agent-status.json` health，失败时 fail-open 为 `ok`
- 原子写入 `agent-status.json`
- 将 HealthEngine 内部状态投射为 public health（例如 `recovering` / `down` → `unavailable`）
- 追加 `unavailable_reason`、`unavailable_since`、rate limit 字段

ActivityState projection 尚未迁入 StatusWriter。当前 activity source 选择、busy/idle 判断、API hook merge、tool/watchdog/foreground 字段聚合仍在 `MonitorOrchestrator` 和 `activity-monitor.js` 的 payload builder 中完成。后续若补 `SignalStore` / projection 边界，应先明确 StatusWriter 是否只负责文件输出，还是同时拥有 public status projection。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **状态投射** | ActivityState 计算 | 设计目标；当前仍在 MonitorOrchestrator / payload builder |
| | 活动时间来源 | 优先级：conversation file mtime → tmux activity → default → api hook |
| | idle 时间计算 | busy → idle 转换时记录 idleSince，计算 idleSeconds |
| **状态聚合** | HealthState | 当前已实现：从 HealthEngine 读取 `health` 字段并规范化 public health |
| | Public health 投射 | 写入前将内部 legacy 状态（如 `recovering` / `down`）规范化为对外 `unavailable` |
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
  │   │     └─ health 附加字段（from HealthEngine，先投射到 public health 后按状态分支写入）：
  │   │        ok:           unavailable_since=null, unavailable_reason=null,
  │   │                      rate_limit_reset=null, cooldown_until=null
  │   │        unavailable:  unavailable_since + unavailable_reason
  │   │        rate_limited: unavailable_since + unavailable_reason + rate_limit_reset + cooldown_until
  │   │        auth_failed:  unavailable_since + unavailable_reason
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

当前实现接口为函数模块：

```javascript
readInitialStatus({ statusFile }): object
publicHealth(health: string): string
buildStatusPayload({ statusObj, healthEngine }): object
writeStatus({ statusFile, statusObj, healthEngine }): boolean
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

StatusWriter helper 是该文件的写入路径。当前未独立落地 SignalStore；其他组件通过注入 reader、ToolPipeline snapshot 或 fallback file read 获取所需状态。

> 实现边界：HealthEngine 内部可在迁移期继续保留 `recovering` / `down` 等 legacy 状态用于退避和 probe 调度；StatusWriter 写 `agent-status.json` 时必须将这些内部状态统一投射为 public `unavailable`，并通过 `unavailable_reason` 暴露诊断原因。

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **HealthEngine** | 读取 | `health`, `healthReason`, `unavailableSince`, `rateLimitResetTime`, `cooldownUntil` | 写入 health 及附加信息（D-2/D-3） |
| **ToolPipeline** | 间接输入 | api activity snapshot / foreground identity | 由 Orchestrator/payload builder 聚合后传入 statusObj |
| **ToolWatchdog** | 间接输入 | `watchdog_phase`, `watchdog_block_reason` | 由 Orchestrator/payload builder 聚合后传入 statusObj |
| **Monitor Orchestrator** | 调用 | injected `writeStatusFile()` | tick 末尾调用 |
| **Guardian** | 间接输入 | offline/stopped result | Orchestrator 构造 not-running status 后写入 |
| **SignalStore** | 未独立实现 | `agent-status.json` | 设计目标；当前由注入 reader / ToolPipeline / fallback file read 分散消费 |
| **c4-receive fallback** | 消费方 | `agent-status.json` | MessageRouter IPC 不可用时做静态 fail-open / unhealthy 判断 |
| **外部（Operator）** | 消费方 | `agent-status.json` | 监控面板展示 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| IDLE_THRESHOLD | 3s | inactiveSeconds < 3s → busy |

## 3. 实施方案

**改动类型**：提取 + Health schema 对齐（D-2/D-3 字段生命周期）

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

1. 已创建 `scripts/status-writer.js`
2. 已提取 atomic JSON 写入、初始 health 读取、public health normalization
3. 未提取活动时间来源计算逻辑（当前在 Orchestrator）
4. 未提取 ActivityState 投射逻辑（当前在 Orchestrator / payload builder）
5. 未提取完整状态聚合逻辑（tool/watchdog/foreground 字段仍由 caller 构造）
6. running / offline / stopped 三条路径仍由 Orchestrator 分支构造 payload 后调用写入函数
