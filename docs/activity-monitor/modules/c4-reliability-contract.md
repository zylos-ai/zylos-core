# C4 Reliability Contract — 模块实施档

> 关联顶层方案：[v3 §三原则 1 / §五.1-5.3 / §六取舍 A](../../activity-monitor-refactor-proposal-v3.md)
> 类型：跨模块 C4 内部 schema/逻辑契约（不是 AM 内部模块，但 AM 落地强依赖）
> 引入版本：v3（R3 review by zylos0t reframe 重审 v2.1 walkback 后新增）

---

## 1. 模块职责与边界

### 职责

C4 Reliability Contract 是 c4 comm-bridge **内部** 的消息可靠性契约——把"消息可靠性"从单一的 `accepted-message durability` 扩展为**三层契约**：

1. **Durability**（既有）：accepted 消息持久化为 inbound 记录
2. **Terminal status**（新增）：每条 inbound 有明确 resolution state，由 c4-receive / c4-dispatcher 协同维护
3. **Unresolved-inbound exposure**（新增）：c4-session-init 查询 pending inbounds 注入新 session startup context

### 边界

**在本契约 scope 内**：
- `conversations` 表 schema 扩展（加 `terminal_status` 列）
- c4-receive 写 inbound / outbound 时的 terminal status 协同更新
- c4-dispatcher 投递前的 pending 过滤
- c4-session-init 查询 pending inbounds + 注入 startup context

**不在 scope 内**：
- channel daemon 外部协议（webhook 事件格式 / message_type 等）—— 不变
- c4-receive **CLI 外部接口**（`--content` / `--channel` / `--endpoint` 等参数）—— 不变（终端用户 / channel daemon 端无感知）
- AM 模块内部状态——AM 不感知 terminal_status，只读 `agent-status.json` 做健康判定

### 谁不该读这份档

实现 AM 业务模块（Guardian / HealthEngine / MessageRouter 等）的开发者不需要读本档——AM 只通过 c4-receive IPC 触发路由决策，不直接操作 conversations 表。本契约是**给 c4 comm-bridge 内部维护者**看的。

---

## 2. 输入 / 输出契约

### 输入

| 输入源 | 触发 | 影响契约的哪一层 |
|---|---|---|
| channel daemon → c4-receive `--content "<msg>"` | 用户发新消息 | Durability + 初始化 Terminal status = `pending` |
| MessageRouter → c4-receive 内部 IPC（unhealthy 路径） | 写 outbound 状态文案 | Terminal status: `pending` → `status_replied` |
| Runtime agent → channel reply → c4 outbound 写入 | agent 主动回复 | Terminal status: `pending` → `replied`（自动配对） |
| Runtime agent 显式调用 `c4-db.js mark-dropped <inbound_id>`（罕见） | agent 决定不答 | Terminal status: `pending` → `manually_dropped` |
| c4-session-init hook 启动时 | 新 session 启动 | 查询 + 注入 pending inbounds（不修改） |

### 输出

| 输出 | 消费者 | 性质 |
|---|---|---|
| c4-dispatcher 投递列表过滤 `WHERE terminal_status = 'pending'` | c4-dispatcher | 决定哪些 inbound 还能投递到 tmux |
| c4-session-init 注入 startup context 第三段（pending inbounds） | Runtime agent（启动时读 context） | 让 agent 看到未答 inbound 列表 |
| 历史查询 / debug：按 terminal_status 过滤的对话视图 | web-console / 人工 | 可观测性 |

### 不变量

- **C-Term-1**：每条 inbound 一旦 terminal（`replied` / `status_replied` / `manually_dropped`），**永远不再变回 pending**——终态单调
- **C-Term-2**：dispatcher 只投递 `terminal_status = 'pending'` 的 inbound——已 terminal 的不投，避免重复回复
- **C-Term-3**：c4-session-init 只暴露 `terminal_status = 'pending'` 的 inbound 给新 session，已 terminal 的不再被注入（避免 agent 被既有已答消息干扰）
- **C-Term-4**：unhealthy 路径写 outbound 状态文案 + 同 inbound 标 `status_replied` 必须**原子完成**（同一事务），避免半完成态导致 dispatcher 在 health 恢复后又投递

---

## 3. 数据结构 / 字段 / 状态机

### Schema 扩展

`conversations` 表新增 1 列：

