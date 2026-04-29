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

### 功能清单

SignalStore 管理两层数据读取：

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **快照层** | 读取 agent-status.json | StatusWriter 上一 tick 写入的状态（冷启动恢复 health） |
| | 读取 proc-state.json | ProcSampler 写入的进程冻结检测结果 |
| | 读取 statusline.json | context-monitor hook 写入的上下文使用率 |
| | 读取 foreground-session.json | session-start hook 写入的前台会话身份 |
| | 读取 user-message-signal.json | c4-receive 写入的用户消息信号（用于清除 auth 抑制、加速恢复） |
| | 读取 health-check-state.json | 上次健康检查时间 |
| **流式层** | 增量读取 tool-events.jsonl | 维护 inode + offset 游标，只读取新增事件 |
| | 文件轮转处理 | 超过 1MB 时 rename → .old，新建空文件，drain 旧文件 |
| | 轮转后 drain | 旧文件读完 + 2s 静默后删除 |
| | inode 变更检测 | 文件被替换（inode 变化）时从头读取 |
| **生命周期** | refresh() | tick 开头调用，读取所有数据，返回 immutable Snapshot |
| | 状态持久化 | tool-event-stream-state.json 保存游标，AM 冷启动恢复 |

### 数据流图

```
                     Signal Files (磁盘)
                     ┌──────────────────────┐
 Hook 脚本写入 ────▶ │ tool-events.jsonl     │──┐
                     │ statusline.json       │  │
                     │ foreground-session.json│  │
                     └──────────────────────┘  │
                                               │  refresh()
 ProcSampler 写入 ──▶ proc-state.json ────────┤  (tick 开头)
                                               │
 StatusWriter 写入 ──▶ agent-status.json ──────┤
                                               │
 c4-receive 写入 ───▶ user-message-signal.json ┤
                                               ▼
                     ┌──────────────────────────┐
                     │  Snapshot (immutable)     │
                     │  ┌────────────────────┐  │
                     │  │ 快照层：6 个 JSON   │  │
                     │  │ 流式层：ToolEvent[] │  │
                     │  │ 元数据：timestamp   │  │
                     │  └────────────────────┘  │
                     └───────────┬──────────────┘
                                 │ 共享只读引用
                     ┌───────────┼───────────┐
                     ▼           ▼           ▼
                  Guardian   ToolPipeline  StatusWriter
                  ProcSampler ToolWatchdog TaskScheduler
```

### 接口定义

```javascript
class SignalStore {
  constructor(signalPaths: SignalPaths)
  refresh(): Snapshot    // tick 开头调用，读取所有 signal files，返回 immutable snapshot
}
```

```javascript
interface SignalPaths {
  agentStatus: string       // ~/zylos/activity-monitor/agent-status.json
  procState: string         // ~/zylos/activity-monitor/proc-state.json
  statusline: string        // ~/zylos/activity-monitor/statusline.json
  foregroundSession: string // ~/zylos/activity-monitor/foreground-session.json
  userMessageSignal: string // ~/zylos/activity-monitor/user-message-signal.json
  healthCheckState: string  // ~/zylos/activity-monitor/health-check-state.json
  toolEvents: string        // ~/zylos/activity-monitor/tool-events.jsonl
  toolEventStreamState: string // ~/zylos/activity-monitor/tool-event-stream-state.json
}
```

```javascript
interface Snapshot {
  // 快照层（readJSON，文件不存在或读取失败返回 null）
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
  health: 'ok' | 'unavailable' | 'rate_limited' | 'auth_failed',  // D-2/D-3
  unavailable_since: number | null,  // D-3: epoch seconds, 消费端基于此判断严重程度
  unavailable_reason: string | null, // D-2: 诊断信息，所有非 OK 状态共用
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

#### foreground-session.json（由 session-start hook 写入）

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

### 流式层增量读取算法

```
refresh() 流式层部分：

1. 旧文件 drain（如果 rotated_drain 存在）：
   ├─ 旧文件不存在 → 清除 drain 状态
   ├─ 读取新增内容（从 drain.offset 开始）
   ├─ 文件大小未增长 + 静默超过 2s → unlink 旧文件，清除 drain
   └─ 否则 → 更新 drain offset/quiet_since

2. 当前文件读取：
   ├─ 文件不存在 → 重置 inode/offset
   ├─ inode 变化或文件缩小 → 从头读取（文件被替换）
   └─ 正常 → 从 offset 开始增量读取

3. JSONL 解析：
   ├─ 按 \n 分割
   ├─ 最后一行不完整 → 存为 tail，下次 tick 拼接
   ├─ 每行 JSON.parse，失败跳过（容错）
   └─ 每个事件加 _arrival_seq（排序用）
```

### 与其他组件的交互

| 消费方 | 读取的 Snapshot 字段 | 用途 |
|-------|---------------------|------|
| **Guardian** | `userMessageSignal` | 清除 auth 抑制 |
| **ProcSampler** | （不读 snapshot，独立采样） | — |
| **ToolPipeline** | `toolEvents`, `foregroundSession`, `statusline` | 事件处理 + 前台身份 |
| **ToolWatchdog** | 通过 ToolPipeline 的 apiActivity | 候选工具超时检测 |
| **TaskScheduler** | snapshot 整体（gate 条件） | idle 判断等 |
| **StatusWriter** | snapshot 整体 | 汇总写入 agent-status.json |
| **Monitor Orchestrator** | `agentStatus`（冷启动恢复 health） | 初始化 HealthEngine |

### 写入方

| 写入方 | 写入的文件 | 时机 |
|-------|-----------|------|
| **hook-activity** | tool-events.jsonl | runtime 工具事件触发 |
| **context-monitor** | statusline.json | Claude 每 turn 后 |
| **session-start-prompt** | foreground-session.json | SessionStart hook |
| **ProcSampler** | proc-state.json | 每 10s 采样 |
| **StatusWriter** | agent-status.json | 每 tick 末尾 |
| **c4-receive** | user-message-signal.json | 用户消息到达 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `activity-monitor.js` tick 循环开头 | 各处 `readJsonFileSafe()` 调用 |
| `tool-event-stream.js`（241行） | 流式层完整实现：`readToolEventsIncrementalFromStream()` + `rotateToolEventStream()` |
| `activity-monitor.js` 全局变量 | `toolEventStreamState`、`activeTail`、`rotatedTail`、`arrivalSeq` |

### 实施步骤

1. 创建 `scripts/signal-store.js`
2. 将 tick 循环开头的所有 `readJsonFileSafe()` 调用收拢到 `refresh()` 方法
3. 将 `tool-event-stream.js` 作为内部实现（流式层直接复用，不修改）
4. 将全局的流式层状态变量（`toolEventStreamState` 等）移入 SignalStore 实例
5. Snapshot 在 tick 内 immutable，所有组件共享同一份引用
6. 流式层游标持久化到 `tool-event-stream-state.json`，AM 冷启动时恢复
