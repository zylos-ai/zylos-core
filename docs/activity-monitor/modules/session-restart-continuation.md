# Session Restart Continuation — 模块实施档

> 关联顶层方案：[v3 §三原则 1 / §五.3 / §六取舍 A](../../activity-monitor-refactor-proposal-v3.md)
> 类型：跨模块契约（AM 视角恢复流程）
> 上游契约：[`c4-reliability-contract.md`](c4-reliability-contract.md)

---

## 1. 模块职责与边界

### 职责

定义 runtime session 重启后**对话续接** 的完整流程契约——AM 视角。具体讲：当 catalog 命中 `restart_session` 类 error（或 unknown error 5min 升级），HealthEngine 触发 `adapter.stop()`、Guardian 拉新 session 后，新 session 如何恢复对历史 inbound 的责任。

### 核心声明

- **delivered-but-unanswered ≠ 消息丢失**：已入 c4 DB inbound + 后续 runtime 异常 → user 视角等同 "agent 反应慢"，不是 data loss
- **AM 不维护私有 ledger**：reply-resolution 由 C4 reliability contract（terminal_status）+ c4-session-init 查询协同
- **Agent 自治续接**：startup context 注入 pending inbounds 后，agent 自决策是否补答
- **Pending 跨 restart 持久**：未处理的 pending 在下次 restart 仍会被注入

### 边界

**在 scope 内**（本档负责的契约）：
- session restart 触发后从 `adapter.stop()` 到 agent 拿到 startup context 的完整流程
- c4-session-init 调用契约（见上游 `c4-reliability-contract.md`）的消费方式
- agent 自治续接的对外行为承诺

**不在 scope 内**：
- C4 内部 schema / terminal_status 字段管理 → 见 [`c4-reliability-contract.md`](c4-reliability-contract.md)
- HealthEngine catalog dispatch / recoveryAction 决策 → 见 [`health-engine.md`](health-engine.md)
- Guardian 拉新 session 的具体机制 → 见 [`guardian.md`](guardian.md)
- MessageRouter unhealthy 路径写 outbound 状态文案 → 见 [`message-router.md`](message-router.md)

---

## 2. 输入 / 输出契约

### 输入

| 输入 | 来源 | 触发时机 |
|---|---|---|
| `restart_session` recoveryAction 命中 | HealthEngine catalog dispatch | sticky context-poison error / unknown error 5min 升级 |
| Guardian 拉新 session 完成 | Guardian | restart 流程 |
| c4 DB 中存在 pending inbound | c4-receive 历史写入 | 跨 restart 持久 |

### 输出

| 输出 | 消费者 | 性质 |
|---|---|---|
| Startup context 注入新 session | Runtime agent (Claude / Codex 启动时) | 来自 c4-session-init hook 的 stdin 内容 |
| Agent 自治补答（写 outbound）→ pending → replied | C4 reliability contract 标 terminal | agent 内部决策驱动 |
| Agent 显式 drop（罕见）→ pending → manually_dropped | 同上 | agent 内部决策驱动 |

### 不变量

- **C-SR-1**：restart 触发到新 session 启动到 startup context 注入完成 = 用户**最长**感知 60-70s 静默后看到 agent 主动答复（如果 agent 决定补答）
- **C-SR-2**：restart 后 startup context **必须**包含当前所有 endpoint 的 pending inbounds（不能只注入 recent-N）
- **C-SR-3**：agent 不主动 broadcast "我恢复了"——unhealthy 时用户已同步收到状态文案（C-Term-2 / message-router.md C1）
- **C-SR-4**：Pending inbound 跨多次 restart 持久——agent 不主动 drop / reply 的话，下次 restart 仍会注入

---

## 3. 数据结构 / 字段 / 状态机

### 不持有自己的 state

本契约**不引入** AM 私有持久化文件——所有 state 由 C4 reliability contract（conversations 表 terminal_status）+ Guardian 状态（restart 计数等）+ HealthEngine 状态（catalog hit history）维护。

### 时序依赖

