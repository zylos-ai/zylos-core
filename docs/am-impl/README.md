# AM Process 实施方案

> 对应顶层设计：§3.1 AM Process 容器
> 分支：docs/activity-monitor-design
> 状态：Draft

## 概述

本目录定义 AM Process 容器内所有组件的接口、数据结构和行为规则，作为从现有单文件（activity-monitor.js, 2324 行）重构为独立模块的实施依据。

每个组件一个文档，统一结构：
1. **组件定义** — 从顶层设计中提取该组件的职责描述和相关决策
2. **组件设计** — 接口签名、数据结构、状态机、与其他组件的交互
3. **实施方案** — 现有代码位置、改动类型（纯提取/行为变更）、具体实施步骤

## 现有结构

大部分逻辑集中在 `activity-monitor.js`，仅 HeartbeatEngine、ProcSampler、DailySchedule、tool-watchdog、tool-lifecycle、tool-event-stream、tool-rules 已拆为独立模块。

## 目标结构（对齐顶层设计 §4.1）

```
activity-monitor/scripts/
├── monitor.js                # Monitor Orchestrator：入口 + 主循环编排
├── guardian.js                # Guardian：进程存活守护
├── health-engine.js           # HealthEngine：健康状态机
├── message-router.js          # MessageRouter：用户消息路由（事件驱动）
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

## 改动原则

- 接口签名和数据结构以现有代码为基线，只在顶层设计要求变更的地方做改动
- 每个组件标注「行为变更」或「纯提取」
- 行为变更的部分引用顶层设计 D-x 编号

## 组件文档索引

| 文档 | 组件 | 改动类型 |
|------|------|---------|
| [runtime-adapter.md](runtime-adapter.md) | Runtime Adapter | 提取 + 新增方法 |
| [signal-store.md](signal-store.md) | SignalStore | 纯提取 |
| [monitor-orchestrator.md](monitor-orchestrator.md) | Monitor Orchestrator | 行为变更（D-4 tick 重组） |
| [guardian.md](guardian.md) | Guardian | 行为变更 |
| [health-engine.md](health-engine.md) | HealthEngine | 行为变更 |
| [message-router.md](message-router.md) | MessageRouter | 新增模块 + C4 receive 行为变更 |
| [proc-sampler.md](proc-sampler.md) | ProcSampler | 纯提取 |
| [tool-pipeline.md](tool-pipeline.md) | ToolPipeline | 纯提取 |
| [tool-watchdog.md](tool-watchdog.md) | ToolWatchdog | 行为变更 |
| [task-scheduler.md](task-scheduler.md) | TaskScheduler | 提取 + 行为变更 |
| [status-writer.md](status-writer.md) | StatusWriter | 纯提取 |
| [hooks.md](hooks.md) | Hook 脚本（4个） | 无变更 |
| [contracts.md](contracts.md) | 顶层补充 Contract | 新增（Spec 1 Review） |

> **SessionRestartContinuation**（D-6 列出）不设独立文档。其职责（session restart 后注入 unsummarized context）由 RuntimeAdapter.`enqueueStartupPrompt()` + session-start-prompt hook 覆盖（见 [runtime-adapter.md](runtime-adapter.md) 和 [hooks.md](hooks.md)）。

## Deferred Proposals

| 文档 | 状态 | 说明 |
|------|------|------|
| [deferred-codex-tool-call-watchdog.md](deferred-codex-tool-call-watchdog.md) | Deferred | Codex tool-call stuck 兜底方案；当前 AM v3 implementation 不实现 |

## 配置项汇总

### config.json 可配置项

| Key | 类型 | 默认值 | 所属组件 |
|-----|------|--------|---------|
| auto_approve_permission | bool | true | hook-auth-prompt |
| new_session_threshold | int | 70 | context-monitor |
| daily_upgrade_enabled | bool | false | TaskScheduler |
| usage_monitor_enabled | bool | true | TaskScheduler |
| usage_alert_enabled | bool | false | TaskScheduler (D-26) |
| usage_check_interval | int | 3600 | TaskScheduler |
| usage_alert_interval | int | 3600 | TaskScheduler (D-26) |
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
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s | HealthEngine |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | HealthEngine |
| BACKOFF_BASE | 60s | HealthEngine |
| BACKOFF_MULTIPLIER | 5 | HealthEngine |
| BACKOFF_CAP | 3600s | HealthEngine |
| PROBE_TIMEOUT | 25s | HealthEngine |
| STICKY_ERROR_MIN_INTERVAL | 30s | HealthEngine |
| ROUTER_IPC_TIMEOUT_MS | 30000ms | MessageRouter / c4-receive |
| ROUTER_PROBE_BUDGET_MS | 25000ms | MessageRouter |
| PROBE_CACHE_TTL_MS | 30000ms | MessageRouter |
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

## 实施顺序

本容器内的组件实施顺序（按依赖关系）：

1. **RuntimeAdapter** — 基础设施，其他组件都依赖
2. **SignalStore** — 数据层，被所有 tick 组件消费
3. **Guardian** — 纯 runtime 生命周期，无外部依赖
4. **ProcSampler** — 已独立，确认接口对齐
5. **ToolPipeline** — 依赖 SignalStore
6. **ToolWatchdog** — 依赖 ToolPipeline，已独立，移除 launchGracePeriod
7. **HealthEngine** — 行为变更最大，依赖 Adapter
8. **MessageRouter** — 依赖 HealthEngine，定义 IPC 路由与 c4-receive 集成
9. **TaskScheduler** — 依赖 config
10. **StatusWriter** — 依赖所有其他组件输出
11. **Monitor Orchestrator** — 组装层，最后实施
