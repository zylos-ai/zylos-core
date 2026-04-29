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

### 接口定义

```javascript
class ToolPipeline {
  tick(snapshot: Snapshot): void   // 处理新事件，更新 lifecycle state，写 api-activity.json
  getApiActivity(): ApiActivity    // 当前 API 活动摘要
  getActiveTools(): number         // 当前活跃工具数
  getForegroundIdentity(): ForegroundIdentity  // 当前可信前台身份
}
```

### Tick 内部流程

1. 从 snapshot 获取新 tool events
2. 排序（ts + arrival_seq），flush reorder buffer（2s 窗口）
3. 调用 `applyOrderedToolEvents()` 更新 lifecycle state
4. `resolveTrustedForegroundIdentity()` 合成可信前台身份
5. `buildApiActivity()` 生成活动摘要
6. `pruneToolLifecycleState()` 清理过期 session（TTL 1h）
7. 检查是否需要轮转 tool-events.jsonl（> 1MB）

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

### Foreground Identity 信任规则

两个来源：
1. **SessionStart hook**（foreground-session.json）：早期信号
2. **statusLine hook**（statusline.json）：每 turn 更新

信任条件：
- `observedAt >= runtimeLaunchAtMs - 5000ms`（launch guard）
- PID 存活且匹配 tmux PID

### 与其他组件的交互

- **SignalStore** → 从 snapshot 获取新 tool events 和 foreground-session / statusline 数据
- **ToolWatchdog** → 消费 `api-activity.json` 中的 watchdog 候选工具
- **StatusWriter** → 读取 `getActiveTools()` 和 foreground identity

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| REORDER_WINDOW_MS | 2000ms | 事件排序缓冲窗口 |
| TOOL_SESSION_TTL_MS | 3600000ms | 非活跃 session 过期时间 |
| TOOL_EVENT_ROTATION_BYTES | 1048576 | 事件文件轮转阈值（1MB）|
| TOOL_EVENT_ROTATION_DRAIN_MS | 2000ms | 旧文件 drain 静默窗口 |
| STATUSLINE_LAUNCH_GUARD_MS | 5000ms | 启动后信任保护期 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

逻辑散落在 `activity-monitor.js` 的 running 分支中，部分已独立到 `tool-lifecycle.js`、`tool-event-stream.js`。

### 实施步骤

1. 创建 `scripts/tool-pipeline.js`
2. 将 running 分支中的工具事件处理、lifecycle state 管理、foreground identity 逻辑收拢
3. 复用现有 `tool-lifecycle.js` 和 `tool-event-stream.js` 模块
4. api-activity.json 的写入逻辑移入 ToolPipeline
