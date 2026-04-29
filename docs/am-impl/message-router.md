# MessageRouter

## 1. 组件定义

> 来源：顶层设计 §3.2 MessageRouter 容器

**职责**：接收 c4-receive 的 IPC 路由请求，查询 HealthEngine 当前健康状态；health≠OK 时触发或加入 recovery probe 聚合，等待 probe 结果后返回最终路由决策和用户文案。

**输入**：c4-receive 发来的 IPC 请求（channel、endpoint、noReply）；HealthEngine 当前状态

**输出**：路由决策：recovered=true 走主链，recovered=false 附带 reason 和 userMessage

**运行模型**：MessageRouter 不在 AM Process 主循环中运行。它由 c4-receive 通过 IPC 事件触发，是一次性调用接口。代码上不是独立模块文件——它是 Monitor Orchestrator IPC handler 的一部分（见 [monitor-orchestrator.md](monitor-orchestrator.md) IPC 监听章节）。

**相关决策**：
- **D-7**：MessageRouter 事件驱动 + probe 结果缓存。c4-receive IPC 触发，不做定时轮询。health≠OK 时 cache-first lookup，缓存过期则触发 recovery probe 并写缓存（带过期时间）
- **D-8**：unhealthy 路径即时双写 DB + c4-send 投递状态文案
- **D-9**：废弃 pending-channels.jsonl 异步恢复广播（unhealthy 已即时返回状态文案）
- **D-14**：status='delivered' 显式覆盖，不引入新 DB 字段

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **路由决策** | 健康时快速放行 | health=OK → 立即返回 `{ recovered: true }` |
| | 不健康时 probe | health≠OK → cache-first → probe → 返回结果 |
| **Probe 缓存** | cache-first lookup | 每次路由请求先检查缓存文件，TTL 内直接使用 |
| | 缓存写入 | probe 完成后将结果写缓存 + 过期时间 |
| **Probe 聚合** | 并发请求共用 | 多个 c4-receive 进程同时到达，只触发一次 probe，其余等待同一个 Promise |
| **文案映射** | reason → userMessage | 将 HealthEngine 返回的 reason 映射为用户可读的状态文案 |
| **Recovery 加速** | notifyUserMessage | 路由请求到达时通知 HealthEngine 加速 recovery |
| **退避判断** | backoff 检查 | 检查距上次 probe 是否过了退避间隔，未过则使用缓存或等待 |

### 路由流程

```
c4-receive IPC 请求到达
        │
        ▼
  ┌─────────────────────────┐
  │ healthEngine.health     │
  └──────────┬──────────────┘
             │
        health=OK?
        ┌────┴────┐
        │ YES     │ NO
        ▼         ▼
     返回        notifyUserMessage()
     recovered   │
     =true       ├─ 检查 probe 缓存
     (走主链)     │
                 缓存有效?
                 ┌──┴──┐
                 YES   NO
                 │     │
                 │     ├─ 已有 in-flight probe?
                 │     │   ┌──┴──┐
                 │     │   YES   NO
                 │     │   │     │
                 │     │   │     └─ 过了退避间隔?
                 │     │   │       ┌──┴──┐
                 │     │   │       YES   NO
                 │     │   │       │     │
                 │     │   │       │     └─ 用过期缓存或
                 │     │   │       │        返回 recovered=false
                 │     │   │       │
                 │     │   │       └─ 触发 runRecoveryProbe()
                 │     │   │          写缓存
                 │     │   │
                 │     │   └─ 等待 in-flight probe 完成
                 │     │
                 ▼     ▼
              probe 结果
              ┌─────┴─────┐
              recovered?
              YES         NO
              │           │
              ▼           ▼
           返回         noReply?
           recovered    ┌───┴───┐
           =true        YES     NO
           (走主链)      │       │
                        ▼       ▼
                     返回     返回
                     recovered recovered
                     =false   =false
                     (静默)    + reason
                              + userMessage
```

### IPC 通信协议

> 完整协议定义在 [monitor-orchestrator.md](monitor-orchestrator.md) IPC 监听章节。此处仅列出与 MessageRouter 路由逻辑直接相关的部分。

**传输层**：Unix socket，JSON-over-newline，短连接（一请求一响应后关闭）。

**Socket 路径**：`~/zylos/activity-monitor/am.sock`

**请求**：

```javascript
{
  type: 'route',
  channel: string,       // 来源渠道（'telegram', 'lark', 'web', ...）
  endpoint: string,      // 渠道内标识（chat_id, user_id, ...）
  noReply: boolean,      // true = 系统消息，probe 失败时静默
}
```

**响应**：

