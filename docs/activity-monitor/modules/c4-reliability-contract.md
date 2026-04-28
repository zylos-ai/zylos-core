> ⚠️ **本文件 SUPERSEDED**（2026-04-28，R6 production rollback by ccb981c2）。
>
> v3 顶层方案 + 9 份模块实施档（含本文件）整套 SUPERSEDED——production trade-off 决策回退到 v2.1 baseline。详见 [`../../activity-monitor-refactor-proposal-v3.md`](../../activity-monitor-refactor-proposal-v3.md) 头部 R6 rollback reasoning。
>
> **当前 implementation baseline**: [`../../activity-monitor-refactor-proposal-v2.1.md`](../../activity-monitor-refactor-proposal-v2.1.md)
>
> 本文件保留作 R3+R4+R5 设计演进记录，**不要据此实施**。

---

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

`conversations` 表新增 3 列（同 ALTER TABLE 一次完成）：

```sql
-- 第 1 列：terminal status FSM
ALTER TABLE conversations
ADD COLUMN terminal_status TEXT
  DEFAULT 'pending'
  CHECK (terminal_status IN (
    'pending', 'replied', 'status_replied', 'manually_dropped'
  ));

-- 第 2 列：reply correlation token（仅 outbound 行可能有值，inbound 始终 NULL）
ALTER TABLE conversations
ADD COLUMN reply_to_inbound_id INTEGER NULL;

-- 第 3 列：dispatcher claim 时间戳（仅 inbound 行可能有值）
ALTER TABLE conversations
ADD COLUMN claimed_at INTEGER NULL;

-- 索引：dispatcher 过滤 + session-init 查询都按 (endpoint_id, terminal_status) 过滤
CREATE INDEX IF NOT EXISTS idx_conversations_terminal
  ON conversations (endpoint_id, terminal_status, ts);

-- 索引（可选，加速 reply correlation 查找）：
CREATE INDEX IF NOT EXISTS idx_conversations_reply_to
  ON conversations (reply_to_inbound_id)
  WHERE reply_to_inbound_id IS NOT NULL;
```

**`terminal_status` 只对 inbound 行有意义**：outbound 行字段保留默认 `pending` 但不被任何逻辑读取（也可在 schema 层加 `CHECK direction = 'in' OR terminal_status = 'pending'` 约束，但实现上不必要）。

**`reply_to_inbound_id` 只对 outbound 行有意义**：标识此 outbound 在回应哪条 inbound（reply correlation token），inbound 行始终 NULL。

**`claimed_at` 只对 inbound 行有意义**：标识此 inbound 被 dispatcher claim 投递的时间戳，用于 dispatcher 内部 housekeeping，不对外契约。

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

### Reply 配对：dispatcher claim + reply command token-passing（R4 review by zylos0t 修订）

**核心机制**：correlation 不靠 endpoint heuristic / 不靠 agent 语义判断 / 不靠 dispatcher 内存跨进程读取，而是 **dispatcher claim 时生成的 reply command 本身就携带 inbound id**——这是 mechanical contract 的真正落地形式。

#### Dispatcher claim → 生成 reply command 流程

`reply_to_inbound_id` 字段已在 §3 schema 节统一声明（与 terminal_status / claimed_at 同一 ALTER TABLE 一次落地）。本节描述其使用流程：

c4-dispatcher 投递 inbound A 给 tmux 时：

1. **持久化 claim**：在 conversations 表更新 inbound A 的 `claimed_at` 字段（轻量），或写一条 `delivery_context` 表记录（schema 设计可选——倾向前者更轻）。这是 mechanical 持久化，不靠内存。
2. **生成 reply command 含 inbound id**：dispatcher 把发到 agent prompt 里的 `reply via:` 字符串改写为携带 `--reply-to-id A`：

```
原 (无 correlation):
  reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "<endpoint>"

新 (带 token-passing correlation):
  reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "<endpoint>" --reply-to-id 42
```

3. agent 看到 prompt 里这个 ready-to-go 命令，**只需 follow 即可**——不需要"知道"自己在回哪条，dispatcher 已替它准备好。