```
T0: catalog 命中 restart_session
    │
T1: HealthEngine: state = Unavailable, write unavailable_reason
    │
T2: HealthEngine: adapter.stop()
    │
T3: Guardian 下一 tick: 看进程消失 → 拉新 session
    │
T4: Runtime 进程 launch → c4-session-init.js hook 触发
    │   ├── 读 last checkpoint summary
    │   ├── 读 recent unsummarized 对话
    │   └── 调 c4-db.js listPendingInbounds() → 拉 pending 列表
    │
T5: c4-session-init 把三段 startup context 写入新 session stdin / context window
    │
T6: Runtime agent 看到 startup context
    │   ├── 解析 pending inbound 列表
    │   └── 自决策（每条 pending）：
    │        ├── 补答 → 写 outbound → c4 自动标 inbound 'replied'
    │        ├── 不答 → 显式 mark 'manually_dropped'
    │        └── 暂不动 → inbound 保持 pending
    │
T7+: 用户 / 操作员看到 agent 主动消息（如果有补答）；或者用户重新触发对话流
```

T0 → T7 总耗时 ≈ 60-70s（restart 主流程）；c4-session-init hook 注入 ≈ 100ms 内。

---

## 4. 关键接口与调用关系

### 接口

| 接口 | 实现 / 调用方 | 用途 |
|---|---|---|
| `c4-db.js listPendingInbounds(endpoint_id?)` | `c4-db.js`（C4 reliability contract 提供）→ `c4-session-init.js` 调用 | 拉所有 / 指定 endpoint 的 pending inbound 列表 |
| `c4-session-init.js` 注入逻辑 | `c4-session-init.js`（既有 hook，扩展）| 把三段 context 输出给 stdin |
| `c4-db.js markInboundTerminal(id, status)` | `c4-db.js`（C4 reliability contract 提供）→ agent 工具调用 | agent 显式 drop |
| `c4-receive insertConversation('out', ...)` | `c4-receive.js`（通过 hook 或 agent 工具）| agent 写 reply（自动触发 clearEndpointPending） |

### Agent 视角的 startup context 格式

`c4-session-init.js` 注入的 stdin 内容（由 hook 决定具体格式，下面是 conceptual layout）：

```
[Last Checkpoint Summary]
{summary text from latest checkpoint}

[Recent Conversations]
{N most-recent conversations within unsummarized window, grouped by endpoint}

[Pending Inbounds — 跨 restart 持久，需自决策处理]
- [endpoint A | ts=2026-04-28T03:15:22Z] {inbound content #1}
- [endpoint B | ts=2026-04-28T03:18:45Z] {inbound content #2}
- ...

(共 N 条 pending；agent 看完决定：补答 / 显式 drop / 暂不处理；
未处理的下次 session restart 仍会被注入)
```

第三段独立可识别（明确 marker `[Pending Inbounds]`），让 agent 在 prompt 解析阶段不会跟前两段混淆。

---

## 5. 错误处理与恢复逻辑

### Case 1：c4-session-init hook 失败

如果 hook 自身 crash 或读 c4 DB 失败：
- 老行为：startup context 缺三段中某段 → agent 启动后没有 context
- 新行为（fail-open）：hook 异常时降级到老行为（只注入 last checkpoint + recent unsummarized），pending 段缺失但 agent 仍能启动
- pending inbound 不会丢——下次 c4-session-init 跑成功时仍能查到

### Case 2：Pending 列表过长

如果 endpoint 累积大量 pending（例如 100+ 条）：
- startup context 注入会膨胀 prompt 大小
- 风险：context 超长导致 API 调用失败

**处理策略**：
- c4-session-init 注入前对 pending 列表按 ts 倒序取最近 N（默认 20）
- 第三段开头标注："共 N 条 pending；显示最近 20 条；其余 X 条仍 pending 但未注入此次 startup"
- 老的 pending 仍在 c4 DB，下次 restart 仍可被查到

### Case 3：Agent 启动后立即 crash

agent 看到 pending 但还没决策就 crash：
- pending 仍是 pending（C-Term-1 不变量）
- 下次 restart 仍会被 c4-session-init 注入

幂等。

### Case 4：Agent 不识别 pending 段

agent 看到 startup context 但忽略第三段：
- pending 仍是 pending（agent 没处理）
- 下次 restart 仍注入

**降级保障**：即使 agent 不识别，pending 也不会被错误地标 terminal。但 user 视角是"agent 反应不太对"——属于 prompt engineering 层问题，不是 contract 失效。

### Case 5：旧 session 在 stop 前还在写 outbound

时序：T1.5（HealthEngine state=Unavailable 之后，T2 stop 之前）老 agent 写出最后一个 outbound：
- 老 outbound 触发 clearEndpointPending → 该 endpoint pending 全部标 `replied`
- 然后 T2 adapter.stop() → 新 session 启动 → c4-session-init 看到该 endpoint 已无 pending
- 行为正确：老 agent 已经回了，新 agent 不重做

