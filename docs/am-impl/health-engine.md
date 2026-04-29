# HealthEngine

## 1. 组件定义

> 来源：顶层设计 §3.1、§3.5

**职责**：维护 HealthState FSM（OK/Unavailable/RateLimited/AuthFailed）的状态流转逻辑和触发动作。不在主循环 tick 中运行，由外部事件异步触发。

**输入**：c4-dispatcher 的异步调用（user message 投递成功后）；check tmux pane / check auth 的检测结果

**输出**：HealthState 状态流转；触发动作（new session / restart）

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。HealthEngine 不读 ActivityState 决定自身状态。
- **D-2**：HealthState 保持 OK / Unavailable / RateLimited / AuthFailed 四种。诊断信息通过 `agent-status.json` 的 `unavailable_reason` 暴露。
- **D-3**：recovering + down 合并为 Unavailable，对外统一暴露。消费端基于 `unavailable_since` 自行判断。
- **D-4**：HealthEngine 不参与主循环 tick，改为由 user message 事件异步触发。
- **D-10**：Health 状态不区分「首次启动」和「故障恢复」。未知时默认 OK；重启后沿用当前状态。
- **D-16**：Probe 与 restart 解耦。heartbeat/probe 失败不默认触发 restart。
- **D-18**：图片损坏等 sticky API error 保留 adapter.stop() 强制 restart。连续 2 次命中防抖（30s 间隔）。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **状态管理** | HealthState FSM | 4 种状态：OK / Unavailable / RateLimited / AuthFailed |
| | 状态转移 | `setHealth(next, reason)` 带日志记录 |
| | 持久化 | health 写入 agent-status.json（via StatusWriter），冷启动恢复（D-10） |
| **OK → 非 OK 检测** | 事件驱动检测（**行为变更**） | `onUserMessageDelivered()` 由 c4-dispatcher 异步调用 |
| | check tmux pane | 等待 5s 后扫描 tmux pane 字符模式 |
| | rate limit 检测 | 连续两次识别 rate limit 模式 → RateLimited |
| | auth failed 检测 | 识别 auth failed 模式 + `checkAuth()` 确认 → AuthFailed |
| | sticky error 检测 | 连续两次 corrupted image 等 → `adapter.stop()` restart（D-18） |
| **Recovery** | heartbeat probe | 向 runtime 发送 heartbeat 并等待 ack |
| | `runRecoveryProbe()` | 供 MessageRouter 调用，按当前状态分支执行 probe |
| | user message 加速 | `notifyUserMessage()` 清除 cooldown / 重置 backoff |
| | 进程信号加速 | agentRunning false→true + grace period → 立即 probe |
| **RateLimited** | 进入 | `enterRateLimited(cooldownUntil, resetTime)` |
| | cooldown 等待 | 到期后 kill session → recovering → Guardian 拉起 |
| | user message 清除 | `notifyUserMessage()` 将 cooldownUntil 设为 0 |
| **AuthFailed** | 进入 | check tmux pane 识别 auth failed 字符模式 → checkAuth() 确认 → `setHealth('auth_failed')` |
| | 恢复 | check auth 通过 → OK |
| | user message 重试 | 触发立即 recovery probe |
| **Unavailable** | 内部二阶段 | recovering（< 1h）→ down（>= 1h），对外统一为 Unavailable（D-3） |
| | 指数退避 | `min(3600, 60 × 5^(n-1))` → 60s, 300s, 1500s, 3600s cap |
| | DOWN 定期探测 | downRetryInterval(1h) 间隔发送 probe |

### HealthState FSM

```
                   ┌──────────────────────────────────────────┐
                   │            全连通状态机                    │
                   │                                          │
                   │   ┌────┐     heartbeat fail     ┌───────────────┐
                   │   │ OK │ ──────────────────────▶ │ Unavailable   │
                   │   │    │ ◀────────────────────── │ (recovering   │
                   │   └────┘     heartbeat ack       │  → down)      │
                   │     │ ▲                          └───────────────┘
                   │     │ │                               │ ▲
                   │     │ │ check auth OK                 │ │
                   │     │ │                               │ │
                   │     │ │      ┌──────────────┐         │ │
                   │     │ └───── │ AuthFailed   │ ◀───────┘ │
                   │     │        │              │           │
                   │     │        └──────────────┘           │
                   │     │                                   │
                   │     │   rate limit 2x    ┌─────────────┐│
                   │     └──────────────────▶ │ RateLimited ││
                   │                          │             │┘
                   │         cooldown expired  └─────────────┘
                   │         → kill → recovering
                   └──────────────────────────────────────────┘
```

