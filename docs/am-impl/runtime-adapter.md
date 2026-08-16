# Runtime Adapter

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：DI 层，封装 Claude / Codex runtime 差异，向其他组件提供统一的 runtime 操作接口。业务组件不做 runtime 分支判断，所有差异通过 Adapter 注入。

**输入**：runtime config（runtime 类型、路径、参数）

**输出**：launch/stop/probe/catalog/tool rules（统一接口，屏蔽 runtime 实现差异）

**相关决策**：
- **D-5**：业务模块不做 runtime 分支判断，所有 Claude / Codex 差异通过 Adapter DI 注入。顶层设计列 6 类（标识/进程管理/健康检查/API error catalog/运行时差异/消息写入），实施细化为 8 类——「API error catalog」演化为 `checkTmuxPane()` 模式匹配（归入健康探测）；新增上下文监控、活动时间、指令文件三类（从现有代码提取的 runtime 差异点）。
- **D-38**：Claude / Codex 差异只进入 Adapter，不进入 HealthEngine / Guardian 分支逻辑。

## 2. 组件设计

### 功能清单

Adapter 提供 8 类能力（D-5 的 6 类细化扩展），每类封装了 Claude 和 Codex 的差异实现：

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **标识** | `runtimeId` | 机器可读标识（`'claude'` / `'codex'`） |
| | `sessionName` | tmux session 名称（`'claude-main'` / `'codex-main'`） |
| | `displayName` | 人类可读名称（`'Claude Code'` / `'Codex'`） |
| **进程管理** | `launch()` | 构建指令文件 → 预处理认证/信任 → 在 tmux session 中启动 runtime |
| | `stop()` | kill tmux session（同步，不可 await） |
| | `isRunning()` | 检查 tmux session 存在 + runtime 进程存活（PID + 进程名/子进程） |
| | `clearStaleState()` | 拉起前清除上一 session 的残留文件（heartbeat-pending.json、context temp files 等），路径因 runtime 不同 |
| | `enqueueStartupPrompt()` | 注入启动提示。Claude: 检测 SessionStart hook → 有则 noop、无则 C4 control fallback；Codex: 自带 bootstrap prompt，noop |
| **认证** | `checkAuth()` | 端到端认证验证（Claude: `claude -p ping`；Codex: token 验证） |
| **健康探测** | `checkTmuxPane()` | 扫描 tmux pane 字符模式，返回 `{ rateLimit, authFailed, stickyError, pattern }` |
| **上下文监控** | `getContextMonitor()` | Claude: 返回 null（由 statusLine hook 处理）；Codex: 返回 polling-based 监控器 |
| **活动时间** | `getConversationMtime()` | 返回 conversation file 的 mtime（Claude: conversation file；Codex: null），StatusWriter 用于活动时间来源优先级链（D-5/D-38） |
| **消息注入** | `sendMessage(text)` | 通过 tmux buffer paste 向 runtime 注入文本（处理特殊字符） |

### Launch 流程（以 Claude 为例）

```
launch()
  │
  ├─ 1. buildInstructionFile()
  │     构建 CLAUDE.md（合并 ZYLOS.md + claude-addon.md）
  │
  ├─ 2. 预处理认证环境
  │     ├─ 检测认证方式：credentials.json? claude.ai login? .env API key?
  │     ├─ 原生认证 → 剥离 .env token 避免冲突
  │     └─ API key 认证 → 预批准 key 跳过交互确认
  │
  ├─ 3. 预接受交互对话框
  │     ├─ onboarding（hasCompletedOnboarding）
  │     ├─ workspace trust（hasTrustDialogAccepted）
  │     └─ dangerous mode permission（skipDangerousModePermissionPrompt）
  │
  ├─ 4. 构建 shell 命令
  │     ├─ 剥离 CLAUDECODE / CLAUDE_CODE_ENTRYPOINT 环境变量
  │     ├─ API key 通过临时文件注入（不暴露在 ps/cmdline）
  │     └─ 附加 exit code 日志记录
  │
  └─ 5. 启动 tmux session
        ├─ session 已存在 → sendMessage(cmd)
        └─ session 不存在 → tmux new-session -d
```

### 组件交互图

