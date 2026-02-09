# Heartbeat Liveness Detection — Open Questions

> Companion to: `docs/heartbeat-liveness-detection.md` (v2.0)
> Created: 2026-02-09
> Purpose: 逐条确认设计中的待定项，确认后回写主文档

---

## Q1. Control Queue 是否用 DB 存储？

**背景**: 之前讨论时倾向"最好不用 DB"，但 v2 设计了 `control_queue` 表。

**选项**:
- A) 用 DB（当前方案）— 好处：原子 claim、crash recovery、可查询状态
- B) 纯文件 — 好处：不依赖 DB，极简；坏处：需要自己处理并发、原子性
- C) DB 但 minimal — 只保留 heartbeat 必需字段，不做通用 job queue

**风险点**: 如果 DB 锁死，control 通道也会受影响。

**决定**: **A) 用 DB。** 本质需求是一个队列，DB 是队列的载体。原子 claim、crash recovery、可查询状态都是队列该有的能力。

---

## Q2. SUSPECT 和 DEGRADED 是否需要区分？

**背景**: v2 状态机为 `NORMAL → SUSPECT → DEGRADED → RECOVERING → NORMAL`。但降级规则中 `suspect` 和 `degraded` 对外行为一致（都拦截消息、auto-reply）。

**问题**: SUSPECT 是否有独有行为？例如：
- SUSPECT 期间是否再发一次确认心跳（二次确认）再进入 DEGRADED？
- 还是 SUSPECT 只是一个瞬时中间态，立即转 DEGRADED？

**选项**:
- A) 保留四态，SUSPECT 期间做二次确认心跳（减少误判）
- B) 保留四态，SUSPECT 为瞬时态，仅表示"已检测到超时、准备恢复"
- C) 合并为三态 `NORMAL → DEGRADED → RECOVERING → NORMAL`

**决定**: **简化 health 为三值（ok / recovering / down），suspect 为 activity-monitor 内部行为。**

最终状态机：

```
        HB 确认超时           HB ack
ok ──────────────► recovering ──────► ok
                       │
                       │ 达到重试上限
                       ▼
                     down
                  (需人工介入)
```

- `health` 字段三个值：`ok`、`recovering`、`down`
- `state` 字段不变（offline / stopped / busy / idle）
- 两个字段独立，互不干扰

### 心跳配置参数（固定值）

| 参数 | 值 | 说明 |
|------|-----|------|
| `HEARTBEAT_INTERVAL` | 1800s (30min) | 心跳发送周期 |
| `ACK_DEADLINE` | 300s (5min) | 单次心跳 ack 等待上限 |
| `MAX_RESTART_FAILURES` | 3 | 连续重启失败进入 down 的阈值 |
| `CONTROL_MAX_RETRIES` | 3 | control 指令投递重试上限 |

### Suspect 内部流程

Suspect 是 activity-monitor 内部逻辑，不暴露给消费方：
1. 每 1800s 发心跳，300s 内没 ack → 内部标记 verifying，立刻发复查 HB
2. 复查也 300s 没 ack → 确认卡死：写 `health=recovering`，kill tmux
3. Guardian 照常重启，启动后立刻发 HB
4. Ack 收到 → 写 `health=ok`，通知 pending channels
5. 连续重启失败达到 3 次 → 写 `health=down`（需人工介入）

验证期间 health 仍为 ok，消息照常投递。只有确认挂了才触发降级。不扰民。

---

## Q3. 恢复后是否通知用户？

**背景**: v1 有明确闭环——记录降级期间收到 auto-reply 的 channel，恢复后发"系统已恢复正常"。v2 未提及。

**问题**: 降级期间给用户回了"系统恢复中"，恢复后是否需要主动通知？

**选项**:
- A) 需要 — 记录 pending channels，恢复后逐一发送恢复通知
- B) 不需要 — 用户下次发消息自然会得到正常响应
- C) 可选 — 作为配置项，默认开启

**决定**: **A) 需要通知。**

- `c4-receive.js` 在 intake 层拒绝消息时，同时将 channel+endpoint 记录到 pending channels 文件（记录与 auto-reply 解耦——记录由 C4 做，回复由调用方 bot 做）
- 恢复后（health → ok），通过 C4 向所有 pending channels 发送 "System has recovered. Please resend your request."
- 发送完毕后清空 pending channels 文件

---

## Q4. Ack 路径：Claude 需要理解参数吗？

