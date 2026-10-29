# 数据源与 Adapter

> 所属总方案：[solution.md](../solution.md)

## 模块职责

封装所有外部数据来源，向 Resolver 提供统一的 capabilities / resolve / health 接口。每个 adapter 负责一种数据来源的连接、读取、解析和健康检测。

## Adapter 接口

所有 adapter 实现统一接口：

```
MetricAdapter:
  capabilities(runtime) → Map<MetricName, Capability>
  resolve(metric, runtime) → MetricResult
  history(metric, runtime, timeRange) → MetricResult[]
  health() → AdapterHealth
```

- `capabilities`：声明此 adapter 对每个 runtime 的每个指标的支持能力
- `resolve`：返回指标的当前值和 availability 状态
- `history`：返回时间范围内的历史数据
- `health`：adapter 自身健康状态（用于 Resolver 降级判断）

## Adapter 一览

| Adapter | 数据来源 | Phase | 覆盖指标 |
|---------|---------|-------|---------|
| FileAdapter | activity-monitor JSON/JSONL | 1 | agent_state, current_tool, tool_calls, tool_duration, health, context_usage |
| StatusLineAdapter | statusline.json（Claude only） | 1 | context_usage, token_usage, session_cost, cache_hit_rate |
| SQLiteAdapter | c4.db, scheduler.db（readonly） | 1 | messages, scheduled_tasks |
| PM2Adapter | pm2 jlist | 1 | pm2_services |
| HookAdapter | Hook 事件流 | 2 | tool_calls, tool_failures, agent_state, session_lifecycle, permission_requests |
| TelemetryAdapter | OTel OTLP 接收端 | 2 | token_usage, session_cost, llm_latency, cache_hit_rate, tool_calls, tool_failures, tool_duration, ttft |

## FileAdapter

### 数据源

| 文件 | 内容 | 更新频率 | 读取方式 | runtime 依赖 |
|------|------|---------|---------|-------------|
| `agent-status.json` | Agent 状态 | ~1s | fs.watch + JSON parse | 无 |
| `cost-log.jsonl` | Session 成本记录 | session 结束 | 启动全量 + tail 增量 | 无 |
| `tool-events.jsonl` | 工具调用事件 | 实时 | tail -f 流式 | 无 |
| `context-monitor-state.json` | Context 使用率 | 定期 | fs.watch | 两端均可用（Codex 需补 file write） |
| `proc-state.json` | 进程采样 | ~10s | fs.watch | 无 |
| `usage.json` | 配额 | 定期 | fs.watch | 无 |

文件监控策略：fs.watch 提示 + 5-10s polling 兜底。activity-monitor 使用 temp+rename 写入模式，inotify 在此模式下不可靠，polling 保证正确性。

### Codex context_usage 特殊说明

zylos-core `CodexContextMonitor`（`cli/lib/runtime/codex-context-monitor.js`）已能读取 Codex context 使用率——读 JSONL rollout `last_token_usage.input_tokens` + `model_context_window`，SQLite fallback，每 30 秒轮询，零 token 消耗。但当前 `getUsage()` 仅驱动 threshold 回调（60%/75%），**未写入 `context-monitor-state.json`**。

待做：activity-monitor polling callback 补一行 `writeFileSync(context-monitor-state.json, { used_percentage, ... })`，Dashboard FileAdapter 即可通过与 Claude 相同的路径消费。

## StatusLineAdapter

读取 `statusline.json`，仅 Claude runtime 可用。包含 context 百分比、累计成本、rate limit 状态、token 统计等。

每 turn 更新一次。Claude 的 statusline hook 在每次 API 回复后写入此文件。

## SQLiteAdapter

只读访问 `c4.db`（通信记录）和 `scheduler.db`（任务调度）。

三层只读保护：
1. URI `?mode=ro` — SQLite 层只读
2. `fileMustExist: true` — 不自动创建
3. `PRAGMA query_only = ON` — 查询层只读

查询即开即关，不持长事务，避免 WAL checkpoint 被拖住。

## PM2Adapter

通过 `pm2 jlist` 获取所有 PM2 管理的服务状态。10s 轮询，5s 超时，失败降级。

