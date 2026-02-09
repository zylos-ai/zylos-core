# Heartbeat Liveness Detection — Implementation Spec

> Version: 3.0
> Date: 2026-02-09
> Status: Ready for Implementation
> Decisions: See `docs/heartbeat-open-questions.md` (Q1–Q20, all confirmed)

## 1. Problem Statement

Claude 进程存在但应用层卡死时，现有进程级监控无法及时识别。系统需要：

- 应用层存活探测（Heartbeat）
- 卡死后的自动恢复
- 降级期可预期行为（不静默丢消息）
- 控制指令机制可复用到其他系统命令（不只 heartbeat）

## 2. Architecture Overview

### 2.1 Dual Plane

| Plane | 用途 | 载体 | 入口 |
|-------|------|------|------|
| **Conversation** | 用户消息、调度任务 | `conversations` 表 | `c4-receive.js` |
| **Control** | 心跳、系统检测、context 检测 | `control_queue` 表 | `c4-control.js` |

两个通道共享同一个 SQLite DB（`~/zylos/comm-bridge/c4.db`），由同一个 Dispatcher 消费。

### 2.2 Component Responsibilities

| 组件 | 角色 |
|------|------|
| **Activity Monitor** (C2) | 心跳编排者：enqueue 心跳、跟踪 ack、判定超时、写 health 状态、触发恢复 |
| **C4 Dispatcher** | 队列消费者：claim → 门控 → 投递 tmux → 等结果。优先消费 control，再消费 conversation |
| **c4-receive.js** | Conversation intake：health 门控、`--json` 输出、pending channels 记录 |
| **c4-control.js** | Control intake：enqueue / get / ack 三个子命令 |
| **Claude** | 心跳执行者：收到 prompt，执行 ack 命令 |

### 2.3 Status File

路径：`~/zylos/comm-bridge/claude-status.json`

```json
{
  "state": "idle",
  "health": "ok",
  "last_activity": 1738000000,
  "last_check": 1738000001,
  "last_check_human": "2026-02-09 12:00:01",
  "idle_seconds": 15,
  "source": "conv_file"
}
```

| 字段 | 写入方 | 语义 |
|------|--------|------|
| `state` | activity-monitor（每 1s） | 进程级活动状态：`offline` / `stopped` / `busy` / `idle` |
| `health` | activity-monitor（仅心跳逻辑） | 应用级健康状态：`ok` / `recovering` / `down` |

两个字段独立，互不干扰。

**Fail-open 规则**：读取 `claude-status.json` 失败（文件不存在 / JSON 损坏 / IO 错误）时，`health` 视为 `ok`，消息正常放行。此规则同时适用于 `c4-receive.js` 和 `c4-dispatcher.js`。

## 3. Health State Machine

```
        HB 确认超时           HB ack
ok ──────────────► recovering ──────► ok
                       │
                       │ 连续重启失败 ≥ 3 次
                       ▼
                     down ─── (人工修复 + HB ack) ──► ok
```

| 状态 | 含义 | 消息行为 |
|------|------|----------|
| `ok` | 正常 | 正常投递 |
| `recovering` | 自动恢复中 | intake 拒绝新消息；dispatcher 暂停消费（hold 队列）。**例外**：`bypass_state=1` 的 control 指令（如心跳）照常投递 |
| `down` | 自动恢复已穷尽 | 同 recovering（含 bypass_state 例外），但 error message 提示联系管理员 |

### 3.1 State Transitions

| 从 | 到 | 触发条件 | 执行者 |
|----|-----|----------|--------|
| `ok` | `recovering` | 心跳二次确认超时（见 §6.2） | activity-monitor |
| `recovering` | `ok` | 收到当前心跳的有效 ack | activity-monitor |
| `recovering` | `down` | 连续重启失败 ≥ `MAX_RESTART_FAILURES` (3) | activity-monitor |
| `down` | `ok` | 人工修复后，activity-monitor 探测到 Claude running 并收到 ack | activity-monitor |

**Single Writer**：`health` 只由 activity-monitor 写入，其他组件只读。

## 4. Configuration Parameters

| 参数 | 值 | 说明 |
|------|-----|------|
| `HEARTBEAT_INTERVAL` | 1800s (30min) | 心跳发送周期 |
| `ACK_DEADLINE` | 300s (5min) | 单次心跳 ack 等待上限 |
| `MAX_RESTART_FAILURES` | 3 | 连续重启失败进入 `down` 的阈值 |
| `CONTROL_MAX_RETRIES` | 3 | control 指令投递重试上限 |

