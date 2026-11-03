# ToolPipeline + ToolWatchdog + ProcSampler — 模块实施档

> 关联顶层方案：[v3 §四.1 / §四.3](../../activity-monitor-refactor-proposal-v3.md)
> 类型：AM 业务模块（tick 第 ③ ④ ⑤ 步）
> Phase：0（Watchdog 边界适配）+ Phase 1（ToolPipeline 物理合并）
> 合档原因：三者共同覆盖"工具生命周期 + 进程冻结" 检测，关联紧

---

## 1. 模块职责与边界

### ToolPipeline（tick 第 ④ 步）

物理合并 PR #500 `tool-lifecycle.js` + `tool-event-stream.js`：
- 消费 `tool-events.jsonl` 增量事件（通过 SignalStore 流式层）
- 维护多 session 工具生命周期内存状态
- 每 tick 合成 `api-activity.json`

### ToolWatchdog（tick 第 ⑤ 步）

PR #500 内部语义**完全保留**——边界适配：
- 5-stage 状态机（Start → Running → Timeout → Intervention → Completed）
- 工具分类规则（通过 Adapter DI 注入，不硬编码）
- 独立 owner 写 `tool-watchdog-state.json`
- 超时触发 → `adapter.sendMessage()` 发中断 + `engine.triggerRecovery()` 通知健康层

### ProcSampler（tick 第 ③ 步）

每 10 秒采样进程 context switch 计数（Linux `/proc/<pid>/status`；macOS `top -l 1 -pid <pid> -stats pid,csw`）：
- 判定规则：`isActive == true` AND `delta == 0 连续 60 秒` → frozen
- 判死后**不写 frozen state**——直接 `adapter.stop()` + 写 `proc-state.json`
- 下一 tick Guardian 看进程消失 → Offline → 拉起

**为什么 ProcSampler 独立而不是 Guardian 一部分**：时间维度不同。Guardian 是 1s 级 boolean 检查；ProcSampler 是 10s 采样 + 60s 滑动窗口状态机。合并会让 Guardian 维护独立时序状态机违反单一职责。

### 边界

**在 scope 内**：
- 工具生命周期检测 + 超时干预
- OS 级冻结检测（context switch 采样）
- 内部状态文件持有

**不在 scope 内**：
- HealthState 直接修改（通过 `triggerRecovery()` 单向通知）
- 进程拉起（Guardian 职责）

---

## 2. 输入 / 输出契约

### ToolPipeline I/O

| 输入 | 来源 |
|---|---|
| `tool-events.jsonl` 增量事件 | hook-activity.js（hook） |
| `signals.toolEventsIncremental` | SignalStore 流式层 |

| 输出 | 消费者 |
|---|---|
| `api-activity.json`（tick 合成） | HealthEngine（catalog scan）/ UI / StatusWriter |

### ToolWatchdog I/O

| 输入 | 来源 |
|---|---|
| `signals.apiActivity` | SignalStore（ToolPipeline 写） |
| `signals.foregroundSession` | SignalStore（hook 写） |
| `tool-watchdog-state.json` | 自身持久化 |
| Adapter `getToolRules()` | DI |

| 输出 | 消费者 |
|---|---|
| `adapter.sendMessage(中断按键)` 调用 | Adapter（直发到 tmux）|
| `engine.triggerRecovery()` 调用 | HealthEngine（同步事件）|
| `tool-watchdog-state.json` 写入 | 自身 |

### ProcSampler I/O

| 输入 | 来源 |
|---|---|
| Adapter `getProcessPid()` | DI |
| OS 进程信息（`/proc` / `top`） | 系统调用 |

| 输出 | 消费者 |
|---|---|
| `proc-state.json` 写入 | Guardian / StatusWriter |
| `adapter.stop()` 调用 | Adapter（判死后）|

---

## 3. 数据结构 / 字段 / 状态机

### ToolWatchdog 5-stage 状态机

PR #500 既有，**内部语义完全不动**：
- Start → Running → Timeout → Intervention → Completed
- 状态机规则值 / intervention 按键序列 / 超时阈值都保留

### ProcSampler 滑动窗状态

```js
class ProcSampler {
  samples: ring buffer (size 6, 60s 滑动窗，每 10s 一次)
  isActive: bool   // 来自 hook fresh + active_tools > 0

  // 判定 frozen：isActive AND samples 全部 delta == 0 (60s 内零 context switch)
}
```

### Adapter 工具规则注入

ToolWatchdog 不硬编码规则：