返回：运行状态（online/stopped/errored）、重启次数、内存/CPU、日志路径。

## HookAdapter（Phase 2）

Dashboard 自身注册 hook handler，实时接收 runtime 事件流，替代文件轮询。

### Dashboard 利用 hook 的两种模式

| 模式 | Phase | 说明 |
|------|-------|------|
| 间接消费（读文件） | Phase 1 | activity-monitor 的 hook 将数据写入状态文件和 JSONL，Dashboard FileAdapter 读取产出物 |
| 直接 ingestion | Phase 2 | Dashboard 自身注册 hook handler，实时接收事件流 |

### Hook 事件覆盖

两个 runtime 都支持 hook 机制。Claude Code 支持 29 种事件，Codex CLI 支持 6 种。

**共有事件（6 种，Dashboard 可统一采集）：**

| 事件 | 说明 |
|------|------|
| SessionStart | 会话开始/恢复 |
| UserPromptSubmit | 用户提交 prompt 前（可阻塞） |
| PreToolUse | 工具执行前 |
| PostToolUse | 工具执行后 |
| PermissionRequest | 权限审批时 |
| Stop | 回复结束时 |

**Claude Code 独有事件（23 种）：**

PostToolUseFailure, PostToolBatch, Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, TeammateIdle, SessionEnd, StopFailure, UserPromptExpansion, PermissionDenied, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PostCompact, Elicitation, ElicitationResult, Setup, at_mention.

不纳入的事件：PreCompact（zylos-core 设计上避免触发 auto compact）。

**HookAdapter 重点事件（Phase 2 直接 ingestion）：**

| 事件 | 采集内容 |
|------|---------|
| PostToolUse | 实时工具调用事件流（替代 JSONL 轮询） |
| PostToolUseFailure | 错误率、失败分类 |
| SessionStart / SessionEnd | 会话生命周期精确时间戳 |
| Stop / StopFailure | Turn 边界 + API 错误分类 |
| SubagentStart / SubagentStop | 子代理追踪 |
| FileChanged | 监听状态文件变更驱动 WebSocket 推送 |

### Hook handler 类型

| 类型 | Claude | Codex | 说明 |
|------|--------|-------|------|
| command | ✅ | ✅ | Shell 命令，stdin 接收 JSON |
| http | ✅ | ❌ | POST 到远程端点 |
| mcp_tool | ✅ | ❌ | 调用 MCP server 工具 |
| prompt | ✅ | ❌ | 单轮 Claude 评估 |
| agent | ✅ | ❌ | 子 agent（实验性） |

### Codex hook 关键限制（源码确认）

- PreToolUse 对暴露 `PreToolUsePayload` 的 handler 触发（Bash/unified exec/apply_patch/MCP），不是所有工具
- 所有 hook 同步阻塞执行（`async` 字段存在于 schema 但未实现）
- PreToolUse 只能 block/deny，不能 approve
- `updatedInput`、`additionalContext`、`updatedMCPToolOutput` 在 schema 中定义但未实现
- 非 JSON 的 stdout 如果以 `{` 或 `[` 开头会导致解析失败
- 默认超时 600 秒，最小 1 秒

### 配置路径

- Claude Code：`~/.claude/settings.json` → `hooks` 字段（project/local/user 三层）
- Codex CLI：`~/.codex/hooks.json` 或 `<repo>/.codex/hooks.json`（project/user 两层 + plugin）

## TelemetryAdapter（Phase 2）

接收 Claude Code 和 Codex CLI 的 OTel OTLP 输出，内部按 runtime 分 codec 解析。

### 架构差异

**Claude Code 主信号是 OTel Metrics pipeline**：8 个 metrics（counter/histogram）+ 17 个 log events + traces（beta）。

**Codex CLI 主信号是 OTel Logs pipeline**：log attributes 聚合（如 `sum(input_token_count)`、`count_distinct(conversation.id)`）。独立 metrics 作为补充。

TelemetryAdapter 内部分两个 codec：
- **Claude codec**：消费 `claude_code.*` metrics + logs + traces
- **Codex codec**：消费 `codex.*` logs（按 attributes 聚合）+ metrics + traces

