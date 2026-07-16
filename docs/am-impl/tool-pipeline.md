# ToolPipeline

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：从 runtime 产生的工具事件流中合成 API 活动摘要，判断 runtime 是否有近期活动。

**输入**：`tool-events.jsonl`（runtime 写入的工具调用事件流）

**输出**：`api-activity.json`（最近活动时间、活跃工具列表，供 ToolWatchdog 消费）

**相关决策**：
- **D-22**：流式层有状态增量读取 tool-events.jsonl，维护 offset / inode / 轮转 drain。
- **D-23**：组件间通信通过 SignalStore 只读快照和显式接口调用。

## 2. 组件设计

### 功能清单

ToolPipeline 由三个子模块协作：

| 能力类别 | 功能 | 子模块 | 说明 |
|---------|------|--------|------|
| **事件排序** | reorder buffer | — | 2s 窗口内按 ts + _arrival_seq 排序，处理乱序事件 |
| **生命周期追踪** | pre_tool → 创建 episode | tool-lifecycle | 工具开始执行，加入 running_tools |
| | post_tool / post_tool_failure → 完成 episode | tool-lifecycle | 工具执行完成，从 running_tools 移除 |
| | prompt → 标记 in_prompt | tool-lifecycle | 用户输入回合开始 |
| | stop / idle → 清除所有 episode | tool-lifecycle | 会话结束/空闲，清理残留 |
| | pending completions | tool-lifecycle | 完成事件先于 pre_tool 到达时暂存，匹配后回填 |
| | pending clear hints | tool-lifecycle | stop/idle 先于 pre_tool 到达时暂存 |
| | 过期清理 | tool-lifecycle | pending 30s TTL，completed event_id 30s TTL |
| **前台身份** | SessionStart 信号 | — | foreground-session.json 提供早期 session_id |
| | statusLine 信号 | — | statusline.json 每 turn 更新 session_id |
| | launch guard | — | `observedAt >= runtimeLaunchAtMs - 5000ms` 防旧 session 身份 |
| | PID 存活验证 | — | PID 必须匹配 tmux 内 runtime 进程 |
| **活动摘要** | buildApiActivity() | — | 聚合 foreground session 的活跃工具、最老工具、watchdog 候选 |
| | hookFresh 判断 | — | api_activity.updated_at < 60s 才算新鲜（防 stale hook） |
| **状态持久化** | session-tool-state.json | — | 写入所有 session 的工具快照（供调试） |
| | api-activity.json | — | 写入活动摘要（供 ToolWatchdog + StatusWriter 消费） |
| **文件轮转** | tool-events.jsonl 轮转 | tool-event-stream | > 1MB 时 rename → .old，新建空文件 |
| **Session 清理** | pruneToolLifecycleState() | tool-lifecycle | 非活跃 session TTL 1h + PID 不存活 → 移除 |

### Tick 内部流程

```
tick(snapshot)
  │
  ├─ 1. 从 snapshot 获取新 tool events
  │
  ├─ 2. 排序（ts + _arrival_seq），flush reorder buffer（2s 窗口）
  │
  ├─ 3. applyOrderedToolEvents() → 更新 lifecycle state
  │     ├─ prompt: 标记 session.in_prompt = true
  │     ├─ pre_tool: 创建 running tool episode
  │     ├─ post_tool: 完成 episode（success）
  │     ├─ post_tool_failure: 完成 episode（failure）
  │     ├─ stop/idle: 清除 session 所有 running tools
  │     └─ purgeExpiredPending(): 清理过期 pending
  │
  ├─ 4. resolveTrustedForegroundIdentity()
  │     ├─ 来源 1: foreground-session.json（SessionStart hook）
  │     ├─ 来源 2: statusline.json（context-monitor hook）
  │     ├─ launch guard: observedAt >= runtimeLaunchAtMs - 5s
  │     └─ PID 验证: tmux pane PID 匹配
  │
  ├─ 5. buildApiActivity() → 生成活动摘要
  │     ├─ 确定 foreground session 的 running_tools
  │     ├─ oldest_active_tool: 最老的活跃工具
  │     ├─ watchdog_candidate_tool: 有 watchdog rule 的最老工具
  │     └─ active_tools / in_prompt / active 标志
  │
  ├─ 6. pruneToolLifecycleState() → 清理过期 session（TTL 1h）
  │
  ├─ 7. 写 session-tool-state.json + api-activity.json
  │
  └─ 8. maybeRotateToolEventStream() → > 1MB 时轮转
```

