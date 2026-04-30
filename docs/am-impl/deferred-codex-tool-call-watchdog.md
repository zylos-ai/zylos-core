# Deferred: Codex Tool-Call Watchdog

> 状态：Deferred proposal
> 当前 AM v3 实施范围：不实现
> 背景：2026-04-29/30 Codex session 出现长时间 tool call 卡住，外部消息无法进入主 loop

## 1. 问题描述

Codex runtime 可能出现一种 live-but-stuck 状态：

- tmux session 仍存在，进程看起来还活着
- Codex UI 显示仍在 `Working (...)`
- 当前 tool call 长时间没有返回
- 新用户消息可能被 Codex 排队到 “下一次 tool call 结束后提交”
- 主 agent loop 因等待 tool call 返回而无法处理新消息

这类问题不同于 AM v3 当前主线里的 runtime down / health failed / sticky API error：

- runtime 没有直接退出
- C4 / Lark / bootstrap 脚本不一定有问题
- 卡点更可能在 Codex tool-runner / PTY / return path

## 2. 非目标

当前 AM v3 implementation 不实现本方案。

原因：

- 该问题属于 Codex runtime 特定兜底策略，不是 AM v3 实施文档里的核心模块拆分目标
- 自动发送 Escape 可能影响正常长任务，需要更完整的风险评估
- rollout JSONL 是 Codex 内部运行记录，格式稳定性需要进一步确认
- 应先完成 AM implementation docs 中定义的 RuntimeAdapter / SignalStore / Guardian / HealthEngine / MessageRouter 等主线工作

## 3. 方案草案

该方案如果未来实现，建议分为两个层级。

### 3.1 Pending User Message Watchdog

目标：当用户已经发来新消息，但 Codex 当前 turn/tool call 阻塞导致消息无法进入主 loop 时，优先尝试中断当前 tool call。

信号来源：

- tmux pane capture
- Codex UI 中的 `Working (...)`
- Codex UI 中的 `Messages to be submitted after next tool call`

判断流程：

1. AM health 必须为 `ok`
2. tmux capture 必须成功
3. Codex 必须处于 working 状态
4. 必须检测到 queued user message
5. working 时间超过阈值后，向 C4 control queue enqueue `[KEYSTROKE]Escape`
6. grace 期后仍未恢复，则触发 Guardian recovery

建议默认值：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `codex_pending_message_interrupt_sec` | 30 | 用户消息已排队时的快速中断阈值 |
| `codex_pending_message_grace_sec` | 10 | Escape 后等待恢复时间 |
| `codex_pending_message_cooldown_sec` | 30 | Escape enqueue 失败后的重试冷却 |

升级原因：

```text
codex_pending_message_stuck
```

### 3.2 Active Tool Call Watchdog

目标：即使没有 queued user message，也能兜底检测长时间未闭合的 Codex tool call。

信号来源：

- 当前 active Codex rollout JSONL
- `~/.codex/state_5.sqlite` 中最新未归档 thread 的 `rollout_path`
- fallback：扫描 `~/.codex/sessions/**/rollout-*.jsonl` 的最新 mtime

rollout 解析草案：

| 事件 | 含义 |
|------|------|
| `response_item` + `payload.type=function_call` | tool call 开始 |
| `response_item` + `payload.type=custom_tool_call` | custom tool call 开始 |
| `response_item` + `payload.type=function_call_output` | tool call 结束 |
| `response_item` + `payload.type=custom_tool_call_output` | custom tool call 结束 |
| `event_msg` + `payload.type` 以 `_end` 结尾 | tool call 结束 |

判断流程：

1. 优先执行 Pending User Message Watchdog；如果命中，该路径优先
2. 没有 queued user message 时，读取 active rollout
3. 找到最早未闭合 tool call
4. 未超过阈值时只观察
5. 超过阈值后 enqueue `[KEYSTROKE]Escape`
6. grace 期后同一 call 仍未闭合，则触发 Guardian recovery

建议默认值：

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `codex_active_call_interrupt_sec` | 900 | 无用户等待时更保守的中断阈值 |
| `codex_active_call_grace_sec` | 30 | Escape 后等待恢复时间 |
| `codex_active_call_cooldown_sec` | 120 | Escape enqueue 失败后的重试冷却 |

升级原因：

```text
codex_active_call_stuck
```

## 4. Episode Key

为避免新一轮 tool call 继承旧 watchdog 状态，episode key 必须绑定当前卡住对象。

建议格式：

```text
codex_pending_message:<working_started_at_sec>
codex_active_call:<call_id>:<started_at_sec>
```

当 episode key 改变时，应清理旧 watchdog state。

## 5. 干预动作

建议不要直接调用 `tmux send-keys`。

应通过 C4 control queue enqueue：

```text
[KEYSTROKE]Escape
```

建议参数：

- priority: `0`
- bypass-state: true
- no-ack-suffix: true
- available-in: 短延迟，例如 `1`

理由：

- 与现有控制消息路径一致
- 保留 C4 queue 的排序与可观测性
- 避免多个模块直接写 tmux

## 6. 风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| 误中断正常长任务 | 某些任务确实可能运行超过数分钟 | active-call 路径默认阈值应足够保守 |
| rollout 格式变化 | Codex JSONL 不是 AM 的稳定内部接口 | 只作为 best-effort signal，失败时 fail closed |
| Escape 无效 | 某些 tool-runner 卡死可能不响应 Escape | grace 后交给 Guardian recovery |
| 与 ToolWatchdog 语义重叠 | Claude hook ToolWatchdog 已有工具级干预 | 未来若实现，应放入 RuntimeAdapter / ToolWatchdog 统一模型 |

## 7. 未来实施条件

建议满足以下条件后再考虑实现：

1. AM v3 当前实施文档中的主线模块拆分完成
2. RuntimeAdapter 能暴露 runtime-specific tool activity signal
3. ToolWatchdog 支持 Codex runtime 的候选工具来源，而不是由 Orchestrator 特判 Codex
4. 有足够真实样本确认 Codex rollout event schema
5. 文档先更新，再实现代码

## 8. 当前结论

该方案记录为独立 deferred proposal。

当前 AM v3 implementation 不包含 Codex pending-message watchdog 或 active-call rollout watchdog。当前优先级是按 `docs/am-impl/` 中已定义的组件实施方案推进 AM 主线。