```sql
ALTER TABLE conversations
ADD COLUMN terminal_status TEXT
  DEFAULT 'pending'
  CHECK (terminal_status IN (
    'pending', 'replied', 'status_replied', 'manually_dropped'
  ));

-- 索引：dispatcher 过滤 + session-init 查询都按 (endpoint_id, terminal_status) 过滤
CREATE INDEX IF NOT EXISTS idx_conversations_terminal
  ON conversations (endpoint_id, terminal_status, ts);
```

**只对 inbound 行有意义**：outbound 行 `terminal_status` 字段保留默认 `pending` 但不被任何逻辑读取（也可在 schema 层加 `CHECK direction = 'in' OR terminal_status = 'pending'` 约束，但实现上不必要）。

### Terminal status 状态机

```
                       (新消息到达)
                            │
                            ▼
                       ┌──────────┐
                       │ pending  │ (初始)
                       └────┬─────┘
              ┌─────────────┼──────────────────┐
              │             │                  │
       [agent 写 outbound]  │     [unhealthy 同步写状态文案]
              │             │                  │
              ▼             │                  ▼
       ┌──────────┐         │           ┌────────────────┐
       │ replied  │         │           │ status_replied │
       └──────────┘         │           └────────────────┘
                            │
                  [agent 显式 mark-dropped]
                            │
                            ▼
                  ┌─────────────────────┐
                  │ manually_dropped    │
                  └─────────────────────┘

终态单调：3 种 terminal 状态都不再变回 pending
```

### 4 种 terminal status 语义

| Status | 含义 | 触发 | dispatcher 投递？ | session-init 注入？ |
|---|---|---|---|---|
| `pending` | 未处理（默认）| 消息刚 accepted | ✓ | ✓（独立段） |
| `replied` | agent 已实质回复 | agent 写 outbound 配对 | ✗ | ✗ |
| `status_replied` | agent 不可用，c4 同步给了状态文案 | unhealthy 路径 outbound 状态文案 | ✗ | ✗ |
| `manually_dropped` | agent 显式判定不答 | agent 通过 c4-db.js mark-dropped | ✗ | ✗ |

### Reply 配对策略（pending → replied）

最简模型：**per-endpoint last-pending-cleared semantic**：
- agent 通过 c4 写 outbound（`direction='out'`）到 endpoint X
- c4-receive / c4-dispatcher hook 把同 endpoint 的**所有**当前 `pending` inbound 标 `replied`
- 不做精确逐条配对（group / multi-msg 假阳性已在 R3 review 讨论中明确）

**理由**：
- 简单可观察——agent 发了 outbound 即视为"对话推进，未答的 prior pending 视作 considered"
- 不需要 reply-to msgid 等精确配对元数据（zylos channels 不一定都支持）
- 边缘 case："agent 选择性答 1 条留 4 条 pending" 比"全部一刀切标 replied"少见，可用 `manually_dropped` 显式 escape

**配对边缘 case + 处理**见 §5 错误处理。

---

## 4. 关键接口与调用关系

### 接口列表

| 接口 | 实现位置 | 职责 |
|---|---|---|
| `insertConversation('in', ...)` | `c4-db.js` / `c4-receive.js` | 写 inbound，默认 `terminal_status = 'pending'` |
| `insertConversation('out', ...)` | `c4-db.js` / `c4-receive.js` / agent 路径 | 写 outbound；如果是 status 文案路径**额外**调 `markInboundTerminal(inbound_id, 'status_replied')`；如果是 agent reply 路径**额外**调 `clearEndpointPending(endpoint_id, 'replied')` |
| `markInboundTerminal(inbound_id, status)` | `c4-db.js` 新增 | 显式标某条 inbound 为 terminal（status_replied / manually_dropped）|
| `clearEndpointPending(endpoint_id, status)` | `c4-db.js` 新增 | 把 endpoint 当前所有 pending inbound 标 terminal（默认 `replied`，用于 agent reply 路径）|
| `listPendingInbounds(endpoint_id?)` | `c4-db.js` 新增 | 查询 pending inbounds（无 endpoint 即查全部，session-init 用全部 endpoint）|
| `c4-dispatcher` 主循环 | `c4-dispatcher.js` | 拉取待投递时加 `WHERE terminal_status = 'pending'` 过滤 |
| `c4-session-init` 注入 | `c4-session-init.js` | 调 `listPendingInbounds()` 把结果作为 startup context 第三段 |

