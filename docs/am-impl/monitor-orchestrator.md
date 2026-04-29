# Monitor Orchestrator

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：主循环入口，每秒驱动一次 tick，按固定顺序调用各组件；负责启动 IPC 监听供 MessageRouter 接入。

**输入**：系统时钟（1s interval）、config

**输出**：按顺序调用各组件的 tick 方法

**相关决策**：
- **D-4**：AM 主循环每 tick 按固定顺序执行 7 步：SignalStore.refresh → Guardian → ProcSampler → ToolPipeline → ToolWatchdog → TaskScheduler → StatusWriter。HealthEngine 不参与主循环 tick，改为由 user message 事件异步触发。
- **D-21**：PM2 重启 AM 自身时，Guardian 不从磁盘恢复 notRunningCount / consecutiveRestarts / restartDelay 等持久化计数器。AM 冷启动 = Guardian 全新开始。

## 2. 组件设计

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

### 与其他组件的交互

- 创建并持有所有组件实例
- 驱动 tick 循环，按固定顺序调用各组件
- 启动 IPC server 供 MessageRouter 接入

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| TICK_INTERVAL | 1000ms | 主循环间隔 |
| LOG_MAX_LINES | 500 | 日志最大行数 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

从 `activity-monitor.js` 的 `init()` + `monitorLoop()` 提取。

### 实施步骤

1. 创建 `scripts/monitor.js` 作为入口文件
2. 提取 `init()` 逻辑：adapter 创建、组件实例化、状态恢复、IPC server 启动
3. 提取 `monitorLoop()` 逻辑：tick 编排、错误处理
4. 这是组装层，最后实施（依赖所有其他组件先完成）
