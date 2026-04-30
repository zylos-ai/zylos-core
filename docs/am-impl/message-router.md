# MessageRouter

## 1. 组件定义

> 来源：顶层设计 §3.2

**职责**：接收 `c4-receive` 的 IPC 路由请求，查询 HealthEngine 当前健康状态；health 非 OK 时按需触发或加入 recovery probe，返回路由决策。

**输入**：`c4-receive` 发来的 IPC 请求（channel、endpoint、noReply）；HealthEngine 当前状态

**输出**：`RouteDecision`。`recovered=true` 时消息走 C4 主链；`recovered=false` 时由 `c4-receive` 根据 noReply 决定是否发送状态文案。

**相关决策**：
- **D-7**：MessageRouter 事件驱动 + probe 结果缓存。采用 IPC 通信 + 30s 硬超时 + 降级 fallback。
- **D-8**：unhealthy 路径即时写入 DB + c4-send 投递状态文案。
- **D-14 / D-34 / D-36**：不扩展 C4 DB schema；unhealthy inbound 写 `status='delivered'`，避免 double delivery。
- **D-37**：每次 `c4-receive` 最多产生一种用户可见结果。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **IPC 路由** | Unix socket server handler | 由 Monitor Orchestrator 启动，MessageRouter 注册 `route` handler |
| | request/response schema | JSON line framed request/response，单请求单响应 |
| **健康路由** | OK 快速路径 | `health='ok'` 立即返回 `recovered=true` |
| | 非 OK 路径 | 按 `notifyUserMessage`、cache、backoff、probe 聚合顺序决策 |
| **Recovery probe** | probe 聚合 | 同一 health/reason key 同一时刻只允许一个 recovery probe 在 AM Process 内运行 |
| | probe budget | route 内等待 probe 最多 25s，给 `c4-send` 留 5s |
| **缓存** | negative cache | 缓存最近一次 probe 失败结果，避免并发请求重复 probe |
| | cache 失效 | probe 成功、health/reason 变化、`notifyUserMessage()` 返回 true 时失效 |
| **文案映射** | reason catalog | MessageRouter 负责 reason → userMessage，`c4-receive` 不维护第二份 catalog |
| **降级** | c4-receive fallback | IPC 不可用/超时时，c4-receive 读 `agent-status.json` 做静态判断 |

### 文件位置

```
activity-monitor/scripts/
├── message-router.js          # MessageRouter class + IPC handler
└── activity-monitor.js        # 当前入口；通过 Orchestrator 启动 IPC server 并挂载 router
```

`c4-receive.js` 位于 C4 组件内，按本文件的 IPC contract 调用 AM Process。

### IPC 协议

#### Socket

```text
~/zylos/activity-monitor/am.sock
```

Monitor Orchestrator 初始化时：

1. 删除 stale socket 文件。
2. 启动 Unix socket server。
3. 将 `MessageRouter` 实例注入 handler。
4. AM 退出时关闭 server 并清理 socket。

#### Request

```javascript
interface RouteRequest {
  version: 1,
  type: 'route',
  requestId: string,          // c4-receive 生成，用于日志关联
  channel: string,            // lark | telegram | web-console | system | ...
  endpoint: string,           // channel-specific endpoint
  noReply: boolean,           // true = 不发送用户可见状态文案
  receivedAt: number,         // epoch ms
}
```

MessageRouter 不需要读取 message content。消息内容仍由 `c4-receive` 写 C4 DB，MessageRouter 只做路由决策，避免业务内容进入 AM。

#### Response

```javascript
interface RouteDecision {
  version: 1,
  requestId: string,
  recovered: boolean,         // true = c4-receive 写 pending，走主链
  health: 'ok' | 'unavailable' | 'rate_limited' | 'auth_failed',
  reason?: string,            // recovered=false 时必填
  userMessage?: string,       // noReply=false && recovered=false 时必填
  cacheHit?: boolean,
  probeStarted?: boolean,
  fallback?: boolean,
}
```