```javascript
{
  recovered: boolean,     // true = 健康/已恢复，消息走主链
  health: string,         // 当前 HealthState
  reason?: string,        // recovered=false 时的原因
  userMessage?: string,   // recovered=false 且 noReply=false 时的用户文案
}
```

**超时**：c4-receive 侧 25s 读超时（对齐 router probe budget ≤25s）。超时视为 recovered=true（fail-open）。

**降级**：socket 不存在或连接失败 → c4-receive 降级为直接读 `agent-status.json`（兼容 AM 未启动/升级中的场景）。

### Probe 缓存机制（D-7）

缓存避免每条 user message 都触发 recovery probe（probe 最长 25s，高并发时开销大）。

**缓存文件路径**：`~/zylos/activity-monitor/probe-cache.json`

**缓存格式**：

```javascript
{
  recovered: boolean,
  health: string,
  reason?: string,
  userMessage?: string,
  expiresAt: number,      // epoch ms，缓存过期时间
  probedAt: number,       // epoch ms，probe 执行时间
}
```

**TTL 规则**：

| probe 结果 | TTL | 说明 |
|-----------|-----|------|
| recovered=true | 0（不缓存） | 恢复后 HealthEngine 已转 OK，后续请求直接走 health=OK 快速路径 |
| recovered=false | `backoffDelay × 1000` | 与 HealthEngine 退避间隔对齐，避免退避期内重复 probe |

**缓存读写规则**：
- 读：IPC handler 收到路由请求、health≠OK 时，先读缓存文件。文件不存在或 JSON 解析失败视为无缓存
- 写：probe 完成且 recovered=false 时写入缓存。probe recovered=true 时删除缓存文件（如果存在）
- 并发安全：缓存文件是 best-effort 提示，写操作用 `writeFileSync` 原子性足够（单文件、AM 进程内单线程）

### Probe 聚合

多个 c4-receive 进程可能在同一时刻发来路由请求。如果每个请求都独立触发 probe，会产生不必要的开销。

**实现**：AM 进程内用一个 module-level Promise 变量作为 in-flight probe 锁。

```javascript
let inflightProbe = null  // Promise<ProbeResult> | null

async function probeWithAggregation(healthEngine) {
  // 已有 in-flight probe → 等待同一个 Promise
  if (inflightProbe) return inflightProbe

  // 触发新 probe
  inflightProbe = healthEngine.runRecoveryProbe()
    .finally(() => { inflightProbe = null })

  return inflightProbe
}
```

**行为**：
- 第一个请求触发 probe，设置 `inflightProbe`
- 后续请求发现 `inflightProbe` 非 null，await 同一个 Promise
- probe 完成后 `inflightProbe` 重置为 null
- 下一波请求可以触发新 probe

### 退避判断

IPC handler 不盲目触发 probe，需要检查是否过了退避间隔：

```javascript
function shouldProbe(healthEngine, cache) {
  const now = Date.now()

  // 有有效缓存 → 不 probe
  if (cache && cache.expiresAt > now) return false

  // 距上次 probe 未过退避间隔 → 不 probe
  const backoffMs = healthEngine.backoffDelay * 1000
  if (now - healthEngine.lastRecoveryAt * 1000 < backoffMs) return false

  return true
}
```

**注意**：`notifyUserMessage()` 返回 true 时会重置 `restartFailureCount=0`，使 `backoffDelay` 变回最小值（60s），从而加速 probe 触发。

### 用户文案映射

MessageRouter 负责将 HealthEngine 的 `reason` 映射为用户可读的 `userMessage`。c4-receive 不维护自己的文案映射——避免文案来源分裂。

**文案表**：

| health | reason 模式 | userMessage |
|--------|-----------|-------------|
| rate_limited | `rate_limit_*` | "I've hit my usage limit.{resetInfo} Please send your message again after I'm back!" |
| auth_failed | `auth_*` | "I'm having authentication issues — please check the API credentials. Your message has been queued and I'll process it once authentication is restored." |
| unavailable | `heartbeat_timeout` | "I'm temporarily unavailable but should be back shortly. Please try again in a moment!" |
| unavailable | `rate_limit_cooldown_expired` | "I'm temporarily unavailable but should be back shortly. Please try again in a moment!" |
| unavailable | `tool_timeout` | "I'm temporarily unavailable but should be back shortly. Please try again in a moment!" |
| unavailable | 其他/未知 | "I'm temporarily unavailable but should be back shortly. Please try again in a moment!" |

**resetInfo 来源**：`healthEngine.rateLimitResetTime`。有值时追加 " I should be back around {resetTime}."；无值时追加 " I should be back within an hour."。

**文案生成函数**：