**背景**: ~~v2 要求 Claude 调用 `c4-control ack` 并传入 `control_id + generation + ack_token`~~ → generation/ack_token 已移除（见 Q13），仅需 `control_id`。

**问题**: 心跳 prompt 的形式是什么？

**选项**:
- A) Prompt 里给完整命令，Claude 只需执行不需理解参数
  ```
  Heartbeat check. Run: c4-control ack --id 42
  ```
- B) Claude 需要从 prompt 解析参数，自己组装命令
- C) 改用 wrapper 脚本，Claude 只跑 `heartbeat-ack.sh`，脚本内部读取 pending 信息并调用 c4-control

**决定**: **A) Prompt 里给完整命令，Claude 只需执行。** Activity-monitor 在 enqueue 时生成完整的 ack 命令（仅需 control_id），Claude 收到后直接跑，不需要理解参数。

```
Heartbeat check. Run: c4-control ack --id 42
```

---

## Q5. Dispatcher 归属哪个组件？

**背景**: v2 描述了 dispatcher 负责 claim → 状态门控 → 投递 → 等 ack 的完整流程，但未说明它运行在哪里。

**选项**:
- A) Activity Monitor (C2) 的一部分 — C2 既监控又分发
- B) Comm Bridge (C4) 的新模块 — C4 负责所有消息投递
- C) 独立进程 — 新的 PM2 service

**考虑因素**: C2 已经是 single writer for state，如果 dispatcher 也在 C2，职责是否过重？但放在 C4 又会让 C4 依赖状态判断。

**决定**: **B) C4 Dispatcher（现有 `c4-dispatcher.js`）。** Dispatcher 已经是 C4 的独立 PM2 进程，具备队列消费、状态门控、tmux 投递、重试等全部能力。扩展它来优先消费 control_queue，再消费 conversations。不新增组件。

---

## Q6. 首版 Schema 范围

**背景**: v2 的 `control_queue` 设计了 15 个字段，包含 `priority`、`require_idle`、`available_at`、`lease_until`、`retry_count` 等通用 job queue 功能。但当前唯一 use case 是 heartbeat。

**问题**: 首版是否需要完整 schema？

**选项**:
- A) 完整实现 — 一步到位，后续 control 指令直接复用
- B) Minimal 首版 — 只留 heartbeat 必需字段，后续按需加列（~~原含 ack_token/generation~~ → 已移除，见 Q13）
- C) 完整 schema 建表，但代码层首版只实现 heartbeat 用到的字段

**决定**: **A) 完整 schema。** Control 通道不只给 heartbeat 用，还有系统健康检测（内存/磁盘）、context window 检测等。这些 use case 会用到 `priority`（心跳 > 健康检测）、`require_idle`（context 检测需要 idle）等字段。一步到位建完整表，代码按需逐步接入。

---

## Q7. Restart Loop 兜底策略

**背景**: v1 提到连续重启失败需要 max restart count + 告警。v2 未覆盖。

**问题**:
1. 连续重启失败的阈值是多少？（如 3 次/30 分钟）
2. 达到阈值后的告警渠道是什么？此时 C1 已挂、C4 处于 degraded，需要不依赖正常链路的通知方式。

**选项**:
- A) Activity Monitor 直接调用 Telegram API 发告警（绕过 C4）
- B) 写入告警文件 + PM2 日志，依赖人工巡检
- C) Activity Monitor 通过备用通道（如邮件、webhook）告警

**决定**: **标记为 `health: "down"`，调用方自行告知用户。**

- 连续重启失败达到上限（如 3 次/30 分钟）→ 写 `health=down`
- `c4-receive.js` 拒绝入队，返回 `{"ok": false, "error": {"code": "HEALTH_DOWN", "message": "System is currently unable to recover automatically. Please contact the administrator."}}`
- 调用方（TG Bot / Lark Bot）解析 error.message 回复用户
- `down` 表示自动恢复已穷尽，需人工修复根因（如修配置、重装 Claude 等）
- 人工修好后无需手动改文件——activity-monitor 持续探测，检测到 Claude running 并收到 ack 后自动恢复为 `ok`（见 Q18）
- 不需要 activity-monitor 主动告警，用户发消息时自然得知

这使 `health` 变为三值：`ok` / `recovering` / `down`。

---

## Q8. 冷启动 Grace Period