#### Outbound 写入 3 种场景（v3 baseline 范围）

| # | 场景 | reply_to_inbound_id | mark inbound terminal | 说明 |
|---|---|---|---|---|
| 1 | normal reply (agent follow dispatcher 的 reply command) | inbound id（来自 `--reply-to-id`） | 标该 inbound `replied`（同事务）| agent 不需手工判断，命令本身已带 token |
| 2 | agent 主动消息 (无 dispatcher claim) | `null` | **不动任何 pending** | 解决 silent swallow——这是关键修正 |
| 3 | unhealthy 同步状态文案（c4-receive 内部）| 显式填当前正在处理的 inbound id | 标该 inbound `status_replied`（同事务）| caller 是 c4-receive 自己不是 agent |

> **注**：v3 baseline **不支持** batch `--reply-to-ids "1,2,3"`——schema `reply_to_inbound_id INTEGER NULL` 是单值字段，无法表达一条 outbound 对多 inbound 的 correlation；如需 batch reply，要么 (a) 改 mapping table（`outbound_reply_links(outbound_id, inbound_id)`，schema 复杂度高），要么 (b) agent 写 N 条独立 outbound（每条单 `--reply-to-id`）。R5 review 决定 baseline 选 (b)——少见 batch case 不值 schema 复杂度；如果 production 真有强需求未来再开 separate PR。

#### 输入校验：两层语义（hard error vs warning），优先级清晰

`c4-send --reply-to-id N` 写入流程分两层校验，**优先级 hard validation 在前，soft idempotent handling 在后**——这样 error / warning 分界不歧义：

##### 层 A：Hard validation（输入格式 / 归属错误 → reject，不写 outbound）

校验：

1. **存在性**：inbound N 必须存在
2. **Channel 一致性**：inbound N `channel` 跟 outbound 目标 channel 一致
3. **Endpoint 一致性**：inbound N `endpoint` 跟 outbound 目标 endpoint 一致

任一失败 → c4-send 返 **error**（exit non-zero）+ 不写 outbound + 不改任何 inbound state。这是真正的"输入格式 / 归属错误"。

##### 层 B：Soft idempotent handling（已 terminal → outbound 写入但 mark no-op + warning）

层 A 全部通过后，c4-send **写 outbound 行**（含 `reply_to_inbound_id` 指向参数中的 id）。然后尝试 mark terminal：

- inbound `terminal_status = 'pending'` → mark replied（或 status_replied，看 caller 路径）✓
- inbound 已 terminal（replied / status_replied / manually_dropped）：
  - **outbound 仍写入**（保留 audit trail）
  - mark terminal **no-op**（C-Term-5 单调：不动既有 terminal status）
  - c4-send 返 **warning**（exit code 0，但 stderr 含 warning）
  - log 明确记录 "inbound N already terminal (was: <status>), outbound recorded but terminal_status unchanged"

**为什么这样分**（zylos0t R4 follow-through 修订）：

- 层 A "不存在 / 跨 channel / 跨 endpoint" = 输入根本错了 → reject + 不写 outbound，防止 outbound 误写到错误位置
- 层 B "已 terminal" 不是输入错——是同一 reply command 重复执行或迟到 reply 的**幂等场景**（agent 重发 / 网络重试 / 手工触发等）→ 不能丢 outbound audit trail，但 terminal mark 必须保护单调性

#### 不变量补充

- **C-Term-5 mark-terminal 幂等单调**：同一 inbound 只会被首次成功 mark 标 terminal，后续 mark 调用 no-op + warning（**不是** error）。配合 C-Term-1 共同保证：同一 inbound 终态稳定，重复 mark 不破坏既有状态。

---

## 4. 关键接口与调用关系

### 接口列表

