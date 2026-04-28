# HealthEngine — 模块实施档

> 关联顶层方案：[v3 §三原则 3 / §四.4 / §五.3 / §六取舍 A-B](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（tick 第 ⑥ 步）
> 上游契约：[`runtime-adapter.md`](runtime-adapter.md)（catalog 数据来源）

---

## 1. 模块职责与边界

### 职责

健康状态机 + 主动探针编排 + API error catalog dispatch。是 v3 出口治理的核心模块。

### 边界

**在 scope 内**：
- 4-state HealthState FSM（OK / Unavailable / RateLimited / AuthFailed）
- 5 触发源（tick / onProcessRestarted / setAuthFailed / triggerRecovery / notifyUserMessage）
- tick() 6 步内部逻辑
- 3 层健康监控编排（ProcSampler 配合）
- **Catalog-driven api-error-check + 5 种 recoveryAction dispatch**
- Unknown error 持续性升级
- Probe 与 restart 的解耦（按 catalog 决定）
- 冷启动 health 回填

**不在 scope 内**：
- 进程拉起（Guardian 职责）
- 工具超时检测（ToolWatchdog 职责）
- catalog 数据本身（adapter 注入）

---

## 2. 输入 / 输出契约

### 输入

| 输入 | 来源 | 性质 |
|---|---|---|
| `tick(signals)` | monitor.js 主循环 | 每秒一次 |
| `onProcessRestarted()` | Guardian restart 完成 | 事件 |
| `setAuthFailed(reason)` | Guardian auth-check 失败 | 事件 |
| `triggerRecovery()` | ToolWatchdog / MessageRouter | 事件 |
| `notifyUserMessage()` | MessageRouter | 事件（加速 probe） |
| `getApiErrorPatterns()` | Adapter（构造时注入）| catalog 数据 |

### 输出

| 输出 | 消费者 | 性质 |
|---|---|---|
| 内存 health 字段（OK / Unavailable / RateLimited / AuthFailed） | StatusWriter（tick 末尾读）| read-only 投射 |
| `unavailable_since` 时间戳 | StatusWriter | 同上 |
| `unavailable_reason` (catalog id) | StatusWriter | 同上 |
| 写 `rate-limit-state.json` | Guardian（条件 #1）| signal 文件 |
| 清 `rate-limit-state.json` | Guardian | 同上 |
| `unknown-api-errors.jsonl` 累积学习 | 人工 weekly review | jsonl |
| `adapter.stop()` 调用 | Adapter | 事件（仅 catalog `restart_session` 路径）|

### 不变量

- **C-HE-1**：HealthState 转换只通过本模块——其他模块只读
- **C-HE-2**：`adapter.stop()` 仅在 catalog 命中 `restart_session` 或 unknown 5min 升级时调用，不在其他 recovery action 路径调用
- **C-HE-3**：`unavailable_reason` 来自 catalog entry id（开放枚举），未知 reason 消费端退化通用文案
- **C-HE-4**：probe 失败 ≠ 自动 restart——按 catalog `recoveryAction` 决定

---

## 3. 数据结构 / 字段 / 状态机

### HealthState FSM

| 状态 | 触发条件 | 恢复路径 |
|---|---|---|
| **OK** | 健康检查通过 | — |
| **Unavailable** | 检查失败，未识别为特定原因 | 指数退避重试（60s → 300s → 1500s → 3600s cap），超 60min 转 3600s 固定间隔 |
| **RateLimited** | 检测到限流文本 + 行为信号 | 冷却到期后进入 Unavailable 恢复流程 |
| **AuthFailed** | 认证探测失败 | 180s 冷却后重试，用户消息到达时立即触发 |

### 转换表

| 从 | 到 | 触发 |
|---|---|---|
| OK | Unavailable | heartbeat probe 失败 / api-error-check 命中 / triggerRecovery 判死 |
| OK | RateLimited | rate-limit-check 命中 |
| OK | AuthFailed | Guardian 调 setAuthFailed |
| Unavailable | OK | recovery probe 成功 |
| Unavailable | RateLimited | 恢复探测时识别出实为限流 |
| RateLimited | Unavailable | 冷却到期 |
| AuthFailed | OK | auth-check 成功 |
| 任意 | (本状态) | onProcessRestarted() 不改 health，只重置退避计时 |

### Catalog Entry 结构

Adapter `getApiErrorPatterns()` 返回数组，每 entry：

```js
{
  id: 'corrupted_context',                    // 唯一标识，落 unavailable_reason
  pattern: /APIError: 400|invalid_request_error/,
  severity: 'sticky' | 'transient' | 'permanent',
  recoveryAction: 'restart_session' | 'probe_only'
                | 'mark_rate_limited' | 'mark_auth_failed' | 'notify_only',
  debounce: 2,                                // 连续 N 次命中才动手
  scanInterval: 30,                           // 秒，可被加速（heartbeat pending 时）
  userMessage: '消息或图片格式有问题，请检查后重发'
}
```

### 5 种 recoveryAction × HealthState + DB 记录路径矩阵

| recoveryAction | HealthState 变更 | adapter.stop()? | DB 记录路径（c4-receive 视角） | terminal_status |
|---|---|---|---|---|
| `restart_session` | OK → Unavailable，写 unavailable_reason | ✅ stop | inbound 既有保留；session 重启后 c4-session-init 注入 pending | restart 前 inbound 维持 `pending`；agent 续接后由 reply 驱动 `replied` |
| `probe_only` | OK → Unavailable，写 unavailable_reason | ❌ | inbound + 立即 outbound 状态文案（c4-receive unhealthy 路径）| inbound 标 `status_replied` |
| `mark_rate_limited` | OK → RateLimited，写 rate-limit-state.json | ❌ | inbound + 立即 outbound 限流文案 | inbound 标 `status_replied` |
| `mark_auth_failed` | OK → AuthFailed | ❌ | inbound + 立即 outbound auth 文案 | inbound 标 `status_replied` |
| `notify_only` | 无变化 | ❌ | 不影响 DB（仅 log + 可选 user 通知）| 不影响 |
| unknown (< 5min) | = `probe_only` 行 | ❌ | 同 | 同 |
| unknown (≥ 5min 升级) | = `restart_session` 行 | ✅ stop | 同 restart_session | 同 restart_session |

### 初始 catalog（PR #501 落地范围）

| id | pattern 关键字 | severity | recoveryAction | userMessage |
|---|---|---|---|---|
| `corrupted_context` | `APIError: 400` / `invalid_request_error` / `422 bad request` | sticky | restart_session | "消息或附件触发 API 错误，请检查后重发" |
| `context_too_long` | `context_length_exceeded` / `prompt is too long` | sticky | restart_session | "对话历史超长——请精简后重发" |
| `transient_overload` | `overloaded_error` / `503 Service Unavailable` | transient | probe_only | "API 暂时繁忙，正在自动重试" |
| `content_filter` | `content_filter_violation` / `harmful` | permanent | notify_only | "请求内容被策略拦截，请调整后重试" |

### 内存状态

```js
class HealthEngine {
  state                       // 'ok' | 'unavailable' | 'rate_limited' | 'auth_failed'
  unavailable_since           // ms timestamp，仅 state='unavailable' 时有意义
  unavailable_reason          // catalog id 或 'unknown'
  unknownErrorStreakCount    // unknown error 连续命中计数
  inflightProbe = null        // 当前 probe Promise
  launchGracePeriodEnd        // 新进程起来 180s 内不主动探
  pendingEvents = []          // drain 用
}
```

---

## 4. 关键接口与调用关系

### tick() 6 步

```
tick(signals):
  ① drain pending events                    # 处理积压的事件
  ② if inLaunchGrace: return                # 新进程 180s 内 no-op
  ③ 被动检测（tmux scan 零成本）
       - 限流文本 → state=RateLimited，写 rate-limit-state.json
       - API error catalog 命中 → 按 entry.recoveryAction 分派：
         ├─ restart_session → adapter.stop() + state=Unavailable + 写 unavailable_reason
         ├─ probe_only → state=Unavailable + 写 unavailable_reason（不 stop）
         ├─ mark_rate_limited → state=RateLimited（不 stop）
         ├─ mark_auth_failed → state=AuthFailed（不 stop）
         └─ notify_only → 仅 log + 可选用户通知，不改 health
       - Unknown error → 默认 probe_only + 写 unknown-api-errors.jsonl
                     + unknownErrorStreakCount++
       - Unknown 连续 10 次（5min）命中 → 升级 recoveryAction = restart_session
  ④ 按当前 state 驱动主动检测
       - OK: 30min heartbeat 安全网（极少 token）
       - Unavailable: 指数退避 probe（按 catalog 决定 probe 失败是否 restart）
       - RateLimited: 查冷却是否到期（到期转 Unavailable）
       - AuthFailed: 180s 后或用户消息触发 auth-check
  ⑤ probe 结果回调更新 state
  ⑥ 若 state 变动：更新内存 + 写/清 rate-limit-state.json
```

### 3 层健康监控（OK 状态下）

| 层 | 间隔 | 检测对象 | Token 成本 |
|---|---|---|---|
| Layer 1（ProcSampler） | 10s | 进程冻结（OS context switch） | 零 |
| Layer 2（tmux scan） | 30s | 限流 / API error / crash 文本 | 零 |
| Layer 3（heartbeat） | 30min | C4 control ack 端到端 | 极少 |

Layer 1+2 覆盖 95% 故障；Layer 3 是"所有看起来正常但不响应 C4"的 safety net。源自 PR #351（2026-03-18）把原来每 3min 的 heartbeat 放宽到 30min。

### triggerRecovery() 门控

防止事件反复触发 probe + restart 循环：

| 当前 state | 行为 |
|---|---|
| OK | no-op |
| RateLimited | 拒绝（返回预计解除时间）|
| Unavailable 且 < 60min | 接受（加入 waitingMessages 聚合）|
| Unavailable 且 ≥ 60min | **拒绝**（退到 3600s 固定节奏，不被事件加速）|
| AuthFailed | 接受 |
| 已有 in-flight probe | 加入 waitingMessages 共享结果 |

### 冷启动 health 回填

Guardian `onProcessRestarted()` 调用后：
- 从 `agent-status.json` 读取持久化 health 回填内存状态（**不强制置 Unavailable**）
- 启动 `launchGracePeriod`（180s）抑制主动探测
- 重置退避计时，clear pending

哲学：磁盘记录 `health: unavailable` 则沿用既有退避计时，避免"重启重置故障认知"。

### Unknown error 持续性升级

- 同一 unknown error pattern 连续 10 次扫描命中（30s × 10 = 5min）→ 升级 recoveryAction = `restart_session`
- 触发原因：probe 在 sticky context 下永远失败（context 没换 → 同样错误反复）；5min 持续命中 = 大概率 sticky 而非 transient → 强制 restart 自愈
- 升级后流程同 restart_session：`adapter.stop()` + Guardian 拉新 session + c4-session-init 注入 pending + agent 自治续接
- 计数重置：任一 catalog hit / state 转出 Unavailable / OK probe 成功
- 升级是兜底**不替代增量学习**——仍写 `unknown-api-errors.jsonl`，weekly review 流程不变

---

## 5. 错误处理与恢复逻辑

### Adapter catalog 加载失败

- 启动时 `getApiErrorPatterns()` 抛错 → fallback 到内置最小 catalog（仅 `corrupted_context` + `transient_overload`）
- log warning，等下次 reload

### Probe 永不 resolve

- HealthEngine 内部 probe timeout（默认 60s）—— 超时记 probe 失败 + state 维持 Unavailable
- 不 hang 主循环 tick

### Catalog 字段名漂移

- catalog entry 必须用 `recoveryAction`——adapter 不得同时支持 `action` alias（避免旧草稿字段漂移）
- 加载时严格 schema 验证：缺字段 / 错字段名 → 拒绝加载该 entry，仅日志 warning

### Heartbeat 永久 pending

- 30min heartbeat probe 没 ack → 进入 Unavailable
- 走标准 Unavailable 退避路径

---

## 6. 迁移策略

### Phase 2 落地

**Step 1**：新建 `health-engine.js` 模块，实现 4-state FSM + 5 触发源 + tick 6 步

**Step 2**：实现 catalog-driven dispatch 逻辑（`getApiErrorPatterns()` 注入 + recoveryAction 5 种分派）

**Step 3**：实现 unknown error 5min 升级路径

**Step 4**：保留 `activity-monitor.legacy.js` 作为回滚路径，PM2 启动参数切换

### 兼容性

- 老 heartbeat-engine 直接 stop+restart 一刀切——新 HealthEngine 按 catalog `recoveryAction` 解耦后行为更细
- `agent-status.json` 加 `unavailable_reason` 字段，向后兼容（可选字段）

### 回滚

- PM2 启动参数切换回 legacy heartbeat-engine
- `unavailable_reason` 字段消费端容忍 missing

---

## 7. 测试策略 + 验收标准

### 单元测试

| 测试 | 描述 |
|---|---|
| FSM 转换全覆盖 | 8 种合法转换都能触发 |
| catalog 5 recoveryAction dispatch | 每个 recoveryAction 触发对应 state 变更 + adapter.stop 行为 |
| Unknown error 5min 升级 | 模拟连续 10 次未匹配 pattern → 升级到 restart_session |
| Unknown 升级后计数重置 | 升级后 state 转 OK → unknownErrorStreakCount 归零 |
| triggerRecovery 60min 门控 | Unavailable ≥ 60min 时 triggerRecovery 拒绝 |
| 冷启动 health 回填 | onProcessRestarted 从 agent-status.json 读 unavailable，不强制重置 |
| Probe / restart 解耦 | rate_limit / auth_failed probe 失败不调 adapter.stop |
| Heartbeat 30min 安全网 | OK 状态长时间无消息 → 30min 一次 heartbeat |

### 集成测试

| 测试 | 描述 |
|---|---|
| restart_session 全链路 | 模拟图 400 → catalog 命中 → state=Unavailable + adapter.stop → Guardian 拉新 → c4-session-init 注入 pending |
| probe_only 全链路 | 模拟 503 → state=Unavailable + 不 stop → c4-receive unhealthy 路径写 outbound 状态文案 |
| mark_rate_limited 全链路 | 模拟限流文本 → state=RateLimited + 写 rate-limit-state.json + Guardian 等冷却 |
| Unknown 升级 → restart 全链路 | 模拟 5min 持续 unknown → 升级 + restart |

### 验收标准

- ✅ 4 种 HealthState 转换 100% 单元测试覆盖
- ✅ 5 种 recoveryAction × 4 HealthState 矩阵 100% 集成测试覆盖
- ✅ Probe / restart 解耦——rate_limit / auth_failed / probe_only 路径 0 次 adapter.stop 调用

---

## 8. 与其他模块的依赖关系

### 上游

- [`runtime-adapter.md`](runtime-adapter.md)：注入 catalog（`getApiErrorPatterns()`）+ `adapter.stop()` / `checkAuth()` 接口
- [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)：tick(signals) 输入 + 写 rate-limit-state.json 给 SignalStore 暴露

### 下游

- [`guardian.md`](guardian.md)：触发 `onProcessRestarted()` / `setAuthFailed()` 事件
- [`message-router.md`](message-router.md)：`triggerRecovery()` / `notifyUserMessage()` 调用
- [`tool-pipeline-watchdog-procsampler.md`](tool-pipeline-watchdog-procsampler.md)：ToolWatchdog 超时触发 `triggerRecovery()`
- [`session-restart-continuation.md`](session-restart-continuation.md)：catalog `restart_session` 路径触发恢复流程

### 不依赖

- TaskScheduler（独立）

---

*v3 R3 review (2026-04-28) 后从 v2.1 §5.3 整段拓展为模块档；保留 catalog-driven dispatch + recoveryAction 5 种 + 5×4 矩阵 + unknown 5min 升级；标注 terminal_status 是 c4-receive 视角的协同字段（HealthEngine 不直接动）。*
