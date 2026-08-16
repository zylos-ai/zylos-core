# HealthEngine — 模块实施档

> 关联顶层方案：[v3 §三.1 / §三.3 / §四.4 / §五.3 / §六.A / §六.G #4 / §六.H](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（tick 第 ⑥ 步）
> Phase：2（状态模型 + 组件拆分）
> 上游契约：[`runtime-adapter.md`](runtime-adapter.md)（catalog 数据来源）

---

## 1. 模块职责与边界

### 职责

健康状态机 + 主动探针编排 + api-error catalog dispatch。是 AM 内部的"什么时候系统 healthy"决策中心。

具体三件事：

1. **维护 4-state FSM**：OK / Unavailable / RateLimited / AuthFailed，按转换规则迁移
2. **主动探针编排**：OK 时跑 30min heartbeat 安全网；Unavailable 时按指数退避跑 recovery probe；其他状态按各自冷却节奏
3. **catalog-driven api-error dispatch**：Layer 2 tmux scan 命中 API error pattern → 按 catalog entry `recoveryAction` 字段分派 5 种动作

### 严格边界

- ❌ **不写 c4 DB**——HealthEngine 只维护内存状态 + 通过 StatusWriter 写 `agent-status.json` 一份；不直接操作 conversations 表（v3 §六.G #4 原则：unhealthy reply 路径走 c4-receive→c4-send，HealthEngine 不参与 DB 写入）
- ❌ **不直接发消息给 user**——AM 不是通信主体；user 通知通过 c4-receive 反应路径触发（v3 §三.4 + [`message-router.md`](message-router.md)）
- ❌ **不调 tmux**——只 read tmux pane content 做 Layer 2 scan，写入由 Adapter `sendMessage` / Guardian 走 c4-control / c4-dispatcher
- ❌ **不维护"已答消息"业务语义**——v3 §六.G #1 明确 C4 不记录消息已回复状态；HealthEngine 不引入 terminal_status / reply_to_inbound_id 等任何"哪条消息回了没"的字段

---

## 2. 输入 / 输出契约

### 输入：5 触发源

| 触发 | 发起方 | 时机 |
|---|---|---|
| `tick(signals)` | 主循环（每秒）| 8 步 tick 第 ⑥ 步 |
| `onProcessRestarted()` | Guardian | restart 成功后 |
| `setAuthFailed(reason)` | Guardian | auth-check 失败时 |
| `triggerRecovery()` | ToolWatchdog / MessageRouter | 工具超时干预 / user 消息触发加速 |
| `notifyUserMessage()` | MessageRouter | user 消息到达（未必触发 probe，看当前 state）|

### 输入：signals（来自 SignalStore）

通过 SignalStore 只读快照消费：
- tmux pane 内容（Layer 2 scan）
- proc-state（进程是否活）
- heartbeat-pending 状态（Layer 3 端到端检测）
- maintenance-state（维护窗口锁）

### 输出

通过 StatusWriter 写 `agent-status.json`：
| 字段 | 取值 |
|---|---|
| `health` | `'ok' / 'unavailable' / 'rate_limited' / 'auth_failed'` |
| `unavailable_since` | 进入 Unavailable 的时间戳（仅 health=unavailable 时出现）|
| `unavailable_reason` | catalog entry id（如 `corrupted_context` / `transient_overload` / `unknown` 等）|
| `schema_version` | 整数（详 [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)） |

写 / 清 `rate-limit-state.json`（Guardian 拉起条件 #1 消费）。

### 单向事件接口

不暴露 getter（v3 §四.2 通信通道：状态走 SignalStore，事件走具名接口）。

---

## 3. 数据结构 / 字段 / 状态机

### 4-state FSM

| 状态 | 触发条件 | 恢复路径 |
|---|---|---|
| **OK** | 健康检查通过 | — |
| **Unavailable** | catalog 命中 `restart_session` / `probe_only` action；或 heartbeat probe 失败；或 triggerRecovery 判死 | 指数退避 recovery probe（60s → 300s → 1500s → 3600s cap）；超 60min 转 3600s 固定间隔 |
| **RateLimited** | catalog 命中 `mark_rate_limited`（限流文本）| 冷却到期后转 Unavailable，进恢复流程 |
| **AuthFailed** | catalog 命中 `mark_auth_failed`；或 Guardian `setAuthFailed()` | 180s 冷却后重试，或 user 消息触发 `notifyUserMessage` 立即触发 auth-check |

### 转换表

| 从 | 到 | 触发 |
|----|----|---|
| OK | Unavailable | heartbeat probe 失败 / api-error catalog 命中 / triggerRecovery 判死 |
| OK | RateLimited | rate-limit-check 命中 |
| OK | AuthFailed | Guardian 调 `setAuthFailed(reason)` |
| Unavailable | OK | recovery probe 成功 |
| Unavailable | RateLimited | 恢复探测时识别出实为限流 |
| RateLimited | Unavailable | 冷却到期 |
| AuthFailed | OK | auth-check 成功 |
| 任意 | 任意（同状态） | `onProcessRestarted()` 不改 health，只重置退避计时 |

### catalog entry 结构（由 Adapter 注入）

每个 entry：
- `id`：唯一标识（落 `unavailable_reason`）
- `pattern`：错误文本匹配规则
- `severity`：sticky / transient / permanent
- `recoveryAction`：5 种取值之一（详 §4 dispatch）
- `debounce`：连续 N 次命中才动手
- `scanInterval`：默认扫描间隔（秒）
- `userMessage`：用户文案（c4-receive 在 unhealthy 路径调 c4-send 投递）

详细 schema 见 [`runtime-adapter.md`](runtime-adapter.md) §3。

### Unknown error 跟踪

内存维护 `unknownErrorStreakCount`：
- 命中 catalog 已知 entry / 进入 OK / 进入非 Unavailable 状态时**重置**
- 同一 unknown pattern 连续 10 次扫描命中（30s × 10 = 5min）→ 升级该 entry 的 `recoveryAction` 为 `restart_session`（v3 §三.3 unknown 升级路径）

落 `unknown-api-errors.jsonl`：每条未匹配命中写一行 `{ts, pane_snippet, current_state}`，weekly review 增补 catalog。

---

## 4. 关键接口与调用关系

### tick() 6 步流程

每秒主循环调一次 `tick(signals)`：

```
① drain pending events                      ← 处理上一秒累积的事件
② if inLaunchGrace: return                  ← 新进程起来 180s 内不主动探
③ Layer 2 tmux scan + catalog dispatch      ← 详见 dispatch 5 路径
④ 按当前 state 驱动主动检测
   ├── OK: 30min heartbeat 安全网
   ├── Unavailable: 指数退避 probe
   ├── RateLimited: 查冷却是否到期
   └── AuthFailed: 180s 后或 user 消息触发 auth-check
⑤ probe 结果回调更新 state
⑥ 若 state 变动: 更新内存 + 写 / 清 rate-limit-state.json
```

### catalog dispatch 5 路径

Layer 2 scan 命中 catalog entry 时按 `recoveryAction` 分派：

| recoveryAction | HealthEngine 行为 | 用户感知（c4-receive 反应路径触发） |
|---|---|---|
| `restart_session` | adapter.stop() → Guardian 拉新 session；进 Unavailable + 写 unavailable_reason | restart 后下一条 user 消息走 c4-receive → 看 health 仍非 OK 或已 OK 决定路径 |
| `probe_only` | 进 Unavailable + 持续 probe；**不 stop** | 同上 |
| `mark_rate_limited` | 进 RateLimited + 写 rate-limit-state.json；**不 stop** | 同上（reason='rate_limited'）|
| `mark_auth_failed` | 进 AuthFailed；**不 stop** | 同上（reason='auth_failed'）|
| `notify_only` | 仅 log + 可选直接通知 user；**不改 health 不 stop** | catalog entry 决定走 c4-send 直发还是仅记录 |

### 5 种 recoveryAction × DB 路径矩阵

> v3 §六.G #4 + §六.H 落地：unhealthy 路径下 user 消息进入 c4-receive 时，由 c4-receive 调 c4-send 投递 catalog.userMessage；HealthEngine **不直接写 DB**。本节展示 user 视角对应行为：

| recoveryAction | HealthState 变更 | Layer 2 命中后用户后续发消息时（c4-receive 看 health 非 OK）|
|---|---|---|
| `restart_session` | OK → Unavailable + adapter.stop() | c4-receive 调 MessageRouter 看 health=非OK → recovered=false → c4-receive 走 unhealthy 路径（`insertConv('in', ..., 'delivered')` + 调 c4-send 投递 unavailable_reason 对应 catalog.userMessage）|
| `probe_only` | OK → Unavailable | 同上 |
| `mark_rate_limited` | OK → RateLimited | 同上（catalog.userMessage 含限流冷却时间）|
| `mark_auth_failed` | OK → AuthFailed | 同上（catalog.userMessage 含 auth 凭证检查提示）|
| `notify_only` | 无变化 | health=OK → c4-receive 走 OK 主链；catalog 的 notify 是侧路（log 或独立 c4-control，不影响主路由）|

**关键**：HealthEngine 不引入"audit 语义"模糊概念——所有"非待投递"行为通过 c4-receive 显式 status='delivered' 覆盖既有字段实现，dispatcher SQL 自然跳过；不引入新字段 `terminal_status`（详 v3 §六.H）。

### 3 层健康监控（OK 状态下）

| 层 | 间隔 | 检测对象 | Token |
|---|---|---|---|
| Layer 1（ProcSampler）| 10s | 进程冻结（OS context switch）| 零 |
| Layer 2（tmux scan）| 30s | 限流 / API error / crash 文本 | 零 |
| Layer 3（heartbeat）| 30min | C4 control ack 端到端 | 极少 |

Layer 1+2 覆盖 95% 故障；Layer 3 是"看起来正常但不响应 C4"的 safety net。

### triggerRecovery() 门控

防止事件反复触发 probe + restart 循环：

| 当前 state | 行为 |
|---|---|
| OK | no-op |
| RateLimited | 拒绝（返回预计解除时间） |
| Unavailable 且 < 60min | 接受（加入 waitingMessages 聚合） |
| Unavailable 且 ≥ 60min | **拒绝**（退到 3600s 固定节奏，不被事件加速） |
| AuthFailed | 接受 |
| 已有 in-flight probe | 加入 waitingMessages 共享结果 |

### 冷启动 health 回填

Guardian `onProcessRestarted()` 调用后：
- 从 `agent-status.json` 读取持久化 `health` 回填内存状态（**不强制置 Unavailable**，避免"重启重置故障认知"）
- 启动 `launchGracePeriod`（180s）抑制主动探测
- 重置退避计时；clear pending events

---

## 5. 错误处理与恢复逻辑

### Probe 失败处理（按 recoveryAction 决定是否触发 stop）

- **`restart_session`** 路径：probe 失败 → 调 `adapter.stop()` 由 Guardian 拉新 session（这是 sticky context-poison 的兜底自愈）
- **其他路径**：probe 失败仅维持 unhealthy state + 文案；**不**调 stop（restart 没意义——比如 rate_limit / auth_failed 重启进程仍是同一限流 / 凭证）

### Unknown error fallback

Layer 2 命中通用 `Error / FATAL / Exception` 但 catalog 未匹配：
- 默认走 `probe_only` 兜底（保守不强 restart）
- 同时写 `unknown-api-errors.jsonl`：`{ts, pane_snippet, current_state}`
- weekly review jsonl → 增补 catalog → 下次同类有专属 entry
- 用户 fallback 文案："服务暂时不可用，正在自动重试探测——请稍候"

### Unknown 5min 升级

防 sticky context 下退避永远卡死：
- `unknownErrorStreakCount` 内存累积
- 同一 unknown pattern 连续 10 次扫描命中（30s × 10 = 5min）→ 强制升级 recoveryAction 为 `restart_session` → 走 stop + Guardian 拉新 session
- 任一 catalog hit / OK probe 成功 / 状态转出 Unavailable 时重置 streak

### Probe / restart 解耦

> v3 §三.3 核心原则：

- heartbeat / probe 失败**不默认** trigger restart——按 catalog `recoveryAction` 决定
- 只有 `restart_session` 路径触发进程重启
- `probe_only` / `mark_rate_limited` / `mark_auth_failed` 探测失败时仅保持 unhealthy state + 文案，restart 没意义

---

## 6. 迁移策略

### Phase 2：HealthEngine 新建

1. 新建 `health-engine.js` 实现 4-state FSM + 5 事件触发源 + tick 6 步
2. catalog 由 Adapter `getApiErrorPatterns()` 注入（详 [`runtime-adapter.md`](runtime-adapter.md)）
3. 实现 5 种 recoveryAction dispatch；unknown 5min 升级
4. 冷启动 health 回填（从 `agent-status.json`）
5. 退避计时 + 180s launchGracePeriod
6. 旧 `heartbeat-engine.js` legacy 共存；feature flag 切换

### Phase 5：legacy 清理

观察 1 周稳定后删除 `heartbeat-engine.js` legacy。

### 兼容性

- `agent-status.json` schema 加 schema_version + unavailable_reason；消费端遇未知 reason 退化通用文案不报错
- 旧 health 值（recovering / down）映射到新 unavailable + unavailable_since 时间差；通过 schema_version 标识

---

## 7. 测试策略 + 验收标准

### 单元测试（mock signals + mock adapter）

- 4-state FSM 转换：转换表中每条边各 1 个 case
- 5 种 recoveryAction 分派：每种 dispatch 后内存状态 + 副作用文件正确
- Unknown 5min 升级：连续 10 次相同 unknown pattern → recoveryAction 升级为 restart_session
- triggerRecovery 门控：≥60min Unavailable 时拒绝事件加速
- 冷启动 health 回填：持久化 unavailable 状态在 onProcessRestarted 后保留
- 180s launchGracePeriod：内 inLaunchGrace=true 阻止主动探针

### E2E 测试

- catalog × HealthState × c4-receive DB 路径矩阵（§4 矩阵 5 行）：每行各 1 个 E2E case，end-to-end 验 user 实际体感
- Probe / restart 解耦：mark_rate_limited 状态下 probe 反复失败但 adapter.stop 不调用
- Layer 2 unknown error 5min 升级 E2E：开始 probe_only 兜底；5min 后切换 restart_session

### 验收标准

- 转换表全 8 条边覆盖；5 种 recoveryAction × 4 health state 路径全 cover
- 不引入 terminal_status / reply_to_inbound_id 等任何"哪条消息回了"字段（grep 全文 0 命中）
- HealthEngine 不直接写 conversations 表（grep `insertConversation` / `c4-db` 调用为 0）

---

## 8. 与其他模块的依赖关系

| 上游 | 来源 | 用途 |
|---|---|---|
| [`runtime-adapter.md`](runtime-adapter.md) | `getApiErrorPatterns()` / `checkAuth()` / `getHeartbeatDeps()` | catalog 数据 + auth 实时 probe + heartbeat-pending 文件名 |
| [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md) | SignalStore 快照 | 读 tmux pane / proc-state / heartbeat-pending / maintenance-state |
| [`guardian.md`](guardian.md) | `setAuthFailed(reason)` / `onProcessRestarted()` 单向事件 | auth 失败 / 进程重启信号 |
| [`tool-pipeline-watchdog-procsampler.md`](tool-pipeline-watchdog-procsampler.md) | `triggerRecovery()` | 工具超时干预触发加速 |
| [`message-router.md`](message-router.md) | `triggerRecovery()` / `notifyUserMessage()` | user 消息触发加速 / 路径门控 |

| 下游 | 行为 |
|---|---|
| [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md) | 写 `agent-status.json` 的 health / unavailable_since / unavailable_reason 字段 |
| [`guardian.md`](guardian.md) | 通过 SignalStore 间接消费 `rate-limit-state.json`（HealthEngine 写，Guardian 拉起条件 #1 读）；通过 `setAuthFailed` 反向接事件不调 getter |

### 跨模块契约（与 [`session-restart-continuation.md`](session-restart-continuation.md)）

`restart_session` recoveryAction 触发 adapter.stop() 后：
- Guardian 看 ActivityState=Offline → 拉新 session（不查 HealthEngine）
- 新 session 起来后 c4-session-init 注入 startup context
- agent 看 context 自决策续接（best-effort，不承诺 unresolved-inbound completeness；详 v3 §三.5）

HealthEngine 在 restart 后等 Guardian 调 `onProcessRestarted()` 回填 health；不参与 continuation 业务逻辑。