```js
// adapter.getToolRules() 返回 runtime-specific 规则
{
  toolTimeoutSec: 300,
  interventionKeys: ['Escape', 'Enter'],
  ignoredTools: ['Read', 'Bash']  // 这些工具不超时
}
```

---

## 4. 关键接口与调用关系

### ToolPipeline.tick(signals)

```
tick(signals):
  events = signals.toolEventsIncremental    # 流式增量
  for event in events:
    updateLifecycleState(event)             # 内存维护各 session 工具状态
  writeApiActivityJson()                    # 合成 api-activity.json
```

### ToolWatchdog.tick(signals)

```
tick(signals):
  for tool in inflightTools:
    if elapsed > timeoutSec:
      adapter.sendMessage(interventionKeys)
      engine.triggerRecovery()
      tool.state = 'Intervention'
```

### ProcSampler.tick(signals)

```
tick():
  if (count % 10 == 0):                     # 每 10 秒采一次
    sample = readContextSwitches(pid)
    samples.push(sample)
  if isActive AND allZeroDeltaInWindow():
    adapter.stop()
    writeProcStateJson({frozen: true, ts: now})
```

---

## 5. 错误处理与恢复逻辑

### ToolPipeline tool-events.jsonl 损坏

- 单行 JSON 解析失败 → skip 该行 + log warning
- 整文件不读 → 视为无新事件，下次 tick 重试

### ToolWatchdog Intervention 失败

- `adapter.sendMessage()` 失败（tmux 不存在 / IPC 错误）→ log + 标 'Intervention_failed'
- 不重试同一干预——下一 tick `triggerRecovery()` 让 HealthEngine 决定 restart

### ProcSampler 读 OS 失败

- macOS `top` 命令失败 / Linux `/proc` 不可访问 → 视为 sample missing
- 不影响判定主流程——多次 sample missing 时不判 frozen（保守）

---

## 6. 迁移策略

### Phase 0 落地（边界适配，PR #500 内部语义不动）

5 项边界适配（详 v3 §八 Phase 0）：
1. `tool-event-stream` 并入 SignalStore 流式层
2. 物理合并 `tool-lifecycle.js` + `tool-event-stream.js` → `tool-pipeline.js`
3. `tool-rules.js` 改为 Adapter DI 覆盖
4. ToolWatchdog 独立持有 `tool-watchdog-state.json`
5. 对外接口收敛为 `.tick(signals)` + `.getPendingInterventions()`

**测试要求**：以现有行为为 golden，适配前后 E2E 行为必须等价。

### Phase 1 落地（ToolPipeline 模块文件）

新建 `tool-pipeline.js`，逻辑搬运 + 接口对齐 SignalStore。

### ProcSampler

PR #351（2026-03-18）已上 main 跑稳——v3 不动 ProcSampler 内部，只把它纳入新模块拼图（独立 owner、独立测试）。

---

## 7. 测试策略 + 验收标准

### Phase 0 Golden test

把 PR #500 既有 E2E 测试 record 为 golden，重构后 100% 行为等价。

### 单元测试

| 测试 | 描述 |
|---|---|
| ToolPipeline 增量消费 | mock tool-events.jsonl 1000 行 → 全部读到 + 游标推进 |
| ToolWatchdog 5-stage 转换 | PR #500 既有测试套保留 |
| ProcSampler 60s 滑动窗 | 模拟 60s 全零 delta → 判 frozen |
| Adapter DI 工具规则 | mock adapter 注入不同规则 → ToolWatchdog 行为差异 |

### 验收标准

- ✅ Phase 0 golden test 100% 等价
- ✅ ProcSampler 误判率 ≤ 1%（PR #351 测试基线）
- ✅ ToolWatchdog 5-stage 转换 PR #500 既有覆盖率不下降

---

## 8. 与其他模块的依赖关系

### 上游

- [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md)：读 toolEventsIncremental / apiActivity / foregroundSession / procState
- [`runtime-adapter.md`](runtime-adapter.md)：DI 工具规则、heartbeat-deps、`adapter.sendMessage()` / `adapter.stop()` / `adapter.getProcessPid()`

### 下游

- [`health-engine.md`](health-engine.md)：ToolWatchdog `triggerRecovery()` / ProcSampler 通过进程消失间接影响（Guardian 看 proc-state）
- [`guardian.md`](guardian.md)：ProcSampler 写 `proc-state.json` + 间接（kill 后 Guardian 拉起）

---

*v3 R3 review (2026-04-28) 整理：合 v2.1 §5.6 ProcSampler + §5.7 ToolPipeline+ToolWatchdog；PR #500 内部语义不动，只做边界适配。*