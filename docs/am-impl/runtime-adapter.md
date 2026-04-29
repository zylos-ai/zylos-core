# Runtime Adapter

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：DI 层，封装 Claude / Codex runtime 差异，向其他组件提供统一的 runtime 操作接口。

**输入**：runtime config（runtime 类型、路径、参数）

**输出**：launch/stop/probe/catalog/tool rules（统一接口，屏蔽 runtime 实现差异）

**相关决策**：
- **D-5**：业务模块不做 runtime 分支判断，所有 Claude / Codex 差异通过 Adapter DI 注入。Adapter 接口包含 6 类：标识、进程管理、健康检查、API error catalog、运行时差异、消息写入/tmux。
- **D-38**：Claude / Codex 差异只进入 Adapter，不进入 HealthEngine / Guardian 分支逻辑。

## 2. 组件设计

### 接口定义

```javascript
interface RuntimeAdapter {
  // 标识
  readonly runtimeId: 'claude' | 'codex'
  readonly sessionName: string          // tmux session name, e.g. 'claude-main'
  readonly displayName: string

  // 进程管理
  launch(): Promise<void>
  stop(): void                          // kill tmux session
  isRunning(): Promise<boolean>

  // 健康检查
  checkAuth(): Promise<{ ok: boolean, reason?: string, output?: string }>
  getHeartbeatDeps(): HeartbeatDeps

  // 运行时差异
  getContextMonitor(): ContextMonitor | null   // Codex: polling-based; Claude: null (用 statusLine hook)
  sendMessage(message: string): void           // 写入 tmux pane
}
```

```javascript
interface HeartbeatDeps {
  enqueueHeartbeat(phase: string): boolean
  getHeartbeatStatus(controlId: number): string
  readHeartbeatPending(): { control_id: number, created_at: string, phase: string } | null
  clearHeartbeatPending(): void
  detectRateLimit(): { detected: boolean, cooldownUntil?: number, resetTime?: string }
  detectApiError(): { detected: boolean, pattern?: string }
}
```

### 与其他组件的交互

- **Guardian** → 调用 `launch()` / `stop()` / `isRunning()`
- **HealthEngine** → 调用 `checkAuth()` / `getHeartbeatDeps()`
- **ToolWatchdog** → 调用 `sendMessage()` 发送中断按键
- **Monitor Orchestrator** → `init()` 时创建 adapter 实例，注入给其他组件

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

`cli/lib/runtime/index.js` → `getActiveAdapter()` 返回 claude 或 codex adapter 实例。

### 实施步骤

1. 在 `scripts/adapters/` 下创建 `claude.js` 和 `codex.js`，封装 `cli/lib/runtime/` 中的差异逻辑
2. 现有 adapter 接口已满足顶层设计需求，不需要新增方法
3. 主文件中散落的 `adapter.xxx` 调用保持不变，只是 adapter 实例的创建位置从 `init()` 移到 Monitor Orchestrator
