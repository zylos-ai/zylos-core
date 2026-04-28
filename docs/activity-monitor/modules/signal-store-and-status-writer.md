# SignalStore + StatusWriter — 模块实施档

> 关联顶层方案：[v3 §三原则 4 / §四.4 / §六取舍 D-E](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（tick 第 ① / ⑧ 步）
> 合档原因：耦合紧——SignalStore 是输入侧（读所有 signal 到只读快照），StatusWriter 是输出侧（写唯一对外契约文件 `agent-status.json`）

---

## 1. 模块职责与边界

### SignalStore 职责

每 tick 开头**刷新一次**，产出一份**只读 snapshot** 供 tick 内所有后续模块共享。两层接口统一：

- **快照层**（readJSON）：一次性读取所有状态文件冻结为 snapshot
- **流式层**（JSONL incremental）：有状态的增量读取器，读取 `tool-events.jsonl` 上次游标之后的新增事件

### StatusWriter 职责

tick 末尾，**唯一**写 `agent-status.json` 的组件——对外契约 single publisher。做两件事：
1. 读 signals snapshot
2. 按决策规则投射 ActivityState + 读 HealthEngine 只读属性 → 写文件

不持有历史状态。**无状态投射**保证"重启 AM 后第一 tick 就写出真值"。

### 边界

**在 scope 内**：
- 12+ 状态文件的统一加载
- `agent-status.json` schema_version 升级
- ActivityState（3 种无状态投射，详 v3 §四.4）

**不在 scope 内**：
- HealthState FSM 内部逻辑（HealthEngine 职责）
- 各 signal 文件的写入方（各自 owner）

---

## 2. 输入 / 输出契约

### SignalStore 输入

**信号清单（13 个）**：

| 信号文件 | 写入者 | 消费者 |
|---|---|---|
| `api-activity.json` | ToolPipeline（tick 合成） | HealthEngine / UI / StatusWriter |
| `statusline.json` | context-monitor.js（hook） | TaskScheduler（context-check） |
| `heartbeat-pending.json` (Claude) / `codex-heartbeat-pending.json` (Codex) — runtime-specific 文件名通过 `adapter.getHeartbeatDeps().pendingKey` 注入 | HealthEngine | HealthEngine（自消费）|
| `user-message-signal.json` | c4-receive.js | HealthEngine（加速探测）|
| `proc-state.json` | ProcSampler | Guardian / StatusWriter |
| `foreground-session.json` | session-foreground.js（hook）| ToolWatchdog |
| `rate-limit-state.json` | HealthEngine（RateLimited 进出时写/清）| Guardian（条件 #1）|
| `maintenance-state.json` | TaskScheduler（maintenance 任务进出时写/清）| Guardian（条件 #4）|
| `unknown-api-errors.jsonl` | HealthEngine | 人工 weekly review |
| `usage.json` | usage-monitor 任务 | usage-alerter / dashboard / web-console |
| `usage-alert-state.json` | usage-alerter 任务 | usage-alerter（去重）|
| `agent-status.json` | StatusWriter | MessageRouter / c4-receive / c4-dispatcher / web-console / HealthEngine 冷启动回填 |
| `tool-events.jsonl` | hook-activity.js | ToolPipeline（流式读）|

### StatusWriter 输出（`agent-status.json` schema v2）

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | `'offline' \| 'busy' \| 'idle'` | ActivityState（合并 stopped → offline）|
| `health` | `'ok' \| 'unavailable' \| 'rate_limited' \| 'auth_failed'` | HealthState |
| `unavailable_since` | int (ms) | 仅 `health='unavailable'` 时存在 |
| `unavailable_reason` | string | 可选——catalog entry id（`corrupted_context` / `transient_overload` / `unknown` 等）|
| `schema_version` | int = 2 | 新增 |

`unavailable_reason` 是**开放枚举**——v3 内置 4 种值（见 catalog），未来 catalog 增补新 entry 自动加入。消费端遇到未知 reason 应退化到通用 unavailable 文案（不报错）。

### 不变量

- **C-SS-1**：tick 内所有模块读到的 SignalStore snapshot **完全一致**——单次 refresh 后全 tick 不变
- **C-SS-2**：`agent-status.json` 仅由 StatusWriter 一处写入——其他模块不得绕过
- **C-SS-3**：写 `agent-status.json` 是原子写（先写 .tmp + rename）

---

## 3. 数据结构 / 字段 / 状态机

### SignalStore 内存结构

```js
class SignalStore {
  snapshot = {}   // 当前 tick 的只读快照
  cursors = {}    // 流式层游标，按文件名（如 'tool-events.jsonl'）

  refresh() {
    // 一次性读所有 signal 文件 + 推进流式游标
    this.snapshot = freeze({
      apiActivity: readJSON('api-activity.json'),
      statusline: readJSON('statusline.json'),
      // ...其他 12 个
    })
    // 流式增量
    this.snapshot.toolEventsIncremental = readJSONLAfter(
      'tool-events.jsonl', this.cursors['tool-events.jsonl']
    )
  }
}
```

### ActivityState 投射规则

```
IF NOT tmux_alive OR NOT proc_alive: state = Offline
ELIF hook_fresh AND (active_tools > 0 OR inactive_sec < 3s): state = Busy
ELSE: state = Idle
```

**冻结的瞬态处理**：ProcSampler 判定冻结后直接 kill，**不写 frozen 状态**；下一 tick 自然投射为 Offline。实现细节不进契约。

---

## 4. 关键接口与调用关系

### SignalStore API

| 方法 | 用途 |
|---|---|
| `refresh()` | tick 开头调用一次，刷新整个 snapshot |
| `get()` | 返回当前 snapshot（readonly）|

### StatusWriter API

| 方法 | 用途 |
|---|---|
| `write(signals, healthEngine)` | tick 末尾调用，写 `agent-status.json` |

### 调用流

```
tick:
  signalStore.refresh()      ← Step ①（读 12+ 文件 + 流式增量）
  ...                        ← 中间 6 步消费 snapshot
  statusWriter.write(        ← Step ⑧（写出对外契约）
    signalStore.get(),
    healthEngine
  )
```

---

## 5. 错误处理与恢复逻辑

### 信号文件不存在 / 损坏

- SignalStore 容忍：missing 文件 → snapshot 中该字段为 `null` / `{}`
- 损坏 JSON → 视为 missing + log warning
- 不阻塞 refresh()——其他文件还能读

### `agent-status.json` 写失败

- StatusWriter 写 .tmp + rename 失败（disk full / permission）→ log 错误 + 跳过本 tick
- 旧的 `agent-status.json` 保留 → 消费端读到稍微 stale 的状态（eventual ≤ 1s）

### 流式游标越界

- `tool-events.jsonl` 被 truncate / rotate → SignalStore 检测游标 > 文件大小 → 重置游标到文件末尾 + log warning

---

## 6. 迁移策略

### Phase 1 落地

**Step 1**：新建 `signal-store.js` + `status-writer.js` 模块文件

**Step 2**：把现有散落的 `readJSON` 调用集中到 SignalStore.refresh()

**Step 3**：把现有 `writeAgentStatus` 调用集中到 StatusWriter.write()

**Step 4**：feature flag 控制启用，老路径保留

### `agent-status.json` schema 升级

- 加 `schema_version: 2` 字段
- `state` 合并 stopped → offline（消费端检测旧值仍能容忍）
- `health` 5 → 4 值（消费端遇 'down'/'recovering' 退化到 'unavailable'）
- 新增可选字段 `unavailable_since` / `unavailable_reason`

### 兼容性

- schema_version 缺失 = v1（老消费端不感知）
- 新增字段 optional，消费端遇 missing 退化通用文案

---

## 7. 测试策略 + 验收标准

| 测试 | 描述 |
|---|---|
| Snapshot 一致性 | 单 tick 多次 read 返同样 snapshot |
| Refresh 后 snapshot 更新 | refresh 后再 read 看到新值 |
| 流式游标推进 | tool-events.jsonl 增量读取，游标正确推进 |
| 文件 missing 容忍 | 删除 5 个 signal 文件 → refresh 不抛 |
| Schema v2 写入 | 写出 JSON 含所有 v2 字段 |
| 原子写 | 中断 write 后老 agent-status.json 保留完整 |
| ActivityState 投射规则 | 三种 state 转换覆盖 |

### 验收标准

- ✅ Refresh 一次 ≤ 50ms（13 个文件 + 流式增量）
- ✅ Write 一次 ≤ 10ms
- ✅ 1000 次重启测试，agent-status.json 0 损坏

---

## 8. 与其他模块的依赖关系

### 上游

无——SignalStore 只读文件系统 + 流式层。

### 下游

所有 AM 模块都读 SignalStore snapshot。StatusWriter 输出被 MessageRouter / c4-receive / c4-dispatcher / web-console / HealthEngine 冷启动回填消费。

---

*v3 R3 review (2026-04-28) 整理：合 v2.1 §5.1 SignalStore + §5.5 StatusWriter，因两者一个是 tick 入口一个是 tick 出口，耦合契约——单一对外发布者。*