`recovered=true` 时 `reason/userMessage` 不返回。

### route() 主流程

```text
route(request)
  │
  ├─ health = healthEngine.health
  │
  ├─ health == 'ok'?
  │    └─ YES → clear cache if stale/non-ok → return recovered=true
  │
  ├─ noReply == false?
  │    └─ YES → accelerated = healthEngine.notifyUserMessage(nowSec)
  │              └─ accelerated=true → invalidate cache, forceProbe=true
  │
  ├─ forceProbe == false?
  │    ├─ valid negative cache for current health/reason?
  │    │    └─ YES → return recovered=false from cache
  │    └─ within HealthEngine backoff window?
  │         └─ YES → return recovered=false with current reason/userMessage
  │
  ├─ result = await joinOrStartProbe(healthEngine.runRecoveryProbe)
  │
  ├─ result.recovered?
  │    └─ YES → invalidate cache → return recovered=true
  │
  └─ write negative cache → return recovered=false + mapped userMessage
```

### notifyUserMessage() 顺序

`notifyUserMessage()` 必须发生在 cache 命中判断之前，否则用户主动发消息无法加速 rate-limit/unavailable recovery。

规则：

- `noReply=false`：调用 `healthEngine.notifyUserMessage(nowSec)`。
- `noReply=true`：不调用，避免 scheduler / internal message 打破 cooldown 或 backoff。
- `notifyUserMessage()` 返回 true：绕过现有 negative cache 和 backoff，立即触发或加入 recovery probe。
- `notifyUserMessage()` 返回 false：按 cache/backoff 正常处理。

### Backoff 判断

MessageRouter 读取：

```javascript
healthEngine.lastRecoveryAt
healthEngine.backoffDelay
```

当 `health='unavailable'` 且 `nowSec - lastRecoveryAt < backoffDelay` 时，普通用户消息可以直接返回当前 unavailable 文案；但若 `notifyUserMessage()` 返回 true，则必须绕过 backoff。

RateLimited / AuthFailed 不使用 Unavailable backoff：

- RateLimited 由 cooldown/cache 控制；用户消息可通过 `notifyUserMessage()` 清 cooldown 后立即 probe。
- AuthFailed 允许按 cache TTL 限制 checkAuth 频率。

### Probe 聚合

MessageRouter 在 AM Process 内维护一个 in-memory probe promise：

```javascript
{
  key: string,                 // `${health}:${healthReason || ''}`
  startedAt: number,           // epoch ms
  promise: Promise<ProbeResult>
}
```

规则：

- 同一 key 已有 probe 运行时，后续 route 加入同一个 promise。
- key 变化时不复用旧 probe，启动新 probe。
- probe 等待 budget 为 25s；超时的 route 返回 recovered=false，但底层 probe 可以继续完成并更新 HealthEngine/cache。
- probe promise settle 后清空 in-memory 状态。
- AM Process 单进程内存聚合即可，不需要跨进程文件锁；所有 `c4-receive` 都通过同一个 IPC server 进入 AM Process。

### Probe Cache

#### 文件

```text
~/zylos/activity-monitor/message-router-probe-cache.json
```

#### Schema

```javascript
{
  version: 1,
  health: 'unavailable' | 'rate_limited' | 'auth_failed',
  reason: string,
  recovered: false,
  userMessage: string,
  createdAt: number,           // epoch ms
  expiresAt: number,           // epoch ms
  probeStartedAt: number,      // epoch ms
}
```

#### TTL

```text
PROBE_CACHE_TTL_MS = 30000
```

30s 与 D-7 的 IPC hard timeout 对齐，避免短时间并发请求重复 probe，同时不会长期阻断用户触发 recovery。

#### 命中条件

cache 同时满足以下条件才可用：

- `expiresAt > nowMs`
- `recovered === false`
- `cache.health === healthEngine.health`
- `cache.reason === healthEngine.healthReason`

