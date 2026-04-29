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
| **OK → 非 OK 检测** | 事件驱动检测 | `onUserMessageDelivered()` 由 c4-dispatcher 异步调用（D-4） |
| | check tmux pane | 等待 5s 后扫描 tmux pane 字符模式 |
| | rate limit 检测 | 连续两次识别 rate limit 模式 → RateLimited |
| | auth failed 检测 | 识别 auth failed 模式 + `checkAuth()` 确认 → AuthFailed |
| | sticky error 检测 | 连续两次 corrupted image 等 → `adapter.stop()` restart（D-18） |
| **Recovery** | heartbeat probe | 向 runtime 发送 heartbeat 并等待 ack |
| | `runRecoveryProbe()` | 供 MessageRouter 调用，按当前状态分支执行 probe |
| | user message 加速 | `notifyUserMessage()` 清除 cooldown / 重置 backoff |
| | 进程信号加速 | agentRunning false→true + grace period → 立即 probe |
| **RateLimited** | 进入 | `enterRateLimited(cooldownUntil, resetTime)` |
| | cooldown 等待 | 到期后 adapter.stop() → Guardian 下一 tick 拉起新 session（复用 D-18 模式） |
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

### 外部调用交互图

```
                       ┌─────────────────────────────────────────┐
                       │           HealthEngine (FSM)            │
                       │                                         │
  c4-dispatcher ──────▶│ onUserMessageDelivered()                │
  (user msg 投递后)     │   → check tmux → 状态转移              │
                       │                                         │
  MessageRouter ──────▶│ runRecoveryProbe()                      │
  (IPC 路由,health≠OK) │   → heartbeat/checkAuth → ProbeResult  │
                       │                                         │
  MessageRouter ──────▶│ notifyUserMessage()                     │
  (user msg 到达)       │   → 清 cooldown / 重置 backoff         │
                       │                                         │
  ToolWatchdog ───────▶│ triggerRecovery(reason)                 │
  (工具超时升级)        │   → setHealth('unavailable')           │
                       │                                         │
  Guardian ───────────▶│ onProcessRestarted()                    │
  (拉起 runtime 后)     │   → 重置退避 / 立即 probe              │
                       │                                         │
  StatusWriter ◀───────│ health / healthReason / cooldownUntil   │
  (tick 末尾读取)       │   / rateLimitResetTime                 │
                       └─────────────────────────────────────────┘
```

三条主路径时序：

```
路径 1：正常检测（OK → 保持 OK）
  c4-dispatcher ─── onUserMessageDelivered() ───▶ sleep 5s → checkTmuxPane()
                                                  → 无异常 → 保持 OK
                                                  → 下次 tick StatusWriter 读 health=ok

路径 2：异常检测 → 状态转移 → recovery
  c4-dispatcher ─── onUserMessageDelivered() ───▶ sleep 5s → checkTmuxPane()
                                                  → 2x rate limit → enterRateLimited()
  (后续 user msg)
  MessageRouter ─── runRecoveryProbe() ──────────▶ heartbeat probe
                                                  → ack → setHealth('ok')
                                                  → 返回 { recovered: true }

路径 3：ToolWatchdog 升级 → Guardian 拉起 → 恢复
  ToolWatchdog ──── triggerRecovery('tool_timeout') ▶ setHealth('unavailable')
  Guardian ──────── onProcessRestarted() ───────────▶ 重置退避 → 立即 probe
                                                     → ack → setHealth('ok')
```

### Recovery Probe 方法（供 MessageRouter 调用）

| 当前状态 | Probe 方法 | 结果分支 |
|---------|-----------|---------|
| RateLimited | heartbeat probe | ack → OK；无 ack → check tmux → rate_limit/auth_failed/Unavailable |
| Unavailable | heartbeat probe | ack → OK；无 ack → check tmux → rate_limited/auth_failed/保持 Unavailable |
| AuthFailed | check auth | 通过 → OK；未通过 → 保持 AuthFailed |

### OK → 非 OK 检测时机

事件驱动（D-4）：user message 投递后异步检测，不在主循环 tick 中运行。

