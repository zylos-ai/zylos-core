# Monitor Orchestrator

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：主循环入口，每秒驱动一次 tick，按固定顺序调用各组件；负责启动 IPC 监听供 MessageRouter 接入。

**输入**：系统时钟（1s interval）、config

**输出**：按顺序调用各组件的 tick 方法

**相关决策**：
- **D-4**：AM 主循环每 tick 按固定顺序执行 7 步。HealthEngine 不参与主循环 tick。
- **D-21**：PM2 重启 AM 时，Guardian 退避状态重置为零。持久化状态从磁盘恢复。

### 当前实现状态

当前实现采用更保守的迁移形态：`activity-monitor.js` 仍是入口和副作用壳，`MonitorOrchestrator` 负责启动组装和 tick sequencing。状态文件写入、watchdog 持久化、C4 interrupt enqueue、HealthEngine recovery action 等副作用通过回调注入，避免在同一轮迁移中改变 ToolWatchdog restart/recovery 语义。

`MonitorOrchestrator` 当前不只是纯组装层。它还承担 ActivityState projection 相关逻辑，包括 activity source 选择、API activity summary/merge、running/stopped/offline 分支编排、ToolPipeline / ToolWatchdog / ProcSampler / TaskScheduler 顺序协调。这些逻辑后续可再提取为 `SignalStore + ActivityState projection` 边界；本轮不做大搬迁。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **初始化** | 加载 runtime adapter | `getActiveAdapter()` 读取 config.json |
| | 实例化所有组件 | Guardian / ProcSampler / ToolPipeline / TaskScheduler / HealthEngine / MessageRouter；SignalStore 未独立落地，StatusWriter 当前是函数模块 |
| | 恢复持久化状态 | health 从 agent-status.json；tool stream 从 state file；watchdog 从 state file |
| | 启动 IPC server | Unix socket，按 type 分发：route → MessageRouter，notify_delivered → HealthEngine |
| | 启动 context monitor | Codex: polling-based；Claude: null（hook 处理） |
| | 清理其他 runtime session | 启动 10s 后 kill 非当前 runtime 的 tmux session |
| **Tick 编排** | 当前固定顺序 | Guardian → ProcSampler → ToolPipeline → ToolWatchdog transition → TaskScheduler → StatusWriter callback |
| | 冻结处理 | ProcSampler.isFrozen() → adapter.stop()（在 ProcSampler.tick 和 ToolWatchdog.tick 之间） |
| | 错误处理 | tick 异常 catch + log，不中断主循环 |
| **主循环** | self-scheduling loop | `setTimeout(scheduleLoop, INTERVAL)` 而非 setInterval，防止异步 tick 重叠 |
| | 日志截断 | 每日 0:00 检查日志行数，超过 500 行截断 |

### 初始化流程

```
init()
  │
  ├─ 1. 环境清理
  │     └─ 删除 stale TMUX env var（PM2 dump 残留）
  │
  ├─ 2. 加载 adapter
  │     └─ getActiveAdapter() → ClaudeAdapter 或 CodexAdapter
  │
  ├─ 3. 读取 config
  │     ├─ tool rules
  │     └─ daily_upgrade_enabled, usage_monitor_enabled, ...
  │
  ├─ 4. 实例化组件
  │     ├─ ProcSampler(adapter.sessionName)
  │     ├─ HealthEngine(deps, options)（deps 由 adapter 方法组装）
  │     ├─ MessageRouter(healthEngine, cacheStore, options)
  │     ├─ TaskScheduler（注册 daily-upgrade, daily-memory-commit, upgrade-check, health-check, usage-monitor, usage-alert, context-check）
  │     └─ 恢复 usage check 状态
  │
  ├─ 5. 恢复持久化状态
  │     ├─ loadInitialHealth() → agent-status.json 的 health
  │     ├─ runtimeLaunchAtMs → agent-status.json 的 runtime_launch_at
  │     ├─ cooldownUntil / rateLimitResetTime（if rate_limited）
  │     ├─ toolEventStreamState → tool-event-stream-state.json
  │     ├─ toolLifecycleState → session-tool-state.json
  │     └─ watchdogState → tool-watchdog-state.json
  │
  ├─ 6. 启动 context monitor（Codex only）
  │     └─ adapter.getContextMonitor()?.startPolling()
  │
  ├─ 7. 启动 IPC server
  │     └─ Unix socket，按 type 分发：route → MessageRouter，notify_delivered → HealthEngine
  │
  └─ 8. 清理其他 runtime
        └─ 10s 后 kill 非当前 runtime 的 tmux session
```

### Tick 编排（D-4）

```
tick() [every 1s, self-scheduling]
  │
  ├─ checkDailyTruncate()  ← 日志截断（housekeeping，不计入 7 步）
  │
  ├─ 1. Runtime liveness tick
  │     Guardian 检查 tmux/runtime 状态；HealthEngine 接收 running signal
  │
  ├─ 2. Not-running 分支
  │     ├─ tmux session 不存在 → offline → 退避 → startAgent()
  │     ├─ isRunning() = false → stopped → 退避 → startAgent()
  │     └─ isRunning() = true → running（退避重置）
  │     返回 GuardianResult { state, attempted_restart, runtimeLaunchAtMs }
  │
  ├─ 2a. if (guardianResult.attempted_restart) healthEngine.onProcessRestarted()
  │      （Guardian 不持有 HealthEngine 引用（D-20），由 Orchestrator 代调）
  │
  ├─ 3. Running 分支：ProcSampler.tick()
  │     └─ isFrozen() → adapter.stop() + skip step 4-6, go to step 7
  │        （D-25：kill 后仍执行 StatusWriter 写入当前状态，下一 tick 自然进入 offline）
  │
  ├─ 4. ToolPipeline.tick()
  │     processToolLifecycle → foregroundIdentity → buildApiActivity
  │
  ├─ 5. ToolWatchdog transition
  │     result = evaluateToolWatchdogTransition
  │     ├─ clearWatchdogState → clear tool-watchdog-state.json
  │     ├─ nextWatchdogState → atomic write tool-watchdog-state.json
  │     └─ api_activity_dirty → rebuild apiActivity
  │
  ├─ 6. TaskScheduler.tick(snapshot)
  │
  └─ 7. writeStatusFile(buildRunningStatus(...))
```