**背景**: Claude 刚启动时没有历史 ack 记录。如果 Activity Monitor 立刻开始检查心跳，可能在第一个心跳周期到来前误判为超时。

**问题**: 新启动 / 重启后是否需要 grace period？

**选项**:
- A) 需要 — 启动后等待一个完整心跳周期再开始检测
- B) 不需要 — 启动流程中立刻发一次心跳探测，以首次 ack 作为基线
- C) 由 RECOVERING → NORMAL 转换自然处理（重启场景已覆盖），仅需处理首次冷启动

**决定**: **不需要 grace period。根据启动时 health 状态决定行为。**

- `health` 为 `ok` 或不存在（正常启动）→ 默认 `ok`，按正常周期（~30min）发首次心跳。不存在误判风险，因为没发过心跳就没有超时判定。
- `health` 为 `recovering`（恢复中重启）→ 保持 `recovering`，Claude running 后立刻发心跳验证恢复。
- `health` 为 `down`（手动修复后重启）→ 保持 `down`，Claude running 后立刻发心跳验证修复。ack → `ok`，no ack → 回到 `down`。

---

## Q9. 数据目录规范

**背景**: 当前 `~/.claude-status` 放在 home 根目录，不符合 `~/zylos/<skill-name>/` 的数据目录规范。v2 改用 DB 后 ack 文件问题消解，但 status file 和 pending file 等本地文件的路径仍需规范。

**问题**:
1. `~/.claude-status` 放在哪里？
2. Activity Monitor 的本地文件（pending heartbeat 等）放在哪里？

**决定**:
- `~/.claude-status` → `~/zylos/comm-bridge/claude-status.json`（status file 是多组件共享的状态，由 activity-monitor 写、C4/Scheduler 等读，放在 comm-bridge 数据目录下）
- Activity Monitor 本地文件（pending heartbeat 等）→ `~/zylos/activity-monitor/`

**影响范围**（需同步修改路径引用）:
- `skills/activity-monitor/scripts/activity-monitor.js` — 写入方
- `skills/comm-bridge/scripts/c4-config.js` — CLAUDE_STATUS_FILE 常量
- `skills/comm-bridge/scripts/c4-dispatcher.js` — 读取方
- `skills/scheduler/scripts/daemon.js` — 读取方
- `skills/scheduler/scripts/runtime.js` — 读取方
- `skills/restart-claude/scripts/restart.js` — 读取方
- `skills/upgrade-claude/scripts/upgrade.js` — 读取方
- `skills/check-context/scripts/check-context.js` — 读取方
- `skills/web-console/scripts/server.js` — 读取方
- `cli/commands/service.js` — 读取方

---

## Q10. no-reply Conversation 的处理

**背景**: v2 降级规则中，no-reply 的 conversation 在降级期间直接丢弃。这包括 C5 调度的定时任务。

**问题**: 丢弃是否可接受？用户调度的定时任务在降级期间被静默丢弃，恢复后不会重试。

**选项**:
- A) 可接受 — 降级期间系统不可用，任务自然跳过
- B) 需要记录 — 丢弃但记录日志，恢复后通知用户哪些任务被跳过
- C) 需要补偿 — 恢复后重新调度被丢弃的任务

**决定**: **`c4-receive.js` 在 intake 层统一拒绝，调用方各自处理失败。**

- `c4-receive.js` 检查 health，当 `health !== 'ok'` 时：
  - 不入队，返回非零 exit code（不区分有无 reply channel，不做 auto-reply）
- 各调用方自行处理失败：
  - **Scheduler** → 零改动，现有逻辑已覆盖（revert to pending → 下次重试 → 超过 miss_threshold 自动 skip）
  - **TG Bot** → 检测失败后直接通过 TG API 回复用户降级消息
  - **Lark Bot** → 检测失败后直接通过 Lark API 回复用户降级消息
- c4-receive.js 不需要知道回复渠道，保持单一职责（intake + 拒绝）

**`--json` 输出模式**（新增）：

`c4-receive.js` 增加 `--json` flag，返回结构化 JSON 到 stdout。Bot 类调用方使用 `--json` 解析错误信息并回复用户。Scheduler 等内部调用方可以继续用 exit code，不强制 `--json`。

成功示例：
```json
{"ok": true, "action": "queued", "id": 123}
```

health 拒绝示例（exit code 非零）：
```json
{"ok": false, "error": {"code": "HEALTH_RECOVERING", "message": "System is recovering, please wait."}}
{"ok": false, "error": {"code": "HEALTH_DOWN", "message": "System is currently unable to recover automatically. Please contact the administrator."}}
```