```
c4-dispatcher 投递 user message
  │
  ▼
healthEngine.onUserMessageDelivered()
  │
  ├─ 等待约 5s（给 runtime 处理时间）
  │
  ├─ 执行 checkTmuxPane()
  │   ├─ rateLimit=true → rateLimitConsecutiveHits++
  │   │   └─ hits >= 2 → enterRateLimited()，重置 hits
  │   ├─ authFailed=true → checkAuth()
  │   │   └─ auth 确实失败 → setHealth('auth_failed')
  │   ├─ stickyError=true → stickyErrorConsecutiveHits++
  │   │   └─ hits >= 2 → stop()，重置 hits（D-18）
  │   └─ 全 false → 重置所有 consecutiveHits
  │
  └─ return
```

### Unavailable 内部状态流程

Unavailable 内部分 recovering 和 down 两阶段，对外统一暴露为 `health: 'unavailable'`（D-3）。

```
进入 Unavailable（heartbeat fail / ToolWatchdog 升级 / RateLimited cooldown kill）
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ RECOVERING 阶段（recoveringStartedAt < 1h）          │
│                                                     │
│  退避策略：min(3600, 60 × 5^(n-1))                  │
│    n=1: 60s → n=2: 300s → n=3: 1500s → n=4: 3600s │
│                                                     │
│  触发 probe 的时机：                                  │
│    1. MessageRouter 调 runRecoveryProbe()            │
│    2. notifyUserMessage() 重置 backoff 后立即 probe   │
│    3. onProcessRestarted() 重置退避后立即 probe       │
│                                                     │
│  probe 结果：                                        │
│    ack → setHealth('ok')，重置 restartFailureCount   │
│    无 ack → restartFailureCount++，下次退避更长       │
│    无 ack + check tmux 发现新异常 → 跨状态转移        │
│                                                     │
│  降级判定：now - recoveringStartedAt >= 1h           │
│    → 进入 DOWN                                       │
├─────────────────────────────────────────────────────┤
│ DOWN 阶段（recoveringStartedAt >= 1h）               │
│                                                     │
│  定期探测：每 downRetryInterval(1h) 发 heartbeat     │
│    lastDownCheckAt + interval <= now → probe         │
│                                                     │
│  probe 结果：同 recovering（ack → OK，无 ack → 保持）│
│                                                     │
│  notifyUserMessage() / onProcessRestarted()          │
│    → 同样可触发立即 probe                             │
└─────────────────────────────────────────────────────┘
```

### 接口定义

```javascript
class HealthEngine {
  constructor(deps: HealthEngineDeps, options: HealthEngineOptions)

  // 状态查询
  get health(): string                    // 当前 HealthState
  get healthReason(): string | null       // 当前诊断信息（D-2），health=ok 时为 null

  // 状态转移
  setHealth(next: string, reason?: string): void
  enterRateLimited(cooldownUntil: number, resetTime?: string): void

  // 事件触发接口（D-4）
  onUserMessageDelivered(): void          // c4-dispatcher 投递成功后异步调用
  notifyUserMessage(currentTime: number): boolean  // 加速 recovery

  // Recovery probe（供 MessageRouter 调用）
  async runRecoveryProbe(): ProbeResult

  // 进程生命周期事件
  onProcessRestarted(): void              // Guardian 拉起 runtime 后调用

  // ToolWatchdog escalation
  triggerRecovery(reason: string): void
}
```

```javascript
interface HealthEngineDeps {
  // Heartbeat probe（runRecoveryProbe / onUserMessageDelivered 内部使用）
  enqueueHeartbeat(phase: string): boolean
  getHeartbeatStatus(controlId: number): string

  // Runtime 操作
  checkAuth(): Promise<boolean>
  checkTmuxPane(): { rateLimit: boolean, authFailed: boolean, stickyError: boolean, pattern?: string }
  stop(): void                    // adapter.stop()，kill session

  // 基础设施
  log(message: string): void
}
```

