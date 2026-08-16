# Guardian

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：守护 runtime 进程存活：检测进程退出后无条件拉起，拉起失败时按退避策略递增延迟重试。

**输入**：snapshot、guardian 内部状态（上次拉起时间、连续失败计数）

**输出**：调用 Runtime Adapter 拉起 runtime

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。Guardian 不读 HealthState 决定是否拉起。
- **D-5/D-38**：业务模块不做 runtime 分支判断，所有 Claude / Codex 差异通过 Adapter DI 注入。
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
| | stale 状态清理 | 拉起前调用 `adapter.clearStaleState()` 清除上一 session 的残留文件（heartbeat-pending、context temp files） |
| | tool 状态重置 | 拉起前调用 `deps.resetToolLifecycleState()` 重置 tool lifecycle / watchdog / api-activity |
| | 启动提示注入 | 调用 `adapter.enqueueStartupPrompt()` 注入启动提示（D-5：差异封装在 adapter 内，Guardian 不做 runtime 分支判断） |
| **退避** | 指数退避 | `delay = min(5s × 2^n, 60s)` → 序列 5, 10, 20, 40, 60, 60... |
| | 退避重置 | runtime 连续运行超过 60s → 重置 consecutiveRestarts |
| **保护** | 启动保护 | 拉起后 30 ticks 跳过 offline 检测（D-33） |
| | 维护等待 | 检测到 restart-claude/upgrade-claude/install.sh 运行中 → 等待完成（最多 300s） |
| | 并发保护 | `startAgentInProgress` flag 防止并发拉起 |

### 拉起决策流程

```
Guardian.tick() 每 tick：
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
  │     ├─ adapter.clearStaleState()
  │     │   （删除 heartbeat-pending.json、context temp files 等 runtime 相关残留）
  │     └─ deps.resetToolLifecycleState()
  │         （重置 tool lifecycle + watchdog + api-activity + hook state）
  │
  ├─ 5. 启动 runtime
  │     adapter.launch()（fire-and-forget，不 await，reject 只 log）
  │
  └─ 6. 启动提示
        adapter.enqueueStartupPrompt()
        （Claude: 检测 SessionStart hook 存在 → noop；不存在 → C4 control fallback）
        （Codex: 自带 bootstrap prompt，noop）
```

> **行为变更**：
> 1. 移除现有代码中的认证预检（`adapter.checkAuth()`）和 auth 抑制机制。按 D-20，Guardian 无条件拉起，不关心 auth 状态。Auth 检测由 HealthEngine 在 user message 投递后事件驱动完成（见 [health-engine.md](health-engine.md) §2 OK → 非 OK 检测时机）。若 token 失效导致 runtime 启动后立即退出，Guardian 通过退避延迟自然减速。
> 2. 现有代码中的启动提示逻辑包含 `adapter.runtimeId === 'claude'` 分支判断，违反 D-5/D-38。改为 `adapter.enqueueStartupPrompt()`，runtime 差异封装在 adapter 内部。
> 3. 现有代码通过 `engine.deps.clearHeartbeatPending()` 绕道 HealthEngine 删除 heartbeat-pending.json。改为 `adapter.clearStaleState()`，runtime 特定的文件清理封装在 adapter 内部。

### 失败语义与退避触发

`adapter.launch()` 是 fire-and-forget：调用后不等待结果，Promise reject 只记日志。Guardian 不通过 launch 的返回值判断成功或失败。

**退避的驱动力是"进程不在"的持续观测，不是 launch 的返回值：**

1. `startAgent()` 调用时立即 `consecutiveRestarts++`，计算 `restartDelay = min(5s × 2^n, 60s)`
2. 调用 `adapter.launch()`，不 await
3. 设置 `startupGrace = 30`（30 ticks 内不检测进程）
4. grace 期结束后，若进程仍不存在 → `notRunningCount` 每 tick +1
5. `notRunningCount >= restartDelay` 时触发下一次 `startAgent()`
6. 若 runtime 连续运行超过 60s → `consecutiveRestarts` 重置为 0

即：launch 成功但进程很快退出、launch Promise reject、tmux 创建失败——对 Guardian 来说都是同一种情况：下次检测时进程不在，继续走退避重试。

### 接口定义

```javascript
class Guardian {
  constructor(adapter: RuntimeAdapter, deps: GuardianDeps)
  tick(snapshot: Snapshot): GuardianResult
  async startAgent(): void               // 内部方法，tick 触发
}
```

```javascript
interface GuardianDeps {
  resetToolLifecycleState(): void         // 重置 tool lifecycle + watchdog + api-activity
  log(message: string): void
}
```

```javascript
interface GuardianResult {
  state: 'offline' | 'stopped' | 'running',
  attempted_restart: boolean,             // 本次 tick 是否尝试了拉起
  runtimeLaunchAtMs: number,              // 最近一次拉起时间（供 StatusWriter 使用）
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
| **Adapter** | 调用 | `isRunning()` | 检测 runtime 进程存活 |
| **Adapter** | 调用 | `clearStaleState()` | 拉起前清除 runtime 相关残留文件 |
| **Adapter** | 调用 | `enqueueStartupPrompt()` | 注入启动提示（runtime 差异封装在 adapter 内） |
| **Adapter** | 读取 | `sessionName` | tmux has-session 检测 |
| **ToolPipeline** | 间接 | `deps.resetToolLifecycleState()` | 拉起前重置 tool 状态（由 Orchestrator 注入） |
| **HealthEngine** | **无交互** | — | D-1, D-20：Guardian 不持有 HealthEngine 引用，不读写 HealthState |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| BASE_RESTART_DELAY | 5s | 初始重启延迟（ticks） |
| MAX_RESTART_DELAY | 60s | 最大重启延迟（ticks） |
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
| `activity-monitor.js:548-561` | `maybeConsumeUserMessageSignal()`（移除） |

### 实施步骤

1. 创建 `scripts/guardian.js`
2. 提取 offline/stopped 分支的所有逻辑：进程存活检测、退避计算、拉起触发
3. 提取 `startAgent()` 完整流程：维护等待、状态清理、launch
4. **移除 `adapter.checkAuth()` 认证预检**：现有代码在 `startAgent()` 中调用 `checkAuth()`，失败则跳过拉起并设置 `engine.setHealth('auth_failed')`——这违反 D-20 的无条件拉起原则。Auth 检测改由 HealthEngine 事件驱动（user message 投递后 check tmux pane）
5. **移除 `engine.canRestart()` 调用**：现有代码在拉起前检查 `canRestart()`（rate_limited 时返回 false），这违反 D-20 的"不因任何 HealthState 阻止拉起"
6. **移除 auth 抑制机制**：`authRetrySuppressedUntil` 及关联的 user-message-signal 清除逻辑全部移除
7. **新增 `adapter.clearStaleState()`**：将现有的 `engine.deps.clearHeartbeatPending()` + context temp files 删除合并为 adapter 方法（见 [runtime-adapter.md](runtime-adapter.md)）
8. **新增 `adapter.enqueueStartupPrompt()`**：将现有的 `runtimeId === 'claude'` + `hasStartupHook()` + `enqueueStartupControl()` 封装到 adapter 内部（D-5/D-38）
9. 提取辅助函数：`getRunningMaintenance()`、`waitForMaintenance()`
10. 内部状态全部为运行时状态，AM 冷启动时重置为零（D-21）