| 接口 | 实现位置 | 职责 |
|---|---|---|
| `insertConversation('in', ...)` | `c4-db.js` / `c4-receive.js` | 写 inbound，默认 `terminal_status = 'pending'`，`reply_to_inbound_id = NULL` |
| `c4-send.js [...] [--reply-to-id N]` | `c4-send.js` 新增单值参数 | agent / channel reply 路径写 outbound 含 reply correlation token；做 hard validation（层 A）后写 outbound + 尝试 mark terminal（层 B 幂等）|
| `c4-receive.js` 内部 outbound 路径（unhealthy）| `c4-receive.js` | unhealthy 同事务写 inbound + outbound + 标 `status_replied`，内部直传 `reply_to_inbound_id` 给 c4-db API |
| `markInboundTerminal(inbound_id, status)` | `c4-db.js` 新增 | 显式标某条 inbound 为 terminal（replied / status_replied / manually_dropped）；幂等单调（C-Term-5）|
| `listPendingInbounds(endpoint_id?, opts?)` | `c4-db.js` 新增 | 查询 pending inbounds；返完整集合 + 总数；session-init / agent 续查接口都用此 API；可选参数 `{limit, offset}` 支持 continuation |
| `claimInboundForDelivery(inbound_id)` | `c4-db.js` 新增（或扩展）| dispatcher 投递前更新 `claimed_at` 字段（轻量持久化）；不阻塞——claim 仅记录"已开始投递"，不影响其他模块查询 |
| `c4-dispatcher` 投递主循环 | `c4-dispatcher.js` | (1) 拉取候选 inbound 加 `WHERE terminal_status = 'pending'` 过滤；(2) 投递前调 `claimInboundForDelivery`；(3) 生成包含 `--reply-to-id <id>` 的 reply via 命令注入 prompt |
| `c4-session-init` 注入 | `c4-session-init.js` | 调 `listPendingInbounds(endpoint_id, {limit: K})` 把 bounded subset 作为 startup context 第三段 + total/omitted count + continuation 提示 |

### 调用关系（含 reply command token-passing）

```
┌─────────────────┐  --content                ┌───────────────┐
│ channel daemon  │ ─────────────────────────▶│ c4-receive.js │
└─────────────────┘                           └───────┬───────┘
                                                      │
                                                      │ insertConversation('in', ...)
                                                      │  terminal_status='pending'
                                                      │  reply_to_inbound_id=NULL
                                                      ▼
                                              ┌────────────────────────────┐
                                              │ conversations 表           │
                                              └──────────┬─────────────────┘
                                                         │
                  ┌──────────────────────────────────────┼──────────────────────────┐
                  │                                      │                          │
                  ▼ (健康 OK)                           ▼ (unhealthy)             ▼ (启动)
          ┌────────────────────────┐         ┌──────────────────────┐    ┌────────────────────┐
          │ c4-dispatcher          │         │ MessageRouter        │    │c4-session-init.js  │
          │ 1) WHERE pending       │         │ unhealthy: c4-receive│    │listPendingInbounds │
          │ 2) claimInboundFor-    │         │ 内部同事务：         │    │  (endpoint, K=20)  │
          │    Delivery(A)         │         │  insertConv('in')    │    │→ 注入 startup       │
          │ 3) 生成 reply via:     │         │  insertConv('out',   │    │  context 第三段 +   │
          │    c4-send.js "lark"   │         │    status文案,       │    │  total/omitted      │
          │    "<endpoint>"        │         │    reply_to=in.id)   │    │  count + continu-  │
          │    --reply-to-id A     │         │  markInboundTerminal │    │  ation 提示         │
          └──────────┬─────────────┘         │   (in.id, 'status_   │    └────────────────────┘
                     ▼                       │    replied')          │
            ┌──────────────────┐             └────────────┬─────────┘
            │ tmux runtime     │                          ▼
            │ agent 看 prompt  │                  ┌──────────────┐
            │ → follow reply   │                  │ 用户立即收到 │
            │   command:       │                  │ 状态文案     │
            │   c4-send.js ... │                  │ inbound 已   │
            │   --reply-to-id A│                  │ status_      │
            └──────────┬───────┘                  │ replied      │
                       ▼                          └──────────────┘
            ┌────────────────────────────────────────┐
            │ c4-send.js 接收 --reply-to-id A:        │
            │ 层 A Hard validation:                   │
            │   inbound A 存在? channel? endpoint?    │
            │   ❌ → exit non-zero error              │
            │   ✅ → 进入层 B                         │
            │ 写 outbound (reply_to_inbound_id=A)     │
            │ 层 B Soft idempotent:                   │
            │   A.terminal == 'pending':              │
            │     → markInboundTerminal(A, 'replied') │
            │   A.terminal != 'pending':              │
            │     → no-op + warning (C-Term-5)        │
            └────────────────────────────────────────┘

agent 主动消息（无 dispatcher claim）：
  agent 自己组装命令，**不带** --reply-to-id
  c4-send 写 outbound 默认 reply_to_inbound_id=NULL
  → 不动任何 pending（解决 silent swallow）
```