```javascript
interface HealthEngineOptions {
  initialHealth?: string          // default 'ok'
  downDegradeThreshold?: number   // default 3600 (1h)
  downRetryInterval?: number      // default 3600 (1h)
  rateLimitDefaultCooldown?: number // default 3600
  userMessageRecoveryCooldown?: number // default 60
  checkDelay?: number             // default 5s, onUserMessageDelivered() 等待时间
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
  healthReason: string | null,            // 当前诊断信息（D-2），setHealth() 时同步保存
  restartFailureCount: number,            // 连续失败次数（退避指数）
  recoveringStartedAt: number,            // epoch seconds（DOWN 降级计时器）
  lastRecoveryAt: number,                 // 上次 recovery probe 时间
  lastDownCheckAt: number,                // 上次 DOWN 定期 probe 时间

  // Rate-limited
  cooldownUntil: number,                 // cooldown 截止时间（epoch seconds）
  rateLimitResetTime: string,            // 人类可读重置时间
  lastUserMessageRecoveryAt: number,     // 上次 user message recovery 时间

  // 事件驱动检测（onUserMessageDelivered）
  rateLimitConsecutiveHits: number,      // 连续 rate limit 检测计数（需 2 次）
  stickyErrorConsecutiveHits: number,    // 连续 sticky error 检测计数（需 2 次，D-18）
}
```

### 核心方法实现逻辑

#### setHealth(next, reason)

```javascript
setHealth(next, reason) {
  if (next === this.healthState) return

  const prev = this.healthState
  this.healthState = next
  this.healthReason = (next === 'ok') ? null : (reason || null)

  if (next === 'ok') {
    this.restartFailureCount = 0
    this.recoveringStartedAt = 0
    this.rateLimitConsecutiveHits = 0
    this.stickyErrorConsecutiveHits = 0
  }

  if (next === 'unavailable' && prev !== 'unavailable') {
    this.recoveringStartedAt = now()
  }

  this.deps.log(`health: ${prev} → ${next}` + (reason ? ` (${reason})` : ''))
}
```

#### onUserMessageDelivered()

```javascript
async onUserMessageDelivered() {
  if (this.healthState !== 'ok') return   // 非 OK 时不做 OK→非OK 检测

  await sleep(this.options.checkDelay)     // 5s

  const result = this.deps.checkTmuxPane()

  if (result.rateLimit) {
    this.rateLimitConsecutiveHits++
    if (this.rateLimitConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
      this.rateLimitConsecutiveHits = 0
      this.enterRateLimited(now() + this.options.rateLimitDefaultCooldown)
    }
    return
  }

  if (result.authFailed) {
    const authOk = await this.deps.checkAuth()
    if (!authOk) {
      this.setHealth('auth_failed', 'auth_check_failed')
    }
    return
  }

  if (result.stickyError) {
    this.stickyErrorConsecutiveHits++
    if (this.stickyErrorConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
      this.stickyErrorConsecutiveHits = 0
      this.deps.log(`sticky error 2x: ${result.pattern}, killing session (D-18)`)
      this.deps.stop()
      // Guardian 下一 tick 拉起，不在这里改 health
    }
    return
  }

  // 无异常 → 重置计数器
  this.rateLimitConsecutiveHits = 0
  this.stickyErrorConsecutiveHits = 0
}
```

#### enterRateLimited(cooldownUntil, resetTime)

```javascript
enterRateLimited(cooldownUntil, resetTime) {
  this.cooldownUntil = cooldownUntil
  this.rateLimitResetTime = resetTime || null
  this.setHealth('rate_limited', 'rate_limit_detected')

  // 启动 cooldown 计时器
  const delay = Math.max(0, cooldownUntil - now())
  setTimeout(() => {
    if (this.healthState !== 'rate_limited') return  // 已被 notifyUserMessage 清除
    this.deps.log('rate limit cooldown expired, killing session (D-18 pattern)')
    this.deps.stop()
    this.setHealth('unavailable', 'rate_limit_cooldown_expired')
    // Guardian 下一 tick 拉起新 session
  }, delay * 1000)
}
```

