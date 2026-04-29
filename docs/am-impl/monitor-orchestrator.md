# Monitor Orchestrator

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：主循环入口，每秒驱动一次 tick，按固定顺序调用各组件；负责启动 IPC 监听供 MessageRouter 接入。

**输入**：系统时钟（1s interval）、config

**输出**：按顺序调用各组件的 tick 方法

**相关决策**：
- **D-4**：AM 主循环每 tick 按固定顺序执行 7 步。HealthEngine 不参与主循环 tick。
- **D-21**：PM2 重启 AM 时，Guardian 退避状态重置为零。持久化状态从磁盘恢复。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **初始化** | 加载 runtime adapter | `getActiveAdapter()` 读取 config.json |
| | 实例化所有组件 | SignalStore / Guardian / ProcSampler / ToolPipeline / ToolWatchdog / TaskScheduler / StatusWriter / HealthEngine |
| | 恢复持久化状态 | health 从 agent-status.json；tool stream 从 state file；watchdog 从 state file |
| | 启动 IPC server | Unix socket，供 MessageRouter 接入 |
| | 启动 context monitor | Codex: polling-based；Claude: null（hook 处理） |
| | 清理其他 runtime session | 启动 10s 后 kill 非当前 runtime 的 tmux session |
| **Tick 编排** | 7 步固定顺序 | SignalStore → Guardian → ProcSampler → ToolPipeline → ToolWatchdog → TaskScheduler → StatusWriter |
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
  │     ├─ heartbeat_enabled
  │     ├─ tool rules
  │     └─ daily_upgrade_enabled, usage_monitor_enabled, ...
  │
  ├─ 4. 实例化组件
  │     ├─ ProcSampler(adapter.sessionName)
  │     ├─ HealthEngine(deps, options)（含 adapter.getHeartbeatDeps()）
  │     ├─ DailySchedule × 3（upgrade, memory-commit, upgrade-check）
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
  │     └─ Unix socket，供 MessageRouter 查询 HealthEngine
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
  ├─ 1. SignalStore.refresh()
  │     快照层：readJSON(agent-status, statusline, foreground-session, ...)
  │     流式层：增量读取 tool-events.jsonl
  │
  ├─ 2. Guardian.tick(snapshot)
  │     ├─ tmux session 不存在 → offline → 退避 → startAgent()
  │     ├─ isRunning() = false → stopped → 退避 → startAgent()
  │     └─ isRunning() = true → running（退避重置）
  │     返回 GuardianResult { state, attempted_restart, runtimeLaunchAtMs }
  │     （state != 'running' 时仍继续执行后续步骤，由 StatusWriter 写入对应状态）
  │
  ├─ 3. ProcSampler.tick(snapshot)
  │     └─ isFrozen() → adapter.stop() + return（D-25：下一 tick 自然进入 offline）
  │
  ├─ 4. ToolPipeline.tick(snapshot)
  │     processToolLifecycle → foregroundIdentity → buildApiActivity
  │
  ├─ 5. ToolWatchdog.tick(snapshot)
  │     evaluateToolWatchdogTransition
  │     └─ api_activity_dirty → rebuild apiActivity
  │
  ├─ 6. TaskScheduler.tick(snapshot)
  │
  └─ 7. StatusWriter.write(snapshot, healthEngine)
```

> **行为变更**：现有代码 tick 中包含 user message signal 消费、periodic probe、API error scan、processHeartbeat() 共 4 个 health 相关步骤。按 D-4，HealthEngine 不参与主循环 tick，这些能力全部移到 HealthEngine 内部，由 c4-dispatcher 异步调用 `onUserMessageDelivered()` 触发。

### 组件注册（init 时创建）

```javascript
this.adapter = getActiveAdapter()
this.signalStore = new SignalStore(signalPaths)
this.healthEngine = new HealthEngine(deps, options)
this.guardian = new Guardian(adapter, { resetToolLifecycleState, log })
this.procSampler = new ProcSampler({ sessionName: adapter.sessionName })
this.toolPipeline = new ToolPipeline(adapter, signalStore)
this.toolWatchdog = new ToolWatchdog(deps)
this.taskScheduler = new TaskScheduler(tasks)
this.statusWriter = new StatusWriter(healthEngine, signalStore)
```

### IPC 监听

Monitor Orchestrator 负责启动 IPC server（Unix socket），供 MessageRouter 接入查询 HealthEngine 状态。IPC 协议定义见 MessageRouter 实施方案。

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
- notRunningCount, consecutiveRestarts, startupGrace
- idleSince, lastPeriodicProbeAt
- apiErrorConsecutiveHits, authRetrySuppressedUntil

### 接口定义

```javascript
class MonitorOrchestrator {
  async init(): void
  async tick(): void
  start(): void
}
```

### 与其他组件的交互

Monitor Orchestrator 持有并驱动所有组件：

| 组件 | 关系 | 调用时机 |
|------|------|---------|
| **Adapter** | 持有 | init 创建，注入给其他组件 |
| **SignalStore** | 持有 + 驱动 | tick 开头 `refresh()` |
| **Guardian** | 持有 + 驱动 | tick offline/stopped 分支 |
| **ProcSampler** | 持有 + 驱动 | tick running 分支 `tick()` + `isFrozen()` |
| **ToolPipeline** | 持有 + 驱动 | tick running 分支 `tick()` |
| **ToolWatchdog** | 持有 + 驱动 | tick running 分支 |
| **TaskScheduler** | 持有 + 驱动 | tick 末尾 |
| **StatusWriter** | 持有 + 驱动 | tick 末尾 `write()` |
| **HealthEngine** | 持有 | 不直接 tick 驱动（事件驱动） |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| TICK_INTERVAL | 1000ms | 主循环间隔 |
| LOG_MAX_LINES | 500 | 日志最大行数 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `activity-monitor.js:2144-2305` | `init()` — 完整初始化流程 |
| `activity-monitor.js:1803-2141` | `monitorLoop()` — 完整 tick 循环 |
| `activity-monitor.js:2307-2324` | 入口：init + self-scheduling loop |
| `activity-monitor.js` 全局变量 | 所有组件状态、全局 flag |

### 实施步骤

1. 创建 `scripts/monitor.js` 作为入口文件
2. 提取 `init()` 逻辑：adapter 创建、组件实例化、状态恢复、IPC server 启动
3. 提取 `monitorLoop()` 逻辑：tick 编排、错误处理
4. 将全局变量收拢到 Orchestrator 实例或委托给各组件
5. **这是组装层，最后实施**（依赖所有其他组件先完成）