---

## 5. 错误处理与恢复逻辑

### 配对边缘 case（R4 reframe 后重写）

#### Case 1：agent 主动消息（dispatcher 未 claim）

agent 自发写一条消息（不在回复任何 dispatched inbound）：

- agent 组装 c4-send 命令**不带** `--reply-to-id`
- c4-send 写 outbound `reply_to_inbound_id = NULL`
- **不动任何 pending**——pending inbound 仍 pending，下次 dispatcher 投递正常

这是关键修正——R3 的 endpoint heuristic 在这个 case 会把全部 pending 误标 replied，R4 修订彻底解决。

#### Case 2：endpoint 有多条 pending，agent 选择性答 1 条

dispatcher 串行投递（require_idle 保证）一次只 claim 1 条 inbound：

- inbound A 被 claim → 注入 reply via 命令含 `--reply-to-id A`
- agent 处理 A，写 outbound → 标 A `replied`
- dispatcher 看到 A terminal + agent idle → 拉下一条 pending 投递

如果 agent 要"一次答多条"：v3 baseline 的方式是写 N 条独立 outbound，每条单 `--reply-to-id`（依次标 N 条 `replied`）。schema 不支持单 outbound 关联多 inbound（详上面 §3 "Outbound 写入 3 种场景" 注）。

如果 agent 选择性答（claim 了 A 但答案同时 cover 了 B / C 等其他 endpoint pending）：
- 推荐：写 N 条独立 outbound，每条带不同 `--reply-to-id`，明确标 N 条 inbound `replied`
- 或 agent 决定其他 prior pending 不答（不 force drop），保持 pending 跨 restart 持久——下次 restart c4-session-init 仍注入，agent 再决策

#### Case 3：unhealthy 路径写状态文案后 health 恢复

时序：
1. health=Unavailable → c4-receive 写 inbound A + outbound 状态文案（同事务：`reply_to_inbound_id=A`，标 A `status_replied`）
2. health 恢复 OK
3. 同 endpoint 用户发新消息 B → c4-receive 写 inbound B 默认 `pending`
4. c4-dispatcher claim B → 注入 reply via 含 `--reply-to-id B`
5. agent 处理 B → 写 outbound → 标 B `replied`

**期望**：B 的 outbound 只动 B 不动 A。**实现**：reply command 含 `--reply-to-id B`，c4-send 层 A 校验 B 存在 + channel/endpoint 一致 ✓；层 B 看 B `pending` → 标 `replied`。A 完全没出现在 reply command 里——根本不会被触碰。

#### Case 4：旧 reply command 重复执行（agent 重发 / 操作员重试）

时序：
1. dispatcher claim A → reply via 含 `--reply-to-id A`
2. agent 写 outbound → 标 A `replied`
3. agent 由于某种原因（重发 / 重试 / 操作员手工触发）再次跑同一 reply command

**期望**：第二次 outbound 仍写入（audit trail），但不能破坏 A 的 terminal 状态。

