# HealthEngine

## 1. 组件定义

> 来源：顶层设计 §3.1、§3.5

**职责**：维护 HealthState FSM（OK/Unavailable/RateLimited/AuthFailed）的状态流转逻辑和触发动作。不在主循环 tick 中运行，由外部事件异步触发。

**输入**：c4-dispatcher 的异步调用（user message 投递成功后）；check tmux pane / check auth 的检测结果

**输出**：HealthState 状态流转；触发动作（new session / restart）

**边界约束**：
- HealthEngine 不读 ActivityState 决定自身状态（D-1）
- 不参与主循环 tick（D-4），所有状态转移由外部事件或内部定时器驱动
- probe 失败不触发 restart（D-16），restart 由 Guardian 独立决策
- Guardian 不持有 HealthEngine 引用（D-20），两者零交互
- runtime 差异不进入 HealthEngine 分支逻辑（D-38），全部走 Adapter

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交
- **D-2**：HealthState 4 种枚举 + `unavailable_reason` 诊断字段
- **D-3**：对外统一暴露 `unavailable`，消费端基于 `unavailable_since` 自行判断严重程度
- **D-4**：HealthEngine 事件驱动，不参与主循环 tick
- **D-10**：Health 状态持久化到 agent-status.json，冷启动恢复。未知时默认 OK
- **D-16**：Probe 与 restart 解耦
- **D-18**：sticky API error 保留 adapter.stop() 强制 restart，连续 2 次命中防抖（30s 间隔）

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **状态管理** | HealthState FSM | 4 种状态：OK / Unavailable / RateLimited / AuthFailed |
| | 状态转移 | `setHealth(next, reason)` 带日志记录，`ok` 时自动清空 reason 和计数器 |
| | 持久化 | health + healthReason 写入 agent-status.json（via StatusWriter），冷启动恢复（D-10） |
| **OK → 非 OK 检测** | 事件驱动检测 | `onUserMessageDelivered()` 由 c4-dispatcher 异步调用（D-4） |
| | check tmux pane | 等待 CHECK_DELAY(5s) 后扫描 tmux pane 字符模式 |
| | rate limit 检测 | 连续 2 次识别 rate limit 模式 → `enterRateLimited()` |
| | auth failed 检测 | 识别 auth failed 模式 + `checkAuth()` 二次确认 → `setHealth('auth_failed')` |
| | sticky error 检测 | 连续 2 次 corrupted image 等（30s 间隔防抖）→ `stop()` kill session（D-18） |
| **Recovery** | `runRecoveryProbe()` | 供 MessageRouter 调用，按当前状态分支执行 probe，返回 ProbeResult |
| | `sendHeartbeatProbe()` | 内部方法，通过 C4 control queue 发送 heartbeat 并等待 ack |
| | `notifyUserMessage()` | 加速 recovery：清除 cooldown / 重置 backoff |
| | `onProcessRestarted()` | Orchestrator 在 Guardian 拉起 runtime 后调用，重置退避并安排立即 probe |
| **RateLimited** | `enterRateLimited()` | 进入 rate_limited 状态 + 启动 cooldown 计时器 |
| | cooldown 到期处理 | 到期后 `stop()` kill session → `setHealth('unavailable')`，Guardian 下一 tick 拉起 |
| | user message 清除 | `notifyUserMessage()` 将 cooldownUntil 设为 0，跳过剩余 cooldown |
| **AuthFailed** | 进入 | check tmux pane 识别 + `checkAuth()` 二次确认 |
| | 恢复 | `runRecoveryProbe()` 中 `checkAuth()` 通过 → `setHealth('ok')` |
| **Unavailable** | 进入 | ToolWatchdog 升级 restart / RateLimited cooldown 到期 kill / RateLimited recovery probe 无 ack 且 pane 无 rate-limit/auth-failed |
| | 退避 probe | `min(3600, 60 × 5^(n-1))` → 60s, 300s, 1500s, 3600s cap，cap 后固定 3600s 周期重试 |
| | 恢复 | heartbeat ack → `setHealth('ok')` |
| **ToolWatchdog 升级** | `triggerRecovery()` | `setHealth('unavailable')` + `stop()` kill session，Guardian 下一 tick 拉起 |

### HealthState FSM

```
                   ┌──────────────────────────────────────────┐
                   │            全连通状态机                    │
                   │                                          │
                   │   ┌────┐  onUserMessageDelivered  ┌─────────────┐
                   │   │ OK │  检测到异常 ───────────▶  │ Unavailable │
                   │   │    │ ◀────────────────────── │             │
                   │   └────┘   heartbeat ack          └─────────────┘
                   │     │ ▲                               │ ▲
                   │     │ │                               │ │
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
                   │         → kill → Unavailable
                   └──────────────────────────────────────────┘
```