### Claude Code OTel

启用方式：环境变量（`CLAUDE_CODE_ENABLE_TELEMETRY=1` 等）。

**8 个 Metrics：**

| Metric | 关键 attributes |
|--------|----------------|
| `claude_code.session.count` | `start_type` (fresh/resume/continue) |
| `claude_code.lines_of_code.count` | — |
| `claude_code.pull_request.count` | — |
| `claude_code.commit.count` | — |
| `claude_code.cost.usage` | `model`, `query_source` (main/subagent/auxiliary), `speed`, `effort` |
| `claude_code.token.usage` | `type` (input/output/cacheRead/cacheCreation), `model`, `query_source`, `speed`, `effort` |
| `claude_code.code_edit_tool.decision` | `language`, `source` |
| `claude_code.active_time.total` | `type` (cli/user) |

**17 个 Log Events：**

| Event | 关键 attributes |
|-------|----------------|
| `claude_code.user_prompt` | `prompt.id`, `event.sequence` |
| `claude_code.tool_result` | `tool_name`, `success`, `prompt.id` |
| `claude_code.tool_decision` | `tool_name`, `decision` |
| `claude_code.api_request` | `model`, `cost_usd`, `prompt.id` |
| `claude_code.api_error` | `error_code`, `status_code` |
| `claude_code.api_request_body` | `body`, `model`（需 `OTEL_LOG_RAW_API_BODIES`） |
| `claude_code.api_response_body` | `body`（需 `OTEL_LOG_RAW_API_BODIES`） |
| `claude_code.api_retries_exhausted` | `total_attempts`, `total_retry_duration_ms` |
| `claude_code.compaction` | `trigger`, `success`, `duration_ms`, `pre_tokens`, `post_tokens` |
| `claude_code.hook_execution_start` | `hook_name`, `event_name` |
| `claude_code.hook_execution_complete` | `hook_name`, `duration_ms`, `exit_code` |
| `claude_code.mcp_server_connection` | `server_name`, `status`, `transport_type`, `duration_ms` |
| `claude_code.permission_mode_changed` | `from_mode`, `to_mode`, `trigger` |
| `claude_code.skill_activated` | `skill.name`, `invocation_trigger`, `skill.source` |
| `claude_code.auth` | `action`, `success`, `auth_method` |
| `claude_code.internal_error` | `error_name`, `error_code` |
| `claude_code.plugin_installed` | `plugin.name`, `plugin.version`, `install.trigger` |

**事件关联**：`prompt.id`（UUID，链接一个 user prompt 下的所有事件）+ `event.sequence`（单调递增排序）。

**Traces（beta）：**

```
claude_code.interaction（一轮对话）
├── claude_code.llm_request（API 调用）
│   model, ttft_ms, attempt, stop_reason, response.has_tool_call
├── claude_code.tool（工具执行）
│   tool_name, duration_ms, result_tokens, file_path, full_command
│   ├── claude_code.tool.blocked_on_user
│   ├── claude_code.tool.execution
│   └── (子 agent spans 嵌套)
├── claude_code.hook
└── claude_code.subagent
```

W3C Trace Context 传播到 Bash 子进程和 Agent SDK 子 agent。

**OTel 配置：**

| 配置 | 说明 |
|------|------|
| `CLAUDE_CODE_ENABLE_TELEMETRY=1` | 主开关 |
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | span tracing |
| `OTEL_METRICS_EXPORTER` | `otlp` / `prometheus` / `console` / `none` |
| `OTEL_LOGS_EXPORTER` / `OTEL_TRACES_EXPORTER` | 同上 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://localhost:4317` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` / `http/json` / `http/protobuf` |

内容细粒度控制（opt-in，默认关闭）：

| 变量 | 内容 |
|------|------|
| `OTEL_LOG_USER_PROMPTS=1` | Prompt 文本 |
| `OTEL_LOG_TOOL_DETAILS=1` | 工具输入参数 |
| `OTEL_LOG_TOOL_CONTENT=1` | 完整工具 I/O（60KB 截断） |
| `OTEL_LOG_RAW_API_BODIES` | 完整 API 请求/响应 |