### 调用关系

```
┌─────────────────┐  --content          ┌───────────────┐
│ channel daemon  │ ───────────────────▶│ c4-receive.js │
└─────────────────┘                     └───────┬───────┘
                                                │
                                                │ insertConversation('in', ...)
                                                ▼
                                        ┌────────────────────────────┐
                                        │ conversations 表           │
                                        │ direction='in'             │
                                        │ terminal_status='pending'  │
                                        └──────────┬─────────────────┘
                                                   │
                  ┌────────────────────────────────┼───────────────────────────┐
                  │                                │                           │
                  ▼ (健康)                        ▼ (unhealthy)              ▼ (启动)
          ┌──────────────┐              ┌────────────────┐         ┌────────────────────┐
          │c4-dispatcher │              │MessageRouter   │         │c4-session-init.js  │
          │WHERE         │              │unhealthy 路径  │         │listPendingInbounds()│
          │  pending     │              │同步写 status   │         │→ inject startup    │
          │  + priority  │              │+ markTerminal  │         │  context 第三段    │
          └──────┬───────┘              └────────┬───────┘         └────────────────────┘
                 ▼                               ▼
          ┌──────────────┐              ┌─────────────────┐
          │ tmux runtime │              │ 用户立即收到   │
          │ agent 处理   │              │ 状态文案        │
          └──────┬───────┘              │ inbound 已 term │
                 │                      └─────────────────┘
                 │ agent 写 outbound (reply)
                 ▼
          ┌─────────────────────────┐
          │ c4 自动 clearEndpoint   │
          │ Pending(endpoint_id,    │
          │   'replied')            │
          └─────────────────────────┘
```

---

## 5. 错误处理与恢复逻辑

### 配对边缘 case

#### Case 1：agent 写 outbound 但 endpoint 当前无 pending inbound

可能原因：
- agent 自发主动消息（不是回复任何 inbound）
- 已经被其他路径 terminal 化的 endpoint 又来了 outbound

**处理**：`clearEndpointPending` 是 no-op（没有 pending 可标）。outbound 正常写入。不报错。

#### Case 2：endpoint 有多条 pending，agent 只想答 1 条

最简模型下，agent 写 outbound → 全部 pending 标 `replied`。如果 agent 实际只想答 1 条留其他 pending：

**处理**：
- 默认行为：全部标 `replied`（接受信息丢失边缘）
- 如果 agent 显式想保留：在写 outbound **之前**先 `markInboundTerminal(other_id, 'manually_dropped')` 显式 drop 不想答的，剩余的"被 outbound 关联标 replied" 是真正答的那一条
- agent 发现 endpoint 还有 prior pending 想保留，可以**先**显式标其他为 `manually_dropped`，再写 outbound——会被关联标 `replied` 的就只剩一条

复杂逻辑放给 agent 决策——LLM 的本职是看 context 自决策；c4 只提供工具不强制策略。

#### Case 3：unhealthy 路径写状态文案后 health 又恢复

时序：
1. health=Unavailable → c4-receive 写 inbound + status_replied 文案 → inbound 标 `status_replied`
2. health 恢复 OK
3. 同 endpoint 用户发新消息 N → c4-receive 写 inbound N 默认 `pending`
4. c4-dispatcher 投递 N → agent 处理 → 写 outbound

**期望**：agent 的 outbound 只标 N 为 `replied`，**不影响**已经 `status_replied` 的旧 inbound。

**实现保证**：`clearEndpointPending` 只标 `pending` → `replied`（不动 terminal 状态，C-Term-1 不变量）。

#### Case 4：agent 写 outbound 跨多 endpoint（如群组转发）

罕见但可能。当前模型：每个 outbound 写到一个 endpoint，不跨 endpoint。如果 agent 用工具发多条 outbound，每条触发自己 endpoint 的 clearEndpointPending。

### Crash 恢复

- **c4-receive crash**：写 inbound 后 process die → inbound 已落库 (durability 不变)，terminal_status 默认 `pending` 自动等下次 dispatcher 拉
- **c4-dispatcher crash**：投递中 process die → inbound 仍 `pending`，下次 dispatcher 重启会重新拉到（避免 dispatcher 提前标 terminal）
- **monitor.js crash**：unhealthy 路径中断 → c4-receive 看不到 router 响应，走 §5.4 IPC 降级文案（不入队）；inbound 不写就没 terminal status 问题
- **agent crash mid-reply**：outbound 已写但 endpoint pending 还没 clear → 下次 dispatcher 拉到 pending 重投，agent 再次处理；可能造成 double-reply 但 LLM 看 context 通常会识别"我刚回过这条"自决策