error.message 直接放用户可读文案（英文），bot 拿到后直接转发给用户，无需 bot 自己维护文案。

**改动范围**：

| 组件 | 改动 |
|------|------|
| `c4-receive.js`（本 repo） | 加 `--json` flag + health 检查 + JSON 输出 |
| TG Bot（外部组件） | 调用时加 `--json`，失败时解析 error.message 回复用户 |
| Lark Bot（外部组件） | 同上 |
| Scheduler（本 repo） | 不改，现有 exit code 判断已够用 |

---

## Q11. 心跳健康状态是否融入 `~/.claude-status` 的 state 字段？

**背景**: 当前 `~/.claude-status` 的 `state` 字段有：`offline`、`stopped`、`busy`、`idle`——描述 Claude 的活动状态。新增的 `normal`、`suspect`、`degraded`、`recovering` 描述健康状态。两个维度正交。

**问题**: 怎么融合？

**选项**:
- A) 新增 `health` 字段 — `state` 保持原有活动语义，`health` 独立描述健康状态。消费方可分别读取。
  ```json
  {"state": "busy", "health": "normal", ...}
  {"state": "busy", "health": "suspect", ...}
  ```
- B) 健康异常时覆盖 `state` — `suspect` / `degraded` / `recovering` 优先级高于 `busy` / `idle`。一个字段，但语义混合。
  ```json
  {"state": "suspect", ...}
  {"state": "degraded", ...}
  ```
- C) 健康状态单独文件 — 不放在 `~/.claude-status`，用独立文件如 `~/zylos/activity-monitor/health.json`

**决定**: **新增 `health` 字段，三个值：`ok` / `recovering` / `down`。**

- `state` 不变（offline / stopped / busy / idle），进程级，每 1s 更新
- `health` 新增，应用级，仅心跳逻辑写入
- 两个字段独立，互不干扰

```json
{"state": "idle", "health": "ok", ...}
{"state": "busy", "health": "recovering", ...}
{"state": "offline", "health": "down", ...}
```

C4 投递规则：
- 现有逻辑不变：`state === 'offline' || state === 'stopped'` → 不投递
- 新增：`health !== 'ok'` → dispatcher 暂停消费（hold 住队列），不做 auto-reply
- 已在队列中的消息不丢弃，health 恢复为 ok 后自然投递
- 新消息的拒绝和用户通知已在 intake 层（c4-receive.js + 调用方 bot）处理

---

## Q12. `health` 文件读取失败时如何处理？

**背景**: `c4-receive.js` 和 `c4-dispatcher.js` 都依赖 `claude-status.json` 的 `health` 字段。文件丢失、JSON 损坏、权限异常时需要统一行为。

**问题**: read error 默认映射为哪个健康状态？

**选项**:
- A) Fail-closed：按 `down` 处理（最安全，宁可拒绝）
- B) Fail-soft：按 `recovering` 处理（阻断投递但提示可恢复）
- C) Fail-open：按 `ok` 处理（可用性优先，但有误投递风险）

**决定**: **C) Fail-open（按 `ok` 处理）。** status file 每 1s 更新，读取失败大概率是瞬时 IO 问题。dispatcher 已有 staleness 检测（文件过久没更新 → 按 offline 处理）作为兜底。Fail-closed 会因一次 IO 抖动拒绝所有消息，过于激进。

**优先级规则**：读取 `claude-status.json` 失败（文件不存在 / JSON 损坏 / IO 错误）时，`health` 视为 `ok`，消息正常放行。此规则同时适用于 `c4-receive.js`（intake）和 `c4-dispatcher.js`（投递）。

---

## Q13. ~~`generation` 的持久化和递增时机~~ → 已移除

**决定**: **generation 和 ack_token 均不需要，已从设计中移除。**

理由：
- Ack 是 Claude 同步执行脚本直接写 DB，不存在异步迟到
- Kill tmux 杀死 Claude 进程，不存在僵尸进程补发 ack
- 每次心跳用唯一 `control_id` 追踪，新旧不会混淆
- 所有组件在同一台机器上，无需 token 防伪

心跳 ack 命令简化为：`c4-control ack --id <control_id>`

**control_queue schema 相应移除字段**：`generation`、`ack_token`

---

## Q14. Control ack 的状态流转与幂等