| 状态 | 对外暴露 | 进入条件 | 恢复方式 |
|------|---------|---------|---------|
| OK | `ok` | 初始状态；heartbeat ack；check auth 通过 | — |
| Unavailable | `unavailable` | ToolWatchdog 升级 restart；RateLimited cooldown 到期 kill；RateLimited probe 无 ack 且 pane 无 rate-limit/auth-failed | heartbeat ack → OK |
| RateLimited | `rate_limited` | 连续 2 次 check tmux 识别到 rate limit | cooldown 到期 kill → Unavailable → probe ack → OK |
| AuthFailed | `auth_failed` | check tmux 识别 + checkAuth() 确认 | checkAuth() 通过 → OK |

**跨状态转移**：probe 无 ack 后会 check tmux，可能发现新异常导致跨状态转移（如 Unavailable → RateLimited、Unavailable → AuthFailed）。

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
  (工具超时升级)        │   → setHealth('unavailable') + stop()  │
                       │                                         │
  Orchestrator ────────▶│ onProcessRestarted()                    │
  (Guardian 拉起后代调)  │   → 重置退避 / 安排立即 probe          │
                       │                                         │
  StatusWriter ◀───────│ health / healthReason / cooldownUntil   │
  (tick 末尾读取)       │   / rateLimitResetTime                 │
                       └─────────────────────────────────────────┘
```

三条主路径时序：

```
路径 1：正常检测（OK → 保持 OK）
  c4-dispatcher ─── onUserMessageDelivered() ───▶ sleep 5s → checkTmuxPane()
                                                  → 全 false → 重置 consecutiveHits
                                                  → 保持 OK

路径 2：异常检测 → 状态转移 → recovery
  c4-dispatcher ─── onUserMessageDelivered() ───▶ sleep 5s → checkTmuxPane()
                                                  → rateLimit 2x → enterRateLimited()
  (cooldown 到期)                                 → stop() → setHealth('unavailable')
  (Orchestrator: Guardian 拉起后代调)              → onProcessRestarted() → 安排 probe
  (后续 user msg)
  MessageRouter ─── runRecoveryProbe() ──────────▶ sendHeartbeatProbe()
                                                  → ack → setHealth('ok')
                                                  → 返回 { recovered: true }

路径 3：ToolWatchdog 升级 → kill session → Guardian 拉起 → 恢复
  ToolWatchdog ──── triggerRecovery('tool_timeout') ▶ setHealth('unavailable') + stop()
  (Guardian 检测进程退出, 拉起新 session)
  Orchestrator ──── onProcessRestarted() ───────────▶ 重置 restartFailureCount
                                                     → 安排 CHECK_DELAY 后 probe
                                                     → ack → setHealth('ok')
```

### Recovery Probe 方法（供 MessageRouter 调用）

| 当前状态 | Probe 方法 | ack 结果 | 无 ack 结果 |
|---------|-----------|---------|------------|
| Unavailable | `sendHeartbeatProbe()` | `setHealth('ok')` → `{ recovered: true }` | checkTmuxPane() 检查跨状态转移 → `restartFailureCount++` → `{ recovered: false }` |
| RateLimited | `sendHeartbeatProbe()` | `setHealth('ok')` → `{ recovered: true }` | checkTmuxPane()：仍有 rate-limit → 保持；有 auth-failed → 转 AuthFailed；无异常 → `setHealth('unavailable')` 降级 |
| AuthFailed | `checkAuth()` | `setHealth('ok')` → `{ recovered: true }` | `{ recovered: false, reason: 'auth_still_failed' }` |

### OK → 非 OK 检测流程

事件驱动（D-4）：user message 投递后异步检测，不在主循环 tick 中运行。

**前置条件**：`health === 'ok'`（非 OK 时直接 return，不做重复检测）

```
c4-dispatcher 投递 user message 成功
  │
  ▼
