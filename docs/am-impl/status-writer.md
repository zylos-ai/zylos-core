# StatusWriter

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：tick 末尾汇总当前 ActivityState、HealthState 及各组件状态，写入对外状态文件。

**输入**：snapshot、HealthEngine 当前状态

**输出**：`agent-status.json`（Operator 和 MessageRouter 消费）

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。StatusWriter 同时写入两层状态。
- **D-10**：Health 状态持久化到 agent-status.json，AM 冷启动时恢复。

## 2. 组件设计

### 接口定义

```javascript
class StatusWriter {
  write(snapshot: Snapshot, healthEngine: HealthEngine, extra: StatusExtra): void
}
```

```javascript
interface StatusExtra {
  state: 'idle' | 'busy' | 'offline' | 'stopped',
  activeTools: number,
  idleSeconds: number,
  inactiveSeconds: number,
  source: string,
  toolPipeline?: ToolPipelineState,    // watchdog/foreground 相关字段
  notRunningSeconds?: number,
  since?: number,
  message?: string,
}
```

### ActivityState 投射规则（顶层设计 §3.5）

无状态投射，相同 snapshot 必须得到相同结果：

```
if (activeTools > 0)                    → busy
else if (inactiveSeconds < IDLE_THRESHOLD)  → busy
else                                        → idle
```

活动时间来源（优先级）：
1. Conversation file mtime（Claude only）
2. tmux window activity
3. 当前时间（default fallback）
4. API hook timestamp（如果 active=true 且更新）

### 与其他组件的交互

- **HealthEngine** → 读取 `health` 状态
- **ToolPipeline** → 读取活跃工具数、foreground identity、watchdog 状态
- **Monitor Orchestrator** → 在 tick 编排末尾被调用
- **SignalStore** → 通过 snapshot 获取各 signal file 数据

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| IDLE_THRESHOLD | 3s | 空闲判定阈值 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

从 `activity-monitor.js` 的 tick 末尾写入 agent-status.json 的逻辑提取。

### 实施步骤

1. 创建 `scripts/status-writer.js`
2. 提取 agent-status.json 的构建和写入逻辑
3. ActivityState 投射为纯函数，无副作用
4. 确保 agent-status.json 的完整 schema（见 [signal-store.md](signal-store.md)）不遗漏字段