#### runRecoveryProbe()

```javascript
async runRecoveryProbe() {
  this.lastRecoveryAt = now()

  // ── AuthFailed 分支：checkAuth 即可，不需要 heartbeat ──
  if (this.healthState === 'auth_failed') {
    const authOk = await this.deps.checkAuth()
    if (authOk) {
      this.setHealth('ok', 'auth_recovered')
      return { recovered: true, health: 'ok' }
    }
    return { recovered: false, health: 'auth_failed', reason: 'auth_still_failed' }
  }

  // ── RateLimited / Unavailable 分支：heartbeat probe ──
  const result = await this.sendHeartbeatProbe(this.healthState)

  if (result.ack) {
    this.setHealth('ok', 'heartbeat_recovered')
    return { recovered: true, health: 'ok' }
  }

  // 无 ack → check tmux 看是否有新异常（可能跨状态转移）
  const tmux = this.deps.checkTmuxPane()
  if (tmux.rateLimit && this.healthState !== 'rate_limited') {
    this.enterRateLimited(now() + this.options.rateLimitDefaultCooldown)
  } else if (tmux.authFailed) {
    const authOk = await this.deps.checkAuth()
    if (!authOk) this.setHealth('auth_failed', 'auth_check_failed')
  }

  this.restartFailureCount++
  return { recovered: false, health: this.healthState, reason: result.reason }
}
```

#### sendHeartbeatProbe(phase) — 内部方法

heartbeat probe 的完整异步实现。现有代码中这是 tick-based 的多轮轮询（processHeartbeat 每 tick 检查 pending 文件），新实现改为单次 async 调用。

```javascript
async sendHeartbeatProbe(phase) {
  // 1. 通过 C4 control channel 入队一条 heartbeat 控制消息
  //    enqueueHeartbeat 写入 c4.db control queue，runtime hook 会消费并写 ack
  const controlId = this.deps.enqueueHeartbeat(phase)
  if (!controlId) {
    return { ack: false, reason: 'enqueue_failed' }
  }

  // 2. 轮询等待 ack（间隔 2s，硬超时 PROBE_TIMEOUT）
  //    getHeartbeatStatus 查 c4.db 该 control_id 的状态
  //    状态值：'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'not_found'
  const deadline = Date.now() + PROBE_TIMEOUT
  while (Date.now() < deadline) {
    const status = this.deps.getHeartbeatStatus(controlId)

    if (status === 'done') {
      return { ack: true }
    }
    if (status === 'failed' || status === 'timeout' || status === 'not_found') {
      return { ack: false, reason: `heartbeat_${status}` }
    }
    // 'pending' / 'running' → 继续等待
    await sleep(PROBE_POLL_INTERVAL)
  }

  // 3. 超时
  return { ack: false, reason: 'heartbeat_timeout' }
}
```

**heartbeat 机制说明**：

```
HealthEngine                     C4 control queue                Runtime Agent
    │                                 │                              │
    │ enqueueHeartbeat('recovery')    │                              │
    │ ────────────────────────────▶   │                              │
    │   写入 {type:'heartbeat',       │                              │
    │    control_id, phase}           │                              │
    │                                 │  runtime hook 读取 control   │
    │                                 │ ─────────────────────────▶   │
    │                                 │                              │
    │                                 │  ◀──── ack (status='done')   │
    │                                 │                              │
    │ getHeartbeatStatus(controlId)   │                              │
    │ ────────────────────────────▶   │                              │
    │ ◀─── 'done'                     │                              │
    │                                 │                              │
    │ → recovered!                    │                              │
```

heartbeat 不是 HTTP ping — 它通过 C4 control queue（c4.db SQLite）传递。`enqueueHeartbeat()` 写入一条控制消息，runtime 侧的 hook 消费该消息并标记完成。如果 runtime 无响应（卡死/崩溃），status 会保持 pending 直到超时。

#### notifyUserMessage(currentTime)

