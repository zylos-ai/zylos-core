# c4-receive Adaptation — 跨组件契约模块档

> 关联顶层方案：[v3 §三.2 / §三.4 / §五.1-5.2 / §六.G #4 / §六.H / §八 Phase 3](../../activity-monitor-refactor-proposal-v3.md)
> 类型：跨组件契约（comm-bridge skill 的 c4-receive 脚本在本 PR Phase 3 的改造档；非 AM 内部模块）
> Phase：3（消息路由 + c4-receive 适配）

---

## 1. 模块职责与边界

### 职责

c4-receive 是 comm-bridge skill 的 per-message 入口脚本——channel daemon（lark / telegram / web-console / hxa-connect）每次收到 user 消息时 spawn 一次 c4-receive 处理。本文档描述 c4-receive 在 PR #501 Phase 3 的改造范围 + 跟 main 行为的精确对比。

c4-receive 在新方案下做 4 件事：

1. **健康路由决策**：调 MessageRouter IPC 拿 `{recovered, reason}`
2. **DB 写入**：根据决策走 OK 路径（`insertConv('in', ..., 'pending')`）或 unhealthy 路径（`insertConv('in', ..., 'delivered')`）
3. **状态文案投递**：unhealthy 路径下 spawn `c4-send.js` 既有接口投递 catalog.userMessage
4. **降级处理**：MessageRouter IPC 不可用时走 terminal 文案路径（不入队）

### 严格边界

- ❌ **不改 c4-receive 的命令行接口**——channel daemon 调用的参数 (`--channel` / `--endpoint` / `--content` / `--priority` / `--no-reply` 等) 完全不变
- ❌ **不引入新 DB 字段 / 新表**——所有改造用既有 `conversations` 表 schema + 既有 `agent-status.json` schema（仅加 schema_version + unavailable_reason 可选字段，详 [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)）
- ❌ **不写 `pending-channels.jsonl`**——main 既有的 victim broadcast 路径在本方案废弃（v3 §六.G #4）
- ❌ **不发明 catalog.userMessage 投递新接口**——直接 spawn 既有 `c4-send.js`（v3 §六.H）
- ❌ **不改 channel daemon 的协议**——daemon 调 c4-receive 的接口签名 / 输出消费方式都不变（详 §4 vs main 对比）

### 范围外（不在本 doc 描述）

- c4-dispatcher 改动（health 值域适配 5→4，详 [`message-router.md`](message-router.md) §6 Phase 3）
- c4-send.js / c4-db.js / c4-session-init 行为（这些组件本 PR 零改动）

---

## 2. 输入 / 输出契约

### 输入：channel daemon 调用（接口签名跟 main 一致）

channel daemon spawn c4-receive 时传命令行参数（main 既有协议，本 PR 不变）：

| 参数 | 含义 |
|---|---|
| `--channel` | 来源渠道 (lark / telegram / web-console / hxa-connect 等) |
| `--endpoint` | endpoint 标识（DM / 群 ID 等）|
| `--content` | 消息正文 |
| `--priority` | 1 / 2 / 3（默认 3）|
| `--no-reply` | 可选——不生成 reply via suffix |
| `--require-idle` | 可选——dispatcher 要求 idle 才投递 |
| `--json` | 可选——输出 JSON 格式 |

### 输出：STDOUT + exit code

#### OK 路径（recovered=true）

跟 main 一致：
- STDOUT：`{"ok": true, "action": "queued", "id": <recordId>}` (json 模式) 或 `[C4] Message queued (id=<recordId>)`
- exit code：0

#### Unhealthy 路径（recovered=false，新行为）

⚠️ **跟 main 不同**：
- STDOUT：仍输出 success 格式（json: `{"ok": true, "action": "queued", "id": <recordId>, "delivered_status": "<reason>"}`）—— inbound 已写 DB（status='delivered'）+ outbound 状态文案已通过 c4-send 投递给 user
- exit code：0
- channel daemon 收到 success 不再展示错误 toast；user 看到的是经 c4-send 投递的 bot 状态消息

#### 30s 硬超时（recovered=undefined，IPC 仍连得上但 probe 慢）

跟 unhealthy 一样走"degraded 文案"路径：
- inbound 写入 'delivered'
- spawn c4-send 投递 generic "服务暂时不可用，正在自动重试" 文案
- exit 0

#### IPC 降级（C4——MessageRouter 连不上）

仅本路径回退到错误响应模式（main 残留的最后一条错误路径）：
- STDOUT：`{"ok": false, "error": {"code": "ROUTER_UNAVAILABLE", "message": "router 暂时不可用，请稍后重发"}}`（json 模式）或 `Error: router 暂时不可用，请稍后重发`
- exit code：1
- 不写 DB；channel daemon 看 exit !=0 展示错误文案
- 此路径只在 monitor.js crash 等罕见异常时触发；正常 production 路径不进此分支

### MessageRouter IPC 协议（详细 schema 见 [`message-router.md`](message-router.md) §2）

c4-receive 调用：
- 请求：`{ channel, endpoint, priority }`
- 响应：`{ recovered: true | false, reason: 'unavailable' | 'rate_limited' | 'auth_failed' | null }`
- 30s 硬超时（c4-receive 侧）

### c4-send.js spawn 协议

c4-receive 在 unhealthy 路径下：

```
spawn node <path-to>/c4-send.js <channel> <endpoint>
  stdin: <catalog.userMessage 文本>
```

c4-send.js 内部完成：
1. `insertConversation('out', channel, endpoint, message)` —— 状态文案 outbound DB 行
2. spawn `<channel>/scripts/send.js` 实际投递到 user

c4-receive 等 c4-send spawn 完成（exit 0）后自己 exit 0。如果 c4-send spawn 失败 → c4-receive 走 IPC 降级路径（terminal 文案 + 不入队 DB outbound）。

---

## 3. 数据结构 / 字段 / 状态机

### 复用既有 conversations 表 schema

c4-receive 写入的 inbound 行字段全用既有 schema（c4-db.js）：

| 字段 | OK 路径取值 | Unhealthy 路径取值 |
|---|---|---|
| `direction` | `'in'` | `'in'` |
| `channel` | 来源渠道 | 来源渠道 |
| `endpoint_id` | endpoint 标识 | endpoint 标识 |
| `content` | 消息正文 + reply via suffix | 消息正文 + reply via suffix |
| **`status`** | `'pending'`（c4-db.js:107 default 'in' → 'pending'）| **`'delivered'`（显式覆盖第 5 个参数）** |
| `priority` | 透传 | 透传 |
| `require_idle` | 透传 | 透传 |
| `timestamp` | now | now |

**关键改造**：调 `insertConversation` 时第 5 个参数 (`status`) 不再依赖 default 'pending'，而是按路由决策显式传入：

```
OK 路径:        insertConversation('in', ch, ep, content, 'pending', ...)
Unhealthy 路径: insertConversation('in', ch, ep, content, 'delivered', ...)
```

**dispatcher 不需要改 SQL**——`getNextPending()` (c4-db.js:140) 已经 `WHERE status='pending'`，自然跳过 'delivered' 行。

### 读取的 SignalStore 快照

通过文件 IO 读 `~/zylos/activity-monitor/agent-status.json`：

| 字段 | 用途 |
|---|---|
| `health` | OK / unavailable / rate_limited / auth_failed (4 值) |
| `unavailable_since` | 可选——计算 unavailable 时长 |
| `unavailable_reason` | 可选——选 catalog.userMessage 文案的索引 |
| `schema_version` | 整数；c4-receive 校验 schema 版本兼容 |

c4-receive 不直接读 catalog 字典——而是把 `unavailable_reason` 作为 c4-send 的 stdin 文案 keyword 传给 c4-send（或在 c4-receive 内部维护一份 catalog 文案 lookup）。具体实现细节是 Phase 3 commit 时决定，这里只描述契约。

---

## 4. 关键接口与调用关系

### 完整流程图

```
channel daemon (lark/telegram/web-console/hxa-connect poll)
    │ 收到 user 消息
    ↓
spawn c4-receive --channel <X> --endpoint <Y> --content <text>
    │
    ↓ parse args + validate
    │
    ↓ 调 MessageRouter IPC
       │ 30s 硬超时
       │
       ├─ recovered=true (health=OK)
       │      ↓
       │   insertConversation('in', ..., 'pending')
       │      ↓
       │   STDOUT success + exit 0
       │      ↓
       │   channel daemon 看 exit=0 → 不展示什么 (等 dispatcher 投 agent reply)
       │
       ├─ recovered=false (health 非 OK 且 probe 失败)
       │      ↓
       │   insertConversation('in', ..., 'delivered')   ← 显式 status 覆盖
       │      ↓
       │   spawn c4-send.js <channel> <endpoint> < catalog.userMessage
       │      │ c4-send 内部 insertConv('out', ...) + spawn channel/scripts/send.js
       │      ↓
       │   STDOUT success + exit 0
       │      ↓
       │   channel daemon 看 exit=0 → 不展示什么 (user 已通过 c4-send 收到 bot 状态消息)
       │
       ├─ 30s 超时 (probe 慢)
       │      ↓
       │   走 unhealthy 同样路径 + generic "服务暂时不可用" 文案
       │
       └─ IPC 连不上 (monitor.js crash)
              ↓
           STDOUT error + exit 1
              ↓
           channel daemon 看 exit=1 → 展示 "router 暂时不可用，请稍后重发"
```

### vs main 路径精确对比

| 步骤 | main | 新方案 |
|---|---|---|
| parse args / validate | 同 | 同 |
| 读 health (`agent-status.json`) | 直接 readJSON | 通过 MessageRouter IPC（IPC 内部读 SignalStore 快照）|
| health=OK | insertConv 'in' (default 'pending') | 同（recovered=true → 'pending'）|
| health 非 OK：写 pending-channels.jsonl | ✅ 写 | ❌ **删** |
| health 非 OK：写 user-message-signal.json | ✅ 写 | ⚠️ 保留（仍通知 AM 加速）|
| health 非 OK：emitError(HEALTH_X, "...") | ✅ exit 1 | ❌ **删** |
| health 非 OK：调 MessageRouter probe | ❌ 没此机制 | ✅ **新加** |
| recovered=false：insertConv 'in' (status 显式覆盖) | ❌ 不入队 | ✅ **新加**（status='delivered'）|
| recovered=false：spawn c4-send 投递文案 | ❌ 没此机制 | ✅ **新加** |
| AM 异步 broadcast "我恢复了" (Phase 5 legacy 清理) | ✅ 有 | ❌ **删**（v3 §六.G #4）|

---

## 5. 错误处理与恢复逻辑

### 30s 硬超时

probe 自然时长 10-30s。c4-receive 30s 硬超时——超时时：
- 走 unhealthy 同样的 `insertConv('in', ..., 'delivered')` + spawn c4-send（generic "服务暂时不可用" 文案）
- exit 0
- MessageRouter probe 继续跑（聚合池不破坏）

### IPC 降级（C4）

c4-receive 连不上 MessageRouter（monitor.js crash 级异常）：
- **不写 DB**（不变量"一次 c4-receive 一次真实答案"——这条消息没被接受）
- emitError ROUTER_UNAVAILABLE → exit 1
- channel daemon 看 exit=1 展示错误文案 "router 暂时不可用，请稍后重发"
- user 凭文案重发是兜底机制

### c4-send spawn 失败

unhealthy 路径下 c4-send.js spawn 失败（process exit !=0）：
- 视为 IPC 降级同等情况：exit 1 + ROUTER_UNAVAILABLE 文案
- inbound 'delivered' 行已写入但 outbound 没投递成功——这条 inbound 在 DB 是孤行（无对应 outbound）
- 边界 case：production 监控 alert（grep DB 看是否有"inbound delivered 但无对应 outbound 且时间窗口内"）

### 不变量保证

每次 c4-receive 进程 exit 时，**"一次 c4-receive 一次真实答案"**：

| 路径 | DB 状态 | user 收到 |
|---|---|---|
| OK | inbound (pending) | 后续 agent 实回复 (走 dispatcher → tmux → c4-send) |
| Probe recovered=true | inbound (pending) | 同上 |
| Probe recovered=false | inbound (delivered) + outbound (catalog.userMessage) | bot 状态消息 (通过 c4-send) |
| 30s 硬超时 | inbound (delivered) + outbound (degraded 文案) | bot 降级文案 (通过 c4-send) |
| IPC 降级 | 不入队 | "router 暂时不可用" terminal 文案 (通过 channel daemon STDERR) |

---

## 6. 迁移策略

### Phase 3 改造步骤（按 commit 拆分）

**Step 1：MessageRouter 加入 monitor.js**
- 详 [`message-router.md`](message-router.md) §6
- 暴露本地 IPC（Unix 域 socket）
- 上线 + smoke test

**Step 2：c4-receive 改造（本 doc 主要改动点）**
- 删 main 既有的 `recordPendingChannel(channel, endpoint)` 调用 + `pending-channels.jsonl` 写入
- 删 main 既有的 4 个 `emitError(HEALTH_X, "...")` 健康分支（保留 INVALID_ARGS / INTERNAL_ERROR / 新加 ROUTER_UNAVAILABLE 错误码）
- 加 MessageRouter IPC 客户端调用 + 30s 硬超时
- 加 `insertConversation('in', ..., 'delivered')` 显式 status 覆盖（unhealthy 路径）
- 加 spawn c4-send.js 投递 catalog.userMessage（unhealthy 路径）
- 单 commit + 跨 channel smoke test

**Step 3：c4-dispatcher 适配新 health 值域**
- 详 [`message-router.md`](message-router.md) §6
- 5→4 health 状态枚举支持

**Step 4：legacy 清理（Phase 5）**
- AM 旧的"drain pending-channels"职责删除
- channel daemon 旧的"展示 emitError health 错误码"逻辑废弃（实际上 daemon 仍可处理 ROUTER_UNAVAILABLE 错误码，那是 IPC 降级场景）

### 兼容性

#### channel daemon 不需要改

main 当前 channel daemon 的 c4-receive 调用代码（如 web-console/scripts/server.js POST /api/send）完全不需要改：

- 仍 spawn c4-receive
- 仍 wait child.on('close')
- 仍按 exit code 判断成功 / 失败
- 仅 user 端体感变化：health 非 OK 时从"看到错误 toast"变成"看到 bot 状态消息"——这个体感升级**通过 c4-send 异步投递实现**，channel daemon 自身不感知

#### 协议兼容性

- c4-receive STDOUT 格式：OK 路径 / 30s 超时路径 / IPC 降级路径分别对应 main 既有的 success / failed 格式；unhealthy probe-failed 路径**新加**返回 success（替代 main 的 emitError exit 1）
- channel daemon 应当能容忍这个变化：success 即"消息已处理"——daemon 不展示什么，user 通过 c4-send 收到 bot 状态消息独立感知

#### 部署顺序

monitor.js MessageRouter 必须先上线（Step 1），c4-receive 改造（Step 2）后才能依赖 IPC。Step 1 只是新增 IPC service，对既有 c4-receive 0 影响（因为旧 c4-receive 不知道 IPC）。

---

## 7. 测试策略 + 验收标准

### 单元测试（mock IPC + mock SignalStore + mock c4-send spawn）

- OK 路径：health=OK → `insertConv('in', ..., 'pending')` → exit 0 STDOUT success
- Unhealthy probe-failed 路径每个 reason（unavailable / rate_limited / auth_failed）：
  - inbound `status='delivered'` 写入正确
  - spawn c4-send 命令行参数正确（channel / endpoint）
  - c4-send stdin 内容 = catalog.userMessage 对应 reason 的文案
  - STDOUT success + exit 0
- 30s 硬超时：probe 不返回 → 走 unhealthy 路径 + generic 文案
- IPC 降级：MessageRouter socket 不可用 → 不写 DB + STDOUT error + exit 1
- c4-send spawn 失败：visualize as IPC 降级（不写 DB outbound + exit 1）

### E2E 测试（跨 channel）

- **lark E2E**：lark daemon 调 c4-receive 在 health=unavailable 时 → user 收到 lark message "API 暂时繁忙，正在自动重试"（通过 c4-send → lark/scripts/send.js）
- **telegram E2E**：同上换 telegram channel
- **web-console E2E**：web 浏览器发消息 → server POST /api/send spawn c4-receive → user 在 web UI 看到 bot 状态消息（通过 c4-send → web-console/scripts/send.js）
- **hxa-connect E2E**：HXA agent 跨 bot 通信场景

### 不变量测试

- "一次 c4-receive 一次真实答案" 5 路径全 cover（参 §5 不变量 table）
- DB schema 不变：跑 1000 条混合 OK/unhealthy 消息 → conversations 表 schema 不变 + 仅 'pending' / 'delivered' 两值在 status 字段
- pending-channels.jsonl 不写：grep 整个 c4-receive 改造代码 0 命中 `recordPendingChannel`

### 验收标准

- 所有单元测试 + E2E 跑通
- main 旧的 `HEALTH_DOWN` / `HEALTH_RECOVERING` / `HEALTH_AUTH_FAILED` / `HEALTH_RATE_LIMITED` 错误码在新 c4-receive 里 0 命中（grep 验证）
- `pending-channels.jsonl` 写入 0 命中
- 跨 channel user 体感统一为"bot 发的消息"（web 上不再有"failed to send"错误 toast 在 health 非 OK 路径）

---

## 8. 与其他模块的依赖关系

| 上游 | 来源 | 用途 |
|---|---|---|
| [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md) | `agent-status.json` 文件 | c4-receive 通过 MessageRouter IPC 间接读 health 状态（IPC 内部读 SignalStore 快照，不直接读 file）|
| [`message-router.md`](message-router.md) | MessageRouter IPC 服务 | c4-receive 调用的对象 |

| 下游 | 行为 |
|---|---|
| c4-send.js（既有，跨进程，本 PR 不改）| unhealthy 路径下被 c4-receive spawn；自身完成 outbound DB 写入 + spawn channel send.js |
| c4-dispatcher（既有，本 PR 小改）| 通过 DB 行的 status 字段间接交互——dispatcher SELECT pending 自然跳过 'delivered' 行（不需要 c4-receive 通知）|
| c4-db.js（既有，本 PR 不改）| 提供 `insertConversation` 接口；c4-receive 调它写 inbound |
| channel daemon（既有，本 PR 不改协议）| spawn c4-receive 的调用方；按 exit code 判断结果 |

### 跨组件契约一致性

| 契约 | 引用文档 |
|---|---|
| MessageRouter IPC 协议 | [`message-router.md`](message-router.md) §2 + §4 |
| c4-send 调用约定（spawn 参数 + stdin 文案）| [`message-router.md`](message-router.md) §1 边界 + 本 doc §2 |
| `agent-status.json` schema_version 兼容性 | [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md) §2 |
| status='delivered' 显式覆盖语义 | v3 §六.H + 本 doc §3 |
| 不写 pending-channels.jsonl | v3 §六.G #4 + 本 doc §6 |
| restart 后 user 凭重发是兜底 | [`session-restart-continuation.md`](session-restart-continuation.md) §2 contract 3 |