```
┌──────────────────────────────────────────────────────────────┐
│                     AM Process 容器                          │
│                                                              │
│  ┌──────────────────────┐                                    │
│  │   Monitor            │  init(): 创建 adapter 实例         │
│  │   Orchestrator       │──────────────────┐                 │
│  └──────────────────────┘                  │                 │
│                                            ▼                 │
│                              ┌──────────────────────┐        │
│  ┌───────────┐  launch()     │                      │        │
│  │ Guardian   │─────────────▶│   Runtime Adapter     │        │
│  │           │  isRunning()  │                      │        │
│  │           │─────────────▶│   ┌────────────────┐  │        │
│  │           │  clearStale() │   │ ClaudeAdapter  │  │        │
│  │           │─────────────▶│   │ or             │  │        │
│  └───────────┘               │   │ CodexAdapter   │  │        │
│                              │   └────────────────┘  │        │
│  ┌───────────┐  checkAuth()  │                      │        │
│  │ Health    │─────────────▶│    tmux session       │        │
│  │ Engine    │  getHB Deps() │    ┌──────────────┐  │        │
│  │           │─────────────▶│    │ runtime 进程   │  │        │
│  └───────────┘               │    └──────────────┘  │        │
│                              │                      │        │
│  ┌───────────┐  sendMessage()│                      │        │
│  │ Tool      │─────────────▶│                      │        │
│  │ Watchdog  │  (中断按键)    │                      │        │
│  └───────────┘               └──────────────────────┘        │
│                                                              │
│  ┌───────────┐                                               │
│  │ Proc      │  adapter.sessionName                          │
│  │ Sampler   │  (读取 tmux PID 做冻结检测)                     │
│  └───────────┘                                               │
│                                                              │
│  ┌───────────┐  adapter.runtimeId                            │
│  │ Tool      │  (加载对应 runtime 的工具规则)                   │
│  │ Pipeline  │                                               │
│  └───────────┘                                               │
└──────────────────────────────────────────────────────────────┘
```

### 接口定义

```javascript
interface RuntimeAdapter {
  // 标识
  readonly runtimeId: 'claude' | 'codex'
  readonly sessionName: string          // tmux session name, e.g. 'claude-main'
  readonly displayName: string

  // 进程管理
  launch(opts?: { bypassPermissions?: boolean }): Promise<void>
  stop(): void                          // kill tmux session（同步）
  isRunning(): Promise<boolean>
  clearStaleState(): void               // 清除上一 session 残留文件
  enqueueStartupPrompt(): void          // 注入启动提示（runtime 差异内部封装）

  // 认证
  checkAuth(): Promise<{ ok: boolean, reason?: string, output?: string }>

  // 健康探测（runtime-specific，注入到 HealthEngineDeps）
  checkTmuxPane(): { rateLimit: boolean, authFailed: boolean, stickyError: boolean, pattern?: string }

  // 上下文监控
  getContextMonitor(): ContextMonitor | null

  // 消息注入
  sendMessage(text: string): Promise<void>

  // 活动时间
  getConversationMtime(): number | null   // conversation file mtime，Codex 返回 null

  // 指令文件
  buildInstructionFile(): Promise<string>
}
```

> **注意**：`enqueueHeartbeat()` / `getHeartbeatStatus()` 是 C4 Control 的能力（共享基础设施，与 runtime 无关），不属于 RuntimeAdapter 接口。由 Orchestrator 在组装 HealthEngineDeps 时直接注入。见 [health-engine.md](health-engine.md) 的 deps 接口定义。

### Claude vs Codex 差异对照