## 5. `control_queue` Schema

```sql
CREATE TABLE IF NOT EXISTS control_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  content         TEXT    NOT NULL,
  priority        INTEGER DEFAULT 0,
  require_idle    INTEGER DEFAULT 0,
  bypass_state    INTEGER DEFAULT 0,
  ack_deadline_at INTEGER,
  status          TEXT    DEFAULT 'pending',
  retry_count     INTEGER DEFAULT 0,
  available_at    INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

| 字段 | 说明 |
|------|------|
| `id` | 自增主键，即 `control_id`，用于追踪心跳 |
| `content` | 指令内容（心跳 prompt 含完整 ack 命令） |
| `priority` | 排序优先级，数字越小越优先（心跳 < 健康检测） |
| `require_idle` | 0/1，是否需要 Claude idle 才投递（context 检测需要） |
| `bypass_state` | 0/1，是否穿透 `state` 门控（心跳设为 1） |
| `ack_deadline_at` | ack 截止时间（unix seconds），由 enqueue 方设定 |
| `status` | `pending` → `running` → `done` / `failed` / `timeout` |
| `retry_count` | 已重试次数，达到 `CONTROL_MAX_RETRIES` 后标记 `failed` |
| `available_at` | 最早可投递时间（延迟投递用） |
| `last_error` | 最近一次错误信息 |

### 5.1 Status Flow

```
pending ──(dispatcher claim)──► running ──(ack)──► done
                                    │
                                    ├──(投递失败, retry_count < 3)──► pending (retry)
                                    ├──(投递失败, retry_count ≥ 3)──► failed
                                    └──(ack_deadline 超过)──► timeout
```

- 对 `done` / `failed` / `timeout` 的重复 ack：幂等成功（exit code 0），返回提示 `ALREADY_FINAL`
- `control_id` 不存在的 ack：错误（exit code 1），返回 `NOT_FOUND`

### 5.2 Data Cleanup

- 终态记录（done/failed/timeout）保留 7 天
- c4-dispatcher 每 24h 执行一次清理
- `DELETE FROM control_queue WHERE status IN ('done','failed','timeout') AND updated_at < ?`

## 6. Heartbeat Flow

### 6.1 Normal Cycle

```
activity-monitor                    control_queue             c4-dispatcher              Claude
     │                                   │                        │                       │
     │── c4-control enqueue ────────────►│                        │                       │
     │   (content=prompt, bypass_state=1) │                        │                       │
     │◄── control_id ───────────────────│                        │                       │
     │                                   │                        │                       │
     │   记录 control_id 到 pending 文件    │◄── claim (pending→running) ──│                       │
     │                                   │                        │── 投递到 tmux ────────►│
     │                                   │                        │                       │
     │                                   │                        │       │── c4-control ack --id N ──►│(DB: running→done)
     │                                   │                        │                       │
     │── c4-control get ────────────────►│                        │                       │
     │◄── status=done ──────────────────│                        │                       │
     │   删除 pending 文件                 │                        │                       │
```

心跳 prompt 示例：

```
Heartbeat check. Run: ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js ack --id 42
```

### 6.2 Suspect — 内部二次确认

Suspect 是 activity-monitor 的内部逻辑，不暴露给外部消费方。验证期间 `health` 保持 `ok`，消息照常投递。

```
activity-monitor (内部)
     │
     │  每 1800s 发心跳
     │  300s 内没 ack
     │
     │  内部标记: verifying
     │  立刻发复查心跳
     │
     │  300s 内没 ack
     │
     │  确认卡死 → 写 health=recovering → kill tmux
     │
     │  Guardian 照常重启 Claude
     │  Claude running 后立刻发心跳
     │
     ├── ack 收到 → 写 health=ok，通知 pending channels
     └── ack 没收到 → 重启失败计数 +1
              │
              ├── 未达上限 → 继续 kill + 重启
              └── 达到 3 次 → 写 health=down