healthEngine.onUserMessageDelivered()
  │
  ├─ 前置检查：health !== 'ok' → return（非 OK 时不做 OK→非OK 检测）
  │
  ├─ await sleep(CHECK_DELAY)           // 5s，给 runtime 处理时间
  │
  ├─ result = deps.checkTmuxPane()      // 扫描 tmux pane 字符模式
  │
  ├─ result.rateLimit === true?
  │   ├─ rateLimitConsecutiveHits++
  │   ├─ hits >= CONSECUTIVE_HITS_THRESHOLD(2)?
  │   │   ├─ YES → enterRateLimited(now + RATE_LIMIT_DEFAULT_COOLDOWN)
  │   │   │        重置 rateLimitConsecutiveHits = 0
  │   │   └─ NO  → return（等下一次 user message 再检测）
  │   └─ return
  │
  ├─ result.authFailed === true?
  │   ├─ authResult = await deps.checkAuth()  // 二次确认，避免误判
  │   ├─ !authResult.ok → setHealth('auth_failed', authResult.reason || 'auth_check_failed')
  │   └─ return
  │
  ├─ result.stickyError === true?
  │   ├─ stickyErrorConsecutiveHits++
  │   ├─ hits == 1? → lastStickyErrorHitAt = now（首次命中，记录基线时间）
  │   ├─ hits >= CONSECUTIVE_HITS_THRESHOLD(2)?
  │   │   ├─ now - lastStickyErrorHitAt < STICKY_ERROR_MIN_INTERVAL(30s)? → return（间隔过短）
  │   │   ├─ YES → deps.stop()           // kill session（D-18）
  │   │   │        重置 stickyErrorConsecutiveHits = 0, lastStickyErrorHitAt = 0
  │   │   │        // 不改 health，Guardian 下一 tick 拉起
  │   │   └─ NO  → return
  │   └─ return
  │
  └─ 全 false → 重置 rateLimitConsecutiveHits = 0, stickyErrorConsecutiveHits = 0
```

**checkTmuxPane 判断优先级**：rateLimit > authFailed > stickyError。每次只匹配第一个命中的分支。

**连续命中计数器语义**：计数器在 `onUserMessageDelivered()` 调用之间累积。类型切换时（如 rateLimit 后 stickyError）重置另一个计数器，防止交替出现的不同异常累积误触发。全 false 时同时重置两个计数器。此跨计数器重置逻辑是实现级别细节，超出顶层设计 D-18 描述范围。

### Unavailable 退避 Probe 策略

Unavailable 是唯一有退避策略的状态。进入后通过 `restartFailureCount` 控制 probe 间隔：

```
进入 Unavailable
  │  （ToolWatchdog 升级 restart / RateLimited cooldown 到期 kill / RateLimited probe 无 ack 降级）
  │  unavailable_since = now()
  │  restartFailureCount = 保持（从前一状态继承，或被 notifyUserMessage/onProcessRestarted 重置为 0）
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 退避 probe 循环                                      │
│                                                     │
│  退避间隔 = min(3600, 60 × 5^(restartFailureCount)) │
│    count=0: 60s                                     │
│    count=1: 300s                                    │
│    count=2: 1500s                                   │
│    count>=3: 3600s (cap，之后固定此间隔周期重试)      │
│                                                     │
│  probe 触发时机（任一满足即执行）：                    │
│    1. MessageRouter 调 runRecoveryProbe()            │
│       （IPC 路由发现 health≠OK，主动触发）           │
│    2. notifyUserMessage() → restartFailureCount=0   │
│       → return true → 调用方触发 runRecoveryProbe() │
│    3. onProcessRestarted() → restartFailureCount=0  │
│       → 安排 CHECK_DELAY 后自动调 runRecoveryProbe()│
│                                                     │
│  probe 结果处理：                                    │
│    ack → setHealth('ok')                            │
│         （restartFailureCount 在 setHealth 中重置）  │
│    无 ack → checkTmuxPane() 检查跨状态转移：         │
│         rateLimit  → enterRateLimited()             │
│         authFailed → checkAuth() → setHealth(...)   │
│         其他       → restartFailureCount++          │
│                      保持 Unavailable               │
└─────────────────────────────────────────────────────┘
```

**注意**：HealthEngine 自身不维护定时器来驱动退避 probe。退避间隔是给 MessageRouter 的参考——MessageRouter 在路由请求时检查是否距上次 probe 已过退避间隔，决定是否触发新 probe。HealthEngine 只响应外部调用。

### 接口定义

```javascript
class HealthEngine {
  constructor(deps: HealthEngineDeps, options: HealthEngineOptions)

  // ── 状态查询（只读 getter）──
  get health(): string                    // 当前 HealthState：'ok'|'unavailable'|'rate_limited'|'auth_failed'
  get healthReason(): string | null       // 当前诊断信息（D-2），health='ok' 时为 null
  get cooldownUntil(): number             // RateLimited cooldown 截止时间（epoch seconds），非 rate_limited 时为 0
  get rateLimitResetTime(): string | null // 人类可读的 rate limit 重置时间
  get unavailableSince(): number          // 进入 Unavailable 的时间（epoch seconds），非 unavailable 时为 0
  get backoffDelay(): number              // 当前退避间隔（秒），供 MessageRouter 判断是否过了退避期

  // ── 状态转移 ──
  setHealth(next: string, reason?: string): void
  enterRateLimited(cooldownUntil: number, resetTime?: string): void

