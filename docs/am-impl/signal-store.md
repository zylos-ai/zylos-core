# SignalStore

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：tick 开头统一读取所有 signal files，生成当次 tick 的 immutable snapshot，供后续组件消费。

**输入**：signal files（`agent-status.json`、`proc-state.json`、`api-activity.json` 等）

**输出**：readonly snapshot（当次 tick 内所有组件共享同一份快照）

**相关决策**：
- **D-22**：分为快照层（readJSON）和流式层（有状态增量读取 tool-events.jsonl，维护 offset / inode / 轮转 drain）。两层输出合并为 immutable signals snapshot。
- **D-23**：组件间通信通过 SignalStore 只读快照（eventual consistency）和显式接口调用。如 HealthEngine 不直接查 C4 DB。

## 2. 组件设计

### 接口定义

```javascript
class SignalStore {
  refresh(): Snapshot    // tick 开头调用，读取所有 signal files，返回 immutable snapshot
}
```

```javascript
interface Snapshot {
  // 快照层（readJSON）
  agentStatus: AgentStatus | null
  procState: ProcState | null
  statusline: StatuslineData | null
  foregroundSession: ForegroundSession | null
  userMessageSignal: { timestamp: number } | null
  healthCheckState: { last_check_at: number, last_check_human: string } | null

  // 流式层（有状态增量读取，D-22）
  toolEvents: ToolEvent[]             // 本次 tick 新增的工具事件
  toolEventStreamState: StreamState   // cursor 状态（inode + offset）

  // 元数据
  timestamp: number                   // tick 时间戳
}
```

### Signal File Schema

#### agent-status.json（读 + 写，由 StatusWriter 写入）

```javascript
{
  state: 'idle' | 'busy' | 'offline' | 'stopped',
  health: 'ok' | 'recovering' | 'down' | 'rate_limited' | 'auth_failed',
  thinking: boolean,
  last_activity: number,           // epoch seconds
  last_api_activity: number,       // epoch seconds (optional)
  active_tools: number,
  last_check: number,              // epoch seconds
  last_check_human: string,        // ISO datetime
  idle_seconds: number,
  inactive_seconds: number,
  source: 'conv_file' | 'tmux_activity' | 'default' | 'api_hook',
  runtime_launch_at: number,       // ms timestamp

  // Tool watchdog
  active_tool_name: string | null,
  active_tool_running_seconds: number,
  active_tool_summary: object | null,
  active_tool_rule_id: string | null,
  active_tool_session_id: string | null,
  watchdog_episode_key: string | null,
  watchdog_phase: string,
  watchdog_last_action_at: number | null,
  watchdog_block_reason: string | null,

  // Foreground identity
  foreground_session_source: string | null,
  foreground_session_observed_at: number,

  // Offline/stopped only
  not_running_seconds?: number,
  since?: number,
  message?: string,

  // Rate limited only
  rate_limit_reset?: string | null,
  cooldown_until?: number | null,
}
```

#### proc-state.json（由 ProcSampler 写入）

```javascript
{
  pid: number | null,
  alive: boolean | null,
  frozen: boolean,
  frozenCount: number,
  lastDelta: number | null,
  lastSampleAt: number,      // epoch seconds
  platform: 'linux' | 'darwin'
}
```

#### tool-events.jsonl（由 hook-activity 写入，流式读取）

```javascript
{
  ts: number,                // Date.now() ms
  pid: number,
  session_id: string,
  event: 'prompt' | 'pre_tool' | 'post_tool' | 'post_tool_failure' | 'stop' | 'idle',
  tool: string,              // optional, tool events only
  summary: object,           // optional
  event_id: string,
  rule_id: string,           // optional, pre_tool only
}
```

#### statusline.json（由 context-monitor hook 写入）

```javascript
{
  session_id: string,
  context_window: { used_percentage: number },
  cost: { total_cost_usd: number },
  rate_limits: object,
  usage: object,
}
```

#### foreground-session.json（由 session-foreground hook 写入）

```javascript
{
  version: 1,
  session_id: string,
  claude_pid: number,
  source: 'session_start',
  session_start_source: 'startup' | 'resume' | 'clear' | 'compact' | null,
  observed_at: number,       // Date.now() ms
}
```

#### user-message-signal.json（由 c4-receive 写入）

```javascript
{
  timestamp: number,         // epoch seconds
  channel: string,
  endpoint: string,
}
```

### 流式层状态（tool-event-stream-state.json）

```javascript
{
  version: 1,
  path: string,
  inode: number,
  offset: number,            // byte position
  last_processed_at: number, // ms
  last_rotation_at: number,  // ms
  rotated_drain: {
    path: string,
    inode: number,
    offset: number,
    last_size: number,
    quiet_since: number,     // ms
  } | null,
}
```

### 与其他组件的交互

- **Monitor Orchestrator** → tick 开头调用 `refresh()`，将返回的 snapshot 传给所有后续组件
- **所有 tick 组件** → 消费 snapshot（只读）

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

逻辑散落在 `activity-monitor.js` 的 tick 循环开头，各处 `readJSON()` 调用。

### 实施步骤

1. 创建 `scripts/signal-store.js`，将 tick 循环开头的所有 `readJSON()` 调用收拢到 `refresh()` 方法
2. 快照层：纯 `readJSON()`，文件不存在或读取失败返回 null
3. 流式层：复用现有 `tool-event-stream.js` 模块，维护 offset + inode 状态实现增量读取
4. Snapshot 在 tick 内 immutable，所有组件共享同一份引用，不应修改
5. 文件轮转：tool-events.jsonl 超过 1MB 时轮转，旧文件 drain 完毕后删除（quiet window 2s）
