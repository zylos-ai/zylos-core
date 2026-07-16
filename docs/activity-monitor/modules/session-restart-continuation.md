# Session Restart Continuation — 跨模块契约

> 关联顶层方案：[v3 §三.2 / §三.5 / §五.4 / §六.I](../../activity-monitor-refactor-proposal-v3.md)
> 类型：跨模块契约（非 AM 内部模块——是 AM / c4-session-init / agent 三方协议）
> Phase：0（不改代码）+ Phase 4（文档同步）

---

## 1. 模块职责与边界

### 职责

定义 session_restart 触发后**对话续接**的三方契约：

1. **c4 DB**：承诺 accepted-message durability（health=OK 时已 insertConv 的 inbound 不丢）
2. **c4-session-init**：注入 startup context（last checkpoint + recent unsummarized）
3. **agent**：看 startup context 自决策是否补 reply（best-effort）

不承诺 unresolved-inbound completeness——接受 residual UX risk（user 凭 unhealthy 时已收到的 catalog.userMessage 重发是兜底机制）。

### 严格边界

- ❌ **不引入受害者识别 ledger**——`recent-inbound.jsonl` 等 R3+R4+R5 早期方案曾设计的整套 ledger 已 ruled out（v3 §六.G #5；v2.1 §5.3.2 砍掉的机制清单）
- ❌ **不引入 unresolved-inbound 完整注入**——bounded subset + continuation CLI 是产品语义不是 AM refactor 必要前置（v3 §六.I）
- ❌ **不主动 broadcast "我恢复了"**——main 旧的 `pending-channels.jsonl` 异步恢复广播路径在本方案废弃（v3 §六.G #4）；unhealthy 时 user 已经同步收到 catalog.userMessage，无需事后再发广播
- ❌ **不引入 reply correlation token**——`reply_to_inbound_id` / reply command token-passing 等 R4 引入机制已 ruled out（v3 §六.G #2）

### 哲学

session restart 是 sticky context-poison 的兜底自愈。restart 后系统从 fresh state 开始；agent 看 c4-session-init 注入的 context 自己判断是不是要补答。这是把"是否补答"的决策**下沉给 agent 自治**，而不是 AM 用 ledger 强制补答——AM 不参与"哪条消息回了"业务语义。

---

## 2. 输入 / 输出契约（3 句 best-effort 边界）

### 契约 1：accepted-message durability

C4 DB 承诺：**health=OK 时 c4-receive 调 `insertConversation('in', ..., 'pending')` 写入的 inbound 在 session restart 后完整保留**——既有 inbound 不丢、不篡改、不删除。

适用范围：
- ✅ health=OK 时 user 发的消息
- ❌ 不含 unhealthy 路径写入的 `status='delivered'` 行（这是 audit trail，本来就不进 dispatcher 主链；不属于"accepted"语义；详 v3 §三.2 边界）

### 契约 2：best-effort continuation

restart 后由 c4-session-init **既有 hook**注入 startup context：
- last checkpoint summary（已有压缩对话历史）
- recent unsummarized conversations（最近 N 条原始对话，N 由 `SESSION_INIT_RECENT_COUNT` 配置，典型值 6）

agent 看 context 自决策：
- 看到"我刚才在处理 user X 的图片"→ 补一条 reply 说明 restart 原因
- 看到"刚 restart 完没什么 in-flight 的"→ 等下条 user 消息正常处理
- 看到"recent context 里 user 发了多条"→ 看 outbound 行判断是否已答（**agent 自己**用 c4-db.js list 查询，不是 AM 推送）

### 契约 3：不承诺 unresolved-inbound completeness + accept residual UX risk

明确**不**承诺：
- 100+ pending inbound 时 startup context 完整暴露（受 token 预算约束，typical 6 条）
- agent 100% 补答 in-flight 消息（agent 自治，可能漏判）
- 系统主动 broadcast 通知所有受害者（v3 §六.G #4 已退场）

接受由此产生的 residual UX risk：
- user 在 health=OK 时发消息进 DB → agent 处理过程中 catalog 命中 restart_session → user 在等不到 reply
- user 凭 unhealthy 时已收到的 catalog.userMessage（如"消息或附件触发 API 错误，请检查后重发"）**自行重发**是 production trade-off 接受的兜底机制
- 边界 case：user 在 health 切换瞬间发的消息可能既没收到 unhealthy 状态文案也没得到 agent reply——这是 best-effort 的 residual UX risk，不在本方案 scope 解

---

## 3. 数据结构 / 字段 / 状态机

**本契约不引入新字段、不引入新表、不引入新 schema**。所有相关字段都是 c4-session-init 既有机制：
- `conversations` 表：既有 schema（direction / channel / endpoint_id / content / status / priority / require_idle / timestamp）
- checkpoint summary：既有 c4-session-init 注入的 prompt 段
- unsummarized recent N 条：既有 c4-session-init 取最近的逻辑

