# Hook 脚本

## 1. 组件定义

> 来源：顶层设计 §3.1

Hook 脚本是 AM 的重要数据采集层。它们注册为 Claude Code 的异步 hook，在 runtime 运行过程中被触发，将事件写入 signal files 供主循环组件消费。Hook 本身不参与主循环 tick，而是作为 runtime 侧的事件采集器独立运行。

数据流：Hook 脚本 → signal files → SignalStore（tick 开头读取）→ snapshot → 各组件消费。

Hook 脚本已经是独立文件，不需要拆分。确认现有行为与顶层设计一致。

### Heartbeat control ack 边界

`contracts.md` §2 中的 recovery heartbeat ack 不对应本页列出的 4 个 `scripts/*hook*.js` 文件，也不要求新增代码 hook。它是 runtime 收到 C4 control 文本后的控制行为：dispatcher 投递 `Heartbeat check. [phase=recovery|post_restart]` 并保留 ack suffix，runtime/system prompt 的 heartbeat control 规则识别该文本后执行 suffix 中的 `c4-control.js ack --id <id>`。因此本页的"hook 无变更"仍成立；需要变更的是 C4 control 投递、auto-ack 禁用，以及 runtime 控制提示/处理规则的 contract 对齐。

### Hook 总览

| Hook | 触发时机 | 输出文件 | 消费方 | 行数 |
|------|---------|---------|-------|------|
| hook-activity | UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop / Notification(idle) | tool-events.jsonl | ToolPipeline | 152 |
| hook-auth-prompt | PermissionRequest | （C4 control） | — | 82 |
| session-start-prompt | SessionStart | foreground-session.json + C4 control | ToolPipeline, Guardian | 89 |
| context-monitor | statusLine | statusline.json + C4 control | ToolPipeline, TaskScheduler | 283 |

---

## 2. hook-activity.js

### 功能清单

| 功能 | 说明 |
|------|------|
| 工具事件记录 | 将 Claude Code hook event 转换为 JSONL 写入 tool-events.jsonl |
| 事件类型映射 | UserPromptSubmit→prompt, PreToolUse→pre_tool, PostToolUse→post_tool, PostToolUseFailure→post_tool_failure, Stop→stop, Notification(idle)→idle |
| subagent 过滤 | `agent_id` 字段存在时跳过（只跟踪主 agent） |
| event_id 生成 | `${ts}-${pid}-${seq}` 唯一标识每个事件 |
| rule_id 匹配 | pre_tool 时匹配 tool-rules 中的规则 ID |
| JSONL append | 追加写入，ToolPipeline 负责轮转 |

### 数据流

```
Claude Code runtime
  │
  ├─ UserPromptSubmit hook → { event: 'prompt', session_id, pid, ts }
  ├─ PreToolUse hook      → { event: 'pre_tool', tool, event_id, rule_id, ... }
  ├─ PostToolUse hook      → { event: 'post_tool', tool, event_id, ... }
  ├─ PostToolUseFailure    → { event: 'post_tool_failure', tool, event_id, ... }
  ├─ Stop hook             → { event: 'stop', session_id, ... }
  └─ Notification(idle)    → { event: 'idle', session_id, ... }
         │
         ▼
   tool-events.jsonl（追加写入）
         │
         ▼
   SignalStore.refresh()（流式增量读取）
         │
         ▼
   ToolPipeline.tick()（lifecycle 状态机处理）
```

### 改动类型

无变更。已独立，确认接口对齐即可。

---

## 3. hook-auth-prompt.js

### 功能清单

| 功能 | 说明 |
|------|------|
| 权限自动确认 | `auto_approve_permission != false` 时，通过 C4 control 发送 Enter 自动确认 |
| 事件记录 | 记录权限请求到 hook-timing.log |
| 配置门控 | 读取 config.json 的 `auto_approve_permission` |

### 数据流

