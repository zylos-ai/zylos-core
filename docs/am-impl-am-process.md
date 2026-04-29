# AM Process 实施方案

> 对应顶层设计：§3.1 AM Process 容器
> 分支：docs/activity-monitor-design
> 状态：Draft

---

## 1. 概述

本文档定义 AM Process 容器内所有组件的接口、数据结构和行为规则，作为从现有单文件（activity-monitor.js, 2324 行）重构为独立模块的实施依据。

**现有结构**：大部分逻辑集中在 `activity-monitor.js`，仅 HeartbeatEngine、ProcSampler、DailySchedule、tool-watchdog、tool-lifecycle、tool-event-stream、tool-rules 已拆为独立模块。

**目标结构**（对齐顶层设计 §4.1）：

```
activity-monitor/scripts/
├── monitor.js                # Monitor Orchestrator：入口 + 主循环编排
├── guardian.js                # Guardian：进程存活守护
├── health-engine.js           # HealthEngine：健康状态机
├── signal-store.js            # SignalStore：信号聚合读取
├── status-writer.js           # StatusWriter：agent-status.json 写入
├── task-scheduler.js          # TaskScheduler：统一定时任务调度
├── proc-sampler.js            # ProcSampler：进程冻结检测（已独立）
├── tool-pipeline.js           # ToolPipeline：工具事件流处理
├── tool-watchdog.js           # ToolWatchdog：工具超时干预（已独立）
├── hook-activity.js           # Hook：工具事件采集（已独立）
├── hook-auth-prompt.js        # Hook：权限请求处理（已独立）
├── context-monitor.js         # Hook：上下文监控（已独立）
├── session-start-prompt.js    # Hook：会话启动注入（已独立）
├── tasks/                     # 注册式定时任务
│   ├── daily-upgrade.js
│   ├── daily-memory-commit.js
│   ├── upgrade-check.js
│   ├── health-check.js
│   ├── usage-monitor.js
│   └── context-check.js
└── adapters/                  # 运行时适配器
    ├── claude.js
    └── codex.js
```

**改动原则**：

- 接口签名和数据结构以现有代码为基线，只在顶层设计要求变更的地方做改动
- 每个组件标注「行为变更」或「纯提取」
- 行为变更的部分引用顶层设计 D-x 编号

---

## 2. Runtime Adapter

**类型**：纯提取（现有逻辑已在 `cli/lib/runtime/` 中）

Adapter 封装 Claude / Codex 的 runtime 差异，其他组件通过统一接口调用，不做 runtime 分支判断（D-5、D-38）。

### 接口定义

```javascript
interface RuntimeAdapter {
  // 标识
  readonly runtimeId: 'claude' | 'codex'
  readonly sessionName: string          // tmux session name, e.g. 'claude-main'
  readonly displayName: string

  // 进程管理
  launch(): Promise<void>
  stop(): void                          // kill tmux session
  isRunning(): Promise<boolean>

  // 健康检查
  checkAuth(): Promise<{ ok: boolean, reason?: string, output?: string }>
  getHeartbeatDeps(): HeartbeatDeps

  // 运行时差异
  getContextMonitor(): ContextMonitor | null   // Codex: polling-based; Claude: null (用 statusLine hook)
  sendMessage(message: string): void           // 写入 tmux pane
}
```

```javascript
interface HeartbeatDeps {
  enqueueHeartbeat(phase: string): boolean
  getHeartbeatStatus(controlId: number): string
  readHeartbeatPending(): { control_id: number, created_at: string, phase: string } | null
  clearHeartbeatPending(): void
  detectRateLimit(): { detected: boolean, cooldownUntil?: number, resetTime?: string }
  detectApiError(): { detected: boolean, pattern?: string }
}
```

### 现有代码位置

`cli/lib/runtime/index.js` → `getActiveAdapter()` 返回 claude 或 codex adapter 实例。

### 实施要点

- 现有 adapter 接口已满足顶层设计需求，不需要新增方法
- 目录结构变更：在 `scripts/adapters/` 下创建 `claude.js` 和 `codex.js`，封装 `cli/lib/runtime/` 中的差异逻辑
- 主文件中散落的 `adapter.xxx` 调用保持不变，只是 adapter 实例的创建位置从 `init()` 移到 Monitor Orchestrator

---

## 3. SignalStore

**类型**：纯提取（逻辑散落在 `activity-monitor.js` 的 tick 循环开头）