```

### 6.3 Pending File Rule

Activity-monitor 使用本地文件（`~/zylos/activity-monitor/heartbeat-pending.json`）追踪当前心跳：

- 文件不存在 → 创建新心跳，写入 `control_id`
- 文件存在 → 只查询该 `control_id` 状态，不创建新心跳
- 查询到终态（done/failed/timeout/not_found）→ 删除文件

此规则保证 activity-monitor 重启后能继续处理上一次心跳，不会"悬空"。

### 6.4 Startup Behavior（无 Grace Period）

根据启动时 `health` 状态决定行为：

| 启动时 health | 行为 |
|---------------|------|
| `ok` 或不存在 | 正常启动，按 `HEARTBEAT_INTERVAL` (1800s) 发首次心跳 |
| `recovering` | Claude running 后立刻发心跳验证恢复 |
| `down` | Claude running 后立刻发心跳验证修复。ack → `ok`，no ack → 留在 `down` |

## 7. C4 Interfaces

### 7.1 `c4-control.js`（新增）

路径：`skills/comm-bridge/scripts/c4-control.js`

三个子命令，**纯文本输出**（消费者为 Claude AI 和 activity-monitor 代码）：

**enqueue** — 写入 control 指令

```bash
c4-control.js enqueue --content "Heartbeat check. Run: ..." --priority 0 --bypass-state --ack-deadline 300
# 成功: "OK: enqueued control 42"
# 失败: "Error: ..." (exit code 1)
```

**get** — 查询 control 状态

```bash
c4-control.js get --id 42
# 成功: "status=done"
# 失败: "Error: not found" (exit code 1)
```

**ack** — 回执

```bash
c4-control.js ack --id 42
# 成功: "OK: control 42 marked as done" (exit code 0)
# 已终态(幂等): "OK: control 42 already in final state (done)" (exit code 0)
# 不存在: "Error: control 42 not found" (exit code 1)
```

### 7.2 `c4-receive.js`（扩展）

新增功能：

1. **Health 门控**：读取 `claude-status.json` 的 `health` 字段，`health !== 'ok'` 时拒绝入队
2. **`--json` flag**：结构化 JSON 输出到 stdout
3. **Pending channels 记录**：拒绝时将 channel+endpoint 写入 pending channels 文件

**`--json` 输出格式**：

成功：
```json
{"ok": true, "action": "queued", "id": 123}
```

失败（exit code 非零）：
```json
{"ok": false, "error": {"code": "HEALTH_RECOVERING", "message": "System is recovering, please wait."}}
{"ok": false, "error": {"code": "HEALTH_DOWN", "message": "System is currently unable to recover automatically. Please contact the administrator."}}
{"ok": false, "error": {"code": "INVALID_ARGS", "message": "..."}}
{"ok": false, "error": {"code": "INTERNAL_ERROR", "message": "..."}}
```

**Error codes**（仅 c4-receive.js `--json`）：

| Code | 含义 | Bot 行为 |
|------|------|----------|
| `HEALTH_RECOVERING` | 系统恢复中 | 转发 error.message 给用户 |
| `HEALTH_DOWN` | 系统不可用 | 转发 error.message 给用户 |
| `INVALID_ARGS` | 参数错误 | Bot 自身 bug，记日志排查 |
| `INTERNAL_ERROR` | 系统内部错误（如 DB 入队失败） | 回复通用失败文案并记录日志 |

## 8. Dispatcher Behavior

扩展现有 `c4-dispatcher.js`，不新增组件。

### 8.1 消费优先级

1. 先消费 `control_queue`（按 `priority ASC, created_at ASC`）
2. 再消费 `conversations`（现有逻辑不变）

### 8.2 每条消息处理流程

```
1. 原子 claim: UPDATE ... SET status='running' WHERE id=? AND status='pending'
2. 门控检查:
   a. state 门控: state in {offline, stopped} && !bypass_state → 不投递（回退 pending）
   b. health 门控: health !== 'ok' → 不投递（hold，回退 pending）
   c. require_idle: require_idle=1 && state !== 'idle' → 不投递（回退 pending）