#### 失效条件

以下情况必须删除 cache：

- `healthEngine.health === 'ok'`
- `healthEngine.health` 或 `healthReason` 与 cache 不一致
- `healthEngine.notifyUserMessage()` 返回 true
- `runRecoveryProbe()` 返回 recovered=true
- cache 解析失败或 version 不匹配

cache 写入使用 atomic write：write tmp → rename。

### reason → userMessage catalog

MessageRouter 维护统一文案 catalog。`c4-receive` 只转发 `RouteDecision.userMessage`，不再做二次映射。

```javascript
const USER_MESSAGE_CATALOG = {
  rate_limit_detected:
    '我现在被上游服务限流了，稍后会自动恢复。你的消息已收到，但暂时不会进入处理队列。',
  rate_limit_cooldown_expired:
    '我正在从限流状态恢复，请稍后再试。',
  auth_still_failed:
    '我当前认证不可用，需要管理员处理后才能继续。',
  auth_check_failed:
    '我当前认证不可用，需要管理员处理后才能继续。',
  heartbeat_timeout:
    '我现在暂时没有响应，正在尝试恢复。请稍后再发一次。',
  heartbeat_failed:
    '我现在暂时没有响应，正在尝试恢复。请稍后再发一次。',
  sticky_context_restart:
    '我检测到当前会话上下文异常，正在切换到新会话恢复。请稍后再发一次。',
  tool_timeout:
    '我刚才的工具执行卡住了，正在重启会话恢复。请稍后再发一次。',
  unavailable:
    '我现在暂时不可用，正在尝试恢复。请稍后再发一次。',
  unknown:
    '我现在暂时不可用，正在尝试恢复。请稍后再发一次。',
}
```

匹配规则：

- `reason.startsWith('tool_timeout_')` → `tool_timeout`
- `reason.startsWith('sticky_')` → `sticky_context_restart`
- exact reason 命中 catalog → 对应文案
- `health='rate_limited'` 且无 exact reason → `rate_limit_detected`
- `health='auth_failed'` 且无 exact reason → `auth_still_failed`
- 其他 → `unknown`

## 3. c4-receive 集成

### 正常 IPC 路径

```text
c4-receive
  │
  ├─ build RouteRequest
  ├─ call IPC route() with 30s hard timeout
  ├─ decision.recovered == true
  │    └─ insertConversation('in', ..., status='pending')
  │       dispatcher 后续投递给 runtime
  │
  └─ decision.recovered == false
       ├─ insertConversation('in', ..., status='delivered')
       ├─ noReply == true?
       │    └─ YES → exit 0，静默跳过
       └─ noReply == false
            └─ spawn c4-send.js 投递 decision.userMessage
```

### noReply 语义

`noReply=true && recovered=false` 时：

- inbound 仍写入 C4 DB，但 status 必须是 `delivered`
- 不调用 c4-send
- dispatcher 不会投递该系统消息
- c4-receive exit 0

这样可以保留审计记录，同时避免 unhealthy 时内部任务进入 runtime。

### c4-send 失败

unhealthy 路径中，inbound 先写 `delivered`，再调用 c4-send。若 c4-send 失败：

- 不得改回 `pending`
- c4-receive exit non-zero
- 记录 terminal error 日志
- 不做 runtime 投递，避免 double delivery

这符合 D-37：用户可见结果只能是状态文案或 terminal error，不能同时产生 runtime 回复。

### IPC fallback

D-7 要求 30s hard timeout + fallback。c4-receive fallback 只做静态判断，不执行 recovery probe。

```text
IPC route 成功
  → 使用 RouteDecision

IPC 连接失败 / 超时 / 响应解析失败
  → read agent-status.json
      ├─ 读不到 / JSON 损坏 / health 缺失
      │    → fail-open: insert pending（D-10 未知默认 OK）
      ├─ health == 'ok'
      │    → insert pending
      └─ health != 'ok'
           → build fallback RouteDecision
              recovered=false
              health=agentStatus.health
              reason=agentStatus.unavailable_reason || health
              userMessage=MessageRouter fallback catalog 映射
```