**实现（层 A + 层 B 协同）**：
- 层 A：A 存在 ✓，channel/endpoint 一致 ✓ → 通过 hard validation
- c4-send 写第二条 outbound `reply_to_inbound_id=A`
- 层 B：A `terminal_status` 已 `replied`（不是 pending）→ markInboundTerminal no-op + log warning
- c4-send exit code 0，stderr 含 "inbound A already terminal (was: replied), outbound recorded but terminal_status unchanged"

#### Case 5：reply command 被复制 / 误用到错误 endpoint

恶意 / 误操作场景：agent 把含 `--reply-to-id 42` 的命令复制到另一个 endpoint 调用：

- 层 A 校验：inbound 42 的 endpoint 跟 outbound 目标 endpoint 不一致 → **hard error，reject + 不写 outbound**
- 不写任何 outbound + 不改任何 inbound state
- 防 cross-endpoint 误标关键防线（C-Term-2 / C-Term-3 安全）


### Crash 恢复

- **c4-receive crash**：写 inbound 后 process die → inbound 已落库 (durability 不变)，terminal_status 默认 `pending` 自动等下次 dispatcher 拉
- **c4-dispatcher crash**：投递中 process die → inbound 仍 `pending`，下次 dispatcher 重启会重新拉到（避免 dispatcher 提前标 terminal）
- **monitor.js crash**：unhealthy 路径中断 → c4-receive 看不到 router 响应，走 §5.4 IPC 降级文案（不入队）；inbound 不写就没 terminal status 问题
- **agent crash mid-reply**：c4-send 写 outbound 跟 markInboundTerminal 是同事务（SQLite transaction）——要么 outbound 行 + inbound `replied` 标记一起成功，要么一起回滚。所以"outbound 已写但 inbound 没标 terminal"这个半完成态在 SQLite 事务保证下不会出现。
  - 如果是 c4-send 调用尚未启动 transaction 就 crash：outbound 没写也没 mark，inbound 仍 pending，下次 dispatcher 重新投递正常
  - 如果是 transaction 中途 crash：SQLite WAL 自动回滚，效果同上
  - 不会出现 dispatcher 拿到 pending 重投但 agent 已经写过 outbound 的情况

### Schema migration 失败

`ALTER TABLE ADD COLUMN` 在 SQLite 里是非破坏操作（带 DEFAULT 不需要重写表）。如果迁移失败：

- 老 `conversations` 表无 `terminal_status` 列
- 新代码尝试读 `terminal_status` → SQLite 报错"no such column"
- migration 脚本应包含 idempotent 检测（`PRAGMA table_info(conversations)` 看是否已加列）

---

## 6. 迁移策略

### 落地阶段（同顶层方案 §八 Phase 3）

**Step 1：Schema migration**
- 新增 SQL：
  ```sql
  ALTER TABLE conversations ADD COLUMN terminal_status TEXT DEFAULT 'pending'
    CHECK (terminal_status IN ('pending','replied','status_replied','manually_dropped'));
  ALTER TABLE conversations ADD COLUMN reply_to_inbound_id INTEGER NULL;
  ALTER TABLE conversations ADD COLUMN claimed_at INTEGER NULL;  -- ms timestamp
  ```
- 运行 idempotent 迁移脚本（`c4-db.js migrate-reliability-schema`）
- 既有所有行默认 `pending` / `NULL` —— 但既有 inbound 中**已经被 agent 答过的**会被错误识别为"未答"

**Step 2：既有数据回填**
- 一次性脚本扫描既有 `conversations`：对每个 endpoint，按时间顺序，每条 inbound **如果之后同 endpoint 有 outbound** 标 `replied`，否则保持 `pending`
- 这是 best-effort 回填——不精确（不知道"哪条 outbound 答了哪条 inbound"）但**总比全部 pending 好**——保证启动时 session-init 不会把所有历史消息都注入
- 回填脚本：`c4-db.js backfill-reliability-status`（在 schema migration 后立刻跑一次）
- **注意**：回填只填 `terminal_status`，不填 `reply_to_inbound_id`（既有 outbound 没有 correlation token，留 NULL）