Resource attributes：`service.name=claude-code`、`service.version`、`os.type`、`host.arch` 等。
Cardinality 控制：`OTEL_METRICS_INCLUDE_SESSION_ID`(默认 true)、`OTEL_METRICS_INCLUDE_VERSION`(默认 false)。

### Codex CLI OTel

启用方式：`~/.codex/config.toml` `[otel]` section。支持 `otlp-http` 和 `otlp-grpc`。

**Log Events：**

| Event | 关键 attributes |
|-------|----------------|
| `codex.conversation_starts` | `conversation.id`, `user.email`, `terminal.type` |
| `codex.api_request` | `model`, `cf_ray`, `auth_mode`, `duration_ms`, `status` |
| `codex.sse_event` | `input_token_count`, `output_token_count`, `cached_token_count`, `reasoning_token_count`, `tool_token_count` |
| `codex.websocket_request` / `codex.websocket_event` | `duration_ms`, `success`, `kind`, `error` |
| `codex.user_prompt` | `conversation.id` |
| `codex.tool_decision` | `tool_name`, `decision`, `call_id` |
| `codex.tool_result` | `tool_name`, `success`, `duration_ms`, `call_id` |

**事件关联**：`conversation.id`（宽关联键）+ `call_id`（仅 tool decision/result 路径）。Per-model-call 细粒度关联待实测。

**Metrics：**

| Metric | 说明 |
|--------|------|
| `codex.turn.e2e_duration_ms` | 端到端 turn 耗时 histogram |
| `codex.turn.ttft.duration_ms` | 首 token 延迟 histogram |
| `codex.approval.requested` | 审批请求计数（按 `tool`、`approved` 分） |
| `codex.mcp.call` | MCP 工具调用结果 |
| `codex.thread.started` | 线程启动 |
| `codex.conversation.turn.count` | 对话轮次计数 |
| `codex.skill.injected` | Skill 注入结果 |
| API/SSE/WebSocket duration | 请求耗时 histogram |

**Traces**：`codex.session` root span + 子 span（API 调用、工具执行）。Resource: `service.name=codex_cli_rs`。

**OTel 配置：**

```toml
[otel]
exporter = { otlp-grpc = { endpoint = "http://localhost:4317" } }
log_user_prompt = false  # 默认 redacted
```

### 派生指标

由 TelemetryAdapter 从原始 OTel 数据计算：

| 派生指标 | 公式 | 来源 |
|---------|------|------|
| cache_efficiency_pct | cacheRead / (cacheRead + input) × 100 | token.usage by type（multi-runtime） |
| cost_leverage | actual_api_cost / subscription_time_equivalent | cost.usage + active_time |
| usage_leverage | cli_time / user_time | active_time.total by type（Claude only） |
| tokens_per_turn | token.usage / turn_count | 聚合 |

### 事件链重建

通过关联字段可串联一次交互下的所有 log events，重建完整执行流程：
- Claude：`prompt.id`（UUID）+ `event.sequence`（单调递增）
- Codex：`conversation.id`（宽关联键）+ `call_id`（tool 路径）

### OTel Collector 配置

Dashboard 内嵌轻量 OTLP 接收端，两个 runtime 的遥测经同一 collector 进入同一 pipeline，由 TelemetryAdapter 按事件前缀（`claude_code.*` / `codex.*`）分别解析。

Claude Code → `http://localhost:4318`（http/protobuf）
Codex CLI → `http://localhost:4317`（gRPC）

OTel 数据存入 Dashboard 自有 SQLite（`dashboard.db`），不污染已有数据库。

## 依赖

- Resolver（消费本模块的 adapter 接口）
- activity-monitor（FileAdapter 读取其产出的状态文件和 JSONL）
- comm-bridge / scheduler（SQLiteAdapter 读取其数据库）
- PM2（PM2Adapter 调用 `pm2 jlist`）
- Claude Code / Codex CLI runtime（TelemetryAdapter 接收 OTel 输出、HookAdapter 接收 hook 事件）
