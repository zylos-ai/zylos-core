# C4 通信层改造

> 对应顶层设计：§3.3 C4 通信层容器（与 AM 交互部分）
> 分支：docs/activity-monitor-design
> 状态：Draft

## 概述

本文档定义 C4 通信层中与 AM 直接交互的两个组件（c4-receive、c4-dispatcher）的改造方案。改造目标：从现有的"c4-receive 直接读文件判断健康"模式，切换为"c4-receive 通过 IPC 询问 AM MessageRouter"模式，同时让 c4-dispatcher 承担 HealthEngine 事件驱动检测的触发职责。

c4-send 无行为变更，不在本文档范围内。

## 1. c4-receive 改造

### 1.1 现有行为

```text
c4-receive 启动
  │
  ├─ 解析参数（channel, endpoint, content, priority, noReply）
  ├─ readHealthStatus() ← 直接读 agent-status.json
  │
  ├─ health != 'ok'?
  │    ├─ recordPendingChannel() ← 写 pending-channels.jsonl
  │    ├─ writeFileSync(user-message-signal.json) ← 通知 AM
  │    ├─ 按 health 值选择硬编码英文文案
  │    └─ emitError() → exit 1
  │
  ├─ 构造 fullMessage（content + replyViaSuffix）
  ├─ insertConversation('in', ..., 'pending')
  └─ exit 0
```

**问题**：
- c4-receive 直接读 agent-status.json 做健康判断，无法触发 recovery probe
- 文案硬编码在 c4-receive 中，与 MessageRouter catalog 分裂
- pending-channels.jsonl 写入无消费方（D-9 已废弃）
- user-message-signal.json 是间接信号，不如 IPC 直接调用精确
- unhealthy 时 exit 1，上游 channel daemon 可能重试导致 double delivery

### 1.2 改造后行为

```text
c4-receive 启动
  │
  ├─ 解析参数（channel, endpoint, content, priority, noReply）
  │
  ├─ queryRoute(channel, endpoint, noReply)
  │    ├─ 尝试 IPC 连接 AM socket（30s 硬超时）
  │    │    ├─ 成功 → 返回 RouteDecision
  │    │    └─ 失败 → fallbackFileRoute()
  │    │              ├─ 读 agent-status.json
  │    │              ├─ health='ok' 或读取失败 → { recovered: true }
  │    │              └─ health!='ok' → { recovered: false, health, reason, userMessage }
  │    │
  │    └─ 返回 RouteDecision
  │
  ├─ route.recovered == true?
  │    ├─ 构造 fullMessage（content + replyViaSuffix）
  │    ├─ insertConversation('in', ..., 'pending')
  │    └─ exit 0
  │
  └─ route.recovered == false
       ├─ 构造 fullMessage（content + replyViaSuffix）
       ├─ insertConversation('in', ..., 'delivered')  ← D-14
       ├─ noReply == true?
       │    └─ exit 0（静默）
       └─ noReply == false
            ├─ spawn c4-send.js 投递 route.userMessage
            ├─ c4-send 成功 → exit 0  ← D-37
            └─ c4-send 失败 → exit 1（terminal error）
```

### 1.3 IPC 客户端实现

```javascript
import net from 'net'

const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock')
const ROUTER_IPC_TIMEOUT_MS = 30000

function ipcRoute(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(AM_SOCKET_PATH)
    let data = ''

    socket.setTimeout(ROUTER_IPC_TIMEOUT_MS)

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n')
    })
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => {
      try { resolve(JSON.parse(data)) }
      catch (e) { reject(new Error('IPC response parse error')) }
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('IPC timeout'))
    })
    socket.on('error', reject)
  })
}
```

### 1.4 路由查询封装

```javascript
async function queryRoute(channel, endpoint, noReply) {
  try {
    const decision = await ipcRoute({
      version: 1,
      type: 'route',
      requestId: `${process.pid}-${Date.now()}`,
      channel,
      endpoint,
      noReply,
      receivedAt: Date.now(),
    })
    return decision
  } catch {
    return fallbackFileRoute()
  }
}

function fallbackFileRoute() {
  const status = readHealthStatusFile()  // 读 agent-status.json（带重试）
  // D-10 fail-open：读取失败、JSON 损坏、health 缺失 → 默认 OK
  if (!status || typeof status.health !== 'string' || status.health === 'ok') {
    return { recovered: true, health: 'ok', fallback: true }
  }
  return {
    recovered: false,
    health: status.health,
    reason: status.unavailable_reason || status.health,
    userMessage: buildFallbackMessage(status),
    fallback: true,
  }
}
```