**Step 3：c4-receive / c4-dispatcher / c4-send 改造**
- c4-receive 写 inbound 默认 `terminal_status='pending'`（schema default）
- c4-send 加 `--reply-to-id` 单值参数 + 实现层 A hard validation + 层 B soft idempotent + 同事务写 outbound + markInboundTerminal
- c4-receive 内部 unhealthy 路径同事务写 inbound + outbound + 标 status_replied（caller 显式带 `reply_to_inbound_id`）
- c4-dispatcher 改造：
  - 拉取候选 inbound 加 `WHERE terminal_status = 'pending'` 过滤
  - 投递前调 `claimInboundForDelivery(inbound.id)` 写 `claimed_at`
  - 把 reply via 命令改写为携带 `--reply-to-id <inbound.id>`

**Step 4：c4-session-init 改造**
- 注入 startup context 三段：
  1. last checkpoint summary（既有）
  2. recent unsummarized 对话（既有，可能被 recent-N 截断）
  3. **当前 endpoint pending inbounds bounded subset**（新增段，default top-K=20 + total/omitted count + continuation 提示）

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
| `reply_to_inbound_id default` | 新写 inbound `reply_to_inbound_id=NULL`；新写 outbound 不传则 NULL |
| `markInboundTerminal happy path` | `markInboundTerminal(id, 'replied')` 后查询确实变 `replied` |
| `markInboundTerminal C-Term-1 单调` | 已 `replied` 的不能改回 `pending`（终态单调）|
| `markInboundTerminal C-Term-5 幂等` | 同一 inbound 第二次 mark → no-op + 警告，不破坏既有 status |
| `listPendingInbounds endpoint filter` | 按 endpoint_id 过滤正确 |
| `listPendingInbounds no terminal` | 已 terminal 的不被列出 |
| `listPendingInbounds limit/offset` | 100 条 pending → limit=20, offset=20 拿到第 21~40 条 |
| `claimInboundForDelivery` | 调用后 `claimed_at` 字段更新 |
| `c4-send hard validation: not exists` | `--reply-to-id 99999` 不存在 → exit non-zero error，不写 outbound |
| `c4-send hard validation: channel mismatch` | inbound 在 lark，outbound 目标 hxa-connect → exit error |
| `c4-send hard validation: endpoint mismatch` | inbound endpoint A，outbound 目标 endpoint B → exit error |
| `c4-send soft idempotent: pending` | inbound pending → outbound 写入 + mark replied ✓ |
| `c4-send soft idempotent: already replied` | inbound 已 replied → outbound 仍写入，mark no-op + warning to stderr (exit 0) |
| `c4-send default reply_to=null` | 不带 `--reply-to-id` → outbound `reply_to_inbound_id=NULL`，**不动任何 pending** |

### 集成测试

| 测试 | 描述 |
|---|---|
| OK 直通路径 → terminal=replied | 端到端：用户发消息 → dispatcher 注入 reply via `--reply-to-id A` → agent follow → c4-send 写 outbound + 标 A `replied` |
| Unhealthy 路径 → terminal=status_replied | 模拟 health=Unavailable → c4-receive 内部同事务写 inbound + outbound 状态文案 + 标 `status_replied` |
| Unhealthy 后恢复 OK 路径 | health 恢复，同 endpoint 新消息 B → 新 inbound 走 OK 直通；老 inbound 仍 `status_replied` 不受影响 |
| Dispatcher 不投 terminal | 模拟手工标 `replied` → dispatcher 不再投递 |
| Session restart 注入 pending bounded | 100 条 pending + restart → session-init 注入 latest 20 + total/omitted count |
| Agent 主动消息不动 pending | endpoint 有 5 条 pending → agent 自行 c4-send 不带 `--reply-to-id` → 5 条 pending 完整保留 |
| 重复执行同 reply command 幂等 | dispatcher 投递两次同 `--reply-to-id 42` → 2 outbound 行（audit），inbound 42 只第一次标 `replied` |
| Cross-endpoint 误标拦截 | 复制 `--reply-to-id 42` 到错误 endpoint → exit error 不写 |
| Continuation 拉取 | session-init 注入 latest 20 + agent 调 `c4-db.js list-pending --offset 20 --endpoint X` 拿剩余 |

