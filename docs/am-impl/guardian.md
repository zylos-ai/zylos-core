# Guardian

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：守护 runtime 进程存活：检测进程退出后无条件拉起，拉起失败时按退避策略递增延迟重试。

**输入**：snapshot、guardian 内部状态（上次拉起时间、连续失败计数）

**输出**：调用 Runtime Adapter 拉起 runtime

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。Guardian 不读 HealthState 决定是否拉起。
- **D-20**：Guardian 原则为「Offline → 无条件拉起进程」，不读 HealthState。拉起失败后通过退避逻辑（递增延迟）避免无限快速重启。进程状态与健康状态完全正交，Guardian 不因 RateLimited 或任何 HealthState 阻止拉起。
- **D-21**：PM2 重启 AM 自身时，Guardian 不从磁盘恢复退避计数器。AM 冷启动 = Guardian 全新开始，立即尝试拉起 tmux。
- **D-33**：保留 startupGrace (30s)，Guardian 拉起 runtime 后的启动保护窗口，防止 runtime 初始化期间被误判为 offline。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **进程检测** | tmux session 检测 | `tmux has-session` 检查 session 是否存在 |
| | runtime 进程检测 | `adapter.isRunning()` 检查 runtime 进程是否在 tmux 内存活 |
| **拉起** | 无条件拉起 | 进程不存在 → 调用 `adapter.launch()`，不读 HealthState（D-20） |
| | 状态清理 | 拉起前清除 stale heartbeat-pending、context temp files、tool lifecycle state |
| | 启动提示注入 | Claude 无 SessionStart hook 时注入 C4 control 启动提示（fallback） |
| **退避** | 指数退避 | `delay = min(5s × 2^n, 60s)` → 序列 5, 10, 20, 40, 60, 60... |
| | 退避重置 | runtime 连续运行超过 60s → 重置 consecutiveRestarts |
| **保护** | 启动保护 | 拉起后 30 ticks 跳过 offline 检测（D-33） |
| | 维护等待 | 检测到 restart-claude/upgrade-claude/install.sh 运行中 → 等待完成（最多 300s） |
| | 并发保护 | `startAgentInProgress` flag 防止并发拉起 |

### 拉起决策流程

```
monitorLoop() 每 tick：
  │
  ├─ tmux session 不存在？
  │   └─ startupGrace > 0？ → 倒计时，跳过
  │   └─ state = 'offline'
  │       │
  │       ▼
  │   ┌─────────────────────────┐
  │   │ 是否该拉起？             │
  │   │                         │
  │   │ 1. notRunningCount      │  ← 只看退避延迟，不读 HealthState
  │   │    >= restartDelay      │
  │   └─────────┬───────────────┘
  │             │ YES
  │             ▼
  │         startAgent()
  │
  ├─ tmux session 存在但 isRunning() = false？
  │   └─ 同上逻辑（state = 'stopped'）
  │
  └─ isRunning() = true
      └─ startupGrace = 0, notRunningCount = 0
      └─ 连续运行 > 60s → 重置退避
```

### startAgent() 内部流程

```
startAgent()
  │
  ├─ 1. 并发检查（startAgentInProgress）
  │
  ├─ 2. 维护等待
  │     检测 restart-claude / upgrade-claude / install.sh
  │     等待最多 300s
  │
  ├─ 3. 状态更新
  │     consecutiveRestarts++
  │     startupGrace = 30
  │     notRunningCount = 0
  │     runtimeLaunchAtMs = Date.now()
  │
  ├─ 4. 清理 stale 状态
  │     ├─ clearHeartbeatPending()
  │     ├─ 删除 context temp files
  │     └─ resetToolLifecycleRuntimeState()
  │
  ├─ 5. 启动 runtime
  │     adapter.launch()（fire-and-forget，不 await）
  │
  └─ 6. 启动提示（Claude fallback）
        无 SessionStart hook → enqueueStartupControl()
```