```
Claude Code runtime
  │
  PermissionRequest hook
  │
  ├─ auto_approve = true
  │   └─ C4 control → send Enter 按键到 tmux
  │
  └─ auto_approve = false
      └─ 只记录日志
```

### 改动类型

无变更。已独立，确认接口对齐即可。

---

## 4. session-start-prompt.js

### 功能清单

| 功能 | 说明 |
|------|------|
| 前台会话注册 | 写入 foreground-session.json（session_id + claude_pid + source） |
| 启动提示注入 | 通过 C4 control queue 注入启动提示（priority=2），触发 runtime 恢复工作 |
| session_start_source | 区分 startup / resume / clear / compact（SessionStart 的子类型） |

### 数据流

```
Claude Code runtime
  │
  SessionStart hook（每次 session 开始时触发）
  │
  ├─ 写 foreground-session.json
  │   { version: 1, session_id, claude_pid, source, session_start_source, observed_at }
  │
  └─ C4 control enqueue
      content: "reply to your human partner...", priority: 2
```

### 与其他组件的交互

| 交互方 | 数据 | 用途 |
|-------|------|------|
| **ToolPipeline** | foreground-session.json | 前台身份识别的早期信号 |
| **Guardian** | C4 control 启动提示 | session-start hook 存在时 Guardian 不需要 fallback 注入 |

### 改动类型

无变更。已独立，确认接口对齐即可。

---

## 5. context-monitor.js

### 功能清单

| 功能 | 说明 |
|------|------|
| statusLine 数据写入 | 每 turn 将 statusLine data 写入 statusline.json |
| 上下文阈值检测 | context >= 70%（可配置）→ 触发 new-session handoff |
| 早期 memory sync | context >= 56% 且 unsummarized > 30 → 触发 memory sync |
| memory sync 冷却 | 10 分钟内不重复触发 |
| session_id 追踪 | 从 statusLine 提取 session_id |

### 数据流

```
Claude Code runtime
  │
  statusLine hook（每 turn 后推送）
  │
  ├─ 写 statusline.json
  │   { session_id, context_window, cost, rate_limits, usage }
  │
  ├─ context >= 56% + unsummarized > 30
  │   └─ C4 control enqueue: "Run Memory Sync now..." (priority: 2)
  │
  └─ context >= 70%
      └─ enqueueNewSession() → C4 control → /new-session handoff
```

### 与其他组件的交互

| 交互方 | 数据 | 用途 |
|-------|------|------|
| **ToolPipeline** | statusline.json 的 session_id | 前台身份识别（statusLine 信号） |
| **SignalStore** | statusline.json | 下次 tick 读取 |

### 可配置项

| Config Key | 默认值 | 说明 |
|------|------|------|
| new_session_threshold | 70 | 触发 new-session 的上下文百分比 |

### 改动类型

无变更。已独立，确认接口对齐即可。

---

## 3. 实施方案

**改动类型**：无变更（4 个代码 hook 均已独立；recovery heartbeat ack 是 runtime control 行为，不是本页 hook 脚本）

### 现有代码位置

| 文件 | 行数 |
|------|------|
| `scripts/hook-activity.js` | 152 |
| `scripts/hook-auth-prompt.js` | 82 |
| `scripts/session-start-prompt.js` | 89 |
| `scripts/context-monitor.js` | 283 |
| `scripts/session-foreground.js` | 55（session-start-prompt 的辅助模块） |

### 实施步骤

1. 确认 4 个 hook 的触发条件、输出文件、行为与顶层设计一致
2. 确认 hook-activity 的事件类型映射和 subagent 过滤逻辑
3. 确认 context-monitor 的阈值逻辑和 memory sync 触发条件
4. 确认 runtime/system prompt 的 heartbeat control 规则会识别 `Heartbeat check. [phase=recovery|post_restart]` 并执行 ack suffix
5. 无需新增 hook 脚本逻辑