| 状态 | 对外暴露 | 从 OK 转入依据 | 恢复方式 |
|------|---------|--------------|---------|
| OK | `ok` | —（初始状态） | — |
| Unavailable (recovering) | `unavailable` | heartbeat 失败；ToolWatchdog 升级 | heartbeat ack → OK |
| Unavailable (down) | `unavailable` | recovering 超过 1h | 定期 probe ack → OK |
| RateLimited | `rate_limited` | 连续两次 rate limit 模式 | cooldown 到期 kill → recovering → ack → OK |
| AuthFailed | `auth_failed` | auth check 失败 | check auth 通过 → OK |

### Recovery Probe 方法（供 MessageRouter 调用）

| 当前状态 | Probe 方法 | 结果分支 |
|---------|-----------|---------|
| RateLimited | heartbeat probe | ack → OK；无 ack → check tmux → rate_limit/auth_failed/Unavailable |
| Unavailable | heartbeat probe | ack → OK；无 ack → check tmux → rate_limited/auth_failed/保持 Unavailable |
| AuthFailed | check auth | 通过 → OK；未通过 → 保持 AuthFailed |

### OK → 非 OK 检测时机（行为变更）

**现有行为**：主循环 tick 中定时扫描 tmux pane（15s 间隔 API error scan）+ heartbeat 定时探测（30min 间隔）。

**目标行为**：改为 user message 事件驱动：

```
c4-dispatcher 投递 user message
  │
  ▼
healthEngine.onUserMessageDelivered()
  │
  ├─ 等待约 5s（给 runtime 处理时间）
  │
  ├─ 执行 check tmux pane
  │   ├─ 连续两次 rate limit → enterRateLimited()
  │   ├─ auth failed + checkAuth() 确认 → setHealth('auth_failed')
  │   ├─ 连续两次 sticky error → adapter.stop()（D-18）
  │   └─ 无异常 → 保持 OK
  │
  └─ return
```

### 接口定义

```javascript
class HealthEngine {
  constructor(deps: HealthEngineDeps, options: HealthEngineOptions)

  // 状态查询
  get health(): string                    // 当前 HealthState

  // 状态转移
  setHealth(next: string, reason?: string): void
  enterRateLimited(cooldownUntil: number, resetTime?: string): void

  // 事件触发接口
  onUserMessageDelivered(): void          // c4-dispatcher 投递成功后异步调用（行为变更）
  notifyUserMessage(currentTime: number): boolean  // 加速 recovery

  // Recovery probe（供 MessageRouter 调用）
  async runRecoveryProbe(): ProbeResult

  // 进程生命周期事件
  onProcessRestarted(): void              // Guardian 拉起 runtime 后调用

  // 现有接口（过渡期保留）
  processHeartbeat(agentRunning: boolean, currentTime: number): void
  triggerRecovery(reason: string): void
  requestImmediateProbe(reason: string): boolean
}
```

```javascript
interface HealthEngineDeps {
  enqueueHeartbeat(phase: string): boolean
  getHeartbeatStatus(controlId: number): string
  readHeartbeatPending(): { control_id: number, created_at: string, phase: string } | null
  clearHeartbeatPending(): void
  killTmuxSession(): void
  notifyPendingChannels(): void
  log(message: string): void
  detectRateLimit?(): { detected: boolean, cooldownUntil?: number, resetTime?: string }
  detectApiError?(): { detected: boolean, pattern?: string }
}
```

```javascript
interface HealthEngineOptions {
  initialHealth?: string          // default 'ok'
  heartbeatEnabled?: boolean      // default true
  heartbeatInterval?: number      // default 1800 (30min)
  downDegradeThreshold?: number   // default 3600 (1h)
  downRetryInterval?: number      // default 3600 (1h)
  signalGracePeriod?: number      // default 30s
  rateLimitDefaultCooldown?: number // default 3600
  userMessageRecoveryCooldown?: number // default 60
}
```

```javascript
interface ProbeResult {
  recovered: boolean,
  health: string,
  reason?: string,
  userMessage?: string,
}
```

### 内部状态

