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

### 接口定义

```javascript
class HealthEngine {
  get health(): string                                   // 当前 HealthState
  get canRestart(): boolean                              // true unless rate_limited

  setHealth(next: string, reason?: string): void         // 状态转移
  enterRateLimited(cooldownUntil: number, resetTime?: string): void

  // 事件触发接口
  onUserMessageDelivered(): void                         // c4-dispatcher 投递成功后异步调用（行为变更）
  notifyUserMessage(currentTime: number): boolean        // 加速 recovery（现有行为保留）

  // Recovery probe 方法（供 MessageRouter 调用）
  async runRecoveryProbe(): ProbeResult                  // 按当前 HealthState 分支执行 probe

  // 进程生命周期事件
  onProcessRestarted(): void                             // Guardian 拉起 runtime 后调用
}
```

```javascript
interface ProbeResult {
  recovered: boolean,
  health: string,             // probe 后的 HealthState
  reason?: string,            // 不健康原因
  userMessage?: string,       // 面向用户的文案
}
```

### HealthState FSM（顶层设计 §3.5）

```
状态：OK, Unavailable, RateLimited, AuthFailed
全连通：OK ↔ Unavailable ↔ RateLimited ↔ AuthFailed
```

| 状态 | 从 OK 转入依据 |
|------|--------------|
| Unavailable | heartbeat 失败（triggerRecovery）；ToolWatchdog 升级 |
| RateLimited | 连续两次 check tmux pane 识别到 rate limit 字符模式 |
| AuthFailed | check tmux pane 识别到 auth failed 字符模式 + check auth 确认 |

### Recovery Probe 方法（顶层设计 §3.2）

| 当前状态 | Probe 方法 | 结果分支 |
|---------|-----------|---------|
| RateLimited | heartbeat probe | ack → OK；无 ack → check tmux pane → rate_limit/auth_failed/Unavailable |
| Unavailable | heartbeat probe | ack → OK；无 ack → check tmux pane → rate_limited/auth_failed/保持 Unavailable |
| AuthFailed | check auth | 通过 → OK；未通过 → 保持 AuthFailed |

### OK → 非 OK 检测时机（行为变更，顶层设计 §3.5）

**现有行为**：主循环 tick 中定时扫描 tmux pane（15s 间隔）+ heartbeat 定时探测。

**目标行为**：改为 user message 事件驱动：
1. c4-dispatcher 投递 user message 后异步调用 `healthEngine.onUserMessageDelivered()`
2. 等待约 5s（给 runtime 处理时间）
3. 执行 check tmux pane，按字符模式匹配：
   - 连续两次 rate limit → RateLimited
   - auth failed + check auth 确认 → AuthFailed
   - 连续两次 corrupted image 等 sticky error → 执行 new session / restart（D-18）
   - 无异常 → 保持 OK

### 内部状态

```javascript
{
  healthState: string,
  recoveringStartedAt: number,         // epoch seconds, 0 when not recovering
  restartFailureCount: number,         // 连续失败次数（退避指数）
  cooldownUntil: number,               // rate limit 冷却截止时间
  rateLimitResetTime: string,          // rate limit 重置时间文案
  apiErrorConsecutiveHits: number,     // 连续 API error 检测计数（需 2 次）
  lastUserMessageRecoveryAt: number,   // 上次 user message recovery 时间
}
```

### 状态持久化（D-10）

health 状态写入 agent-status.json 的 `health` 字段，AM 冷启动时恢复。未知时默认 OK。

### 与其他组件的交互

- **MessageRouter** → 调用 `runRecoveryProbe()` 执行恢复探测
- **c4-dispatcher** → 异步调用 `onUserMessageDelivered()` 触发检测
- **Guardian** → 调用 `onProcessRestarted()` 通知进程已拉起
- **ToolWatchdog** → 升级时触发状态转移到 Unavailable
- **StatusWriter** → 读取 `health` 写入 agent-status.json
- **Adapter** → 调用 `checkAuth()` / `getHeartbeatDeps()` 执行 probe

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| DOWN_DEGRADE_THRESHOLD | 3600s | recovering 超过 1h 降级为 down |
| DOWN_RETRY_INTERVAL | 3600s | down 状态下的定期 probe 间隔 |
| RATE_LIMIT_DEFAULT_COOLDOWN | 3600s | rate limit 默认冷却时间 |
| USER_MESSAGE_RECOVERY_COOLDOWN | 60s | user message recovery 冷却 |
| CHECK_DELAY | 5s | user message 投递后等待时间 |

## 3. 实施方案

**改动类型**：行为变更（D-4：从 tick 移出改为事件驱动）

### 现有代码位置

HealthEngine 逻辑散落在 `activity-monitor.js` 的多个位置：heartbeat 检测、tmux pane 扫描、rate limit 处理、auth 检查等。

### 实施步骤

1. 创建 `scripts/health-engine.js`
2. 提取所有健康状态相关逻辑，按 FSM 重新组织
3. **行为变更**：从 tick 循环定时检测改为 `onUserMessageDelivered()` 事件驱动
4. 复用现有 heartbeat probe、tmux pane 扫描、auth check 逻辑
5. 实现 `runRecoveryProbe()` 供 MessageRouter 调用
6. 实现 sticky error 连续 2 次检测 + restart 逻辑（D-18）
7. 这是行为变更最大的组件，建议在其他纯提取组件完成后再实施