  // ── 事件触发接口（D-4）──
  async onUserMessageDelivered(): void    // c4-dispatcher 投递成功后异步调用
  notifyUserMessage(currentTime: number): boolean  // 加速 recovery，返回 true 表示调用方应触发 probe

  // ── Recovery probe ──
  async runRecoveryProbe(): ProbeResult   // 供 MessageRouter 调用

  // ── 进程生命周期 ──
  onProcessRestarted(): void              // Orchestrator 在 Guardian 拉起 runtime 后代调

  // ── ToolWatchdog escalation ──
  triggerRecovery(reason: string): void   // ToolWatchdog 超时升级
}
```

```javascript
interface HealthEngineDeps {
  // ── 来源: C4 Control（共享基础设施，与 runtime 无关）──
  // 完整 contract 见 contracts.md §2
  enqueueHeartbeat(phase: string): number | false
  //   写入 c4.db control 表: { type:'heartbeat', phase, status:'pending' }
  //   phase: 'recovery' | 'post_restart' — 标识 probe 阶段
  //   返回 control_id（成功）或 false（DB 写入失败）
  //   heartbeat control 必须 bypass health gate（contracts.md §2）

  getHeartbeatStatus(controlId: number): string
  //   读取 c4.db 该 control_id 的 status
  //   返回值：'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'not_found'
  //   'running' = dispatcher 已投递到 tmux，等待 runtime hook ack
  //   'done' = runtime hook 已消费并显式 ack（无 auto-ack）

  // ── 来源: RuntimeAdapter（runtime-specific 实现）──
  checkAuth(): Promise<{ ok: boolean, reason?: string, output?: string }>
  //   执行认证检查（runtime-specific）
  //   ok=true: 认证有效；ok=false: 认证失败，reason 用于 unavailable_reason

  checkTmuxPane(): TmuxCheckResult
  //   扫描 tmux pane 输出，匹配预定义字符模式
  //   返回结构化结果，各字段互斥判定见下方说明

  stop(): void
  //   kill tmux session（adapter.stop()）
  //   调用后 runtime 进程退出，Guardian 下一 tick 检测到并拉起