每次 tick 开头统一读取所有 signal files，生成 immutable snapshot（D-22、D-23）。

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

### 实施要点

- 快照层：纯 `readJSON()`，文件不存在或读取失败返回 null
- 流式层：复用现有 `tool-event-stream.js` 模块，维护 offset + inode 状态实现增量读取
- Snapshot 在 tick 内 immutable，所有组件共享同一份引用，不应修改
- 文件轮转：tool-events.jsonl 超过 1MB 时轮转，旧文件 drain 完毕后删除（quiet window 2s）

---

## 4. Monitor Orchestrator

**类型**：纯提取（从 `activity-monitor.js` 的 `init()` + `monitorLoop()` 提取）

主循环入口，负责初始化所有组件、驱动 tick 循环、启动 IPC 监听（D-4）。

### 接口定义

```javascript
class MonitorOrchestrator {
  async init(): void           // 初始化：加载 adapter、创建组件实例、恢复持久化状态、启动 IPC 监听
  async tick(): void           // 单次 tick，按固定顺序调用各组件
  start(): void                // 启动主循环（setInterval 1s）
}
```

### Tick 编排顺序（D-4）

```
tick every 1s:
  1. SignalStore.refresh()           → snapshot
  2. Guardian.tick(snapshot)         → 可能触发 adapter.launch()
  3. ProcSampler.tick(snapshot)      → 更新 proc-state.json
  4. ToolPipeline.tick(snapshot)     → 更新 api-activity、tool lifecycle state
  5. ToolWatchdog.tick(snapshot)     → 可能发送中断或触发 recovery
  6. TaskScheduler.tick(snapshot)    → 执行到期的定时任务
  7. StatusWriter.write(snapshot)    → 写 agent-status.json
```

### 组件注册

```javascript
// init() 中创建并注册
this.adapter = getActiveAdapter()
this.signalStore = new SignalStore(signalPaths)
this.healthEngine = new HealthEngine(deps)
this.guardian = new Guardian(adapter, healthEngine, config)
this.procSampler = new ProcSampler(adapter.sessionName)
this.toolPipeline = new ToolPipeline(adapter, signalStore)
this.toolWatchdog = new ToolWatchdog(deps)
this.taskScheduler = new TaskScheduler(tasks)
this.statusWriter = new StatusWriter(healthEngine, signalStore)
```

### IPC 监听

Monitor Orchestrator 负责启动 IPC server（Unix socket），供 MessageRouter 接入查询 HealthEngine 状态。IPC 协议定义见 MessageRouter 实施方案。

### 状态恢复（AM 冷启动）

PM2 重启 AM 时的状态恢复策略（D-21）：

**从磁盘恢复**：
- health 状态 → 从 agent-status.json 读取（D-10）
- tool event stream cursor → 从 tool-event-stream-state.json
- tool lifecycle state → 从 session-tool-state.json
- watchdog state → 从 tool-watchdog-state.json
- runtimeLaunchAtMs → 从 agent-status.json 的 runtime_launch_at
- 各 daily task 状态 → 各自的 state 文件
- usage check 状态 → usage.json / usage-codex.json

**重置为零**（D-21）：
- notRunningCount = 0
- consecutiveRestarts = 0
- startupGrace = 0
- idleSince = 0
- lastPeriodicProbeAt = 0
- apiErrorConsecutiveHits = 0
- authRetrySuppressedUntil = 0

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| TICK_INTERVAL | 1000ms | 主循环间隔 |

---

## 5. Guardian

**类型**：纯提取（从 `activity-monitor.js` 的 offline/stopped 分支提取）

守护 runtime 进程存活：检测进程退出后无条件拉起，拉起失败时按退避策略递增延迟重试（D-20、D-21）。

### 接口定义

```javascript
class Guardian {
  tick(snapshot: Snapshot): void   // 每次 tick 调用，检测是否需要拉起
}
```

### 行为规则

1. **无条件拉起**（D-20）：进程不存在（offline/stopped）→ 尝试拉起，不读 HealthState
2. **退避策略**：`restartDelay = min(BASE_RESTART_DELAY × 2^consecutiveRestarts, MAX_RESTART_DELAY)`
   - 序列：5s, 10s, 20s, 40s, 60s, 60s, ...
