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

### 与其他组件的交互

- **Monitor Orchestrator** → 在 tick 编排中被调用
- **SignalStore** → gate 条件可能读取 snapshot 数据

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| daily_upgrade_enabled | false | 是否启用每日自动升级 |
| usage_monitor_enabled | false | 是否启用用量监控 |
| usage_alert_enabled | false | 是否启用用量告警（D-26、D-27）|
| usage_check_interval | 3600 | 用量检查间隔 |
| usage_idle_gate | 30 | 检查前需要的空闲秒数 |
| usage_warn_threshold | 80 | 用量告警阈值（%）|
| usage_high_threshold | 90 | 用量高阈值（%）|
| usage_critical_threshold | 95 | 用量危急阈值（%）|
| usage_notify_cooldown | 14400 | 告警通知冷却（秒）|
| usage_active_hours_start | 8 | 活跃时段开始（小时）|
| usage_active_hours_end | 23 | 活跃时段结束（小时）|

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

从 `activity-monitor.js` 的各 daily scheduler + usage check 提取。

### 实施步骤

1. 创建 `scripts/task-scheduler.js`，实现通用的 daily + interval 调度框架
2. 将各定时任务实现移到 `scripts/tasks/` 目录下的独立文件
3. 每个任务文件导出符合 `TaskDefinition` 接口的对象
4. TaskScheduler 在 `init()` 时接收所有任务定义，`tick()` 时统一调度
5. 注意 D-26：usage_monitor 和 usage_alert 必须是两个独立任务