| 能力 | Claude | Codex |
|------|--------|-------|
| sessionName | `'claude-main'` | `'codex-main'` |
| launch | `claude --dangerously-skip-permissions` | `codex --full-auto` |
| checkAuth | `claude -p ping --max-turns 1`（30s timeout） | token 文件验证 |
| clearStaleState | 删除 `heartbeat-pending.json` + `/tmp/context-*` | 删除 `codex-heartbeat-pending.json` + 对应 temp files |
| enqueueStartupPrompt | 检测 SessionStart hook → 有则 noop，无则 C4 control fallback | noop（Codex bootstrap prompt 自带） |
| getConversationMtime | 读取 conversation file mtime（epoch ms） | `null`（无 conversation file） |
| checkTmuxPane | 扫描 Claude tmux pane 字符模式 | 扫描 Codex tmux pane 字符模式 |
| getContextMonitor | `null`（由 statusLine hook 处理） | `CodexContextMonitor`（polling） |
| sendMessage | tmux buffer paste（临时文件 → load-buffer → paste-buffer → Enter） | tmux buffer paste（同机制） |
| buildInstructionFile | 生成 `CLAUDE.md` | 生成 `AGENTS.md` |
| 认证方式 | credentials.json / claude.ai login / .env API key | .env API key / device auth |
| 预处理 | 预接受 onboarding + trust + dangerous mode；API key 预批准 | 预接受 trust |

### 与其他组件的交互

| 消费方 | 调用的方法 | 用途 |
|-------|-----------|------|
| **Monitor Orchestrator** | `getActiveAdapter()` | init 时创建 adapter 实例，注入给其他组件 |
| **Guardian** | `launch()`, `isRunning()`, `clearStaleState()`, `enqueueStartupPrompt()`, `sessionName` | 进程存活守护：检测退出 → 清理 → 拉起 → 启动提示 |
| **HealthEngine** | `checkAuth()`, `checkTmuxPane()`, `stop()` | 认证验证 + tmux 扫描 + kill session（注入到 HealthEngineDeps） |
| **ToolWatchdog** | `sendMessage()` | 发送中断按键（Escape）终止超时工具 |
| **ProcSampler** | `sessionName`（属性读取） | 获取 tmux PID 做冻结检测 |
| **ToolPipeline** | `runtimeId`（属性读取） | 加载对应 runtime 的工具规则 |
| **StatusWriter** | `runtimeId`, `displayName`, `getConversationMtime()` | 写入 agent-status.json + 活动时间来源 |

## 3. 实施方案

**改动类型**：提取 + 新增方法（`clearStaleState()`, `enqueueStartupPrompt()`）

### 现有代码位置

| 文件 | 内容 |
|------|------|
| `cli/lib/runtime/base.js` | 抽象基类 RuntimeAdapter（129行） |
| `cli/lib/runtime/claude.js` | ClaudeAdapter 完整实现（441行） |
| `cli/lib/runtime/codex.js` | CodexAdapter 完整实现 |
| `cli/lib/runtime/index.js` | Registry + `getActiveAdapter()` |
| `cli/lib/runtime/instruction-builder.js` | 指令文件构建 |
| `cli/lib/runtime/claude-context-monitor.js` | Claude 上下文监控（statusLine hook 模式） |
| `cli/lib/runtime/codex-context-monitor.js` | Codex 上下文监控（polling 模式） |
| `cli/lib/runtime/session-handoff.js` | 会话交接 |

### 实施步骤

1. **Adapter 留在 `cli/lib/runtime/`**，不做物理迁移。现有 base.js / claude.js / codex.js / index.js 结构保持不变
2. **新增 `clearStaleState()`**：在 ClaudeAdapter / CodexAdapter 中各自新增方法，从 `activity-monitor.js:600-613`（直接删除 heartbeat-pending.json + context temp files）提取逻辑（文件路径因 runtime 不同）
3. **新增 `enqueueStartupPrompt()`**：在 ClaudeAdapter / CodexAdapter 中各自新增方法，从 `activity-monitor.js:486-521`（`hasStartupHook()` + `enqueueStartupControl()`）+ `activity-monitor.js:636-639`（runtimeId 分支判断）提取逻辑（D-5/D-38：消除 Guardian 中的 runtime 分支判断）
4. **新增 `checkTmuxPane()`**：在 ClaudeAdapter / CodexAdapter 中各自新增方法，封装 tmux pane 字符模式扫描（从 activity-monitor.js 现有的 detect 系列函数提取）
5. 主文件中散落的 `adapter.xxx` 调用保持不变，只是 adapter 实例的创建位置从 `init()` 移到 Monitor Orchestrator
6. `activity-monitor.js` 中残留的直接 runtime 分支判断（`adapter.runtimeId === 'claude'`）需要收拢到 adapter 方法中（D-5）