### api-activity.json Schema

```javascript
{
  version: 3,
  pid: number,
  sessionId: string | null,
  scope: 'foreground' | null,
  foreground_identity: {
    session_id: string | null,
    source: string | null,
    trusted: boolean,
    observed_at: number,
  },
  event: string | null,
  tool: string | null,
  active: boolean,
  active_tools: number,
  in_prompt: boolean,
  updated_at: number,                    // ms
  oldest_active_tool: ToolSnapshot | null,
  watchdog_candidate_tool: ToolSnapshot | null,
  last_completed_tool: object | null,
}
```

### 接口定义

```javascript
class ToolPipeline {
  constructor(adapter: RuntimeAdapter, signalStore: SignalStore)
  tick(snapshot: Snapshot): void        // 处理新事件，更新 lifecycle state
  getApiActivity(): ApiActivity         // 当前 API 活动摘要
  getActiveTools(): number              // 当前活跃工具数
  getForegroundIdentity(): ForegroundIdentity  // 当前可信前台身份
}
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **SignalStore** | 消费 | `snapshot.toolEvents` | 新增工具事件 |
| **SignalStore** | 消费 | `snapshot.foregroundSession` | 前台会话身份（SessionStart） |
| **SignalStore** | 消费 | `snapshot.statusline` | 前台会话身份（statusLine） |
| **ToolWatchdog** | 提供 | `apiActivity.watchdog_candidate_tool` | 候选超时工具 |
| **StatusWriter** | 提供 | `getActiveTools()`, foreground identity | 写入 agent-status.json |
| **ProcSampler** | 间接 | `activeTools > 0 && hookFresh` → `isActive` | 冻结检测的活跃判断依据 |
| **Adapter** | 读取 | `runtimeId` | 加载对应 runtime 的工具规则 |
| **Monitor Orchestrator** | 读取 | tmux claude PID | 前台身份 PID 验证 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| REORDER_WINDOW_MS | 2000ms | 事件排序缓冲窗口 |
| TOOL_SESSION_TTL_MS | 3600000ms | 非活跃 session 过期时间 |
| TOOL_EVENT_ROTATION_BYTES | 1048576 | 事件文件轮转阈值（1MB） |
| TOOL_EVENT_ROTATION_DRAIN_MS | 2000ms | 旧文件 drain 静默窗口 |
| STATUSLINE_LAUNCH_GUARD_MS | 5000ms | 启动后信任保护期 |
| PENDING_EVENT_TTL_MS | 30000ms | pending completion/hint 过期 |
| COMPLETION_MATCH_WINDOW_MS | 5000ms | pending 匹配时间窗口 |
| COMPLETED_EVENT_TTL_MS | 30000ms | completed event_id 过期 |
| HOOK_FRESH_THRESHOLD | 60s | api-activity 新鲜度判断 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `tool-lifecycle.js`（442行） | 完整 lifecycle 状态机：`applyOrderedToolEvents()`, `pruneToolLifecycleState()`, `getSessionSnapshot()` |
| `tool-event-stream.js`（241行） | 流式层：`readToolEventsIncrementalFromStream()`, `rotateToolEventStream()` |
| `tool-rules.js`（99行） | 工具规则定义：`getToolRules()` |
| `activity-monitor.js:1978-1995` | monitorLoop running 分支：processToolLifecycle + buildApiActivity + writeSnapshots |
| `activity-monitor.js` 多处 | `resolveTrustedForegroundIdentity()`, `buildApiActivity()`, 全局状态变量 |

### 实施步骤

1. 创建 `scripts/tool-pipeline.js`，作为 lifecycle + event-stream + foreground identity 的编排层
2. 直接复用 `tool-lifecycle.js` 和 `tool-event-stream.js`（不修改）
3. 从 `activity-monitor.js` 提取 `resolveTrustedForegroundIdentity()`、`buildApiActivity()`
4. 将全局状态（`toolLifecycleState`、reorder buffer、foreground identity cache）移入 ToolPipeline 实例
5. api-activity.json 和 session-tool-state.json 的写入移入 ToolPipeline
