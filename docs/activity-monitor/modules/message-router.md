# MessageRouter — 模块实施档

> 关联顶层方案：[v3 §五.1-5.2 / §六取舍 A](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（事件驱动，**运行于 monitor.js 进程**）
> 上游契约：[`c4-reliability-contract.md`](c4-reliability-contract.md)

---

## 1. 模块职责与边界

### 职责

事件驱动模块——c4-receive 通过本地 IPC 询问 MessageRouter 路由决策。MessageRouter 根据当前 health 状态决定：
- 直通 c4 主链投递（health=OK）
- 触发 recovery probe + 同步等结果（health 非 OK）
- 决定 c4-receive 后续行为（写 inbound + outbound 状态文案 / IPC 降级 terminal 文案）

### 核心约束

**不调 tmux**——所有 tmux 写入由 c4-dispatcher 独占。C4 主链不可绕。

### 边界

**在 scope 内**：
- 路由决策本身（health 投射 + probe 触发 + 结果反馈给 c4-receive）
- IPC server 端协议
- 并发聚合（多消息共享一次 probe）

**不在 scope 内**：
- HealthEngine 本身（详 [`health-engine.md`](health-engine.md)）
- terminal_status 字段管理（详 [`c4-reliability-contract.md`](c4-reliability-contract.md)，但 MessageRouter 通过 c4-receive 协同写入）
- c4 DB 实际写入（c4-receive 自己干）

---

## 2. 输入 / 输出契约

### 输入

| 输入 | 来源 | 触发 |
|---|---|---|
| IPC `route(msg_meta)` 请求 | c4-receive | 用户消息到达 |
| `triggerRecovery()` 调用 | ToolWatchdog（tool 超时）| 工具异常需联动健康检测 |
| `notifyUserMessage()` 调用 | c4-receive 或自身 IPC | 加速 health probe |

### 输出

| 输出 | 消费者 | 性质 |
|---|---|---|
| IPC 响应：`{ok|need_probe|ipc_degraded}` 路径决策 | c4-receive | 同步阻塞响应 |
| 触发 HealthEngine probe（必要时）| HealthEngine `triggerRecovery()` | 同步具名调用 |

### 不变量（4 约束 C1~C4）

#### C1：C4 DB 是消息可靠性边界——所有 accepted 消息都进 DB

- **OK 直通**：c4-receive 写 inbound（默认 `pending`）→ dispatcher 主链投递；runtime 后续异常**不算丢失**（详 [`session-restart-continuation.md`](session-restart-continuation.md)）
- **Unhealthy + probe 仍异常**：c4-receive 同事务写 inbound + outbound 状态文案 + 标 inbound `status_replied`（详 [`c4-reliability-contract.md`](c4-reliability-contract.md)）—— outbound 显式带 `reply_to_inbound_id = inbound.id`（不再走 endpoint heuristic）。用户立即收到状态回复，DB 记录两端 + terminal status 一气呵成
- **仅 IPC 降级（C4）**才不写 DB（属 monitor.js crash 级罕见异常）

#### C2：短 window + 30s timeout fallback

Probe 自然时长 10-30s。c4-receive 硬超时 30s，超时回 STATUS degraded（同样写 inbound + outbound 状态文案 + 标 status_replied，§5.4 C1 路径）。MessageRouter 的 probe 继续跑，聚合池不被破坏。

#### C3：MessageRouter 读 health 走 SignalStore

读 `agent-status.json` + `rate-limit-state.json`，不直接调 HealthEngine 方法。代价 1s eventual consistency；收益跨模块解耦（详 [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)）。

#### C4：IPC 不可用时的降级

c4-receive 连不上 MessageRouter（monitor.js crash）时：
- **不写 inbound**——消息不进队列
- 回 terminal 文案："router 暂时不可用，请稍后重发"
- 用户凭文案自行重发

**"一次 c4-receive 一次真实答案" 不变量在所有路径下 100% 成立**。

---

## 3. 数据结构 / 字段 / 状态机

### 内存状态

```js
class MessageRouter {
  inflightProbes = new Map()  // key: 'recovery' | 'auth_check', value: Promise + waiters
  // 不持久化——monitor.js crash 后内存消失，无 carry-over
}
```

### 路由决策表

| health 投射 | 行为 |
|---|---|
| OK | IPC 立即返 `{ok}`，c4-receive 走 OK 直通 |
| Unavailable / RateLimited / AuthFailed | 触发 / 加入 inflight probe 聚合，c4-receive 阻塞等结果 |

### 并发聚合

inflight probe 聚合策略：
- 多条消息同时到达 unhealthy state → 共享同一个 `recovery` probe Promise
- Probe 完成后所有 waiter 收到同样结果（recovered=true / false）
- 聚合 window 期间不再触发新 probe（HealthEngine 内部去重）

---

## 4. 关键接口与调用关系

### IPC server 端协议

```
c4-receive → MessageRouter:
  POST /route
  { meta: {channel, endpoint, msgid, ts, content_preview} }

MessageRouter → c4-receive:
  Status 200:
    { route: 'ok' }                    # health=OK 直通
    | { route: 'unhealthy', reason: 'rate_limited|auth_failed|unavailable',
        userMessage: '<catalog 文案>' }  # probe 仍异常 → c4-receive 同事务写 inbound + outbound + 标 status_replied
    | { route: 'recovered' }            # probe 期间恢复 → c4-receive 走 OK 直通
  Status 504 (硬超时 30s):
    { route: 'degraded',
      userMessage: '服务暂时不可用，请稍后重发' }
                                       # c4-receive 同事务写 inbound + outbound + 标 status_replied
  Connection refused (IPC 降级):
    (c4-receive 检测不到 router → 不写 DB → 回 terminal 文案不入队)
```

### HealthEngine 协作

| 方法 | 调用方向 | 何时 |
|---|---|---|
| `triggerRecovery()` | MessageRouter → HealthEngine | unhealthy 路径首次进入聚合 |
| `notifyUserMessage()` | MessageRouter → HealthEngine | 用户消息到达，加速 health probe（特别 AuthFailed 状态）|

### c4-receive 协作（写 DB 责任在 c4-receive 侧）

MessageRouter 不写 DB——只返决策。c4-receive 拿到决策后：
- `route='ok'` / `route='recovered'` → `insertConversation('in', ...)` (默认 pending) → dispatcher 后续 claim 投递
- `route='unhealthy'` / `route='degraded'` → 同事务做：
  ```
  in_id = insertConversation('in', ...)                            # 默认 pending
  insertConversation('out', userMessage,                           # 状态文案
                     reply_to_inbound_id = in_id)                  # 显式 correlation
  markInboundTerminal(in_id, 'status_replied')                     # 标 terminal
  ```
  显式 reply_to_inbound_id 走 c4-reliability-contract 标准路径，不依赖 endpoint heuristic
- `IPC 降级` → 不调 c4-db，仅返 terminal 文案

---

## 5. 错误处理与恢复逻辑

### IPC server 启动失败

- monitor.js 启动 IPC server 失败（端口占用 / 权限）→ MessageRouter 不可用
- c4-receive 检测不到 server → 走 IPC 降级路径
- 不影响 monitor.js 主循环（其他模块照常 tick）

### Probe 超时

- c4-receive 硬超时 30s → 不阻塞用户
- MessageRouter 的 inflight probe 不取消（HealthEngine 自然完成）—— probe 结果用于内部状态更新，但下一波消息会重新读 health snapshot

### Probe 期间 monitor.js crash

- inflight probe Promise 永远不 resolve
- c4-receive 30s timeout 触发 → 走 degraded 路径
- monitor.js 重启后 inflight 内存清空，无 carry-over

### terminal_status 写入失败

罕见 case：c4-receive 写 inbound 成功但写 outbound + 标 terminal 失败：
- 由 c4-reliability-contract 用 SQLite transaction 保证原子化
- 部分写入会回滚，c4-receive 收到错误 → 返 IPC 错误给 router → router 同样回 c4-receive degraded 路径，重试
- 不会出现"inbound 已 pending 但 outbound 状态文案没发出去"的半完成态

---

## 6. 迁移策略

### Phase 3 落地（同顶层 §八）

**Step 1**：monitor.js 进程内实例化 MessageRouter，暴露本地 IPC（unix domain socket）

**Step 2**：c4-receive 改造同步等 router IPC 响应：
- 老 c4-receive：直接 health snapshot 决策 + insertConv
- 新 c4-receive：先 IPC 调 MessageRouter，按响应路径执行

**Step 3**：实现 4 路径的 c4-receive 处理（OK / unhealthy / degraded / IPC 降级）

**Step 4**：c4-dispatcher 适配新 health 值域（不区分子状态，但要按 terminal_status 过滤——见 c4-reliability-contract）

### 兼容性

老 c4-receive 不调 IPC → 直接读 snapshot → 正常工作但缺并发聚合 + 缺 unhealthy 同步状态文案。需要 c4-receive 升级 + monitor.js 升级**同 release 部署**。

### 回滚

切回 legacy monitor.js + 老 c4-receive，绕过 IPC，直接 snapshot 决策。

---

## 7. 测试策略 + 验收标准

| 测试 | 描述 |
|---|---|
| OK 直通 | health=OK → IPC 返 ok → c4-receive 写 inbound pending → dispatcher 投递 |
| Unhealthy 同步状态文案 | health=Unavailable → probe 失败 → IPC 返 unhealthy → c4-receive 同事务写 inbound + outbound + 标 status_replied |
| 并发聚合 | 5 条消息同时到达 → 共享同一次 probe → 5 个 IPC 响应一致 |
| 30s 硬超时 | probe 永远不 resolve → c4-receive 30s 后超时 → 走 degraded 路径 |
| IPC 降级 | monitor.js 不存在 → c4-receive connect refused → 回 terminal 文案不入队 |
| C1 不变量 | 100 条消息跑 4 路径覆盖：每条要么 inbound+某 terminal status 要么完全不入队，0 条只有 inbound 没 terminal |
| C2 timeout fallback | 模拟 probe 慢响应 → c4-receive 30s 准时超时 |
| Probe / restart 解耦 | rate_limit 触发的 unhealthy → probe 失败 → router 不要 trigger restart（restart 决定权在 catalog dispatch） |

### 验收标准

- ✅ C1~C4 不变量在所有 4 路径 100% 成立
- ✅ 100 条并发消息 probe 聚合数 ≤ 5（短 window 共享）
- ✅ p99 IPC 往返延迟 ≤ 100ms（健康路径）

---

## 8. 与其他模块的依赖关系

### 上游

- [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)：读 health 投射（C3）
- [`health-engine.md`](health-engine.md)：调 triggerRecovery / notifyUserMessage
- [`c4-reliability-contract.md`](c4-reliability-contract.md)：unhealthy 路径写 status_replied 协同

### 下游

- c4-receive：本模块响应被 c4-receive 消费驱动 DB 操作
- c4-dispatcher：MessageRouter 不调 dispatcher，但 dispatcher 受 terminal_status 影响（间接关联）

### 不依赖

- Guardian / ProcSampler / ToolPipeline / TaskScheduler / Adapter

---

*v3 R3 review (2026-04-28) 后，把 v2.1 §5.4 message-router 章节扩展为独立模块档；新增 unhealthy 路径写 status_replied 协同（C-Term-2 守 1-reply invariant）。*