**背景**: 需要防止重复 ack 造成状态污染。

**问题**: 哪些状态流转是允许的？

**决定**: 确认以下规则：
- `pending → running → done|failed|timeout`
- 对 `done|failed|timeout` 的重复 ack：忽略并返回 `ALREADY_FINAL`
- ack 匹配仅靠 `control_id`（generation 和 ack_token 已移除）
- `control_id` 不存在：返回 `NOT_FOUND`

---

## Q15. ~~`lease_until` 过期后的 reclaim 策略~~ → 已移除

**决定**: **`lease_until` 不需要，从 schema 中移除。**

理由：
- 等 ack 的超时判定由 activity-monitor 负责（心跳 5min deadline），不依赖 DB 层 lease
- Dispatcher 崩了 → 心跳没投递 → Claude 没 ack → activity-monitor 超时 → 走恢复流程
- Activity-monitor 的心跳超时已是最终兜底，DB 层 lease 冗余
- Dispatcher 只需 pending → running（防重复投递），ack → done。无需 lease 回收机制

**control_queue schema 相应移除字段**：`lease_until`

---

## Final: `control_queue` Schema（权威清单）

综合 Q1（DB 存储）、Q6（完整 schema）、Q13（移除 generation/ack_token）、Q15（移除 lease_until）后的最终字段列表：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK | 自增主键，即 control_id |
| `content` | TEXT NOT NULL | 指令内容（如心跳 prompt） |
| `priority` | INTEGER DEFAULT 0 | 排序优先级（数字越小越优先） |
| `require_idle` | INTEGER DEFAULT 0 | 是否需要 Claude idle 才投递（0/1） |
| `bypass_state` | INTEGER DEFAULT 0 | 是否穿透 state 门控（0/1） |
| `ack_deadline_at` | INTEGER | ack 截止时间（unix seconds） |
| `status` | TEXT DEFAULT 'pending' | `pending`/`running`/`done`/`failed`/`timeout` |
| `retry_count` | INTEGER DEFAULT 0 | 已重试次数（上限 3） |
| `available_at` | INTEGER | 最早可投递时间（unix seconds） |
| `last_error` | TEXT | 最近一次错误信息 |
| `created_at` | INTEGER NOT NULL | 创建时间（unix seconds） |
| `updated_at` | INTEGER NOT NULL | 最后更新时间（unix seconds） |

**已移除字段**：`generation`、`ack_token`、`lease_until`

---

## Q16. Control 重试与退避参数

**背景**: 当前只确定了 restart 上限，对 control 指令本身的 retry/backoff 还未定。

**问题**: 全局默认参数是多少？

**决定**: **`max_retries = 3`，无退避，按 dispatcher poll cycle 自然间隔重试。**

- 重试主体是 c4-dispatcher（投递到 tmux 失败时回退 `pending`，下轮 poll 自动重试）
- 不需要指数退避——control 指令不是高频外部请求，目标是自己的 tmux，无"退避减压"需求
- 间隔由 dispatcher poll cycle 自然决定（当前 ~5s）
- 3 次投递失败 → 标记 `failed`
- Activity-monitor 的 5min deadline 是最终兜底：投递失败 → 没 ack → 超时 → 走恢复流程

---

## Q17. pending channels 文件的去重与容量

**背景**: Q3 确认了恢复后通知用户，但 pending channels 的去重策略与容量上限未定义。

**问题**:
1. 去重键是否为 `channel + endpoint`？
2. 是否设置上限（防止异常期间文件无限增长）？

**决定**: **A) 去重 + 无上限。**

- 去重键：`channel + endpoint`（同一用户同一渠道只记一条）
- 不设上限——去重后条目数 = 独立用户数 × 渠道数，实际上界很小
- 格式：JSON lines 文件（`~/zylos/comm-bridge/pending-channels.jsonl`），每行 `{"channel":"telegram","endpoint":"12345"}`
- 恢复时：读取 → 去重 → 逐一通知 → 清空文件

---

## Q18. `health=down` 的人工恢复入口

**背景**: Q7 定义 `down` 为终态，需人工介入。但尚未定义“介入动作”。

**问题**: 运维通过什么方式把系统从 down 拉回可恢复路径？

**决定**: **无需专门入口，activity-monitor 自动探测恢复。**