  // 基础设施
  log(message: string): void
}
```

```javascript
interface TmuxCheckResult {
  rateLimit: boolean,     // 匹配到 rate limit 字符模式（如 "rate limit exceeded"）
  authFailed: boolean,    // 匹配到 auth failed 字符模式（如 "authentication failed"）
  stickyError: boolean,   // 匹配到 sticky error 字符模式（如 "invalid_request_error", corrupted image）
  pattern?: string,       // 匹配到的原始模式文本（日志用）
}
// 注意：多个字段可能同时为 true，但 onUserMessageDelivered 按优先级只处理第一个
```

```javascript
interface HealthEngineOptions {
  initialHealth?: string              // default 'ok'，冷启动时从 agent-status.json 恢复（D-10）
  rateLimitDefaultCooldown?: number   // default 3600 (1h)，rate limit 默认 cooldown 秒数
  userMessageRecoveryCooldown?: number // default 60 (1min)，notifyUserMessage 冷却期
  checkDelay?: number                 // default 5 (5s)，onUserMessageDelivered 等待时间
}
```

```javascript
interface ProbeResult {
  recovered: boolean,     // true = 恢复到 OK，false = 仍异常
  health: string,         // probe 后的 HealthState
  reason?: string,        // 未恢复时的原因（'heartbeat_timeout'|'auth_still_failed'|...）
}
```

### 内部状态

```javascript
{
  // ── FSM 核心 ──
  healthState: string,                    // 当前状态：'ok'|'unavailable'|'rate_limited'|'auth_failed'
  healthReason: string | null,            // D-2 诊断信息，setHealth() 时同步更新

  // ── Unavailable 退避 ──
  restartFailureCount: number,            // 连续 probe 失败次数，决定退避间隔
                                          // 退避公式：min(3600, 60 × 5^count) 秒
  unavailableSince: number,               // 进入 Unavailable 的 epoch seconds（D-3：消费端据此判断严重程度）
  lastRecoveryAt: number,                 // 上次执行 runRecoveryProbe 的 epoch seconds

  // ── RateLimited ──
  cooldownUntil: number,                  // cooldown 截止 epoch seconds，0 表示无 cooldown
  rateLimitResetTime: string | null,      // 人类可读重置时间（如 "2:30 PM"），来自 rate limit 响应头
  cooldownTimer: Timer | null,            // setTimeout 句柄，cooldown 到期时 kill session
  lastUserMessageRecoveryAt: number,      // 上次 notifyUserMessage 的 epoch seconds（冷却期防抖）

  // ── 事件驱动检测计数器 ──
  rateLimitConsecutiveHits: number,       // 连续 checkTmuxPane().rateLimit=true 次数
  stickyErrorConsecutiveHits: number,     // 连续 checkTmuxPane().stickyError=true 次数
                                          // 两个计数器独立，全 false 时同时重置
  lastStickyErrorHitAt: number,           // 首次 stickyError 命中时间（epoch ms），D-18 30s 防抖基线
}
```

**初始值**：

```javascript
{
  healthState: options.initialHealth || 'ok',
  healthReason: null,
  restartFailureCount: 0,
  unavailableSince: 0,
  lastRecoveryAt: 0,
  cooldownUntil: 0,
  rateLimitResetTime: null,
  cooldownTimer: null,
  lastUserMessageRecoveryAt: 0,
  rateLimitConsecutiveHits: 0,
  stickyErrorConsecutiveHits: 0,
  lastStickyErrorHitAt: 0,
}
```

### 核心方法实现逻辑

#### setHealth(next, reason)

状态转移的唯一入口。所有状态变更必须经过此方法。

**前置条件**：`next` 是 4 种合法状态之一
**后置条件**：healthState 和 healthReason 已更新；OK 时所有计数器/时间戳已清零

```javascript
setHealth(next, reason) {
  if (next === this.healthState) return   // 幂等：相同状态不重复处理

  const prev = this.healthState
  this.healthState = next
  this.healthReason = (next === 'ok') ? null : (reason || null)

  // OK：清空所有附加状态（StatusWriter 依赖这些字段为 null/0 来输出干净的 ok 状态）
  if (next === 'ok') {
    this.restartFailureCount = 0
    this.unavailableSince = 0
    this.rateLimitConsecutiveHits = 0
    this.stickyErrorConsecutiveHits = 0
    this.lastStickyErrorHitAt = 0
    this.rateLimitResetTime = null
    this.cooldownUntil = 0
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = null
    }
  }

  // 进入 Unavailable：记录时间戳（D-3：unavailable_since）
  if (next === 'unavailable' && prev !== 'unavailable') {
    this.unavailableSince = now()
  }

  this.deps.log(`health: ${prev} → ${next}` + (reason ? ` (${reason})` : ''))
}
```

#### onUserMessageDelivered()

OK → 非 OK 的唯一检测路径。c4-dispatcher 投递 user message 成功后异步调用。

**前置条件**：无（内部检查 health 状态）
**后置条件**：health 可能从 OK 转移到 rate_limited/auth_failed，或 session 被 kill（sticky error）

```javascript
async onUserMessageDelivered() {
  // 非 OK 时不做 OK→非OK 检测，避免干扰正在进行的 recovery
  if (this.healthState !== 'ok') return

  await sleep(this.options.checkDelay)     // 5s，给 runtime 处理 user message 的时间

  const result = this.deps.checkTmuxPane()

  // 优先级 1：rate limit
  if (result.rateLimit) {
    this.rateLimitConsecutiveHits++
    this.stickyErrorConsecutiveHits = 0    // 类型切换，重置另一个计数器
    if (this.rateLimitConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
      this.rateLimitConsecutiveHits = 0
      this.enterRateLimited(now() + this.options.rateLimitDefaultCooldown)
    }
    return
  }

  // 优先级 2：auth failed
  if (result.authFailed) {
    const authResult = await this.deps.checkAuth()
    if (!authResult.ok) {
      this.setHealth('auth_failed', authResult.reason || 'auth_check_failed')
    }
    // authResult.ok=true：tmux 误判，不转移。重置计数器
    this.rateLimitConsecutiveHits = 0
    this.stickyErrorConsecutiveHits = 0
    return
  }

  // 优先级 3：sticky error（D-18：连续 2 次命中防抖，30s 间隔）
  if (result.stickyError) {
    this.stickyErrorConsecutiveHits++
    this.rateLimitConsecutiveHits = 0      // 类型切换，重置另一个计数器
    if (this.stickyErrorConsecutiveHits === 1) {
      this.lastStickyErrorHitAt = Date.now()  // 首次命中：记录基线时间
    }
    if (this.stickyErrorConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
      // D-18 30s 间隔防抖：第二次命中距首次命中须 >= 30s
      if ((Date.now() - this.lastStickyErrorHitAt) < STICKY_ERROR_MIN_INTERVAL) {
        return  // 间隔过短，等下一次 user message（hits 保持，下次继续检查间隔）
      }
      this.stickyErrorConsecutiveHits = 0
      this.lastStickyErrorHitAt = 0        // 重置，下一轮重新计时
      this.deps.log(`sticky error 2x: ${result.pattern}, killing session (D-18)`)
      this.setHealth('unavailable', 'sticky_context_restart')  // contracts.md §3：先进入 unavailable
      this.deps.stop()
      // 时序：unavailable → stop() → Guardian 下一 tick 检测到 offline → 拉起新 session
      //       → Orchestrator 调 onProcessRestarted() → 安排 probe → 成功回 OK。
      // unavailable 确保 restart 窗口内 MessageRouter 返回 unhealthy 文案（D-8/D-37）。
    }
    return
  }

  // 全 false：无异常，重置所有计数器
  this.rateLimitConsecutiveHits = 0
  this.stickyErrorConsecutiveHits = 0
}
```

#### enterRateLimited(cooldownUntil, resetTime)

进入 RateLimited 状态并启动 cooldown 计时器。

**前置条件**：`cooldownUntil > now()`
**后置条件**：health 为 rate_limited，cooldown 计时器已启动

```javascript
enterRateLimited(cooldownUntil, resetTime) {
  this.cooldownUntil = cooldownUntil
  this.rateLimitResetTime = resetTime || null
  this.setHealth('rate_limited', 'rate_limit_detected')

  // 清除旧计时器（防止重复进入时叠加）
  if (this.cooldownTimer) clearTimeout(this.cooldownTimer)

  // 启动 cooldown 计时器：到期后 kill session，转入 Unavailable
  const delayMs = Math.max(0, (cooldownUntil - now()) * 1000)
  this.cooldownTimer = setTimeout(() => {
    this.cooldownTimer = null
    if (this.healthState !== 'rate_limited') return  // 已被 notifyUserMessage 或其他路径改变
    this.deps.log('rate limit cooldown expired, killing session')
    this.deps.stop()
    this.setHealth('unavailable', 'rate_limit_cooldown_expired')
    // Guardian 下一 tick 检测到进程退出后拉起新 session
  }, delayMs)
}
```

#### runRecoveryProbe()

按当前 HealthState 分支执行 recovery probe。供 MessageRouter 在 IPC 路由时调用。

**前置条件**：`health !== 'ok'`（OK 时不需要 probe）
**后置条件**：health 可能恢复为 OK，或保持/转移到其他非 OK 状态

```javascript
async runRecoveryProbe() {
  this.lastRecoveryAt = now()

  // ── AuthFailed 分支：checkAuth 即可，不需要 heartbeat ──
  if (this.healthState === 'auth_failed') {
    const authResult = await this.deps.checkAuth()
    if (authResult.ok) {
      this.setHealth('ok', 'auth_recovered')
      return { recovered: true, health: 'ok' }
    }
    return { recovered: false, health: 'auth_failed', reason: authResult.reason || 'auth_still_failed' }
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
    const authResult = await this.deps.checkAuth()
    if (!authResult.ok) this.setHealth('auth_failed', authResult.reason || 'auth_check_failed')
  } else if (this.healthState === 'rate_limited') {
    // RateLimited probe 无 ack，且 pane 里已无 rate-limit/auth-failed 模式
    // → 不再保持 rate_limited，降级为 unavailable 进入退避流程
    this.setHealth('unavailable', result.reason || 'heartbeat_timeout')
  }
  // Unavailable + tmux 无新异常：保持当前状态

  this.restartFailureCount++
  return { recovered: false, health: this.healthState, reason: result.reason }
}
```

#### sendHeartbeatProbe(phase) — 内部方法

heartbeat probe 的完整异步实现。通过 C4 control queue 发送 heartbeat 并轮询等待 ack。

**前置条件**：runtime 进程可能存活也可能已死
**后置条件**：返回 `{ ack: true }` 或 `{ ack: false, reason: string }`

```javascript
async sendHeartbeatProbe(phase) {
  // 1. 通过 C4 control channel 入队一条 heartbeat 控制消息
  const controlId = this.deps.enqueueHeartbeat(phase)
  if (!controlId) {
    return { ack: false, reason: 'enqueue_failed' }
  }

  // 2. 轮询等待 ack（间隔 PROBE_POLL_INTERVAL，硬超时 PROBE_TIMEOUT）
  const deadline = Date.now() + PROBE_TIMEOUT
  while (Date.now() < deadline) {
    const status = this.deps.getHeartbeatStatus(controlId)

    if (status === 'done') {
      return { ack: true }
    }
    if (status === 'failed' || status === 'timeout' || status === 'not_found') {
      return { ack: false, reason: `heartbeat_${status}` }
    }
    // 'pending' | 'running' → 继续等待
    await sleep(PROBE_POLL_INTERVAL)
  }

  // 3. 超时（runtime 无响应）
  return { ack: false, reason: 'heartbeat_timeout' }
}
```

**heartbeat 通信机制**：

```
HealthEngine                     C4 control queue (c4.db)        Runtime Agent
    │                                 │                              │
    │ enqueueHeartbeat('recovery')    │                              │
    │ ────────────────────────────▶   │                              │
    │   INSERT {type:'heartbeat',     │                              │
    │    control_id:N, phase, status: │                              │
    │    'pending'}                   │                              │
    │                                 │  runtime hook 轮询 control   │
    │                                 │ ─────────────────────────▶   │
    │                                 │                              │
    │                                 │  ◀──── UPDATE status='done'  │
    │                                 │                              │
    │ getHeartbeatStatus(N)           │                              │
    │ ────────────────────────────▶   │                              │
    │ ◀─── 'done'                     │                              │
    │                                 │                              │
    │ → { ack: true }                 │                              │