---

## 6. 迁移策略

### 落地阶段

跟 [`c4-reliability-contract.md`](c4-reliability-contract.md) 同步在 Phase 3：

**Step 1**：先落 c4-reliability-contract 的 schema 扩展 + `listPendingInbounds` API
**Step 2**：扩展 `c4-session-init.js` 调用新 API + 注入第三段
**Step 3**：在 staging 跑端到端 restart 测试，验证 pending inbound 正确注入到新 session

### 兼容性

- 老 c4-session-init 不调 `listPendingInbounds` → 新 session 看不到 pending 段，但 startup 不报错（向后兼容）
- 新 c4-session-init 在老 schema（无 terminal_status）上跑 → `listPendingInbounds` 报错 "no such column"
- **必须 schema migration + c4-session-init 升级同 release** 部署

### 回滚

- 切回老 c4-session-init 二进制 → 不注入第三段，回到老 v2.1 行为（recent-N 注入 only）
- terminal_status schema 列保留不删（无害）

---

## 7. 测试策略 + 验收标准

### 端到端集成测试

| 测试 | 描述 |
|---|---|
| `restart 后 pending 注入 happy path` | 模拟 endpoint 有 1 条 pending → catalog 命中 → adapter.stop → Guardian 拉新 session → c4-session-init 注入 → 新 session stdin 包含该 inbound 内容 |
| `多 endpoint pending 注入` | 3 个 endpoint 各 1 条 pending → restart → startup context 含 3 条 |
| `跨 restart 持久` | pending 注入 → agent 不处理 → 再次 restart → 仍注入 |
| `Replied 不再注入` | restart 后 agent 写 outbound 标 replied → 再 restart → 不再注入这条 |
| `Status_replied 不再注入` | unhealthy 路径触发 status_replied → restart → 不再注入这条（历史 status 文案已发） |
| `Pending 列表截断` | endpoint 100+ pending → restart 注入最近 20 条 + 截断标注 |
| `c4-session-init 异常 fail-open` | mock c4-db.js 异常 → c4-session-init 降级到老行为，pending 段缺失但 agent 启动正常 |

### Agent 行为测试

| 测试 | 描述 |
|---|---|
| `Agent 看 pending 主动补答` | startup context 含 1 条 pending → agent prompt 让其处理 → agent 写 outbound → 该 inbound 标 replied |
| `Agent 决定不答` | startup context 含 1 条 pending → agent prompt 让其判定不答 → agent 调 markInboundTerminal('manually_dropped') → 该 inbound 终态 |
| `Agent 暂不处理` | startup context 含 1 条 pending → agent 没动作 → 下次 restart 仍注入 |

### 验收标准

- ✅ C-SR-1 时序在 100 次 restart 测试中 95 分位 ≤ 80s
- ✅ C-SR-2 pending 注入完整性 100%（不丢任何 pending；列表截断需有标注）
- ✅ C-SR-3 不主动 broadcast——log 扫描 0 次"我恢复了"类消息
- ✅ C-SR-4 跨 1000 次 restart pending 持久 100%

---

## 8. 与其他模块的依赖关系

### 上游依赖

| 依赖 | 关系 |
|---|---|
| [`c4-reliability-contract.md`](c4-reliability-contract.md) | 强依赖——`listPendingInbounds` / `markInboundTerminal` API + terminal_status schema |
| [`health-engine.md`](health-engine.md) | catalog 命中 `restart_session` 触发本契约入口 |
| [`guardian.md`](guardian.md) | Guardian 拉新 session 完成是 c4-session-init hook 的触发条件 |
| `c4-session-init.js`（既有 hook） | 改造点——新增第三段注入 |

### 下游消费者

| 消费者 | 怎么消费 |
|---|---|
| Runtime agent (Claude / Codex) | 启动时读 startup context，自决策处理 pending |

### 相邻契约

- [`message-router.md`](message-router.md)：unhealthy 路径写 status_replied 前置——确保 unhealthy 期间消息已 terminal，restart 后这些不再注入到 startup context
- [`c4-reliability-contract.md`](c4-reliability-contract.md)：reply 配对策略 + 边缘 case 由 contract 层处理

---

*v3 R3 review (zylos0t reframe, 2026-04-28) 重写：从 v2.1 的"AM 不维护 ledger 边界声明"扩展为"消费 C4 reliability contract 的恢复流程契约"。zylos101 主笔。*
