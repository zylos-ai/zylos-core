# 指标模型

## 模块职责

`src/lib/metric-resolver.js` 为已采集指标选择当前可用样本，并明确返回来源、时效、置信度、候选项和降级原因。它处理历史指标与聚合；当前 Agent 状态和当前会话用量另由 `CoreState` 直接读取 Core 权威状态。

## 固定来源链

Resolver 的来源优先级写在 `METRIC_CHAINS` 中，而不是由 adapter capability 动态发现。当前覆盖：

| 指标 | 主要来源链 |
|---|---|
| `context_pct` | statusline summary → JSONL usage → statusline → Codex rollout → token estimate |
| `session_cost` | statusline summary → statusline → JSONL usage → token price estimate |
| `daily_cost` | JSONL usage → statusline delta → token price estimate |
| `cache_hit_rate` | statusline summary → JSONL usage → current statusline usage → JSONL usage |
| `cpu_pct`、内存、磁盘 | system summary → system sample |
| `ttft`、`turn_duration` | Codex rollout |
| `tool_duration` | post-tool hook sample |

Rate limit 指标单独从 Core account usage 读取，并在 reset window 已过期时返回 unknown，避免把旧窗口的百分比继续显示为当前值。

## Runtime 过滤

- `statusline`、`statusline_delta`、`statusline_current_usage` 仅用于 Claude。
- `rollout` 仅用于 Codex。
- `system` 是 runtime-neutral 来源。
- 其他记录必须与当前 runtime 匹配，防止切换 runtime 后复用上一运行时的样本。

## 选择与 freshness

默认 freshness 阈值为 120 秒，可由 `metricStalenessSeconds` 配置覆盖。Resolver 按来源链顺序收集候选：

1. 选择第一个仍新鲜且值有效的来源。
2. 如果首选来源不可用或过期，选择后续新鲜来源，并写入 `fallback_reason`。
3. 如果所有候选都过期，返回链中第一个可用候选，同时明确标记样本年龄和 “All sources stale”。
4. 没有候选或指标未知时返回 `value: null`，不伪造默认值。

典型输出：

```json
{
  "value": 42,
  "selected_source": "jsonl_usage",
  "freshness": 8,
  "confidence": "actual",
  "alternatives": [],
  "fallback_reason": "statusline data stale or unavailable, using jsonl_usage"
}
```

`alternatives` 保留已找到候选的 value、age、freshness 和 confidence，供诊断与 UI 解释来源选择。

## 聚合

`resolveAggregated()` 对成本和 cache hit rate 返回：

- 当前 session；
- 当前自然日（按 `TZ` 计算日界线）；
- 最近七个自然日。

底层聚合由 store 完成。API 的时间序列端点还可按时间范围和 bucket 查询 token、cost 与 cache 数据。

## 与当前状态的边界

以下数据不应从历史指标链反推：

- Agent 当前状态、当前活跃工具和会话身份；
- 当前会话 context observation；
- Core 账号的 5-hour / 7-day usage window。

这些数据由 `CoreState` 和 Core session reader 提供。把两条路径分开，可以避免历史样本在会话切换、runtime 切换或 identity 变化后冒充实时状态。