fallback 中 `noReply=true` 仍遵循 noReply 语义：写 `delivered`，不发 c4-send。

## 4. 接口定义

```javascript
class MessageRouter {
  constructor({ healthEngine, cacheStore, clock, log, options })

  async route(request: RouteRequest): Promise<RouteDecision>
  async joinOrStartProbe(key: string): Promise<ProbeResult>
  mapUserMessage(health: string, reason?: string): string
}
```

```javascript
interface MessageRouterOptions {
  probeBudgetMs?: number,       // default 25000
  probeCacheTtlMs?: number,     // default 30000
}
```

```javascript
interface CacheStore {
  read(): ProbeCache | null
  write(cache: ProbeCache): void
  clear(): void
}
```

## 5. 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 触发时机 | 说明 |
|-------|------|----------|---------|------|
| **Monitor Orchestrator** | 创建/挂载 | `new MessageRouter(...)` | init | Orchestrator 启动 IPC server 并注册 route handler |
| **HealthEngine** | 读取 | `health`, `healthReason`, `backoffDelay`, `lastRecoveryAt` | route 时 | 判断是否 OK、是否需要 probe |
| **HealthEngine** | 调用 | `notifyUserMessage()` | `noReply=false && health!=ok` | 用户消息加速 recovery |
| **HealthEngine** | 调用 | `runRecoveryProbe()` | cache miss 且需要 probe | 执行 heartbeat/checkAuth recovery |
| **c4-receive** | 调用方 | IPC `route` | 每条 inbound 到达 | 根据 RouteDecision 写 DB 和发送状态文案 |
| **StatusWriter** | fallback 数据 | `agent-status.json` | IPC fallback | 仅 c4-receive 降级路径读取 |

## 6. 常量

| 常量 | 值 | 说明 |
|------|------|------|
| ROUTER_IPC_TIMEOUT_MS | 30000 | c4-receive 等待 IPC response 的硬超时 |
| ROUTER_PROBE_BUDGET_MS | 25000 | MessageRouter 等待 recovery probe 的预算 |
| PROBE_CACHE_TTL_MS | 30000 | negative cache TTL |

## 7. 实施方案

**改动类型**：新增模块 + C4 receive 行为变更

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `skills/comm-bridge/scripts/c4-receive.js` | 外部消息入口，需接入 IPC route 决策 |
| `skills/comm-bridge/scripts/c4-send.js` | unhealthy 状态文案发送 |
| `skills/activity-monitor/scripts/activity-monitor.js` | 现有 AM 主进程，需由 Orchestrator 启动 IPC server |
| `scripts/health-engine.js` | HealthEngine/HeartbeatEngine probe 逻辑来源 |

### 实施步骤

1. 新增 `activity-monitor/scripts/message-router.js`，实现 `MessageRouter`、cache store、reason catalog。
2. 在 Monitor Orchestrator init 中创建 MessageRouter，并启动 Unix socket IPC server。
3. 修改 `c4-receive.js`：写 inbound DB 前先调用 IPC route。
4. 实现 30s IPC timeout 和 `agent-status.json` fallback。
5. 按 RouteDecision 写入 C4 DB：
   - recovered=true → inbound `status='pending'`
   - recovered=false → inbound `status='delivered'`
6. recovered=false 且 noReply=false 时，调用 `c4-send.js` 发送 `userMessage`。
7. 添加测试：
   - health OK fast path
   - health non-OK cache miss → probe success
   - health non-OK cache miss → probe failure → c4-send
   - `notifyUserMessage()` 返回 true 时绕过 cache
   - `sticky_context_restart` / `sticky_*` reason 映射到 sticky 文案
   - noReply 静默 delivered
   - IPC fallback status missing/malformed → fail-open
   - IPC fallback status non-OK → unhealthy