- `down` 状态下 activity-monitor 不停止探测——只要检测到 Claude running，就发心跳
- 人工修好问题 → Claude 跑起来 → activity-monitor 发心跳 → ack → 自动写 `health=ok`
- 没 ack → 留在 `down`，等人继续修
- 不需要额外 CLI 或手动编辑文件，health 自愈
- 与 Q8 一致：`health=down` 时 Claude running 后立刻发心跳验证，ack → `ok`

---

## Q19. `--json` 错误码全集

**背景**: Q10 给了示例，但调用方（TG/Lark/Bot）需要稳定错误码契约。

**问题**: 首版固定哪些 code？

**决定**: **按消费者类型分别设计，不统一错误码体系。**

**c4-receive.js `--json`**（消费者：Bot 代码）：
- `HEALTH_RECOVERING` — 系统恢复中
- `HEALTH_DOWN` — 系统不可用，需人工介入
- `INVALID_ARGS` — 参数错误
- Bot 实际只用 `ok` + `error.message` 转发用户，code 仅供日志/分支判断

**c4-control.js**（消费者：Claude AI + activity-monitor 代码）：
- 纯文本输出，不需要 `--json`，不需要 error code
- Claude 调 ack：读文本即可理解（如 `"OK: control 42 marked as done"`、`"Error: control 42 not found"`）
- activity-monitor 调 enqueue/get：用 exit code + stdout 文本

---

## Q20. Control 历史数据清理策略

**背景**: control_queue 会持续增长，需要 retention 策略。

**问题**:
1. 保留多久？
2. 清理哪些状态（只清 done，还是 done/failed/timeout 都清）？
3. 清理频率与执行组件（scheduler 定时 / dispatcher 启动时 / 独立任务）？

**决定**: **统一保留 7 天，c4-dispatcher 每 24h 清理一次。**

- 终态记录（done/failed/timeout）统一保留 7 天
- 清理由 c4-dispatcher 附带执行，每 24h 一次（记 `lastCleanup` 时间戳）
- `DELETE FROM control_queue WHERE status IN ('done','failed','timeout') AND updated_at < ?`
- 量级很小（心跳 ~48 条/天 + 系统检测若干），不需要独立清理进程

---

## Summary

| # | Topic | Status |
|---|-------|--------|
| Q1 | Control Queue 存储方式 | **DB（队列载体）** |
| Q2 | 状态机简化 | **三值 health（ok/recovering/down），suspect 内部化** |
| Q3 | 恢复后用户通知 | **需要，记录 pending channels 并通知** |
| Q4 | Ack 路径复杂度 | **给完整命令，Claude 只需执行** |
| Q5 | Dispatcher 归属 | **C4 Dispatcher（扩展现有 c4-dispatcher.js）** |
| Q6 | 首版 Schema 范围 | **完整 schema（多 use case：HB/系统检测/context 检测）** |
| Q7 | Restart Loop 兜底 | **health="down"，c4-receive 拒绝入队，调用方回复用户联系管理员** |
| Q8 | 冷启动 Grace Period | **不需要，按启动时 health 状态决定行为** |
| Q9 | 数据目录规范 | **status → ~/zylos/comm-bridge/，monitor 文件 → ~/zylos/activity-monitor/** |
| Q10 | no-reply 任务降级处理 | **intake 层拒绝 + 返回失败，调用方自行重试** |
| Q11 | 健康状态与 ~/.claude-status 融合 | **新增 `health` 字段（ok/recovering/down）** |
| Q12 | `health` 文件读取失败策略 | **Fail-open（按 ok 处理）** |
| Q13 | ~~generation 持久化~~ | **移除（generation + ack_token 均不需要）** |
| Q14 | ack 状态流转与幂等 | **确认：仅靠 control_id，终态幂等** |
| Q15 | ~~lease 过期回收~~ | **移除（activity-monitor 超时已兜底）** |
| Q16 | control 重试与退避参数 | **max_retries=3，无退避，poll cycle 自然间隔** |
| Q17 | pending channels 去重与上限 | **去重(channel+endpoint) + 无上限，JSONL 文件** |
| Q18 | `down` 的人工恢复入口 | **无需专门入口，activity-monitor 自动探测恢复** |
| Q19 | `--json` 错误码全集 | **c4-receive: 3 codes (HEALTH_RECOVERING/DOWN, INVALID_ARGS)；c4-control: 纯文本，无 error code** |
| Q20 | control 数据清理策略 | **统一保留 7 天，dispatcher 每 24h 清理终态记录** |
