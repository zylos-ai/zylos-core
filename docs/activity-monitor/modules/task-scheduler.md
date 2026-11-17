# TaskScheduler — 模块实施档

> 关联顶层方案：[v3 §二目标 8 / §四.1 / §四.3 / §六.F](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（tick 第 ⑦ 步）
> Phase：1（基础设施）

---

## 1. 模块职责与边界

### 职责

注册式定时任务调度器——把 v2.1 之前 3 套 ad-hoc 调度（DailySchedule / 间隔 timestamp / 独立状态机）合并为统一接口。

### 边界

**在 scope 内**：
- 任务注册接口
- 间隔（`intervalSeconds`）+ 每日固定时刻（`dailyHour`）调度
- maintenance window 协议（写 `maintenance-state.json` 给 Guardian）
- usage 监测/告警双 gate 拆分

**不在 scope 内**：
- 任务的具体业务逻辑（各任务自己实现）
- cron 表达式解析（明确不引入，详 v3 §六 I）

---

## 2. 输入 / 输出契约

### 输入

| 输入 | 来源 | 用途 |
|---|---|---|
| 任务注册声明 | 各任务文件（注册时） | 加入调度池 |
| `tick()` | monitor.js | 每秒一次 |
| `signals.statusline` | SignalStore | context-check 任务条件 |

### 输出

| 输出 | 消费者 | 性质 |
|---|---|---|
| 任务执行（调用注册的 `execute` 函数）| 各任务 | 同步 |
| `maintenance-state.json` 写入（maintenance 任务进出时）| Guardian（条件 #4） | signal 文件 |

---

## 3. 数据结构 / 字段 / 状态机

### 任务声明 schema

```js
{
  name: 'daily-upgrade',
  interval: null,             // 间隔秒（与 dailyHour 二选一）
  dailyHour: 3,                // 每日固定小时（0-23），与 interval 二选一
  condition: (signals) => bool, // 执行前置条件函数
  execute: async () => { ... }, // 执行体
  maintenance: true,           // 写 maintenance-state.json 标 maintenance window
  skipOnStart: true            // 避免服务启动立即执行 daily 任务
}
```

### 现有任务（7 个）

| 任务 | 频率 | maintenance? |
|---|---|---|
| `daily-upgrade` | 每日 03:00 | ✅ |
| `daily-memory-commit` | 每日 04:00 | ❌ |
| `upgrade-check` | 间隔 6h | ❌ |
| `health-check` | 间隔 1h | ❌ |
| `usage-monitor` | 间隔 5min | ❌ |
| `usage-alerter` | 间隔 5min | ❌ |
| `context-check` | 间隔 30s | ❌ |

新加任务只需在 `tasks/` 目录新建文件 + 注册——不需要改主循环。

### Usage 监测 / 告警双 gate（v3 新增）

main 分支当前 `maybeCheckUsage()` 用单一 `usage_monitor_enabled` 开关同时控制本地监测（零 token）和主动告警（消耗 token）。两件事被一刀切——v3 拆开：

| 任务 | 控制 gate（默认值） | 行为 | 写 state |
|---|---|---|---|
| `usage-monitor` | `usage_monitor_enabled`（**新 default true**）| 读 statusline / usage 计算 tier，零 token | `usage.json` |
| `usage-alerter` | `usage_alert_enabled`（**新增**，default false）| 读 monitor state，达阈值 C4 enqueue alert + 去重 | `usage-alert-state.json` |

### 4 种语义矩阵

| monitor | alert | 行为 |
|---|---|---|
| true | false | ✅ **新 default**：本地 state 新鲜，零 token |
| true | true | ✅ 监测 + 告警都开（=main 当前 monitor=true 行为）|
| false | false | ✅ 完全关（=main 当前默认行为）|
| false | true | ❌ 矛盾——alerter 依赖 monitor state；启动 warning，alerter 自动 no-op |

### State 文件分工

- `usage.json`：tier / window / 监测元数据（写：usage-monitor；读：usage-alerter / dashboard / web-console）
- `usage-alert-state.json`（新增）：已通知的 tier + 时间戳，alerter 自己写自己读做去重

### 升级兼容性策略

- 旧 config 只有 `usage_monitor_enabled=true` → 新版 default `usage_alert_enabled=false` —— 告警关闭（保守）
- 启动检测 legacy config 输出明显 warning：
  ```
  ⚠️  Detected legacy config: usage_monitor_enabled=true with no usage_alert_enabled.
       v3 默认不发 usage alert（避免 runtime token 消耗）。
       如需恢复旧行为，请显式配置：usage_alert_enabled=true
  ```
- 鼓励老用户主动 opt-in 告警，把"是否消耗 runtime token"决策权交还给 user
- Release notes 单独标注此变更

---

## 4. 关键接口与调用关系

### TaskScheduler API

| 方法 | 用途 |
|---|---|
| `register(taskDef)` | 注册新任务 |
| `tick(signals)` | 每秒检查 + 触发到期任务 |

### 任务执行顺序

tick 第 ⑦ 步 TaskScheduler 按注册顺序执行——usage-monitor 在前刷 state，usage-alerter 在后读最新 state 决定告警。**单 tick 内时序正确**。

### Maintenance 协议

```
maintenance task 开始执行：
  写 maintenance-state.json: { running: true, taskName, startedAt, expectedEndBy }
  
执行体跑完：
  清 maintenance-state.json
```

Guardian 看到 `maintenance-state.running=true` → 拉起条件 #4 不满足，等待。

---

## 5. 错误处理与恢复逻辑

### 任务执行抛错

- TaskScheduler 捕获异常，log error，**不影响主循环**
- 下一周期到来时再次执行（不阻塞）

### Maintenance state 永久卡死

- 任务超时（如 daily-upgrade 卡 5h）→ TaskScheduler 内部 timeout 30min 强制清 maintenance state + log warning
- Guardian 见状态 clear 后正常拉起

### usage-alerter 依赖 missing

- `usage_alert_enabled=true` 但 `usage_monitor_enabled=false` → alerter no-op + log warning（不报错）

---

## 6. 迁移策略

### Phase 1 落地

**Step 1**：新建 `task-scheduler.js` 模块 + `tasks/` 目录

**Step 2**：迁移 7 个任务到独立文件 + 注册：
- `tasks/daily-upgrade.js`
- `tasks/daily-memory-commit.js`
- `tasks/upgrade-check.js`
- `tasks/health-check.js`
- `tasks/usage-monitor.js`（拆出原来 maybeCheckUsage 的监测部分）
- `tasks/usage-alerter.js`（新建，原 maybeCheckUsage 的告警部分）
- `tasks/context-check.js`
- `tasks/stale-signal-cleanup.js`（新建，每 5min 清理 stale signal 文件）

**Step 3**：legacy `activity-monitor.js` 中的对应代码清理（同 PR）

### 升级兼容性

- 旧 config `usage_monitor_enabled=true` → 启动 warning + 新 default 行为
- Release notes 单独一节明确 usage 双 gate 变更

---

## 7. 测试策略 + 验收标准

| 测试 | 描述 |
|---|---|
| 注册 + 调度 happy path | 注册间隔 5s 任务 → 5s 后执行 |
| `dailyHour` 调度 | mock 时间到 03:00 → 触发执行 |
| `skipOnStart` 行为 | daily 任务设 skipOnStart → 启动当时刻不立即执行 |
| Maintenance 协议 | maintenance 任务开始 → maintenance-state.running=true → 结束清理 |
| Usage 双 gate 4 种矩阵 | 4 种 (monitor, alert) 组合行为正确 |
| Legacy config warning | 启动时 `usage_monitor_enabled=true` 无 alert 配置 → log warning |
| 任务执行抛错不阻塞 | 一任务抛错，其他任务下周期仍执行 |

### 验收标准

- ✅ 7 任务全部覆盖单元测试 + 集成测试
- ✅ Maintenance window 30min 强制清理超时
- ✅ Usage 双 gate 4 种语义矩阵 100% 覆盖

---

## 8. 与其他模块的依赖关系

### 上游

- [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)：读 statusline 等 signal

### 下游

- [`guardian.md`](guardian.md)：通过 `maintenance-state.json` 间接（条件 #4）
- 各任务自身依赖 channel daemon / runtime API（不进 TaskScheduler 接口）

---

*v3 R3 review (2026-04-28) 整理：合 v2.1 §5.8 + §5.8.1 usage 双 gate 拆分；保留 7 任务 + maintenance 协议 + 升级兼容策略。*