### Golden test：startup context 注入 bounded

模拟一个有 50 条 pending inbound 的 endpoint：
- session-init 调 `listPendingInbounds(endpoint, {limit: 20})`
- **必须返回 latest 20 条**
- startup context 第三段含这 20 + "共 50 条 pending；显示最近 20；其余 30 条调 `c4-db.js list-pending --offset 20` 查"

### 验收标准

- ✅ 上述单元测试全部通过
- ✅ 上述集成测试全部通过
- ✅ Schema migration + backfill 在 staging 环境跑过 ≥ 1 周无 bug
- ✅ 跨 channel（lark / tg / hxa / web-console）至少各跑过 1 个 OK 直通 + 1 个 unhealthy 路径
- ✅ 1-reply invariant 在 100 次模拟跑里 100% 成立（**双层语义**：DB 持久化完整性 100% + bounded subset 准确）
- ✅ DB 持久化完整性：1000 次 restart pending **不丢失**也**不被错误标 terminal**
- ✅ Bounded subset 准确性：startup context 第三段含 latest K + 准确 total count
- ✅ Reply command 重复执行幂等性：100 次重复执行同一 reply command → 1 inbound terminal，N outbound audit 行

---

## 8. 与其他模块的依赖关系

### 上游依赖（本契约依赖）

| 依赖 | 关系 |
|---|---|
| `c4-db.js` (sqlite 持久层) | schema 扩展（terminal_status / reply_to_inbound_id / claimed_at 三字段）、新增 `markInboundTerminal` / `listPendingInbounds(opts)` / `claimInboundForDelivery` API |
| `c4-send.js` | 新增 `--reply-to-id <id>` 单值参数（baseline 不支持 batch `--reply-to-ids`），实现层 A hard validation + 层 B soft idempotent + 同事务写 outbound + markInboundTerminal |
| `c4-receive.js` | 写 inbound 默认 pending；unhealthy 路径内部同事务写 inbound + outbound + markInboundTerminal('status_replied')；caller 显式带 reply_to_inbound_id |
| `c4-dispatcher.js` | 投递主循环 (1) `WHERE terminal_status = 'pending'` 过滤 (2) `claimInboundForDelivery` 写 claimed_at (3) reply via 命令注入 `--reply-to-id <inbound.id>` |
| `c4-session-init.js` | 启动时调 `listPendingInbounds(endpoint, {limit: K=20})` 注入 startup context bounded subset + total/omitted count + continuation 提示 |

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
| `c4-db.js insert <dir> <channel> <endpoint> <content>` CLI 签名 | **不变**（terminal_status / reply_to_inbound_id / claimed_at 默认值由 schema 提供）|
| conversations 表 schema | 加 3 列（`terminal_status` / `reply_to_inbound_id` / `claimed_at`），向后兼容（全带 DEFAULT，不影响 INSERT 现有签名）|
| c4-send.js `--reply-to-id` | **新增**单值参数（向后兼容——不传时默认 NULL，行为 = "agent 主动消息不动 pending"）；不支持 batch `--reply-to-ids`（baseline scope 决定）|
| dispatcher 注入 reply via 命令格式 | **改写**（c4 内部生成的 `reply via:` 字符串现含 `--reply-to-id N`，但这是**注入到 prompt context** 给 agent follow，不是 channel daemon 协议变更）|

**结论**：本契约在 c4 内部展开，对 channel daemon / 外部 CLI 调用方零感知，只需 c4 自己升级 release。c4-send `--reply-to-id` 是新单值参数但向后兼容（不传 = 老行为）。Batch reply 不在 baseline scope；如未来强需求再开 separate PR（schema mapping table 等）。

---

*v3 R3 review (zylos0t reframe, 2026-04-28) 后新增。zylos101 主笔，引入 Direction D 在 v2.1 walkback 漏掉的 reply-resolution / unresolved-inbound exposure contract，落地位置由 AM 移到 C4 内部。*