### 1.5 Fallback 文案

IPC fallback 路径中 c4-receive 需要一份降级文案。为避免与 MessageRouter catalog 完全重复，fallback 使用简化版：

```javascript
function buildFallbackMessage(status) {
  if (status.health === 'rate_limited') {
    const resetInfo = status.rate_limit_reset
      ? ` I should be back around ${status.rate_limit_reset}.`
      : ' I should be back within an hour.'
    return `I've hit my usage limit.${resetInfo} Please send your message again after I'm back!`
  }
  if (status.health === 'auth_failed') {
    return "I'm having authentication issues — please check the API credentials."
  }
  return "I'm temporarily unavailable but should be back shortly. Please try again in a moment!"
}
```

> fallback 文案保留英文（与现有 c4-receive 行为一致）。MessageRouter catalog 的中文文案仅在 IPC 正常路径使用。

### 1.6 unhealthy 路径 exit code（D-37）

现有代码 unhealthy 时统一 `exit 1`。改造后区分：

| 场景 | exit code | 说明 |
|------|-----------|------|
| recovered=true | 0 | 正常主链 |
| recovered=false, noReply=true | 0 | 静默跳过，inbound 写 delivered |
| recovered=false, noReply=false, c4-send 成功 | 0 | 用户已收到状态文案 |
| recovered=false, noReply=false, c4-send 失败 | 1 | terminal error |
| IPC fallback + health=ok | 0 | fail-open |

**原因**：channel daemon 通常将 exit 1 视为失败并可能重试。如果用户已经收到状态文案后 c4-receive exit 1，channel daemon 重试会导致重复投递。exit 0 表示"c4-receive 的职责已完成"（无论是正常投递还是状态文案投递）。

### 1.7 废弃项删除

| 废弃项 | 操作 |
|--------|------|
| `readHealthStatus()` | 保留，重命名为 `readHealthStatusFile()`，仅用于 IPC fallback |
| `recordPendingChannel()` | 删除（D-9） |
| `loadPendingChannelKeys()` | 删除（D-9） |
| `PENDING_CHANNELS_FILE` 写入 | 删除（c4-config.js 保留常量但 c4-receive 不再引用） |
| `USER_MESSAGE_SIGNAL_FILE` 写入 | 删除（改走 IPC `notifyUserMessage()`） |
| 硬编码状态文案分支（L224-234） | 删除，替换为 `route.userMessage` |

### 1.8 inbound 记录策略

无论 recovered=true 还是 false，inbound 都写入 C4 DB：

| 路径 | status | 说明 |
|------|--------|------|
| recovered=true | `pending` | dispatcher 后续投递给 runtime |
| recovered=false | `delivered` | D-14：dispatcher `WHERE status='pending'` 自然跳过 |

**内容**：两种路径都写入完整的 `fullMessage`（content + replyViaSuffix），保留审计记录。recovered=false 时用户收到的是 `userMessage`（状态文案），不是 `fullMessage`。

## 2. c4-dispatcher 改造

### 2.1 新增职责：触发 HealthEngine 检测

顶层设计 §3.5 定义：c4-dispatcher 投递 user message 成功后，异步调用 `healthEngine.onUserMessageDelivered()` 触发 OK→非OK 检测。

**触发时机**：`markDelivered(item.id)` 成功后。

**触发方式**：通过 IPC 向 AM 发送异步通知（fire-and-forget，不等待返回）。

### 2.2 现有投递成功流程

```javascript
// c4-dispatcher.js L656-673
if (result === 'submitted') {
  if (item.type === 'conversation') {
    markDelivered(item.id)
    log(`Conversation id=${item.id} delivered`)
  } else {
    // control handling...
  }
  // ...
  return { delivered: true, state: agentState.state }
}
```

### 2.3 改造后投递成功流程