唯一相关的 v3 引入字段是 `agent-status.json` 的 `unavailable_reason`（详 [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)）——agent 在 startup 时可以通过 SignalStore 看上一次进入 unhealthy 的原因，但这是参考信息不是 driving 续接决策的强字段。

---

## 4. 关键接口与调用关系

### Restart 触发 → continuation 流程

```
HealthEngine catalog dispatch (`restart_session`)
  → adapter.stop()
  → tmux session 退出
  → Guardian 看 ActivityState=Offline → 调 adapter.launch()
  → 新 session 起来
  → c4-session-init.js (既有 hook，启动时由 Claude / Codex 自动调) 跑
       ├── 拼 last checkpoint summary 段
       └── 拼 recent unsummarized N 条原始对话段
  → agent 看 startup context 自决策是否补 reply
  → agent 走正常 c4-send 路径回复（如果决定补答）
  → 下一条 user 消息按 v3 §五.1 OK 直通路径正常路由
```

### c4-session-init 接口（不修改）

c4-session-init.js 是 comm-bridge skill 既有 hook，路径：`skills/comm-bridge/scripts/c4-session-init.js`。本方案下**接口签名 / 行为完全不变**——继续用现状 last checkpoint + unsummarized recent 注入。

未来如果想增强（比如显式 unresolved-inbound subset），那是另一个 PR 的 scope（v3 §六.I 明确不在本方案范围）。

### Agent 自治续接 prompt

agent（Claude / Codex）在 startup context 看到的是：

```
[Last Checkpoint Summary] ...
[Recent Conversations]
[2026-04-28 06:45:58] IN (lark|<user>): ...
[2026-04-28 06:45:59] OUT (lark|<user>): ...
[2026-04-28 06:46:30] IN (lark|<user>): <最新一条 in-flight 时刚发的>
```

agent 凭这段 context 决策——**没有"unresolved-inbound 显式列表"段**（不引入新机制）。agent 模型的核心 capability 就是看 context 自决策，这是 best-effort 设计的依赖前提。

### 对 AM 内部模块的影响

| 模块 | 影响 |
|---|---|
| HealthEngine | restart 后 Guardian 调 `onProcessRestarted()` 回填 health；HealthEngine 不参与续接业务逻辑 |
| Guardian | restart 后调 `onProcessRestarted()` + 重置 4 字段；不查 HealthEngine 内部状态 |
| MessageRouter | restart 后下一条 c4-receive 调用时按当前 health state 正常路由；不"知道"刚发生过 restart |
| StatusWriter | 重启后第一 tick 写 `agent-status.json` 时已含恢复后的 health（HealthEngine 回填）+ 可能保留的 unavailable_reason（如果 health 仍非 OK）|

---

## 5. 错误处理与恢复逻辑

### Edge case 1：restart 期间 user 发新消息

- session 已 stop / 新 session 还没起来 → ActivityState=Offline + health 状态由 HealthEngine 决定（多数情况是 Unavailable）
- c4-receive 调 MessageRouter probe → recovered=false → 走 unhealthy 路径（`insertConv('in', ..., 'delivered')` + 调 c4-send 投递 catalog.userMessage）
- user 立即收到状态文案；本条 inbound 不进 dispatcher 主链
- **不算未答**——user 已收到 ack，不在 best-effort continuation 范围

### Edge case 2：restart 完成后 health=OK 时 user 发新消息

- 走 OK 直通路径（`insertConv('in', ..., 'pending')` → dispatcher → tmux → agent）
- agent 在新 session 中看 startup context 已含 last checkpoint + unsummarized recent → agent 知道刚 restart
- agent 答这条新消息时可能"先解释一下我刚 restart"或"直接答"——agent 自治

### Edge case 3：restart 前 in-flight 的 user 消息 agent 没答

- inbound 在 c4 DB 完整保留（contract 1）
- restart 后 c4-session-init 注入的 unsummarized recent 段含这条 inbound（如果 N 内）
- agent 看 context 自决策是否补一条 reply
- 如果 N 之外（100+ pending） / agent 漏判 → user 凭已收到的 unhealthy 状态文案重发是兜底（contract 3 residual UX risk）

### Edge case 4：连续多次 restart

- 每次 restart 都重置 4 字段 + 进入 launchGracePeriod
- c4-session-init 每次注入 last checkpoint + recent unsummarized
- agent 在每次新 session 中独立决策；checkpoint 跨 restart 沉淀对话状态

### Edge case 5：restart 后 health 仍非 OK（catalog 持续命中）