为彻底避免 case "agent crash mid-reply 重投"，可在 c4-receive 写 outbound 时把 `clearEndpointPending` 同事务执行（SQLite transaction），保证 outbound 写入 + pending 清理原子化。

### Schema migration 失败

`ALTER TABLE ADD COLUMN` 在 SQLite 里是非破坏操作（带 DEFAULT 不需要重写表）。如果迁移失败：

- 老 `conversations` 表无 `terminal_status` 列
- 新代码尝试读 `terminal_status` → SQLite 报错"no such column"
- migration 脚本应包含 idempotent 检测（`PRAGMA table_info(conversations)` 看是否已加列）

---

## 6. 迁移策略

### 落地阶段（同顶层方案 §八 Phase 3）

**Step 1：Schema migration**
- 新增 SQL：`ALTER TABLE conversations ADD COLUMN terminal_status ...`
- 运行 idempotent 迁移脚本（`c4-db.js migrate-terminal-status`）
- 既有所有行默认 `pending`——但既有 inbound 中**已经被 agent 答过的**会被错误识别为"未答"

**Step 2：既有数据回填**
- 一次性脚本扫描既有 `conversations`：对每个 endpoint，按时间顺序，每个 inbound **如果之后有 outbound** 标 `replied`，否则保持 `pending`
- 这是 best-effort 回填——不精确（不知道"哪条 outbound 答了哪条 inbound"）但**总比全部 pending 好**——保证启动时 session-init 不会把所有历史消息都注入
- 回填脚本：`c4-db.js backfill-terminal-status`（在 schema migration 后立刻跑一次）

**Step 3：c4-receive / c4-dispatcher 改造**
- c4-receive 写 inbound 默认 `pending`（schema default）
- c4-receive 写 outbound：health=OK 路径同事务 `clearEndpointPending(endpoint_id, 'replied')`；unhealthy 路径同事务 `markInboundTerminal(inbound_id, 'status_replied')`
- c4-dispatcher 主循环加 `WHERE terminal_status = 'pending'` 过滤

**Step 4：c4-session-init 改造**
- 注入 startup context 三段：
  1. last checkpoint summary（既有）
  2. recent unsummarized 对话（既有，可能被 recent-N 截断）
  3. **当前 endpoint pending inbounds**（新增段，不被截断）

### 兼容性

- 老 c4-receive / c4-dispatcher 不读 `terminal_status` 字段——schema migration 后老代码也能跑，但 dispatcher 不过滤 pending 会重新投已答消息（短窗口 bug）
- 因此 schema migration 必须跟代码改造**同 release 部署**——不允许新 schema + 老代码同时存在
- 回滚：drop column 是破坏性的，但留 column 不删不影响老代码（老代码忽略 unknown column）；回滚只需切回老二进制

---

## 7. 测试策略 + 验收标准

### 单元测试

| 测试 | 描述 |
|---|---|
| `terminal_status default` | 新写 inbound 默认 `pending` |
| `markInboundTerminal happy path` | `markInboundTerminal(id, 'status_replied')` 后查询确实变 status_replied |
| `markInboundTerminal idempotent` | 重复调用不变状态（C-Term-1 不变量）|
| `markInboundTerminal terminal monotonic` | 已 `replied` 的不能改回 `pending`（C-Term-1）|
| `clearEndpointPending happy path` | 多条 pending → 全部标 replied |
| `clearEndpointPending no-op` | 无 pending 时不报错 |
| `clearEndpointPending 不影响 terminal` | `pending` + `status_replied` 混合 → 只动 pending（C-Term-1）|
| `listPendingInbounds endpoint filter` | 按 endpoint_id 过滤正确 |
| `listPendingInbounds no terminal` | 已 terminal 的不被列出 |

### 集成测试

