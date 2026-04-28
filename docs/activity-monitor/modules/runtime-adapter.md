> ⚠️ **本文件 SUPERSEDED**（2026-04-28，R6 production rollback by ccb981c2）。
>
> v3 顶层方案 + 9 份模块实施档（含本文件）整套 SUPERSEDED——production trade-off 决策回退到 v2.1 baseline。详见 [`../../activity-monitor-refactor-proposal-v3.md`](../../activity-monitor-refactor-proposal-v3.md) 头部 R6 rollback reasoning。
>
> **当前 implementation baseline**: [`../../activity-monitor-refactor-proposal-v2.1.md`](../../activity-monitor-refactor-proposal-v2.1.md)
>
> 本文件保留作 R3+R4+R5 设计演进记录，**不要据此实施**。

---

# Runtime Adapter — 模块实施档

> 关联顶层方案：[v3 §三原则 5 / §四.4](../../activity-monitor-refactor-proposal-v3.md)
> 类型：DI（依赖注入）封装层——非 tick 模块，构造时注入业务模块

---

## 1. 模块职责与边界

### 职责

封装 Claude / Codex 等运行时的**所有差异**——业务模块（Guardian / HealthEngine / ToolWatchdog 等）通过 Adapter 接口与 runtime 解耦，不在代码里做 runtime 分支判断。

### 边界

**在 scope 内**：
- 进程管理（launch / stop / isRunning）
- 健康检查（checkAuth / heartbeat 协议）
- API error catalog（注入给 HealthEngine）
- 工具规则（注入给 ToolWatchdog）
- tmux 配置（target / session 名）
- 消息写入（sendMessage 直发到 tmux）
- runtime 差异（context monitor 路径、usage state 文件路径）

**不在 scope 内**：
- 业务逻辑（HealthEngine FSM / Guardian 退避 / 等）
- C4 内部 schema（c4-reliability-contract）

### 关键不变量

- **C-A-1**：业务模块**不写** `if (runtime === 'claude') ... else ...`——任何 runtime 差异由 Adapter 接口隐藏
- **C-A-2**：Adapter 接口稳定——加新 runtime（Bedrock / Vertex 等）只需新写一个 adapter，业务层零改动

---

## 2. 输入 / 输出契约

### 输入（构造时）

```js
new ClaudeAdapter(config)   // config 来自 ~/zylos/activity-monitor/config.json
new CodexAdapter(config)
```

### 输出（接口分类）

每个 adapter 实现这 6 类接口：

#### a. 标识

| 字段 | 类型 | 说明 |
|---|---|---|
| `runtimeId` | string | `'claude'` / `'codex'` |
| `heartbeatEnabled` | bool | 是否支持 heartbeat probe |
| `supportsHooks` | bool | 是否支持 hook 文件 |

#### b. 进程管理

| 方法 | 用途 |
|---|---|
| `launch()` | 启动 runtime 进程（在 tmux 里） |
| `stop()` | 停 runtime 进程 |
| `isRunning()` | 检查进程是否在运行 |
| `getProcessPid()` | 拿 PID（ProcSampler 用） |

#### c. 健康检查

| 方法 | 用途 |
|---|---|
| `checkAuth()` | 同步触发 auth-check（返 `{ok|failed}`） |
| `getHeartbeatDeps()` | 返 heartbeat-pending 文件名 / 协议（HealthEngine 注入） |

返回 `getHeartbeatDeps()` 内容示例：
```js
{
  pendingKey: 'heartbeat-pending.json',     // Claude
  // pendingKey: 'codex-heartbeat-pending.json',  // Codex
  ackTimeoutMs: 30000
}
```

#### d. API error catalog（核心）

| 方法 | 用途 |
|---|---|
| `getApiErrorPatterns()` | 返 catalog 数组 |

每 entry 含：

```js
{
  id: 'corrupted_context',
  pattern: /APIError: 400|invalid_request_error/,
  severity: 'sticky' | 'transient' | 'permanent',
  recoveryAction: 'restart_session' | 'probe_only'
                | 'mark_rate_limited' | 'mark_auth_failed' | 'notify_only',
  debounce: 2,
  scanInterval: 30,
  userMessage: '...'
}
```

**严格约束**：adapter 不得同时支持 `action` alias —— 避免旧草稿字段漂移。HealthEngine 加载时严格 schema 验证。

#### e. 运行时差异

| 方法 | 用途 |
|---|---|
| `getContextMonitor()` | 返 context-monitor.js 路径（hook） |
| `getUsageStateFile()` | 返 usage 监测的 statusline 文件路径 |
| `getToolRules()` | 返工具超时规则（ToolWatchdog 注入） |

#### f. 消息写入 + tmux

| 方法 | 用途 |
|---|---|
| `sendMessage(text, opts)` | 直发消息到 tmux session（绕 c4-dispatcher，仅 watchdog 中断 / 系统级用）|
| `getTmuxTarget()` | 返 tmux session:window:pane 标识 |
| `getSessionName()` | 返 tmux session 名 |

---

## 3. 数据结构 / 字段 / 状态机

Adapter 是无状态封装层——不持有自己的持久化 state。

### Claude adapter 关键差异点

- `heartbeatEnabled = true`（用 c4-control ack 端到端）
- `supportsHooks = true`（hook-activity / context-monitor / claude-pid 等）
- catalog 含 4 个初始 entry（corrupted_context / context_too_long / transient_overload / content_filter）
- launch 命令：`claude` CLI