3. **退避重置**：agent 连续运行超过 BACKOFF_RESET_THRESHOLD 后重置 consecutiveRestarts
4. **启动保护**（D-33）：拉起成功后设置 startupGrace = 30 ticks，期间跳过 offline 检测
5. **维护等待**：拉起前检查是否有正在进行的 `restart-claude`、`upgrade-claude`、`claude.ai/install.sh` 进程，等待最多 300s
6. **Auth 抑制**：auth 失败后抑制 180s 不重试，user message signal 可清除抑制

### 内部状态

```javascript
{
  notRunningCount: number,         // 进程未运行的 tick 计数
  consecutiveRestarts: number,     // 连续重启次数（退避指数）
  stableRunningSince: number,      // 连续运行起始时间（epoch seconds）
  startupGrace: number,            // 启动保护倒计时（ticks）
  startAgentInProgress: boolean,   // 防止并发拉起
  authRetrySuppressedUntil: number,// auth 失败抑制截止时间
}
```

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| BASE_RESTART_DELAY | 5s | 初始重启延迟 |
| MAX_RESTART_DELAY | 60s | 最大重启延迟 |
| BACKOFF_RESET_THRESHOLD | 60s | 连续运行多久后重置退避 |
| STARTUP_GRACE_TICKS | 30 | 启动保护 tick 数 |
| MAINTENANCE_WAIT_TIMEOUT | 300s | 维护等待超时 |
| AUTH_RETRY_SUPPRESSION | 180s | Auth 失败抑制时间 |

### 与其他组件的交互

- 调用 `adapter.launch()` 拉起 runtime
- 调用 `adapter.isRunning()` / `tmuxHasSession()` 检测进程存活
- 读取 `user-message-signal.json` 清除 auth 抑制
- **不读取** HealthEngine 状态（D-1、D-20）

---

## 6. HealthEngine

**类型**：行为变更（D-4：从 tick 移出改为事件驱动）

维护 HealthState FSM，不参与主循环 tick，由外部事件异步触发。

### 接口定义

```javascript
class HealthEngine {
  get health(): string                                   // 当前 HealthState
  get canRestart(): boolean                              // true unless rate_limited

  setHealth(next: string, reason?: string): void         // 状态转移
  enterRateLimited(cooldownUntil: number, resetTime?: string): void

  // 事件触发接口
  onUserMessageDelivered(): void                         // c4-dispatcher 投递成功后异步调用（行为变更）
  notifyUserMessage(currentTime: number): boolean        // 加速 recovery（现有行为保留）

  // Recovery probe 方法（供 MessageRouter 调用）
  async runRecoveryProbe(): ProbeResult                  // 按当前 HealthState 分支执行 probe

  // 进程生命周期事件
  onProcessRestarted(): void                             // Guardian 拉起 runtime 后调用
}
```

```javascript
interface ProbeResult {
  recovered: boolean,
  health: string,             // probe 后的 HealthState
  reason?: string,            // 不健康原因
  userMessage?: string,       // 面向用户的文案
}
```

### HealthState FSM（顶层设计 §3.5）

```
状态：OK, Unavailable, RateLimited, AuthFailed
全连通：OK ↔ Unavailable ↔ RateLimited ↔ AuthFailed
```

| 状态 | 从 OK 转入依据 |
|------|--------------|
| Unavailable | heartbeat 失败（triggerRecovery）；ToolWatchdog 升级 |
| RateLimited | 连续两次 check tmux pane 识别到 rate limit 字符模式 |
| AuthFailed | check tmux pane 识别到 auth failed 字符模式 + check auth 确认 |

### Recovery Probe 方法（顶层设计 §3.2）

| 当前状态 | Probe 方法 | 结果分支 |
|---------|-----------|---------|
| RateLimited | heartbeat probe | ack → OK；无 ack → check tmux pane → rate_limit/auth_failed/Unavailable |
| Unavailable | heartbeat probe | ack → OK；无 ack → check tmux pane → rate_limited/auth_failed/保持 Unavailable |
| AuthFailed | check auth | 通过 → OK；未通过 → 保持 AuthFailed |

### OK → 非 OK 检测时机（行为变更，顶层设计 §3.5）

**现有行为**：主循环 tick 中定时扫描 tmux pane（15s 间隔）+ heartbeat 定时探测。

**目标行为**：改为 user message 事件驱动：
1. c4-dispatcher 投递 user message 后异步调用 `healthEngine.onUserMessageDelivered()`
2. 等待约 5s（给 runtime 处理时间）
3. 执行 check tmux pane，按字符模式匹配：
   - 连续两次 rate limit → RateLimited
   - auth failed + check auth 确认 → AuthFailed
   - 连续两次 corrupted image 等 sticky error → 执行 new session / restart
   - 无异常 → 保持 OK

