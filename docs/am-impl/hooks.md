# Hook 脚本

## 1. 组件定义

> 来源：顶层设计 §3.1

Hook 脚本是 AM 的重要数据采集层。它们注册为 Claude Code 的异步 hook，在 runtime 运行过程中被触发，将事件写入 signal files 供主循环组件消费。Hook 本身不参与主循环 tick，而是作为 runtime 侧的事件采集器独立运行。

数据流：Hook 脚本 → signal files → SignalStore（tick 开头读取）→ snapshot → 各组件消费。

Hook 脚本已经是独立文件，不需要拆分。确认现有行为与顶层设计一致。

---

## 2. hook-activity.js

### 组件设计

**改动类型**：无变更

- **触发**：UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop、Notification(idle_prompt)
- **输出**：写入 tool-events.jsonl（schema 见 [signal-store.md](signal-store.md)）
- **过滤**：忽略 subagent 事件（`agent_id` 字段存在时跳过）

### 与其他组件的交互

- **ToolPipeline** → 通过 SignalStore 消费 tool-events.jsonl

### 实施方案

已独立，确认接口对齐即可。

---

## 3. hook-auth-prompt.js

### 组件设计

**改动类型**：无变更

- **触发**：PermissionRequest
- **行为**：当 `auto_approve_permission != false` 时，通过 C4 control 发送 Enter 按键自动确认
- **配置**：`auto_approve_permission`（默认 true）

### 与其他组件的交互

- 独立运行，不与其他 AM 组件直接交互
- 通过 C4 control channel 发送按键

### 实施方案

已独立，确认接口对齐即可。

---

## 4. session-start-prompt.js

### 组件设计

**改动类型**：无变更

- **触发**：SessionStart
- **行为**：通过 C4 control queue 注入启动提示（priority=2），触发 runtime 恢复工作

### 与其他组件的交互

- 独立运行，通过 C4 control queue 注入提示

### 实施方案

已独立，确认接口对齐即可。

---

## 5. context-monitor.js

### 组件设计

**改动类型**：无变更

- **触发**：statusLine（Claude Code 每 turn 后推送）
- **行为**：
  - 写入 statusline.json（所有 turn）
  - context >= 56% 且 unsummarized > 30：触发 memory sync
  - context >= 70%：触发 new-session handoff
- **配置**：`new_session_threshold`（默认 70）

### 与其他组件的交互

- **SignalStore** → 写入 statusline.json，供下次 tick 读取
- **ToolPipeline** → statusline.json 的 session_id 用于 foreground identity 信任

### 实施方案

已独立，确认接口对齐即可。