### Codex adapter 关键差异点

- `heartbeatEnabled = false`（不支持 control queue ack）
- `supportsHooks = false`（不支持 hook 系统）
- catalog 待 codex-specific patterns 实证（启动初期可能用相对宽松的 unknown fallback）
- launch 命令：`codex` CLI

---

## 4. 关键接口与调用关系

### 构造 + 注入

```js
// monitor.js 启动时
const adapter = createAdapter(runtimeId)  // 'claude' or 'codex'

const guardian = new Guardian({adapter, signalStore})
const engine = new HealthEngine({
  adapter,
  catalog: adapter.getApiErrorPatterns(),
  heartbeat: adapter.getHeartbeatDeps(),
})
const watchdog = new ToolWatchdog({
  adapter,
  toolRules: adapter.getToolRules()
})
// ...
```

业务模块通过 adapter 间接调用 runtime——不直 import runtime-specific 实现。

### 调用频率

- `launch()`：罕见（restart 时）
- `stop()`：罕见（catalog `restart_session` 路径）
- `isRunning()`：每 tick 一次（Guardian）
- `getApiErrorPatterns()`：启动一次（HealthEngine 缓存）
- `sendMessage()`：罕见（仅 ToolWatchdog 中断 / hook 转发）
- `checkAuth()`：罕见（AuthFailed 冷却到期 / 用户消息触发）

### Adapter swap（未来扩展）

加新 runtime 例如 Bedrock：
1. 新写 `adapters/bedrock.js`，实现 6 类接口
2. `monitor.js` 启动时 `runtimeId = 'bedrock'` → `createAdapter` 返 BedrockAdapter
3. 业务层零代码改动——所有 catalog / heartbeat / 工具规则差异都封装在 adapter

---

## 5. 错误处理与恢复逻辑

### Adapter 加载失败

- `createAdapter('unknown_id')` → throw "unsupported runtime"
- monitor.js 启动 abort，log error

### catalog 加载失败 / schema 错

- `getApiErrorPatterns()` 抛错或返回非数组 → HealthEngine fallback 到内置最小 catalog（仅 corrupted_context + transient_overload）
- log warning，不 abort

### `launch()` 失败

- 命令不存在 / 权限 / tmux 错误 → 抛错给 Guardian
- Guardian 视为"进程仍不在运行"，下次 tick 重试（同时退避计数累积）

### `sendMessage()` 失败

- tmux session 不存在 → 抛错给调用方
- ToolWatchdog 收到错误 → log + 标 'Intervention_failed' + 仍调 `triggerRecovery()` 让 HealthEngine 决策

---

## 6. 迁移策略

### Phase 0+1+2 落地

Adapter 抽象本身贯穿 Phase 0-2：
- **Phase 0**：tool-rules.js 改为 Adapter DI 覆盖（PR #500 既有规则注入到 adapter）
- **Phase 1**：context-monitor 路径 / usage state file 等通过 adapter 注入
- **Phase 2**：catalog + heartbeat + auth-check 接口完整化

### 兼容性

- 老 monitor.js 直 import runtime-specific 文件 → 新 adapter 接口让业务模块不直 import
- 渐进迁移——一次拆一个接口，feature flag 控制启用

### 加新 runtime 流程

1. `adapters/<new>.js` 实现 6 类接口
2. `createAdapter` 工厂注册
3. config.json 加 `runtime: '<new>'` 选项
4. 写 catalog（基于实证）
5. 启用——业务层零改动

---

## 7. 测试策略 + 验收标准

| 测试 | 描述 |
|---|---|
| Claude adapter 6 类接口完整 | 每个接口都返合理值 |
| Codex adapter 6 类接口完整 | 同上，差异点（无 hook / 无 heartbeat）正确 |
| Mock adapter 单元测试 | 业务模块用 mock adapter 完全隔离测试 |
| catalog schema 验证 | adapter 返错配 catalog → HealthEngine 拒绝加载 |
| `getApiErrorPatterns` 不允许 `action` alias | 加 alias → schema 验证拒绝 |

### 验收标准

- ✅ 业务模块**完全不导入** runtime-specific 文件——`grep -r "claude\\|codex"` 在业务模块代码中 0 命中
- ✅ Mock adapter 可以让 Guardian / HealthEngine 等单元测试独立跑（不依赖真实 runtime）
- ✅ 加新 runtime 的工作量评估：单一 adapter 文件（< 300 行）+ catalog 编辑

---

## 8. 与其他模块的依赖关系

### 上游

- 无（adapter 是 DI 封装层，不依赖 AM 业务模块）

### 下游

- [`guardian.md`](guardian.md)：launch / isRunning / checkAuth
- [`health-engine.md`](health-engine.md)：getApiErrorPatterns / getHeartbeatDeps / stop
- [`tool-pipeline-watchdog-procsampler.md`](tool-pipeline-watchdog-procsampler.md)：getToolRules / sendMessage / getProcessPid
- [`task-scheduler.md`](task-scheduler.md)：getContextMonitor / getUsageStateFile（间接通过任务实现）

---

*v3 R3 review (2026-04-28) 整理：从 v2.1 §六 摘出 Adapter 章节独立成档；保留 6 类接口 + DI 模型 + Claude/Codex 差异 + 严格不允许 `action` alias 字段漂移。*