| 测试 | 描述 |
|---|---|
| OK 直通路径 → terminal=replied | 端到端：用户发消息 → agent 回复 → 查 inbound 已 `replied` |
| Unhealthy 路径 → terminal=status_replied | 模拟 health=Unavailable → c4-receive 写 inbound + outbound 状态文案 → 查 inbound 已 `status_replied` |
| Unhealthy 后恢复 OK 路径 | 上一步后 health 恢复，同 endpoint 新消息 → 新 inbound 走 OK 直通；老 inbound 仍 `status_replied`（不受影响）|
| Dispatcher 不投 terminal | 模拟手工把 inbound 标 `replied` → dispatcher 不再投递 |
| Session restart 注入 pending | 模拟有 pending inbound + restart → c4-session-init 把 pending 列表注入 startup context |
| Reply 配对 - 多 pending | endpoint 有 3 条 pending → agent 写 1 条 outbound → 3 条全部 `replied` |
| Reply 配对 - 跨 endpoint 不污染 | endpoint A 有 pending → agent 写 endpoint B outbound → A pending 不变 |
| `manually_dropped` 路径 | agent 显式 mark-dropped → inbound 不再 pending，dispatcher 不投，session-init 不注入 |

### Golden test：startup context 注入

模拟一个有 5 条 inbound 的 conversations 表，2 条 `replied`、1 条 `status_replied`、1 条 `manually_dropped`、1 条 `pending`：
- session-init 调 `listPendingInbounds(endpoint_id)`
- **必须只返回 1 条** pending 的
- startup context 第三段恰好包含这 1 条

### 验收标准

- ✅ 所有单元测试通过
- ✅ 所有集成测试通过
- ✅ Schema migration + backfill 在 staging 环境跑过 ≥ 1 周无 bug
- ✅ 跨 channel（lark / tg / hxa / web-console）至少各跑过 1 个 OK 直通 + 1 个 unhealthy 路径
- ✅ 1-reply invariant 在 100 次模拟跑里 100% 成立
- ✅ pending inbound 跨 restart 持久——重启 1000 次，pending 不丢失也不被错误标 terminal

---

## 8. 与其他模块的依赖关系

### 上游依赖（本契约依赖）

| 依赖 | 关系 |
|---|---|
| `c4-db.js` (sqlite 持久层) | schema 扩展、新增 `markInboundTerminal` / `clearEndpointPending` / `listPendingInbounds` API |
| `c4-receive.js` | 写 inbound / outbound 时调用新 API（同事务）|
| `c4-dispatcher.js` | 投递主循环加 `terminal_status = 'pending'` 过滤 |
| `c4-session-init.js` | 启动时调 `listPendingInbounds` 注入 startup context |

### 下游依赖（依赖本契约的模块）

| 模块 | 怎么依赖 |
|---|---|
| [`message-router.md`](message-router.md) | unhealthy 路径写 outbound 状态文案 + `markInboundTerminal` 同事务，守 C1 不变量 |
| [`session-restart-continuation.md`](session-restart-continuation.md) | session restart 后消费 `listPendingInbounds` 输出 + agent 自治续接逻辑 |

### 不依赖本契约的模块

AM 内业务模块（Guardian / HealthEngine / SignalStore / StatusWriter / TaskScheduler / ToolPipeline / ToolWatchdog / ProcSampler / Adapter）**不直接读写** terminal_status——它们通过 c4-receive IPC 与 c4 交互，不感知 terminal_status 字段。这是 **separation of concerns**：

- AM 关心 runtime liveness/health
- C4 关心消息可靠性（包括 reply-resolution）
- 两者通过 `agent-status.json` 单向 channel 协同——不互相穿透

### 与 channel daemon / 外部接口的关系

| 表面 | 是否变更 |
|---|---|
| Lark / TG / HXA / Web channel daemon ↔ c4-receive CLI 协议 | **不变** |
| c4-receive `--content` / `--channel` / `--endpoint` / `--priority` 参数 | **不变** |
| `c4-db.js insert <dir> <channel> <endpoint> <content>` CLI 签名 | **不变**（terminal_status 默认值由 schema 提供）|
| conversations 表 schema | 加 1 列（`terminal_status`），向后兼容（带 DEFAULT，不影响 INSERT 现有签名）|

**结论**：本契约在 c4 内部展开，对 channel daemon / 外部 CLI 调用方零感知，只需 c4 自己升级 release。

---

*v3 R3 review (zylos0t reframe, 2026-04-28) 后新增。zylos101 主笔，引入 Direction D 在 v2.1 walkback 漏掉的 reply-resolution / unresolved-inbound exposure contract，落地位置由 AM 移到 C4 内部。*
