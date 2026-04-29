# TaskScheduler

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：统一管理定时任务（健康检查、日志清理、usage 告警等），按配置的 interval 触发执行。

**输入**：系统时钟、config 中的任务定义

**输出**：任务执行结果；maintenance 状态文件

**相关决策**：
- **D-26**：usage_monitor 与 usage_alert 拆为两个独立 gate。usage_monitor_enabled（默认 true，本地 state 刷新，零 token）和 usage_alert_enabled（默认 false，达阈值时 C4 enqueue alert）。
- **D-27**：旧 config 只有 usage_monitor_enabled=true 时，新版 default usage_alert_enabled=false。静默处理，不输出 warning。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **调度框架** | daily 任务 | 每日指定小时触发一次（local timezone） |
| | interval 任务 | 固定间隔触发（秒） |
| | gate 条件 | 可选前置条件（如 idle 秒数、health 状态） |
| | 状态持久化 | 每个任务的 last-run 时间持久化到独立 state 文件 |
| **已注册任务** | daily-upgrade | 每日 5:00 触发自动升级（需 config 开启） |
| | daily-memory-commit | 每日 3:00 git commit memory 目录 |
| | upgrade-check | 每日 6:00 检查 Claude Code 新版本 |
| | health-check | 每 24h 检查 PM2/disk/memory |
| | usage-monitor | 每 1h 读取本地 usage 快照，刷新 state（D-26：零 token） |
| | usage-alert | 每 1h 检查用量阈值，达阈值 C4 通知 owner（D-26） |
| | context-check | adapter.getContextMonitor() 非 null 时 polling 检查上下文占用 |

### 已注册任务详情

#### daily-upgrade（每日 5:00）

```
gate: daily_upgrade_enabled = true && snapshot.health = 'ok'
execute: enqueue C4 control → runtime 执行 /upgrade-claude
state: ~/zylos/activity-monitor/daily-upgrade-state.json
```

#### daily-memory-commit（每日 3:00）

```
gate: 无
execute: git add + commit ~/zylos/memory/ 目录
state: ~/zylos/activity-monitor/daily-memory-commit-state.json
```

#### upgrade-check（每日 6:00）

```
gate: snapshot.health = 'ok'
execute: 检查 Claude Code 最新版本，如有新版写入 upgrade-available.json
state: ~/zylos/activity-monitor/upgrade-check-state.json
```

#### health-check（每 24h）

```
gate: runtime 在线
execute: enqueue C4 control → runtime 执行 /health-check skill
state: ~/zylos/activity-monitor/health-check-state.json
```

#### usage-monitor（每 1h）

```
gate: usage_monitor_enabled = true && idle >= 30s && snapshot.health = 'ok'
execute:
  1. 读取本地 usage 快照（Claude: statusline/usage.json; Codex: usage-codex.json）
  2. 计算 session/weekly 用量百分比
  3. 写入 state 文件（百分比 + 时间戳）
state: ~/zylos/activity-monitor/usage.json 或 usage-codex.json
```

职责边界：只做数据采集和 state 刷新，不做告警判断。零 token 开销（D-26）。

#### usage-alert（每 1h）

```
gate: usage_alert_enabled = true && idle >= 30s && snapshot.health = 'ok'
execute:
  1. 读取 usage-monitor 写入的 state 文件
  2. 按 tier 判断是否达阈值：warn(80%) → high(90%) → critical(95%)
  3. 达阈值 → 检查 cooldown（4h per tier，升级跳过 cooldown）
  4. 通过 cooldown → enqueue C4 通知 owner
state: ~/zylos/activity-monitor/usage-alert-state.json
active hours: 8:00-23:00 only
```

职责边界：只做阈值判断和告警发送，不做数据采集。依赖 usage-monitor 的 state 文件作为数据源。默认关闭（D-27）。

#### context-check

```
gate: adapter.getContextMonitor() != null
execute: polling 检查上下文占用
  - >= 56% + unsummarized > 30 → memory sync
  - >= 70% → new-session handoff
note: adapter.getContextMonitor() 返回 null 时跳过（由 statusLine hook 处理）
```

### 调度流程

```
tick(snapshot)
  │
  ├─ for each task in registeredTasks:
  │   │
  │   ├─ daily 任务：
  │   │   ├─ 当前小时 == task.hour？
  │   │   ├─ 今天未执行过？（检查 state 文件）
  │   │   ├─ gate 条件满足？
  │   │   └─ YES → execute(), 更新 state
  │   │
  │   └─ interval 任务：
  │       ├─ 距上次执行 >= intervalSec？
  │       ├─ gate 条件满足？
  │       └─ YES → execute(), 更新 state
  │
  └─ return
```

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

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **Monitor Orchestrator** | 调用 | `tick()` | 在 tick 编排中被调用 |
| **SignalStore** | 读取 | `snapshot.health` | gate 条件（部分任务需 health=ok，D-23：通过 snapshot 读取，eventual consistency——snapshot 来自 tick step 1，TaskScheduler 在 step 6 执行时 health 可能已变，这是 D-23 允许的） |
| **Adapter** | 读取 | `runtimeId` | 选择 usage 快照来源 |
| **C4 Control** | 调用 | `c4-control.js enqueue` | daily-upgrade、health-check 通过 C4 控制 runtime |
| **SignalStore** | 消费 | snapshot | idle 秒数等 gate 条件 |

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| daily_upgrade_enabled | false | 是否启用每日自动升级 |
| usage_monitor_enabled | true | 是否启用用量监控（D-26：零 token，本地 state 刷新） |
| usage_check_interval | 3600 | usage-monitor 检查间隔（秒） |
| usage_idle_gate | 30 | usage-monitor / usage-alert 共用：检查前需要的空闲秒数 |
| usage_alert_enabled | false | 是否启用用量告警（D-26、D-27：独立任务） |
| usage_alert_interval | 3600 | usage-alert 检查间隔（秒） |
| usage_warn_threshold | 80 | 用量告警阈值（%） |
| usage_high_threshold | 90 | 用量高阈值（%） |
| usage_critical_threshold | 95 | 用量危急阈值（%） |
| usage_notify_cooldown | 14400 | 告警通知冷却（秒） |
| usage_active_hours_start | 8 | usage-alert 活跃时段开始 |
| usage_active_hours_end | 23 | usage-alert 活跃时段结束 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `scripts/daily-schedule.js`（52行） | DailySchedule class（通用 daily 调度框架） |
| `scripts/upgrade-check.js`（150行） | upgrade-check 任务实现 |
| `scripts/usage-check-engine.js`（36行） | usage check 初始化逻辑 |
| `scripts/usage-monitor-file-reader.js`（144行） | Claude usage 文件读取 |
| `scripts/usage-codex-rollout-reader.js`（151行） | Codex usage 读取 |
| `activity-monitor.js:2131-2141` | tick 中的任务调度调用 |
| `activity-monitor.js:2199-2247` | init 中的 DailySchedule 实例化 |
| `activity-monitor.js:1680-1801` | `maybeCheckUsage()` 完整 usage monitor 逻辑 |

### 实施步骤

1. 创建 `scripts/task-scheduler.js`，实现统一的 daily + interval 调度框架
2. 将各定时任务实现移到 `scripts/tasks/` 目录下的独立文件
3. 每个任务文件导出符合 `TaskDefinition` 接口的对象
4. 合并现有 `DailySchedule` 和 interval 调度逻辑为统一框架
5. usage-monitor 和 usage-alert 拆为两个独立任务（D-26）
6. context-check 在 adapter.getContextMonitor() 返回非 null 时注册（由 hook 处理时 adapter 返回 null）