> **行为变更**：移除现有代码中的认证预检（`adapter.checkAuth()`）和 auth 抑制机制。按 D-20，Guardian 无条件拉起，不关心 auth 状态。Auth 检测由 HealthEngine 在 user message 投递后事件驱动完成（见 [health-engine.md](health-engine.md) §2 OK → 非 OK 检测时机）。若 token 失效导致 runtime 启动后立即退出，Guardian 通过退避延迟自然减速。

### 接口定义

```javascript
class Guardian {
  constructor(adapter: RuntimeAdapter, healthEngine: HealthEngine, config: object)
  tick(snapshot: Snapshot): void         // 每次 tick 调用
  async startAgent(): void               // 拉起 runtime（内部方法，tick 触发）
}
```

### 内部状态

```javascript
{
  notRunningCount: number,         // 进程未运行的 tick 计数
  consecutiveRestarts: number,     // 连续重启次数（退避指数）
  stableRunningSince: number,      // 连续运行起始时间（epoch seconds）
  startupGrace: number,            // 启动保护倒计时（ticks）
  startAgentInProgress: boolean,   // 防止并发拉起
  runtimeLaunchAtMs: number,       // 最近一次拉起时间（ms timestamp）
}
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **Adapter** | 调用 | `launch()` | 拉起 runtime |
| **Adapter** | 调用 | `stop()` | kill tmux session（冻结处理由 Orchestrator 调用，不是 Guardian） |
| **Adapter** | 调用 | `isRunning()` | 检测 runtime 进程存活 |
| **HealthEngine** | 调用 | `clearHeartbeatPending()` | 拉起前清除 stale heartbeat |
| **HealthEngine** | **不读取** | `health` / `canRestart()` | D-1, D-20：Guardian 不读 HealthState，不因任何健康状态阻止拉起 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| BASE_RESTART_DELAY | 5s | 初始重启延迟 |
| MAX_RESTART_DELAY | 60s | 最大重启延迟 |
| BACKOFF_RESET_THRESHOLD | 60s | 连续运行多久后重置退避 |
| STARTUP_GRACE_TICKS | 30 | 启动保护 tick 数 |
| MAINTENANCE_WAIT_TIMEOUT | 300s | 维护等待超时 |

## 3. 实施方案

**改动类型**：行为变更

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `activity-monitor.js:568-641` | `startAgent()` — 完整拉起流程 |
| `activity-monitor.js:1809-1937` | monitorLoop offline/stopped 分支 — 检测 + 退避 + 触发拉起 |
| `activity-monitor.js:1940-1952` | running 分支 — 退避重置逻辑 |
| `activity-monitor.js:433-483` | `getRunningMaintenance()` + `waitForMaintenance()` |
| `activity-monitor.js:486-521` | `hasStartupHook()` + `enqueueStartupControl()` |
| `activity-monitor.js:548-561` | `maybeConsumeUserMessageSignal()` |

### 实施步骤

1. 创建 `scripts/guardian.js`
2. 提取 offline/stopped 分支的所有逻辑：进程存活检测、退避计算、拉起触发
3. 提取 `startAgent()` 完整流程：维护等待、状态清理、launch
4. **移除 `adapter.checkAuth()` 认证预检**：现有代码在 `startAgent()` 中调用 `checkAuth()`，失败则跳过拉起并设置 `engine.setHealth('auth_failed')`——这违反 D-20 的无条件拉起原则。Auth 检测改由 HealthEngine 事件驱动（user message 投递后 check tmux pane）
5. **移除 `engine.canRestart()` 调用**：现有代码在拉起前检查 `canRestart()`（rate_limited 时返回 false），这违反 D-20 的"不因任何 HealthState 阻止拉起"
6. **移除 auth 抑制机制**：`authRetrySuppressedUntil` 及关联的 user-message-signal 清除逻辑全部移除
7. 提取辅助函数：`getRunningMaintenance()`、`waitForMaintenance()`、`hasStartupHook()`
8. 内部状态全部为运行时状态，AM 冷启动时重置为零（D-21）