```

heartbeat 通过 C4 control queue（c4.db SQLite）传递，不是 HTTP ping。`enqueueHeartbeat()` 写入控制消息，runtime 侧 hook 消费并标记完成。runtime 无响应时 status 保持 pending 直到 PROBE_TIMEOUT。

#### notifyUserMessage(currentTime)

user message 到达时的 recovery 加速。由 MessageRouter 在 `health!=ok && noReply=false` 时调用；`noReply=true` 的系统/内部消息不得调用，避免打破 cooldown 或 backoff。

**前置条件**：调用方已确认当前 health 非 OK，且本次 route request 允许用户可见回复（`noReply=false`）
**后置条件**：返回 true 时调用方应触发 `runRecoveryProbe()`
**冷却期**：USER_MESSAGE_RECOVERY_COOLDOWN(60s) 内多次调用只有第一次生效

```javascript
notifyUserMessage(currentTime) {
  if (this.healthState === 'ok') return false  // OK 时不需要 recovery

  // 冷却期检查：防止短时间内大量 user message 反复触发 probe
  if (currentTime - this.lastUserMessageRecoveryAt < this.options.userMessageRecoveryCooldown) {
    return false
  }
  this.lastUserMessageRecoveryAt = currentTime

  if (this.healthState === 'rate_limited') {
    // 清除 cooldown：用户主动发消息意味着愿意重试，不需要等 cooldown 到期
    this.cooldownUntil = 0
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = null
    }
  }

  // 重置退避：下次 probe 立即执行（不需要等退避间隔）
  this.restartFailureCount = 0
  return true  // 调用方据此触发 runRecoveryProbe()
}
```

#### onProcessRestarted()

Orchestrator 在 Guardian 拉起 runtime 后代调（Guardian 不持有 HealthEngine 引用，D-20）。重置退避并安排一次延迟 probe。

**调用链**：Guardian.tick() 返回 `GuardianResult.attempted_restart=true` → Orchestrator 检测到 → 调用 `healthEngine.onProcessRestarted()`
**前置条件**：runtime 进程刚被 Guardian 拉起
**后置条件**：退避已重置；如果当前非 OK，CHECK_DELAY 后会自动执行 probe

```javascript
onProcessRestarted() {
  this.restartFailureCount = 0
  this.deps.log('process restarted, backoff reset')

  // 如果当前非 OK，安排一次延迟 probe
  // 延迟 CHECK_DELAY 给新 session 启动时间
  if (this.healthState !== 'ok') {
    setTimeout(async () => {
      if (this.healthState !== 'ok') {
        const result = await this.runRecoveryProbe()
        this.deps.log(`post-restart probe: recovered=${result.recovered}, health=${result.health}`)
      }
    }, this.options.checkDelay * 1000)
  }
}
```

#### triggerRecovery(reason)

ToolWatchdog 工具超时升级时调用。直接标记为 Unavailable。

**前置条件**：ToolWatchdog 判定工具超时需要升级
**后置条件**：health 为 unavailable（如果之前是 OK）

```javascript
triggerRecovery(reason) {
  // 只在 OK 时转移：升级意味着 runtime 已无响应
  if (this.healthState === 'ok') {
    this.setHealth('unavailable', reason)
    this.deps.stop()
    // 时序：标记 unavailable → kill session → Guardian 下一 tick 检测到 offline → 拉起新 session
  }
  // 已经是非 OK 时不覆盖，保留原状态和 reason
  // 例如已经是 rate_limited 时不降级为 unavailable
}
```

#### get backoffDelay() — 只读 getter

供 MessageRouter 判断当前退避间隔，决定是否触发 probe。

```javascript
get backoffDelay() {
  // 退避公式：min(3600, 60 × 5^count)
  return Math.min(3600, 60 * Math.pow(5, this.restartFailureCount))
}
// count=0: 60s, count=1: 300s, count=2: 1500s, count>=3: 3600s (cap)
// cap 后固定 3600s 周期重试，不会无限增长
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 触发时机 | 说明 |
|-------|------|----------|---------|------|
| **Guardian** | **无交互** | — | — | D-20：Guardian 不持有 HealthEngine 引用。唯一间接关联：Guardian 拉起后由 Orchestrator 调 `onProcessRestarted()` |
| **Monitor Orchestrator** | 调用 | `onProcessRestarted()` | Guardian 拉起 runtime 后 | Orchestrator 持有 HealthEngine 引用，代为调用 |
| **c4-dispatcher** | 调用 | `onUserMessageDelivered()` | user message 投递成功后 | 异步调用，不等待返回 |
| **MessageRouter** | 调用 | `runRecoveryProbe()` | IPC 路由时 health≠OK | 同步等待 ProbeResult |
| **MessageRouter** | 调用 | `notifyUserMessage()` | `health!=ok && noReply=false` | 返回 true 时接着调 `runRecoveryProbe()` |
| **MessageRouter** | 读取 | `health`, `backoffDelay`, `lastRecoveryAt` | IPC 路由时 | 判断是否过了退避期，决定是否触发 probe |
| **ToolWatchdog** | 调用 | `triggerRecovery(reason)` | 工具超时升级 | 单向通知 |
| **StatusWriter** | 读取 | `health`, `healthReason`, `unavailableSince`, `rateLimitResetTime`, `cooldownUntil` | tick 末尾 | 写入 agent-status.json |
| **RuntimeAdapter** | 被依赖 | `checkAuth()`, `checkTmuxPane()`, `stop()` | probe / 检测时 | runtime-specific 实现，注入到 deps |
| **C4 Control** | 被依赖 | `enqueueHeartbeat()`, `getHeartbeatStatus()` | probe 时 | C4 control queue 读写，与 runtime 无关 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s (1h) | rate limit 默认 cooldown |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | notifyUserMessage 冷却期 |
| CHECK_DELAY | 5s | onUserMessageDelivered / onProcessRestarted 延迟 |
| CONSECUTIVE_HITS_THRESHOLD | 2 | rate limit / sticky error 需连续命中次数 |
| STICKY_ERROR_MIN_INTERVAL | 30000ms (30s) | D-18：两次 stickyError 命中间最小间隔 |
| PROBE_TIMEOUT | 25000ms (25s) | sendHeartbeatProbe 硬超时（对齐顶层设计 router probe budget ≤25s） |
| PROBE_POLL_INTERVAL | 2000ms (2s) | heartbeat status 轮询间隔 |
| BACKOFF_BASE | 60s | 退避基数 |
| BACKOFF_MULTIPLIER | 5 | 退避指数底数 |
| BACKOFF_CAP | 3600s (1h) | 退避上限，cap 后固定此间隔 |