3. 投递到 Claude (tmux)
4. 投递失败 → retry_count++，回退 pending（或 retry_count ≥ 3 → failed）
5. 投递成功 → 等待 ack（由 Claude 主动调 c4-control ack 写 DB）
```

### 8.3 Health 门控行为

- `health !== 'ok'` 时 dispatcher **暂停消费**（hold 住队列）
- 已在队列中的消息不丢弃，health 恢复为 ok 后自然投递
- 新消息的拒绝在 intake 层（c4-receive.js）处理
- 例外：`bypass_state=1` 的 control 指令（如心跳）不受 health 门控

### 8.4 数据清理

每 24h 清理一次 control_queue 终态记录（7 天保留），附带在主循环中执行。

## 9. Degraded Message Handling

### 9.1 Intake 层（c4-receive.js）

当 `health !== 'ok'` 时：

1. 不入队
2. 将 channel+endpoint 写入 `~/zylos/comm-bridge/pending-channels.jsonl`（去重键：channel+endpoint）
3. 返回非零 exit code
4. `--json` 模式返回对应 error code 和用户可读 message

### 9.2 调用方各自处理

| 调用方 | 处理方式 |
|--------|----------|
| **TG Bot** | 解析 `--json` error.message，通过 TG API 直接回复用户 |
| **Lark Bot** | 解析 `--json` error.message，通过 Lark API 直接回复用户 |
| **Scheduler** | 用 exit code 判断失败，现有逻辑覆盖（revert to pending → 重试 → 超 miss_threshold 自动 skip） |

### 9.3 Recovery Notification

health 恢复为 `ok` 后：

1. 读取 `~/zylos/comm-bridge/pending-channels.jsonl`
2. 去重（channel+endpoint）
3. 通过 C4 向每个 channel+endpoint 发送 "System has recovered. Please resend your request."
4. 清空文件

## 10. File Paths

| 文件 | 路径 | 写入方 |
|------|------|--------|
| Status file | `~/zylos/comm-bridge/claude-status.json` | activity-monitor |
| Control DB | `~/zylos/comm-bridge/c4.db` (control_queue 表) | c4-control.js / c4-dispatcher.js |
| Heartbeat pending | `~/zylos/activity-monitor/heartbeat-pending.json` | activity-monitor |
| Pending channels | `~/zylos/comm-bridge/pending-channels.jsonl` | c4-receive.js |

### 10.1 Status File 路径迁移

`~/.claude-status` → `~/zylos/comm-bridge/claude-status.json`

需同步修改的文件：

| 文件 | 角色 |
|------|------|
| `skills/activity-monitor/scripts/activity-monitor.js` | 写入方 |
| `skills/comm-bridge/scripts/c4-config.js` | 常量定义 |
| `skills/comm-bridge/scripts/c4-dispatcher.js` | 读取方 |
| `skills/scheduler/scripts/daemon.js` | 读取方 |
| `skills/scheduler/scripts/runtime.js` | 读取方 |
| `skills/restart-claude/scripts/restart.js` | 读取方 |
| `skills/upgrade-claude/scripts/upgrade.js` | 读取方 |
| `skills/check-context/scripts/check-context.js` | 读取方 |
| `skills/web-console/scripts/server.js` | 读取方 |
| `cli/commands/service.js` | 读取方 |

## 11. Implementation Plan

### Phase 1: Foundation

1. `control_queue` 建表（§5 schema）
2. `c4-control.js` 新增（enqueue / get / ack）
3. Status file 路径迁移（§10.1）
4. `claude-status.json` 增加 `health` 字段

### Phase 2: Dispatcher

5. `c4-dispatcher.js` 扩展：control 优先消费 + health 门控 + bypass_state
6. `c4-dispatcher.js` 增加 control_queue 数据清理（7 天 / 24h）

### Phase 3: Heartbeat

7. Activity-monitor 接入心跳 enqueue / get 闭环
8. Suspect 内部二次确认逻辑
9. 恢复流程：kill tmux → guardian 重启 → 验证心跳 → health 转换
10. `down` 状态与连续失败计数

### Phase 4: Degraded Handling

11. `c4-receive.js` 增加 health 门控 + `--json` 输出
12. `c4-receive.js` 增加 pending channels 记录
13. Recovery notification（health → ok 后通知 pending channels）

### Phase 5: E2E Validation

14. 正常心跳闭环（enqueue → dispatch → ack → done）
15. 超时 → suspect → recovering → 重启 → ack → ok
16. 连续失败 → down → 人工修复 → 自动恢复
17. 降级期消息拒绝（TG/Lark bot `--json` 解析）
18. Scheduler 任务降级期重试
19. Pending channels 恢复通知
20. Status file 读取失败 fail-open 验证

---

*Document authored by Howard & Claude, 2026-02-09*
*Decisions record: `docs/heartbeat-open-questions.md` (Q1–Q20)*
