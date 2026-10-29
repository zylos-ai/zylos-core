# 指标模型

> 所属总方案：[solution.md](../solution.md)

## 模块职责

定义 Dashboard 的核心数据抽象——统一指标模型。所有指标对用户呈现统一的语义和展示结构，底层由哪个 adapter 提供、来自哪个 runtime，由本模块的 Resolver 引擎自动决定。

## 指标目录

| 指标 | 语义 | 单位 | Claude | Codex | Resolver chain（优先级递减） |
|------|------|------|--------|-------|--------------------------|
| **agent_state** | Agent 当前状态 | idle/busy/thinking/error/stopped | ✅ | ✅ | hook lifecycle → status file → PM2 |
| **current_tool** | 当前执行的工具 | string | ✅ | ✅ | hook Pre/PostToolUse → status file |
| **tool_calls** | 工具调用事件流 | event stream | ✅ | ✅ | telemetry → hook → JSONL fallback |
| **tool_failures** | 工具执行失败 | event stream | ✅ | ✅ | telemetry → PostToolUseFailure (Claude) / tool_result inference → status fallback |
| **tool_duration** | 工具执行耗时 | ms | ✅ | ✅ | telemetry → Pre/Post 时间差 |
| **context_usage** | Context window 使用率 | % | ✅ | degraded（上游前置） | Claude: telemetry → statusLine → context-monitor-state.json；Codex: CodexContextMonitor 已有读取能力，但 activity-monitor 尚未写入 state file，当前 Phase 1 为 degraded/missing |
| **token_usage** | Token 消耗 | count | ✅ | ✅/verify | telemetry → statusLine → cost-log |
| **session_cost** | Session 成本 | USD | ✅ | ✅/verify | telemetry → statusLine → cost-log |
| **llm_latency** | LLM 请求延迟 | ms (P50/P95/P99) | ✅ | ✅/verify | telemetry span / metric |
| **session_lifecycle** | Session 启动/结束 | event | ✅ | ✅ | SessionStart hook → status file |
| **permission_requests** | 权限审批 | event stream | ✅ | ✅ | PermissionRequest hook |
| **health** | 健康/心跳 | healthy/degraded/error | ✅ | ✅ | status file (health + watchdog_phase) |
| **cache_hit_rate** | Prompt cache 命中率 | % | ✅ | ✅ | Claude: cacheRead/(cacheRead+input)；Codex: cached/(cached+input) |
| **ttft** | 首 token 延迟 | ms | ✅ | ✅ | telemetry span/metric |
| **usage_leverage** | 自主工作比 | ratio | ✅ | — | 派生：active_time(cli) / active_time(user) |
| **pm2_services** | PM2 服务状态 | structured | ✅ | ✅ | pm2 jlist（runtime 无关） |
| **messages** | 通信消息量 | count + event | ✅ | ✅ | c4.db（runtime 无关） |
| **scheduled_tasks** | 计划任务状态 | structured | ✅ | ✅ | scheduler.db（runtime 无关） |

`✅/verify` 表示 capability=supported 但字段映射需 Phase 2 实测验证。

## Capability / Availability 两层模型

每个指标对每个 runtime 有两层状态，解决"能力上支持但此刻数据不可用"的表达问题。

### capability（静态，文档定义）

| 值 | 含义 |
|---|------|
| `supported` | 正式支持 |
| `supported/beta` | 支持但 API 不稳定 |
| `unsupported` | 不支持 |
| `planned` | 计划中 |

### availability（动态，resolver 实时判断）

| 值 | 含义 | 前端处理 |
|---|------|---------|
| `ok` | 数据正常 | 正常展示 |
| `degraded` | 使用了 fallback 来源或数据部分缺失 | 黄灯 + fallback 来源提示 |
| `stale` | 数据存在但超过 freshness 阈值 | 黄灯 + 最后更新时间 |
| `missing` | capability=supported 但数据未到达 | 灰态 + "数据未收集" |
| `error` | 数据源报错 | 红灯 + 错误信息 |

`capability=unsupported` 的指标不进入 resolver，直接在前端隐藏或灰态显示。

## Resolver 引擎

### 全局来源优先级

**telemetry > hook > 状态文件**

### 排序规则

Resolver 按指标查找所有 adapter 的 capability，收集 resolve 结果，按以下 ranking 选出最终结果：

1. **最高优先级 adapter 且 availability=ok** → 直接选中
2. **任意 adapter availability=ok** → 选优先级最高的 ok（跳过 stale/degraded 的高优来源）
3. **degraded** → 仅在没有 ok 结果（或指标声明 `degradedAcceptable`）时选中
4. **stale** → 不压过更新鲜的低优来源，仅在没有 ok/degraded 时选中
5. **全部 missing/error** → 返回最高优先级 adapter 的状态

**核心规则：freshness 优先于 source priority。**

### 输出结构

```json
{
  "value": 42,
  "availability": "ok",
  "capability": "supported",
  "source": "hook",
  "preferredSource": "telemetry",
  "fallbackReason": null,
  "confidence": "high",
  "updatedAt": "2026-05-01T16:00:00Z"
}
```

当 `source !== preferredSource` 时，`fallbackReason` 标明原因（如 `telemetry_missing`、`telemetry_stale`），供前端降级提示。

### Resolver 示例

```
resolve("tool_calls", "claude"):
  TelemetryAdapter → missing (collector not running)
  HookAdapter      → ok, value=[...]
  FileAdapter      → ok, value=[...]
  ranking: HookAdapter ok（优先级高于 FileAdapter）
  → source="hook", preferredSource="telemetry", fallbackReason="telemetry_missing"

resolve("context_usage", "codex"):
  FileAdapter → missing (context-monitor-state.json 不存在或无 Codex 数据)
  → availability="missing", source=none
  注：上游前置——activity-monitor 补写 context-monitor-state.json 后，此路径变为 FileAdapter → ok

resolve("context_usage", "claude"):
  TelemetryAdapter  → stale (last update 5min ago)
  StatusLineAdapter → ok, value=72.3 (updated 2s ago)
  ranking: StatusLineAdapter ok 优先于 TelemetryAdapter stale
  → source="statusline", preferredSource="telemetry", fallbackReason="telemetry_stale"
```

## Freshness 规则

按指标类型分别定义，不用全局硬编码阈值：

| 指标类型 | freshness 规则 |
|---------|---------------|
| event-stream（tool_calls, tool_failures） | 超过 N 秒无事件不一定 degraded，除非另一来源显示 agent 处于 active 状态 |
| state（agent_state, health） | 超过 2× heartbeat interval 未更新 → stale |
| cost/token | 交互结束后一段时间仍未更新 → degraded |
| PM2/health | 轮询失败一次 → stale，连续失败 → degraded/error |

各阈值均可在 config 中 per-metric override。

## 派生指标

由 TelemetryAdapter 从原始 OTel 数据计算，不直接来自某一个事件或 metric：

| 派生指标 | 公式 | 来源 |
|---------|------|------|
| cache_efficiency_pct | cacheRead / (cacheRead + input) × 100 | token.usage by type（multi-runtime） |
| cost_leverage | actual_api_cost / subscription_time_equivalent | cost.usage + active_time |
| usage_leverage | cli_time / user_time | active_time.total by type（Claude only） |
| tokens_per_turn | token.usage / turn_count | 聚合 |

## 依赖

- Adapter Layer（本模块消费 adapter 的 capabilities / resolve 接口）
- 前端（消费本模块的 resolver 输出结构和 availability 状态做展示决策）