## 3. 实施方案

**改动类型**：行为变更（D-4：事件驱动检测 + 按需 recovery probe）

### 现有代码位置

| 现有位置 | 内容 | 对应新方法 |
|---------|------|-----------|
| `scripts/heartbeat-engine.js`（449行） | HeartbeatEngine class — FSM + tick-based heartbeat | 整体重构为 HealthEngine |
| `scripts/heartbeat-config.js`（15行） | `isRuntimeHeartbeatEnabled()` | 删除（不再有 tick-based heartbeat 开关） |
| `activity-monitor.js:2081-2127` | monitorLoop 中的 API error scan + periodic probe + rate limit 检测 | `onUserMessageDelivered()` 替代 |
| `activity-monitor.js:2087-2089` | user message signal 消费（tick 中读取 signal file） | `notifyUserMessage()` 替代（由 MessageRouter 调用） |
| `activity-monitor.js:2173-2197` | init 中的 HeartbeatEngine 实例化 + state 恢复 | HealthEngine 构造 + D-10 冷启动恢复 |

### 实施步骤

1. 创建 `scripts/health-engine.js`，按本文档接口定义和实现逻辑编写
2. 实现 `setHealth()` — FSM 转移 + reason + 计数器清零
3. 实现 `onUserMessageDelivered()` — 事件驱动检测
4. 实现 `enterRateLimited()` — cooldown 计时器
5. 实现 `sendHeartbeatProbe()` + `runRecoveryProbe()` — async probe 流程
6. 实现 `notifyUserMessage()` + `onProcessRestarted()` + `triggerRecovery()` — 外部事件响应
7. 实现只读 getter：health/healthReason/cooldownUntil/rateLimitResetTime/unavailableSince/backoffDelay
8. 删除 `heartbeat-engine.js` 和 `heartbeat-config.js`
9. 删除 monitorLoop 中的 API error scan、periodic probe、user message signal 消费逻辑
10. **这是行为变更最大的组件**，建议在其他纯提取组件完成后再实施