```javascript
function buildUserMessage(health, reason, healthEngine) {
  if (health === 'rate_limited') {
    const resetInfo = healthEngine.rateLimitResetTime
      ? ` I should be back around ${healthEngine.rateLimitResetTime}.`
      : ' I should be back within an hour.'
    return `I've hit my usage limit.${resetInfo} Please send your message again after I'm back!`
  }

  if (health === 'auth_failed') {
    return "I'm having authentication issues — please check the API credentials. Your message has been queued and I'll process it once authentication is restored."
  }

  // unavailable（所有 reason 统一文案）
  return "I'm temporarily unavailable but should be back shortly. Please try again in a moment!"
}
```

### IPC Handler 完整逻辑（AM 侧）

此逻辑在 Monitor Orchestrator 的 IPC server connection handler 中实现。

```javascript
async function handleRouteRequest(req, healthEngine) {
  // 1. 健康时快速放行
  if (healthEngine.health === 'ok') {
    return { recovered: true, health: 'ok' }
  }

  // 2. 通知 HealthEngine 有用户消息到达（加速 recovery）
  const shouldTryProbe = healthEngine.notifyUserMessage(Math.floor(Date.now() / 1000))

  // 3. 检查缓存
  const cache = readProbeCache()

  // 4. 决定是否 probe
  let result
  if (shouldTryProbe || shouldProbe(healthEngine, cache)) {
    result = await probeWithAggregation(healthEngine)
    // 写缓存
    if (result.recovered) {
      deleteProbeCache()
    } else {
      writeProbeCache({
        ...result,
        userMessage: req.noReply ? undefined : buildUserMessage(result.health, result.reason, healthEngine),
        expiresAt: Date.now() + healthEngine.backoffDelay * 1000,
        probedAt: Date.now(),
      })
    }
  } else if (cache && cache.expiresAt > Date.now()) {
    // 缓存有效，直接使用
    result = cache
  } else {
    // 无缓存且未过退避 → 返回当前状态（不 probe）
    result = {
      recovered: false,
      health: healthEngine.health,
      reason: healthEngine.healthReason || 'backoff_active',
    }
  }

  // 5. 构造响应
  if (result.recovered) {
    return { recovered: true, health: 'ok' }
  }

  const response = {
    recovered: false,
    health: result.health,
    reason: result.reason,
  }

  if (!req.noReply) {
    response.userMessage = result.userMessage || buildUserMessage(result.health, result.reason, healthEngine)
  }

  return response
}
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 触发时机 | 说明 |
|-------|------|----------|---------|------|
| **HealthEngine** | 读取 | `health`, `healthReason`, `backoffDelay`, `lastRecoveryAt`, `rateLimitResetTime` | 每次路由请求 | 判断状态、是否 probe、文案生成 |
| **HealthEngine** | 调用 | `notifyUserMessage(currentTime)` | 每次路由请求 | 加速 recovery（清 cooldown / 重置 backoff） |
| **HealthEngine** | 调用 | `runRecoveryProbe()` | cache miss + 过了退避间隔 | 执行 probe，等待结果 |
| **c4-receive** | 被调用 | IPC socket 请求/响应 | c4-receive spawn 时 | 短连接，一问一答 |
| **Monitor Orchestrator** | 宿主 | IPC handler 注册 | AM init 时 | handler 持有 healthEngine 引用 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| PROBE_CACHE_FILE | `~/zylos/activity-monitor/probe-cache.json` | 缓存文件路径 |

> 其他常量（IPC socket 路径、probe 超时等）定义在 Monitor Orchestrator 或 HealthEngine 中。

## 3. 实施方案

**改动类型**：新增功能（现有代码中无 MessageRouter 概念，c4-receive 直接读 agent-status.json）

### 涉及的现有代码

| 现有位置 | 内容 | 改动 |
|---------|------|------|
| `c4-receive.js:87-111` | `readHealthStatus()` — 直接读 agent-status.json | 改为 IPC 调用 AM socket，保留文件读取作为降级 fallback |
| `c4-receive.js:113-151` | `recordPendingChannel()` — 写 pending-channels.jsonl | 删除（D-9 废弃） |
| `c4-receive.js:216-234` | 主流程中的健康检查和状态文案 | 改为使用 IPC 响应中的 userMessage |
| `c4-config.js` | `PENDING_CHANNELS_FILE`, `USER_MESSAGE_SIGNAL_FILE` | 标记废弃 |
| `monitor.js`（新） | Monitor Orchestrator IPC server | 新增 IPC handler 实现路由逻辑 |

### c4-receive 侧改造

c4-receive 从"直接读文件判断健康"改为"IPC 询问 AM，AM 返回路由决策"。

**改造后的主流程**：

```javascript
// 取代现有的 readHealthStatus() + recordPendingChannel() + 状态文案分支
async function queryRoute(channel, endpoint, noReply) {
  try {
    return await ipcQuery({ type: 'route', channel, endpoint, noReply })
  } catch (err) {
    // IPC 失败 → 降级到文件读取
    return fallbackFileRoute()
  }
}