### 内部状态

```javascript
{
  healthState: string,
  recoveringStartedAt: number,         // epoch seconds, 0 when not recovering
  restartFailureCount: number,         // 连续失败次数（退避指数）
  cooldownUntil: number,               // rate limit 冷却截止时间
  rateLimitResetTime: string,          // rate limit 重置时间文案
  apiErrorConsecutiveHits: number,     // 连续 API error 检测计数（需 2 次）
  lastUserMessageRecoveryAt: number,   // 上次 user message recovery 时间
}
```

### 状态持久化（D-10）

health 状态写入 agent-status.json 的 `health` 字段，AM 冷启动时恢复。未知时默认 OK。

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| DOWN_DEGRADE_THRESHOLD | 3600s | recovering 超过 1h 降级为 down |
| DOWN_RETRY_INTERVAL | 3600s | down 状态下的定期 probe 间隔 |
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s | rate limit 默认冷却时间 |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | user message recovery 冷却 |
| CHECK_DELAY | 5s | user message 投递后等待时间 |

---

## 7. ProcSampler

**类型**：纯提取（已独立模块，无变更）

通过 OS 级指标检测 runtime 进程是否冻结。

### 接口定义

```javascript
class ProcSampler {
  constructor(sessionName: string, options?: { sampleInterval: number, frozenThreshold: number })
  setSessionName(name: string): void
  reset(): void
  tick(currentTime: number, opts?: { isActive: boolean }): void
  isFrozen(): boolean
  isAlive(): boolean | null
  getState(): ProcState
}
```

### 冻结检测算法

1. 每 10s 采样一次 context switch 计数（`/proc/<pid>/status`）
2. delta = 当前 - 上次
3. delta > 0 → 存活，重置 frozenCount
4. delta == 0 且 isActive（有活跃工具）→ frozenCount += sampleInterval
5. delta == 0 且非 active → 正常（idle 不算冻结）
6. frozenCount >= 60s → 冻结

### 冻结处理（D-25）

ProcSampler 检测到冻结后，由调用方（Monitor Orchestrator tick 循环）执行 `adapter.stop()` kill 会话。下一 tick Guardian 自然检测到 offline 并拉起。frozen 不写入 agent-status.json 或日志。

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| SAMPLE_INTERVAL | 10s | 采样间隔 |
| FROZEN_THRESHOLD | 60s | 冻结判定阈值 |

---

## 8. ToolPipeline

**类型**：纯提取（逻辑散落在 `activity-monitor.js` 的 running 分支中）

从工具事件流中合成 API 活动摘要，维护工具生命周期状态。

### 接口定义

```javascript
class ToolPipeline {
  tick(snapshot: Snapshot): void   // 处理新事件，更新 lifecycle state，写 api-activity.json
  getApiActivity(): ApiActivity    // 当前 API 活动摘要
  getActiveTools(): number         // 当前活跃工具数
  getForegroundIdentity(): ForegroundIdentity  // 当前可信前台身份
}
```

### Tick 内部流程

1. 从 snapshot 获取新 tool events
2. 排序（ts + arrival_seq），flush reorder buffer（2s 窗口）
3. 调用 `applyOrderedToolEvents()` 更新 lifecycle state
4. `resolveTrustedForegroundIdentity()` 合成可信前台身份
5. `buildApiActivity()` 生成活动摘要
6. `pruneToolLifecycleState()` 清理过期 session（TTL 1h）
7. 检查是否需要轮转 tool-events.jsonl（> 1MB）

### api-activity.json Schema

```javascript
{
  version: 3,
  pid: number,
  sessionId: string | null,
  scope: 'foreground' | null,
  foreground_identity: {
    session_id: string | null,
    source: string | null,
    trusted: boolean,
    observed_at: number,
  },
  event: string | null,
  tool: string | null,
  active: boolean,
  active_tools: number,
  in_prompt: boolean,
  updated_at: number,                    // ms
  oldest_active_tool: ToolSnapshot | null,
  watchdog_candidate_tool: ToolSnapshot | null,
  last_completed_tool: object | null,
}
```

### Foreground Identity 信任规则

两个来源：
1. **SessionStart hook**（foreground-session.json）：早期信号
2. **statusLine hook**（statusline.json）：每 turn 更新