```javascript
{
  healthState: string,                    // 当前 FSM 状态
  restartFailureCount: number,            // 连续失败次数（退避指数）
  recoveringStartedAt: number,            // epoch seconds（DOWN 降级计时器）
  lastHeartbeatAt: number,                // 上次 heartbeat 时间
  lastRecoveryAt: number,                 // 上次 recovery 尝试时间
  lastDownCheckAt: number,                // 上次 DOWN probe 时间

  // Process signal acceleration
  lastAgentRunning: boolean | null,       // 上一 tick 的 agentRunning
  signalDetectedAt: number,              // false→true 转换检测时间

  // Rate-limited
  cooldownUntil: number,                 // cooldown 截止时间（epoch seconds）
  rateLimitResetTime: string,            // 人类可读重置时间
  lastUserMessageRecoveryAt: number,     // 上次 user message recovery 时间

  // API error scan
  apiErrorConsecutiveHits: number,       // 连续 API error 检测计数（需 2 次）
}
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **Guardian** | **无交互** | — | D-20：Guardian 不持有 HealthEngine 引用，不读写 HealthState。stale heartbeat-pending.json 由 Guardian 直接删除文件 |
| **c4-dispatcher** | 被调用 | `onUserMessageDelivered()` | user message 投递后检测（行为变更） |
| **MessageRouter** | 被调用 | `runRecoveryProbe()` | IPC 路由时执行恢复探测 |
| **ToolWatchdog** | 被调用 | `triggerRecovery(reason)` | 工具超时升级 |
| **StatusWriter** | 读取 | `health`, `rateLimitResetTime`, `cooldownUntil` | 写入 agent-status.json |
| **Adapter** | 调用 | `checkAuth()`, `getHeartbeatDeps()` | 执行认证检查和 heartbeat probe |
| **Adapter** | 调用 | `stop()` (via `killTmuxSession`) | sticky error / recovery 时 kill session |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| HEARTBEAT_INTERVAL | 1800s (30min) | 主要 heartbeat 探测间隔 |
| DOWN_DEGRADE_THRESHOLD | 3600s (1h) | recovering 超过此时间 → down |
| DOWN_RETRY_INTERVAL | 3600s (1h) | down 状态定期 probe 间隔 |
| SIGNAL_GRACE_PERIOD | 30s | 进程信号加速等待期 |
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s (1h) | rate limit 默认冷却 |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | user message recovery 冷却 |
| CHECK_DELAY | 5s | user message 投递后等待时间（新增） |
| API_ERROR_SCAN_INTERVAL | 15s | API error 扫描间隔 |
| MAX_PENDING_AGE | 600s (10min) | pending heartbeat 超时上限 |
| BACKOFF_SEQUENCE | 60s, 300s, 1500s, 3600s | `min(3600, 60 × 5^(n-1))` |

## 3. 实施方案

**改动类型**：行为变更（D-4：从 tick 移出改为事件驱动）

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `scripts/heartbeat-engine.js`（449行） | HeartbeatEngine class — 完整 FSM + heartbeat 处理 |
| `scripts/heartbeat-config.js`（15行） | `isRuntimeHeartbeatEnabled()` |
| `activity-monitor.js:2081-2127` | monitorLoop 中的 API error scan + periodic probe + rate limit 检测 |
| `activity-monitor.js:2087-2089` | user message signal 消费 |
| `activity-monitor.js:2173-2197` | init 中的 HeartbeatEngine 实例化 + state 恢复 |

### 实施步骤

1. 创建 `scripts/health-engine.js`，基于现有 `heartbeat-engine.js` 重构
2. **行为变更**：新增 `onUserMessageDelivered()` 方法，实现事件驱动检测
   - 等待 5s → check tmux pane → 按模式分支转移状态
   - 连续 2 次 rate limit / sticky error 的计数逻辑
3. 新增 `runRecoveryProbe()` 方法供 MessageRouter 调用
   - 按当前 HealthState 分支：RateLimited/Unavailable → heartbeat probe；AuthFailed → check auth
4. 新增 `onProcessRestarted()` 方法供 Guardian 调用
5. 保留现有 `processHeartbeat()` 作为过渡期 heartbeat 处理
6. 将 monitorLoop 中散落的 API error scan、periodic probe 逻辑收拢到 HealthEngine 内部
7. **这是行为变更最大的组件**，建议在其他纯提取组件完成后再实施