function fallbackFileRoute() {
  const status = readHealthStatus()  // 现有文件读取逻辑
  if (status.health === 'ok') {
    return { recovered: true, health: 'ok' }
  }
  return {
    recovered: false,
    health: status.health,
    reason: status.health,
    userMessage: buildFallbackMessage(status),
  }
}

async function ipcQuery(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(AM_SOCKET_PATH)
    let data = ''

    socket.setTimeout(IPC_TIMEOUT)  // 25s
    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n')
    })
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => {
      try { resolve(JSON.parse(data)) }
      catch (e) { reject(e) }
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('IPC timeout'))
    })
    socket.on('error', reject)
  })
}
```

**c4-receive 主流程改造后**：

```javascript
// 现有：直接读文件 + 状态分支 + exit
// 改为：IPC 路由查询
const route = await queryRoute(channel, endpoint, noReply)

if (!route.recovered) {
  // D-8: 写 inbound 记录为 delivered（dispatcher 自然跳过）
  insertConversation('in', channel, endpoint, dbContent, 'delivered', priority, requireIdle)

  // D-8: noReply=false 时调 c4-send 投递状态文案
  if (!noReply && route.userMessage) {
    // spawn c4-send.js 向用户发送状态文案
    execFileSync('node', [C4_SEND_SCRIPT, channel, endpoint, '--content', route.userMessage])
  }

  emitError(json, `HEALTH_${route.health.toUpperCase()}`, route.userMessage || route.reason)
}

// recovered=true → 正常流程：写 inbound pending + 等待 dispatcher 投递
```

### 废弃项清理（D-9）

| 废弃项 | 位置 | 处理 |
|--------|------|------|
| `pending-channels.jsonl` | `~/zylos/activity-monitor/pending-channels.jsonl` | c4-receive 不再写入；AM 不再读取；保留文件（历史兼容），不主动删除 |
| `user-message-signal` | `~/zylos/activity-monitor/user-message-signal.json` | c4-receive 不再写入（用户消息信号改走 IPC `notifyUserMessage()`）；AM SignalStore 不再读取 |
| `recordPendingChannel()` | c4-receive.js:113-151 | 整段删除 |
| `loadPendingChannelKeys()` | c4-receive.js:113-132 | 整段删除 |
| `USER_MESSAGE_SIGNAL_FILE` | c4-config.js | 移除导出 |
| `PENDING_CHANNELS_FILE` | c4-config.js | 移除导出 |

### 实施步骤

1. **AM 侧 IPC handler** — 在 Monitor Orchestrator 的 IPC server 中实现 `handleRouteRequest()`、`probeWithAggregation()`、`shouldProbe()`、`buildUserMessage()` 和 probe 缓存读写（已在 [monitor-orchestrator.md](monitor-orchestrator.md) IPC 监听章节定义 socket 和协议）
2. **c4-receive 侧改造** — 新增 `ipcQuery()` 和 `queryRoute()`，替代 `readHealthStatus()` + 状态分支；保留 `readHealthStatus()` 作为 IPC 失败时的降级 fallback
3. **c4-receive unhealthy 路径** — 实现 D-8：`insertConversation(..., 'delivered')` + spawn `c4-send.js` 投递 `userMessage`
4. **废弃项清理** — 删除 `recordPendingChannel()`、`loadPendingChannelKeys()`、`USER_MESSAGE_SIGNAL_FILE` 写入
5. **测试** — IPC 连通性（正常/AM 未启动/AM 重启中）；probe 缓存有效/过期/无缓存；probe 聚合（并发请求共用一次 probe）；noReply 静默；降级 fallback

### 实施顺序（在整体 Spec 2 + Spec 3 中的位置）

MessageRouter 的实现分布在两侧：
- **AM 侧**（IPC handler + probe 缓存 + 文案映射）→ 依赖 HealthEngine（Spec 1 组件），在 Monitor Orchestrator 实施时一并完成
- **c4-receive 侧**（IPC client + unhealthy 路径 + 废弃项清理）→ 属于 Spec 3: C4 改造

实施顺序：先完成 AM 侧 IPC handler（确保 socket 可用），再改造 c4-receive 侧。两侧之间通过 IPC 协议解耦，可以灰度切换（c4-receive 有 fallback）。