```javascript
notifyUserMessage(currentTime) {
  if (this.healthState === 'ok') return false

  // 冷却期检查
  if (currentTime - this.lastUserMessageRecoveryAt < this.options.userMessageRecoveryCooldown) {
    return false
  }
  this.lastUserMessageRecoveryAt = currentTime

  if (this.healthState === 'rate_limited') {
    // 清除 cooldown，用户消息意味着愿意重试
    this.cooldownUntil = 0
  }

  // 重置退避，允许立即 probe
  this.restartFailureCount = 0
  return true  // 调用方可据此触发 runRecoveryProbe()
}
```

#### onProcessRestarted()

```javascript
onProcessRestarted() {
  // Guardian 拉起 runtime 后调用
  // 重置退避计数，让下次 probe 立即执行
  this.restartFailureCount = 0
  this.deps.log('process restarted, backoff reset')

  // 如果当前非 OK，安排一次立即 probe（等 grace period）
  if (this.healthState !== 'ok') {
    setTimeout(() => {
      if (this.healthState !== 'ok') {
        this.runRecoveryProbe()
      }
    }, this.options.checkDelay * 1000)
  }
}
```

#### triggerRecovery(reason)

```javascript
triggerRecovery(reason) {
  // ToolWatchdog 超时升级调用
  // 直接标记为 unavailable，不 probe（因为升级意味着 runtime 已经无响应）
  if (this.healthState === 'ok') {
    this.setHealth('unavailable', reason)
  }
  // 已经是非 OK 状态时，不覆盖（保留原状态信息）
}
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **Guardian** | **无交互** | — | D-20：Guardian 不持有 HealthEngine 引用，不读写 HealthState。stale heartbeat-pending.json 由 Guardian 直接删除文件 |
| **c4-dispatcher** | 被调用 | `onUserMessageDelivered()` | user message 投递后异步检测（D-4） |
| **MessageRouter** | 被调用 | `runRecoveryProbe()` | IPC 路由时执行恢复探测 |
| **ToolWatchdog** | 被调用 | `triggerRecovery(reason)` | 工具超时升级 |
| **StatusWriter** | 读取 | `health`, `healthReason`, `rateLimitResetTime`, `cooldownUntil` | 写入 agent-status.json |
| **Adapter** | 调用 | `checkAuth()`, `checkTmuxPane()`, `enqueueHeartbeat()` | 认证检查、tmux 扫描、heartbeat probe |
| **Adapter** | 调用 | `stop()` | sticky error / RateLimited cooldown 到期 kill session |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| DOWN_DEGRADE_THRESHOLD | 3600s (1h) | recovering 超过此时间 → down |
| DOWN_RETRY_INTERVAL | 3600s (1h) | down 状态定期 probe 间隔 |
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s (1h) | rate limit 默认冷却 |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | user message recovery 冷却 |
| CHECK_DELAY | 5s | onUserMessageDelivered() 投递后等待时间 |
| CONSECUTIVE_HITS_THRESHOLD | 2 | rate limit / sticky error 需连续命中次数 |
| PROBE_TIMEOUT | 30000ms (30s) | sendHeartbeatProbe 硬超时 |
| PROBE_POLL_INTERVAL | 2000ms (2s) | heartbeat status 轮询间隔 |
| BACKOFF_SEQUENCE | 60s, 300s, 1500s, 3600s | `min(3600, 60 × 5^(n-1))` |

## 3. 实施方案

**改动类型**：行为变更（D-4：事件驱动检测 + 按需 recovery probe）

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
2. 实现事件驱动检测 `onUserMessageDelivered()`
   - 等待 5s → check tmux pane → 按模式分支转移状态
   - 连续 2 次 rate limit / sticky error 的计数逻辑
3. 实现 `runRecoveryProbe()` 供 MessageRouter 调用
   - 按当前 HealthState 分支：RateLimited/Unavailable → heartbeat probe；AuthFailed → check auth
4. 实现 `onProcessRestarted()` 供 Guardian 调用
5. 删除 `processHeartbeat()`、periodic probe、API error scan 等 tick-driven 接口
6. **这是行为变更最大的组件**，建议在其他纯提取组件完成后再实施
