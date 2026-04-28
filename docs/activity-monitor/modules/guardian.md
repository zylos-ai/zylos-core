# Guardian — 模块实施档

> 关联顶层方案：[v3 §三原则 2 / §五.4 / §六取舍 F](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（tick 第 ② 步）

---

## 1. 模块职责与边界

### 职责

进程存活守护——只关心进程是否在运行，**不关心为什么不健康**。

### 边界

**在 scope 内**：
- 检查 tmux + agent 进程存活，决定是否拉起
- restart 指数退避管理（5s → 10s → 20s → 40s → 60s cap，连续稳定 60s 自动归零）
- `authRetrySuppressedUntil`（AuthFailed 后 180s 内抑制 restart）
- launch 前观察 `maintenance-state.json`，最长等待 300s
- bypass-once + marker 重置语义

**不在 scope 内**：
- HealthState 判定（HealthEngine 职责）
- 工具超时检测（ToolWatchdog 职责）

### 关键不变量

- **C-G-1**：Guardian 决策闭环中**不同步查询**任何其他模块——所有输入来自 SignalStore snapshot 或 Guardian 自己 state
- **C-G-2**：Guardian 只看 ActivityState，不读 HealthState；不绕过 4 拉起条件

---

## 2. 输入 / 输出契约

### 输入

| 输入 | 来源 | 用途 |
|---|---|---|
| `signals.rateLimitState` | SignalStore（HealthEngine 写）| 拉起条件 #1 |
| `signals.maintenanceState` | SignalStore（TaskScheduler 写）| 拉起条件 #4 |
| `signals.procState` | SignalStore（ProcSampler 写）| 进程存活判断 |
| `signals.tmuxAlive` | SignalStore | 进程存活判断 |
| 自身持久化字段（4 个） | `guardian-state.json` | restart 退避状态 |
| Reset marker 文件 | operator CLI | 显式重置触发 |

### 输出

| 输出 | 消费者 | 性质 |
|---|---|---|
| `setAuthFailed(reason)` 调用 | HealthEngine | 事件 |
| `onProcessRestarted()` 调用 | HealthEngine | 事件 |
| `adapter.launch()` 调用 | Adapter | 事件 |
| 写 `guardian-state.json` | 自身（持久化）| state file |

---

## 3. 数据结构 / 字段 / 状态机

### Guardian 4 持久化字段

`guardian-state.json` 内容：

```json
{
  "notRunningCount": 0,            // 连续 tick 看到进程不在运行的计数
  "consecutiveRestarts": 0,        // 连续重启次数（用于退避升级）
  "restartDelay": 5,               // 当前 restart 退避秒数（5/10/20/40/60）
  "authRetrySuppressedUntil": 0    // ms timestamp，AuthFailed 后 180s 抑制窗
}
```

### 4 个拉起条件

全部从 SignalStore 或自身 state 读取，**不查询其他模块**：

| # | 条件 | 数据源 |
|---|---|---|
| 1 | `signals.rateLimitState == null \|\| Date.now() >= signals.rateLimitState.until` | SignalStore（HealthEngine 写）|
| 2 | `Date.now() >= authRetrySuppressedUntil` | Guardian 自身 |
| 3 | `notRunningCount >= restartDelay` | Guardian 自身 |
| 4 | `signals.maintenanceState == null \|\| !signals.maintenanceState.running` | SignalStore（TaskScheduler 写）|

### Cold start：bypass-once + marker 重置

#### Reset marker 文件

路径：`~/zylos/activity-monitor/.reset-request`

#### 路径 A：默认（无 marker） —— bypass-once

- 从 `guardian-state.json` 恢复 4 字段（保留故障认知）
- **首次 probe 绕过条件 #1/#2/#3**（时间驱动退避），但**不绕过 #4**（维护窗口互斥锁）
- 首次 probe 成功 → 清空 4 字段
- 首次 probe 失败 → 回到持久化退避水位（不退回 initial_delay）

#### 路径 B：operator 显式重置（marker 存在）

- 冷启动检测到 marker → 清空 4 字段 + unlink marker（one-shot）+ 关闭 bypass-once
- CLI：`zylos am reset-backoff [--restart]`

#### 三场景语义矩阵

| 场景 | marker | Guardian 4 字段 | 首次探测 |
|---|---|---|---|
| `zylos am reset-backoff --restart` | ✅ one-shot | **清零** | 从 initial_delay 开始 |
| daily-upgrade 完成后 AM 自重启 | ❌ | 保留持久化 | bypass-once 给 1 次机会 |
| auto-restart（AM 崩溃 / PM2 拉起） | ❌ | 保留持久化 | bypass-once 给 1 次机会 |

---

## 4. 关键接口与调用关系

### Guardian API

| 方法 | 用途 |
|---|---|
| `tick(signals)` | 每秒一次主循环 |
| `coldStart()` | AM 启动时调用，决定路径 A/B + 加载/清空 state |
| `setAuthFailed(reason)` | 写 `authRetrySuppressedUntil = now + 180s`（被 HealthEngine 间接调用）|
| `onAuthCheckSuccess()` | 重置 `authRetrySuppressedUntil` |

### tick() 主流程

```
tick(signals):
  if NOT signals.tmuxAlive OR NOT proc_alive:
    notRunningCount++

    if 全部 4 拉起条件满足:
      adapter.launch()           # 进程拉起
      onLaunchSuccess() ➜ engine.onProcessRestarted()
      reset 退避

    else:
      pass   # 等待条件
  else:
    onRunStable()                # 连续运行 60s 后归零退避
```

### 与 HealthEngine 的事件调用

- Guardian 调 `engine.onProcessRestarted()`：拉起成功后，让 HealthEngine 从 agent-status.json 回填 health + 启动 launchGracePeriod
- Guardian 调 `engine.setAuthFailed(reason)`：auth-check 失败时通知 HealthEngine 转 AuthFailed state

**单向调用**——HealthEngine 不反向调 Guardian。HealthEngine 通过 SignalStore 写 `rate-limit-state.json` 间接影响 Guardian 拉起条件 #1。

---

## 5. 错误处理与恢复逻辑

### `guardian-state.json` 损坏

- 启动时 JSON 解析失败 → 视为 missing → 默认 4 字段全 0
- 等同 first-time start

### Marker 文件意外残留

- 老的测试 / 半完成 reset 留下 marker → AM 启动时检测到 → 清空 + unlink → 进入"清零"路径
- 风险：可能掩盖真实持久化退避——operator 应保证 marker 文件只通过 `zylos am reset-backoff` CLI 创建

### `adapter.launch()` 失败

- 启动外部进程失败（命令不存在 / 权限）→ Guardian 视为"进程仍不在运行"，下一 tick 继续 4 拉起条件检查
- log error，不进入 hard fail

### Maintenance window 超时

- 等 maintenance-state.json clear 最长 300s → 超时强制拉起（避免无限等）
- log warning + 拉起

---

## 6. 迁移策略

### Phase 2 落地

**Step 1**：新建 `guardian.js` 模块，实现 4 拉起条件 + bypass-once + marker

**Step 2**：迁移老 `activity-monitor.js` 中 Guardian 相关字段到 `guardian-state.json`（一次性 migration script）

**Step 3**：保留 `activity-monitor.legacy.js`，PM2 启动参数切换

### 兼容性

- `guardian-state.json` 是新文件——老 monitor 不会冲突
- bypass-once 是新 default 行为，`zylos am reset-backoff` CLI 是新增

---

## 7. 测试策略 + 验收标准

| 测试 | 描述 |
|---|---|
| 4 拉起条件全覆盖 | 每个条件独立 false 时阻止 launch |
| Bypass-once 首次成功 | restart 持久化字段 → 启动 → bypass 成功 → 字段清零 |
| Bypass-once 首次失败 | restart 持久化字段 → 启动 → bypass 失败 → 退回持久化水位 |
| Marker 路径 B | 创建 marker → 启动 → 4 字段清零 + marker unlink |
| Marker 不绕过 #4 | maintenance running 时即使 marker 存在也等待 |
| AuthFailed 180s 冷却 | setAuthFailed 后 180s 内不 launch |
| Maintenance 300s 超时 | maintenance-state 长期未 clear → 300s 后强制 launch |
| `engine.onProcessRestarted` 事件 | launch 成功后调用一次 |

### 验收标准

- ✅ 4 拉起条件单元测试 100% 覆盖
- ✅ 三场景语义矩阵端到端测试 100% 通过
- ✅ Guardian 决策不调任何其他模块 getter（C-G-1）

---

## 8. 与其他模块的依赖关系

### 上游

- [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)：读 rate-limit-state / maintenance-state / proc-state / tmux signal
- [`runtime-adapter.md`](runtime-adapter.md)：调 `adapter.launch()` / `adapter.isRunning()` / `adapter.checkAuth()`
- [`task-scheduler.md`](task-scheduler.md)：TaskScheduler 写 maintenance-state.json

### 下游

- [`health-engine.md`](health-engine.md)：通过 `setAuthFailed()` / `onProcessRestarted()` 单向触发

---

*v3 R3 review (2026-04-28) 整理：从 v2.1 §5.2 摘出 Guardian 模块独立成档；保留 4 拉起条件 / bypass-once / marker 三场景语义。*