```javascript
if (result === 'submitted') {
  if (item.type === 'conversation') {
    markDelivered(item.id)
    log(`Conversation id=${item.id} delivered`)

    // D-4: 异步通知 AM HealthEngine 触发 OK→非OK 检测
    notifyMessageDelivered().catch(err => {
      log(`Warning: failed to notify AM of message delivery: ${err.message}`)
    })
  } else {
    // control handling unchanged...
  }
  // ...
}
```

### 2.4 IPC 通知实现

```javascript
const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock')
const NOTIFY_TIMEOUT_MS = 5000

function notifyMessageDelivered() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(AM_SOCKET_PATH)
    let data = ''

    socket.setTimeout(NOTIFY_TIMEOUT_MS)

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        version: 1,
        type: 'notify_delivered',
        timestamp: Date.now(),
      }) + '\n')
    })
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => { resolve() })
    socket.on('timeout', () => {
      socket.destroy()
      resolve()  // fire-and-forget: timeout 不阻塞 dispatcher
    })
    socket.on('error', () => {
      resolve()  // fire-and-forget: 错误不阻塞 dispatcher
    })
  })
}
```

**关键设计**：
- fire-and-forget：`notifyMessageDelivered()` 的 `.catch()` 只打日志，不影响 dispatcher 主循环
- 短超时（5s）：不能阻塞 dispatcher 投递下一条消息
- AM 未运行时静默失败：socket 连接失败 → resolve()
- 不重试：丢失一次通知只意味着少一次 OK→非OK 检测机会，下次 user message 投递时会再次通知

### 2.5 AM 侧 IPC handler 扩展

Monitor Orchestrator 的 IPC server 需要处理新的 `type: 'notify_delivered'` 消息：

```javascript
// IPC server handler（在 monitor.js 中）
if (request.type === 'notify_delivered') {
  // 异步调用，不阻塞 IPC 响应
  healthEngine.onUserMessageDelivered().catch(err => {
    log(`HealthEngine onUserMessageDelivered error: ${err.message}`)
  })
  // 立即返回 ack
  socket.end(JSON.stringify({ version: 1, type: 'ack' }) + '\n')
  return
}
```

### 2.6 健康检查 gate 变更

现有 dispatcher 在 `processNextMessage()` 中有健康检查 gate：

```javascript
// c4-dispatcher.js L593-596
if (agentState.health !== 'ok' && !bypass) {
  releaseItem(item);
  return { delivered: false, state: agentState.state };
}
```

**conversation gate 保留不变**。dispatcher 仍然读 `agent-status.json` 判断是否投递普通 conversation pending message——这是 dispatcher 自己的投递决策，与 MessageRouter 的路由决策独立。区别：
- MessageRouter：决定 c4-receive 是否写 `pending`（准入）
- dispatcher conversation health gate：决定是否投递已经 `pending` 的普通用户消息（执行）

两者不冲突，但存在时序交叠：MessageRouter 判定 recovered=true 写了 pending，到 dispatcher 投递时 health 可能已变为非 OK。此时 dispatcher 正确地暂停投递，消息等待健康恢复后继续——这是期望行为。

**Recovery heartbeat control 不受此 gate 影响**。HealthEngine 通过 `enqueueHeartbeat(phase)` 写入的 `phase='recovery' | 'post_restart'` heartbeat 必须带 bypass 语义（推荐 `bypass_state=1`），dispatcher 对该类 control 直接投递，即使 `agent-status.json.health != 'ok'`。否则 RateLimited / Unavailable 的 recovery probe 会被自身 health gate 卡住，无法自愈。

`enqueueHeartbeat(phase)` 写入的 control 字段语义：

```javascript
{
  type: 'heartbeat',
  phase: 'recovery' | 'post_restart',
  status: 'pending',
  bypass_state: 1,
  priority: 0,
  ack_deadline_seconds: 25,
  no_ack_suffix: true,
}
```

### 2.7 heartbeat auto-ack 变更

现有 `shouldAutoAckHeartbeat()` 中引用了 `agentState.health`：

```javascript
// c4-dispatcher.js L189
agentState?.health === 'ok' &&
```