信任条件：
- `observedAt >= runtimeLaunchAtMs - 5000ms`（launch guard）
- PID 存活且匹配 tmux PID

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| REORDER_WINDOW_MS | 2000ms | 事件排序缓冲窗口 |
| TOOL_SESSION_TTL_MS | 3600000ms | 非活跃 session 过期时间 |
| TOOL_EVENT_ROTATION_BYTES | 1048576 | 事件文件轮转阈值（1MB）|
| TOOL_EVENT_ROTATION_DRAIN_MS | 2000ms | 旧文件 drain 静默窗口 |
| STATUSLINE_LAUNCH_GUARD_MS | 5000ms | 启动后信任保护期 |

---

## 9. ToolWatchdog

**类型**：纯提取（已独立模块，无变更，仅移除 launchGracePeriod，D-33）

检测工具调用超时，执行干预。

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

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| web_tool_watchdog_enabled | true | 是否启用 WebFetch/WebSearch watchdog |
| web_tool_timeout_sec | 3600 | 超时阈值 |
| web_tool_interrupt_grace_sec | 15 | 中断后等待时间 |
| web_tool_timeout_cooldown_sec | 60 | 重试冷却 |

---

## 10. TaskScheduler

**类型**：纯提取（从 `activity-monitor.js` 的各 daily scheduler + usage check 提取）

统一管理定时任务。

### 接口定义

```javascript
class TaskScheduler {
  constructor(tasks: TaskDefinition[])
  tick(snapshot: Snapshot): void      // 检查所有任务，执行到期的
}
```

```javascript
interface TaskDefinition {
  id: string,
  type: 'daily' | 'interval',

  // daily 类型
  hour?: number,                     // 0-23，每日触发时刻

  // interval 类型
  intervalSec?: number,              // 秒，触发间隔
  gate?: (snapshot: Snapshot) => boolean,  // 可选前置条件

  execute: () => void | Promise<void>,
  stateFile?: string,                // 持久化状态文件路径
}
```

### 已注册任务

| 任务 ID | 类型 | 参数 | 说明 |
|---------|------|------|------|
| daily-upgrade | daily | hour=5 | 每日 5:00 自动升级 |
| daily-memory-commit | daily | hour=3 | 每日 3:00 内存提交 |
| upgrade-check | daily | hour=6 | 每日 6:00 检查更新 |
| health-check | interval | 86400s | PM2/disk/memory 健康检查 |
| usage-monitor | interval | 3600s | 用量监控（有 idle gate）|
| context-check | interval | — | 上下文占用检查（Codex 轮询）|

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| daily_upgrade_enabled | false | 是否启用每日自动升级 |
| usage_monitor_enabled | false | 是否启用用量监控 |
| usage_alert_enabled | false | 是否启用用量告警（D-26、D-27）|
| usage_check_interval | 3600 | 用量检查间隔 |
| usage_idle_gate | 30 | 检查前需要的空闲秒数 |

---

## 11. StatusWriter

**类型**：纯提取

tick 末尾汇总状态，写入 agent-status.json。

### 接口定义

```javascript
class StatusWriter {
  write(snapshot: Snapshot, healthEngine: HealthEngine, extra: StatusExtra): void
}
```

```javascript
interface StatusExtra {
  state: 'idle' | 'busy' | 'offline' | 'stopped',
  activeTools: number,
  idleSeconds: number,
  inactiveSeconds: number,
  source: string,
  toolPipeline?: ToolPipelineState,    // watchdog/foreground 相关字段
  notRunningSeconds?: number,
  since?: number,
  message?: string,
}
```

### ActivityState 投射规则（顶层设计 §3.5）

无状态投射，相同 snapshot 必须得到相同结果：

```
if (activeTools > 0)                    → busy
else if (inactiveSeconds < IDLE_THRESHOLD)  → busy
else                                        → idle
```

活动时间来源（优先级）：
1. Conversation file mtime（Claude only）
2. tmux window activity
3. 当前时间（default fallback）
4. API hook timestamp（如果 active=true 且更新）

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| IDLE_THRESHOLD | 3s | 空闲判定阈值 |

---

## 12. Hook 脚本

Hook 脚本已经是独立文件，不需要拆分。确认现有行为与顶层设计一致。

### hook-activity.js

**类型**：无变更

- 触发：UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop、Notification(idle_prompt)
- 输出：写入 tool-events.jsonl（schema 见 §3 SignalStore）
- 过滤：忽略 subagent 事件（`agent_id` 字段存在时跳过）

### hook-auth-prompt.js

**类型**：无变更

