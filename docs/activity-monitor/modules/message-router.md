# MessageRouter — 模块实施档

> 关联顶层方案：[v3 §三.2 / §三.4 / §五.1-5.2 / §六.D / §六.G #4 / §六.H](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（事件驱动，**运行于 monitor.js 进程**，**不在 tick 里**）
> Phase：3（消息路由 + c4-receive 适配）

---

## 1. 模块职责与边界

### 职责

MessageRouter 是 c4-receive 的本地 IPC 路由决策服务——当 c4-receive 看到 health 非 OK 时，调 MessageRouter 触发**recovery probe 聚合**，决定该 user 消息走"等 probe 恢复后正常投递"还是"走 unhealthy 状态文案路径"。

### 严格边界

- ❌ **不调 tmux**——所有 tmux 写入由 c4-dispatcher 独占，C4 主链不可绕
- ❌ **不写 DB**——inbound / outbound 写入由 c4-receive 决策后执行（MessageRouter 只返回路由决策，不副作用 DB）
- ❌ **不直接调 channel send 接口**——unhealthy 状态文案的实际投递由 c4-receive 调 `c4-send.js` 既有接口完成（详 §4 与 v3 §六.H）
- ✅ **只做 probe 聚合**——多个 user 同时来消息触发 recovery 时共享同一次 probe，避免每条独立触发

### 进程归属

运行于 `monitor.js`（AM 主进程）；通过 Unix 域 socket（或类似本地 IPC）暴露服务给 c4-receive。c4-receive 是 per-message 短进程，每次消息到达 spawn 一次。

---

## 2. 输入 / 输出契约

### 输入：c4-receive IPC 请求

c4-receive 在每条 user 消息到达时调 MessageRouter，传入：

| 字段 | 含义 |
|---|---|
| `channel` | 来源渠道 (lark / telegram / web-console / hxa-connect 等) |
| `endpoint` | endpoint 标识（DM / 群 ID 等） |
| `priority` | 消息优先级（c4-receive 透传）|

不需要传消息正文——MessageRouter 只做路由决策不读内容。

### 输出：路由决策

| 字段 | 取值 |
|---|---|
| `recovered` | `true` / `false` |
| `reason` | health=非OK 的具体子状态（unavailable / rate_limited / auth_failed），用于 c4-receive 选 catalog 文案 |

c4-receive 看 `recovered=true` → 走 OK 直通路径（`insertConv('in', ..., 'pending')` → dispatcher 主链投递）；看 `recovered=false` → 走 unhealthy 路径（`insertConv('in', ..., 'delivered')` + 调 c4-send 投递 catalog.userMessage；详 §4）。

### IPC 协议

本地 socket 短连接，请求-响应 JSON。30s 硬超时（c4-receive 侧）；MessageRouter 单次 probe 自然时长 10-30s。

---

## 3. 数据结构 / 字段 / 状态机

MessageRouter 自身**无持久化状态**——内存里只维护 *in-flight probe* 状态做聚合。

### 内存状态

| 字段 | 类型 | 含义 |
|---|---|---|
| `inflightProbe` | `null` / Promise | 当前进行中的 probe（多个 c4-receive 共享）|
| `waitingMessages` | array | 当前等 probe 结果的 c4-receive 调用列表（用于聚合时同步唤醒）|

### 没有引入新 DB 字段

不引入任何 `terminal_status` / `reply_to_inbound_id` / `claimed_at` 等新字段。Unhealthy 路径的 inbound `status='delivered'` 是 c4-receive 调 `insertConversation` 时显式覆盖既有 `conversations.status` 字段的 default 'pending'，**复用既有字段值，零新概念**（详 v3 §六.H）。

---

## 4. 关键接口与调用关系

### MessageRouter 暴露的 IPC 方法

`route(channel, endpoint, priority) → { recovered, reason }`

调用流程：
1. 读 SignalStore 快照（health from agent-status.json + rate-limit-state from rate-limit-state.json）
2. 如果 health=OK → 直接返回 `{recovered: true}`
3. 如果 health 非 OK：
   - 加入 `waitingMessages` 队列
   - 如果 `inflightProbe == null` → 触发新 probe（调 HealthEngine `triggerRecovery()` 单向事件）
   - 如果已有 inflight → 加入聚合等结果
   - probe 完成后唤醒所有 waiting，返回 `{recovered, reason}`
4. c4-receive 侧 30s 硬超时——超时时 router 仍持续跑（不中断），c4-receive 退化处理（见 C2）

### c4-receive 适配（Phase 3 改造）

c4-receive 收到路由决策后两条路径：

**OK 路径（recovered=true）**：
1. `insertConversation('in', channel, endpoint, content, 'pending')`（默认 status，dispatcher 主链投递）
2. exit 0

**Unhealthy 路径（recovered=false）**：
1. `insertConversation('in', channel, endpoint, content, 'delivered')`——**第 5 个参数显式覆盖 default 'pending'**，dispatcher SQL `WHERE status='pending'` 自然跳过
2. **调 c4-send.js 投递 catalog.userMessage**：c4-receive spawn `node c4-send.js <channel> <endpoint>` 传入 catalog.userMessage 文本；c4-send 内部完成 `insertConversation('out', ..., catalog.userMessage)` + spawn `<channel>/scripts/send.js` 实际投递
3. exit 0

### 4 约束 C1~C4

**C1：C4 DB 是消息可靠性边界——所有 accept 消息都进 DB**
- OK 路径：`insertConv('in', ..., 'pending')`——accepted-message durability 适用
- Unhealthy 路径：`insertConv('in', ..., 'delivered')` + c4-send 写 outbound——DB 双行 audit trail 完整；inbound `'delivered'` 显式标记非待投递不算 accepted（v3 §三.2 边界）
- IPC 降级（C4）才不写 DB（属 monitor.js crash 级罕见异常）

**C2：短 window + 30s 硬超时 fallback**
Probe 自然时长 10-30s。c4-receive 30s 硬超时——超时时 c4-receive 走 unhealthy 路径（`insertConv('in', ..., 'delivered')` + 调 c4-send 投递 generic "服务暂时不可用" 文案）。MessageRouter 的 probe 继续跑，聚合池不被破坏。

**C3：MessageRouter 读 health 走 SignalStore**
读 `agent-status.json` + `rate-limit-state.json` 的 SignalStore 快照，**不直接调 HealthEngine 的 getter 方法**——保持模块边界。

**C4：IPC 不可用时的降级**
c4-receive 连不上 MessageRouter（monitor.js crash）时：
- **不 `insertConversation`**——消息不进队列
- 回 terminal 文案给 channel daemon："router 暂时不可用，请稍后重发"
- 用户凭文案自行重发；不变量"一次 c4-receive 一次真实答案"在所有路径下 100% 成立

---

## 5. 错误处理与恢复逻辑

### Probe 失败（recovered=false）

不属于错误——是 health 仍异常的正常返回值。c4-receive 据此走 unhealthy 路径（已在 §4）。

### Probe 超时（30s 内未返回）

c4-receive 侧超时；MessageRouter 内部 probe 继续跑直至自然结束。c4-receive 走 unhealthy 路径返回"服务暂时不可用"generic 文案。

### IPC 降级（monitor.js crash）

c4-receive 连接失败 → 走 C4 路径（terminal 文案 + 不入队）。

### 并发聚合规则

| 场景 | 行为 |
|---|---|
| user A / user B 同时 health 非 OK | 共享同一 probe；同时唤醒；两条 c4-receive 各自决策 DB 写入 |
| Probe 进行中又来 user C | 加入 waiting；不重复触发 probe |
| Probe 失败后 30s 内 user D | 看 SignalStore 仍非 OK → 重新触发 probe（Probe 快速 churn 的退避由 HealthEngine FSM 管，不在 MessageRouter） |

### 不变量

每次 c4-receive 调用 MessageRouter，无论路径如何，**最终 c4-receive 进程 exit 时**：

| 路径 | DB 状态 | user 感知 | "一次 c4-receive 一次真实答案" |
|---|---|---|---|
| OK 直投 | inbound (pending) | 后续 agent 实回复 | ✓ |
| Probe recovered → 投递 | inbound (pending) | 后续 agent 实回复 | ✓ |
| Probe not recovered | inbound (delivered) + outbound (catalog.userMessage) | 立即收到 bot 状态消息 | ✓ |
| 30s 硬超时 | inbound (delivered) + outbound (degraded 文案) | 立即收到 bot 降级文案 | ✓ |
| IPC 降级 | 不入队 | 立即收到 "router 暂时不可用，请稍后重发" | ✓ |

---

## 6. 迁移策略

### Phase 3：消息路由 + c4-receive 适配

1. **monitor.js 进程内实例化 MessageRouter**，暴露本地 IPC（Unix 域 socket）
2. **c4-receive 改造**：
   - 删除 main 既有的 `recordPendingChannel` 调用 + `pending-channels.jsonl` 写入（v3 §六.G #4）
   - 删除 main 既有的 `emitError(HEALTH_X, "...")` 错误响应路径
   - 加：调 MessageRouter IPC 拿路由决策
   - 加：unhealthy 路径 `insertConversation('in', ..., 'delivered')` 显式 status 覆盖
   - 加：unhealthy 路径 spawn `c4-send.js` 投递 catalog.userMessage（HealthEngine 提供 catalog 文案查询接口或读 SignalStore 中的 unavailable_reason）
   - 30s 硬超时 + IPC 降级处理
3. **c4-dispatcher 适配新 health 值域**（v2.1 §八）：4 状态枚举（ok / unavailable / rate_limited / auth_failed）；`health !== 'ok'` 仍 defer，不区分子状态
4. **legacy 清理**：AM 旧的 "drain pending-channels" 职责删除（v3 §六.G #4 砍 main 旧 broadcast 路径）

### 兼容性

- channel daemon 调 c4-receive 接口签名不变
- `agent-status.json` schema 加 schema_version + unavailable_reason（详 [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)）
- main 旧 emitError 错误路径在 Phase 3 切换 commit 中替换为新 c4-send 投递路径（一次切换，无灰度——新 channel 看到的是"bot 状态消息"，main 旧的"error toast"行为退场）

---

## 7. 测试策略 + 验收标准

### 单元测试（mock IPC + mock SignalStore）

- OK 路径：health=OK → `recovered=true` → c4-receive 走 pending insertConv → dispatcher 主链投递 E2E
- Unhealthy 路径每个子状态（unavailable / rate_limited / auth_failed）：health=非OK → `recovered=false` → c4-receive insertConv 'delivered' + spawn c4-send → user 收到 catalog.userMessage 一致（lark / telegram / web-console 各 channel）
- Probe 聚合：3 个 c4-receive 同时调 → 1 次 probe → 3 个同时唤醒
- 30s 硬超时：probe 不返回 → c4-receive 走 unhealthy generic 文案
- IPC 降级：MessageRouter socket 不可用 → c4-receive 不入队 + terminal 文案

### E2E 测试

- "一次 c4-receive 一次真实答案"不变量：5 种路径下都成立（验收强约束）
- DB 状态：unhealthy 路径 inbound `status='delivered'` + outbound `'delivered'` 双行存在；dispatcher 跑一遍 inbound 不被 pick up（status='pending' SQL 不命中）
- 跨 channel 一致性：lark / telegram / web-console 三个 channel 在 unhealthy 时 user 看到的体感都是"bot 发的消息"（不是错误 toast）

### 验收标准

- 不变量 C1-C4 单测全过
- 跨 5 种路径 E2E 通过
- main 旧 emitError 错误响应路径退场（grep `HEALTH_DOWN` / `HEALTH_RECOVERING` / `HEALTH_AUTH_FAILED` / `HEALTH_RATE_LIMITED` / `recordPendingChannel` 残留为 0）

---

## 8. 与其他模块的依赖关系

| 上游 | 来源 | 用途 |
|---|---|---|
| [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md) | SignalStore 快照 | 读 health / rate-limit-state |
| [`health-engine.md`](health-engine.md) | catalog（含 userMessage 字段）| 提供 unhealthy 路径文案；通过 unavailable_reason 字段在 SignalStore 暴露 |
| [`runtime-adapter.md`](runtime-adapter.md) | (间接，通过 HealthEngine) | catalog 由 Adapter `getApiErrorPatterns()` 注入 HealthEngine |

| 下游 | 行为 |
|---|---|
| [`health-engine.md`](health-engine.md) | MessageRouter 触发 probe 时调 `triggerRecovery()` 单向事件接口（不读 HealthEngine getter）|
| c4-receive（外部脚本，跨进程） | IPC 客户端；按路由决策选 OK / Unhealthy 两条 DB 写入路径 |
| c4-send.js（外部脚本，跨进程） | unhealthy 路径下被 c4-receive spawn；MessageRouter 自身**不**直接调 c4-send |
| c4-dispatcher（外部脚本，跨进程）| **不直接交互**——通过 DB 行的 `status` 字段间接协作（dispatcher 只 SELECT `status='pending'`，跳过 'delivered'）|

### 跨模块契约（与 [`session-restart-continuation.md`](session-restart-continuation.md)）

session restart 触发后 MessageRouter 不参与续接——continuation 由 c4-session-init 既有 hook 完成；MessageRouter 在 restart 后下一条 c4-receive 调用时按当前 health state 正常路由（v3 §三.5 best-effort continuation）。