> **行为变更**：旧 monitor tick 中包含 user message signal 消费、periodic probe、API error scan、health maintenance 驱动共 4 个 health 相关步骤。按 D-4，这些步骤不再由主循环 tick 驱动；HealthEngine 改为事件驱动（c4-dispatcher 异步调用 `onUserMessageDelivered()`）并由自身 maintenance timer 处理 pending heartbeat / cooldown / post-restart probe。

### 组件注册（init 时创建）

```javascript
this.adapter = getActiveAdapter()
this.healthEngine = new HealthEngine(deps, options)
this.messageRouter = new MessageRouter({ healthEngine, cacheStore, clock, log, options })
this.guardian = new Guardian(adapter, { resetToolLifecycleState, log })
this.procSampler = new ProcSampler({ sessionName: adapter.sessionName })
this.toolPipeline = new ToolPipeline(adapter, config)
this.taskScheduler = new TaskScheduler(tasks)
// StatusWriter remains a thin function module called through injected wrappers.
```

### IPC 监听

Monitor Orchestrator 负责启动 IPC server（Unix socket）。IPC server 按 `request.type` 分发：`route` 交给 MessageRouter 处理路由决策，`notify_delivered` 调用 `healthEngine.onUserMessageDelivered()` 并立即返回 ack。c4-receive 和 c4-dispatcher 通过 IPC 调用，不直接读取 HealthEngine。IPC 协议定义见 [message-router.md](message-router.md) 和 [c4-changes.md](c4-changes.md)。

### 状态恢复（AM 冷启动）

**从磁盘恢复**：
- health 状态 → agent-status.json（D-10）
- tool event stream cursor → tool-event-stream-state.json
- tool lifecycle state → session-tool-state.json
- watchdog state → tool-watchdog-state.json
- runtimeLaunchAtMs → agent-status.json 的 runtime_launch_at
- 各 daily task 状态 → 各自的 state 文件
- usage check 状态 → usage.json / usage-codex.json

**重置为零**（D-21）：
- Guardian：notRunningCount, consecutiveRestarts, startupGrace
- StatusWriter：idleSince
- HealthEngine 内部状态由 HealthEngine constructor 初始化（restartFailureCount, consecutiveHits 等）

### 接口定义

```javascript
class MonitorOrchestrator {
  async init(): void
  async tick(): void
  start(): void
}
```

### 与其他组件的交互

Monitor Orchestrator 持有并驱动大部分 runtime 组件：

| 组件 | 关系 | 调用时机 |
|------|------|---------|
| **Adapter** | 持有 | init 创建，注入给其他组件 |
| **SignalStore** | 未独立实现 | 当前读取逻辑分散在 ToolPipeline、StatusWriter helper、Orchestrator 注入回调 |
| **Guardian** | 持有 + 驱动 | tick offline/stopped 分支 |
| **ProcSampler** | 持有 + 驱动 | tick running 分支 `tick()` + `isFrozen()` |
| **ToolPipeline** | 持有 + 驱动 | tick running 分支 `tick()` |
| **ToolWatchdog** | 持有 + 驱动 | tick running 分支 |
| **TaskScheduler** | 持有 + 驱动 | tick 末尾 |
| **StatusWriter** | 通过回调调用 | tick 末尾由 `activity-monitor.js` 注入 `writeStatusFile()` / payload builder |
| **HealthEngine** | 持有 | 不直接 tick 驱动（事件驱动） |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| TICK_INTERVAL | 1000ms | 主循环间隔 |
| LOG_MAX_LINES | 500 | 日志最大行数 |

## 3. 实施方案

**改动类型**：行为变更（D-4 tick 重组 + MessageRouter IPC handler 注册）

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `activity-monitor.js:2144-2305` | `init()` — 完整初始化流程 |
| `activity-monitor.js:1803-2141` | `monitorLoop()` — 完整 tick 循环 |
| `activity-monitor.js:2307-2324` | 入口：init + self-scheduling loop |
| `activity-monitor.js` 全局变量 | 所有组件状态、全局 flag |

### 实施步骤

1. 未创建 `scripts/monitor.js`；当前入口仍是 `activity-monitor.js`
2. 已将 adapter 创建、组件实例化、状态恢复、IPC server 启动的主要编排迁入 `MonitorOrchestrator.start()`
3. 已将 `monitorLoop()` 的 tick sequencing 迁入 `MonitorOrchestrator.handleMonitorTick()`
4. 部分全局状态已收拢到 Orchestrator components；`runtimeLaunchAtMs` / `lastState` / `idleSince` / `watchdogState` 仍由 `activity-monitor.js` 接回以保持兼容边界
5. 已消费 ToolWatchdog 返回的 state mutation intent：`clearWatchdogState` 清除 `tool-watchdog-state.json`，`nextWatchdogState` atomic write `tool-watchdog-state.json`，并同步 in-memory watchdog state
6. 副作用仍通过注入回调保留在 `activity-monitor.js`，后续若继续收敛需单独评估 watchdog/recovery 语义