- 触发：PermissionRequest
- 行为：当 `auto_approve_permission != false` 时，通过 C4 control 发送 Enter 按键自动确认
- 配置：`auto_approve_permission`（默认 true）

### session-start-prompt.js

**类型**：无变更

- 触发：SessionStart
- 行为：通过 C4 control queue 注入启动提示（priority=2），触发 runtime 恢复工作

### context-monitor.js

**类型**：无变更

- 触发：statusLine（Claude Code 每 turn 后推送）
- 行为：
  - 写入 statusline.json（所有 turn）
  - context >= 56% 且 unsummarized > 30：触发 memory sync
  - context >= 70%：触发 new-session handoff
- 配置：`new_session_threshold`（默认 70）

---

## 13. 配置项汇总

### config.json 可配置项

| Key | 类型 | 默认值 | 所属组件 |
|-----|------|--------|---------|
| heartbeat_enabled | bool | false | HealthEngine |
| codex_heartbeat_enabled | bool | false | HealthEngine |
| auto_approve_permission | bool | true | hook-auth-prompt |
| new_session_threshold | int | 70 | context-monitor |
| daily_upgrade_enabled | bool | false | TaskScheduler |
| usage_monitor_enabled | bool | false | TaskScheduler |
| usage_alert_enabled | bool | false | TaskScheduler (D-26) |
| usage_check_interval | int | 3600 | TaskScheduler |
| usage_idle_gate | int | 30 | TaskScheduler |
| usage_warn_threshold | int | 80 | TaskScheduler |
| usage_high_threshold | int | 90 | TaskScheduler |
| usage_critical_threshold | int | 95 | TaskScheduler |
| usage_notify_cooldown | int | 14400 | TaskScheduler |
| usage_active_hours_start | int | 8 | TaskScheduler |
| usage_active_hours_end | int | 23 | TaskScheduler |
| web_tool_watchdog_enabled | bool | true | ToolWatchdog |
| web_tool_timeout_sec | int | 3600 | ToolWatchdog |
| web_tool_interrupt_grace_sec | int | 15 | ToolWatchdog |
| web_tool_timeout_cooldown_sec | int | 60 | ToolWatchdog |

### 硬编码常量汇总

| 常量 | 值 | 所属组件 |
|------|------|---------|
| TICK_INTERVAL | 1000ms | Orchestrator |
| IDLE_THRESHOLD | 3s | StatusWriter |
| BASE_RESTART_DELAY | 5s | Guardian |
| MAX_RESTART_DELAY | 60s | Guardian |
| BACKOFF_RESET_THRESHOLD | 60s | Guardian |
| STARTUP_GRACE_TICKS | 30 | Guardian |
| DOWN_DEGRADE_THRESHOLD | 3600s | HealthEngine |
| DOWN_RETRY_INTERVAL | 3600s | HealthEngine |
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s | HealthEngine |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | HealthEngine |
| SAMPLE_INTERVAL | 10s | ProcSampler |
| FROZEN_THRESHOLD | 60s | ProcSampler |
| REORDER_WINDOW_MS | 2000ms | ToolPipeline |
| TOOL_SESSION_TTL_MS | 3600000ms | ToolPipeline |
| TOOL_EVENT_ROTATION_BYTES | 1048576 | ToolPipeline |
| HEALTH_CHECK_INTERVAL | 86400s | TaskScheduler |
| DAILY_UPGRADE_HOUR | 5 | TaskScheduler |
| DAILY_MEMORY_COMMIT_HOUR | 3 | TaskScheduler |
| DAILY_UPGRADE_CHECK_HOUR | 6 | TaskScheduler |
| LOG_MAX_LINES | 500 | Orchestrator |

---

## 14. 实施顺序

本容器内的组件实施顺序（按依赖关系）：

1. **RuntimeAdapter** — 基础设施，其他组件都依赖
2. **SignalStore** — 数据层，被所有 tick 组件消费
3. **Guardian** — 纯 runtime 生命周期，无外部依赖
4. **ProcSampler** — 已独立，确认接口对齐
5. **ToolPipeline** — 依赖 SignalStore
6. **ToolWatchdog** — 依赖 ToolPipeline，已独立，移除 launchGracePeriod
7. **HealthEngine** — 行为变更最大，依赖 Adapter
8. **TaskScheduler** — 依赖 config
9. **StatusWriter** — 依赖所有其他组件输出
10. **Monitor Orchestrator** — 组装层，最后实施