- HealthEngine 回填 unavailable state；继续指数退避 probe
- user 后续消息走 unhealthy 路径
- 这不是 continuation 的问题——是 health 路径的问题；continuation 等 health 恢复后下次 restart / 自然续上

---

## 6. 迁移策略

### Phase 0：不改代码

c4-session-init.js 既有路径完全保留——本契约是**显式声明既有机制的边界**而不是引入新代码。

**唯一动作**：v3 / v2.1 文档（包括本模块档）写清三句契约 + 5 个 edge case 边界，让 reviewer / agent / 实现者都按一致预期工作。

### Phase 4：文档 + 下游文案

- web-console UI 在显示历史对话时如果看到 `inbound status='delivered'` + 对应 outbound `catalog.userMessage` 配对，标识为"系统状态消息"以区分 agent reply
- agent prompt（Claude / Codex 各自）的 system prompt 段加一句"看 startup context 自决策是否补答"——可选优化，提升 best-effort continuation 实际命中率

### 兼容性

- 跟 main 完全兼容——main 的 c4-session-init 既有逻辑不动
- main 旧的 pending-channels broadcast 路径退场（参 v3 §六.G #4 + [`message-router.md`](message-router.md) §6 Phase 3 legacy 清理）

---

## 7. 测试策略 + 验收标准

### 单元测试（mock c4-session-init + mock agent）

- Contract 1 durability：1000 次 restart 后 health=OK 时 insertConv 的 inbound 行 100% 保留（schema 不变 + content 完整）
- Contract 2 注入正确性：c4-session-init 输出含 last checkpoint + recent N 条 unsummarized；N 由配置决定
- Contract 3 边界声明：100+ pending 时 startup context 不报错地输出 N 条 + total count 不需要（不承诺 completeness）

### E2E 测试

- Edge case 1（restart 期间发消息）：health=Unavailable 期间 c4-receive 调用走 unhealthy 路径；inbound `status='delivered'`；agent 不"看到"这条
- Edge case 2（restart 后 OK 期间）：health 恢复后 OK 路径正常；agent 看 startup context 提及 restart
- Edge case 3（in-flight 漏答）：模拟 user 在 health=OK 发消息 → agent 处理中 → catalog 命中 restart_session → user 发消息后没等到 reply → 测试 agent 在新 session 中是否补答（best-effort，不强制 100%）
- Edge case 5（连续非 OK）：3 次连续 catalog 命中 restart_session → 每次 startup context 都正确注入

### 验收标准

- Contract 1 durability：100%（1000 次 restart 0 inbound 丢失）
- Contract 2 startup context 注入：100%（每次新 session 都有 last checkpoint + recent N 条）
- Contract 3 best-effort continuation：**不要求 100%**——agent 补答率统计监控指标，但不作 binary 验收
- 不引入受害者识别 ledger（grep `recent-inbound.jsonl` / `pending-channels.jsonl` / `restart-in-progress.json` / `recent-inbound.lock` 残留为 0）
- 不引入 reply correlation 字段（grep `reply_to_inbound_id` / `terminal_status` / `claimed_at` 残留为 0）

---

## 8. 与其他模块的依赖关系

| 上游 | 来源 | 用途 |
|---|---|---|
| [`health-engine.md`](health-engine.md) | catalog dispatch 触发 `restart_session` | restart 起点 |
| [`guardian.md`](guardian.md) | `adapter.launch()` 拉新 session | restart 流程关键步骤 |
| c4-session-init.js（既有 comm-bridge hook，跨进程）| startup context 注入 | continuation 实施载体 |
| c4-db.js（既有 comm-bridge 接口，跨进程）| `conversations` 表查询 | agent 自治续接时可调 list-pending 等查询 |

| 下游 | 行为 |
|---|---|
| Agent（Claude / Codex 进程） | 看 startup context 自决策是否补 reply；通过 c4-send 走正常 outbound 路径 |
| User | 看 agent 补答（如果 best-effort 命中）；或凭 unhealthy 状态文案重发（residual UX risk 兜底）|

### 跨模块契约的一致性引用

| 文档 | 引用 |
|---|---|
| v3 §三.2 | accepted-message durability 边界（contract 1）|
| v3 §三.5 | best-effort continuation 三句（contract 1-3）|
| v3 §六.G #4 | 不主动 broadcast；main 旧 pending-channels 路径废弃 |
| v3 §六.G #5 | 不引入 victim identification ledger |
| v3 §六.I | TODO 2 落地：不补 unresolved-inbound 完整注入；接受 residual UX risk |
| [`message-router.md`](message-router.md) §1 | MessageRouter 不参与续接逻辑 |
| [`health-engine.md`](health-engine.md) §4 catalog dispatch | `restart_session` 路径触发 continuation 流程 |