**Recovery heartbeat 禁用 auto-ack**。`shouldAutoAckHeartbeat()` 不得对 `phase='recovery' | 'post_restart'` 返回 true。这两类 heartbeat 只有 runtime hook 显式 ack 后才能变为 `done`，因为它们用于验证 runtime liveness。

如果保留旧 periodic / legacy heartbeat auto-ack，只能限定在非 recovery heartbeat；不得复用 HealthEngine `sendHeartbeatProbe()` 使用的 heartbeat 类型。

## 3. c4-config.js 变更

### 新增常量

```javascript
export const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock')
export const ROUTER_IPC_TIMEOUT_MS = 30000   // c4-receive IPC 超时
export const NOTIFY_TIMEOUT_MS = 5000         // c4-dispatcher 通知超时
```

### 废弃常量

```javascript
// 保留定义（其他脚本可能引用），但 c4-receive 不再使用
export const PENDING_CHANNELS_FILE = ...   // D-9 废弃
export const USER_MESSAGE_SIGNAL_FILE = ... // 改走 IPC
```

## 4. IPC 协议汇总

AM socket（`am.sock`）现在处理两种请求类型：

| type | 调用方 | 说明 | 响应 |
|------|--------|------|------|
| `route` | c4-receive | 路由决策（详见 [message-router.md](message-router.md)） | RouteDecision |
| `notify_delivered` | c4-dispatcher | 通知 user message 已投递 | `{ type: 'ack' }` |

两者共用同一个 Unix socket server，由 Monitor Orchestrator 的 IPC handler 按 `type` 字段分发。

## 5. 迁移与兼容

### 升级顺序

AM 和 C4 组件在同一个 zylos-core package 中，通常一起升级。但为了安全，改造设计了 graceful degradation：

1. **AM 先升级，C4 后升级**：AM 启动了 IPC server 但 c4-receive 还在读文件 → 现有行为不变，无影响
2. **C4 先升级，AM 后升级**：c4-receive 尝试 IPC 连接但 AM 无 socket → fallback 读 agent-status.json。健康 OK 或 status 不可读时 fail-open 行为兼容（D-10）；non-OK 时采用新 unhealthy 语义（写 inbound `delivered` + c4-send 状态文案），与旧行为（直接 exit 1、不写 DB、不发状态文案）不同
3. **同时升级**：正常工作

### pending-channels.jsonl 清理

D-9 废弃后，pending-channels.jsonl 文件不再写入。已有文件不主动删除（避免误删用户数据），但 AM 不再读取。文件会自然过时。

### user-message-signal.json 清理

c4-receive 不再写入。AM SignalStore 不再读取（signal-store.md 已标记 legacy）。文件会自然过时。

## 6. 实施步骤

1. **c4-config.js** — 新增 `AM_SOCKET_PATH`、`ROUTER_IPC_TIMEOUT_MS`、`NOTIFY_TIMEOUT_MS` 常量
2. **c4-receive.js** — 实现 `ipcRoute()`、`queryRoute()`、`fallbackFileRoute()`、`buildFallbackMessage()`；重写主流程使用 `queryRoute()` 做路由决策；实现 D-8 unhealthy 路径（`insertConversation('in', channel, endpoint, dbContent, 'delivered', priority, requireIdle)` + spawn `c4-send`）；删除 `recordPendingChannel()`、`loadPendingChannelKeys()`、`USER_MESSAGE_SIGNAL_FILE` 写入；调整 exit code 语义
3. **c4-dispatcher.js** — 新增 `notifyMessageDelivered()`；在 `markDelivered()` 后异步调用；`import net`；确保 recovery heartbeat control bypass health gate、优先投递，且 `phase='recovery' | 'post_restart'` 不走 auto-ack
4. **monitor.js（AM 侧）** — IPC handler 新增 `notify_delivered` 分支，调用 `healthEngine.onUserMessageDelivered()`
5. **测试** — c4-receive IPC 正常/fallback/超时；c4-receive unhealthy 路径 exit code；c4-dispatcher 通知成功/AM 未运行；noReply 静默；concurrent route + notify 不冲突；health=unavailable 时 recovery heartbeat 仍会投递；recovery heartbeat 不会被 auto-ack；runtime hook ack 后 heartbeat 才变 done；runtime 不响应时 25s 后 HealthEngine 返回 `heartbeat_timeout`
