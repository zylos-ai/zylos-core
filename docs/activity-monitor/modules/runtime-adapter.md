# Runtime Adapter — 模块实施档

> 关联顶层方案：[v3 §三.3 / §四.1 / §六.A](../../activity-monitor-refactor-proposal-v3.md)
> 类型：DI（依赖注入）封装层——非 tick 模块，构造时注入业务模块
> Phase：1（基础设施）

---

## 1. 模块职责与边界

### 职责

封装运行时（Claude Code / Codex / 未来其他 LLM CLI）的差异，让 AM 业务模块（Guardian / HealthEngine / ToolWatchdog / MessageRouter / TaskScheduler）写得像跑在通用 runtime 上一样。

具体三件事：

1. **进程管理差异**：`launch` / `stop` / `isRunning` / `getProcessPid` 各 runtime 实现不同（CLI 命令 / 信号处理 / tmux 集成等）
2. **健康检查差异**：`checkAuth` 是否实时 probe / `getHeartbeatDeps` 用什么 pending 文件名等
3. **API error catalog**：每个 runtime 的错误模式 + 用户文案 + recoveryAction 映射（即 v3 §三.3 catalog-driven dispatch 数据源）

### 严格边界

- ❌ **不写状态文件**——SignalStore 是输入侧（只读），StatusWriter 是输出侧（写 agent-status.json）；Adapter 不直接写状态文件
- ❌ **不读 c4 DB**——Adapter 不参与 conversations 表逻辑；v3 §三.4 里 c4-receive 调 c4-send 投递 catalog.userMessage 是 c4-receive 的责任
- ❌ **不持有业务状态**——Adapter 是无状态封装；FSM / 退避计时 / event 队列由业务模块持有
- ❌ **不引入 reply correlation 接口**——v3 §六.G #2 ruled out R3+R4 reply command token-passing；Adapter `sendMessage` / catalog 接口不含 `replyTo` / `inboundId` 等任何"哪条消息回了"参数（不引入 R4 token-passing 残留）

### DI 模式

由 monitor.js 启动时根据 `ACTIVE_RUNTIME` 配置（`'claude'` / `'codex'`）选择具体 Adapter 实现，构造时注入到业务模块的 constructor。业务模块通过 `this.adapter.<method>` 调用，不知道也不需要知道具体 runtime。

测试时传 mock adapter 实现完全隔离的单元测试。

---

## 2. 输入 / 输出契约

### 输入：runtime-specific 配置

由 monitor.js 启动时读 config 注入。各 Adapter 实现知道如何解析自己 runtime 的 config 字段。

### 输出：6 类接口（业务模块通过 `this.adapter` 消费）

详见 §4 关键接口。

### 不变量

所有 Adapter 实现共享同一接口签名——业务模块换 Adapter 不改一行业务代码。新 runtime 加入只需新建 `scripts/adapters/<runtime>.js` 实现接口。

---

## 3. 数据结构 / 字段 / 状态机

### catalog entry schema（核心数据结构）

每个 catalog entry 描述一种 API error pattern + 处理路径。Adapter 通过 `getApiErrorPatterns()` 返回 entry 数组：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 唯一标识（如 `corrupted_context` / `transient_overload`）；落 `unavailable_reason` |
| `pattern` | RegExp / string | 错误文本匹配规则（Layer 2 tmux scan 命中条件）|
| `severity` | enum | `'sticky'` / `'transient'` / `'permanent'` |
| `recoveryAction` | enum | 5 种取值之一：`'restart_session'` / `'probe_only'` / `'mark_rate_limited'` / `'mark_auth_failed'` / `'notify_only'` |
| `debounce` | integer | 连续 N 次命中才动手（默认 1-2）|
| `scanInterval` | integer | 默认扫描间隔（秒）；可被加速（heartbeat pending 时）|
| `userMessage` | string | 用户文案——unhealthy 路径下 c4-receive 调 c4-send 投递的 catalog.userMessage 文本（详 v3 §六.H）|

**显式约束**：
- catalog entry 不含任何 reply correlation 字段（`replyTo` / `inboundId` 等）——v3 §六.G #2 ruled out
- 每个 entry 的 `userMessage` 是 generic（不含 user-specific 信息），适合所有 channel 的 user 看
- `recoveryAction` 只能取上述 5 种之一；不引入 `action` 旧别名（v2.1 §六 严格约束，避免字段漂移）

### 初始 catalog（PR #501 落地范围，Claude runtime）

| id | pattern 关键字 | severity | recoveryAction | userMessage |
|---|---|---|---|---|
| `corrupted_context` | `APIError: 400` / `invalid_request_error` / `422 bad request` | sticky | restart_session | "消息或附件触发 API 错误，请检查后重发" |
| `context_too_long` | `context_length_exceeded` / `prompt is too long` | sticky | restart_session | "对话历史超长——请精简后重发" |
| `transient_overload` | `overloaded_error` / `503 Service Unavailable` | transient | probe_only | "API 暂时繁忙，正在自动重试" |
| `content_filter` | `content_filter_violation` / `harmful` | permanent | notify_only | "请求内容被策略拦截，请调整后重试" |

Codex Adapter 提供自己的 entry 集合（错误模式 / 文案各不同）。

### 状态机

Adapter **无状态**——业务模块持有所有 FSM / 退避 / 队列。每次方法调用是独立的副作用 / 查询。

---

## 4. 关键接口与调用关系

### 6 类接口

#### (1) 标识

```
runtimeId        → 'claude' / 'codex' / ...
heartbeatEnabled → boolean (是否支持 Layer 3 heartbeat)
supportsHooks    → boolean (是否支持 Claude Code 风格的 hook 路径)
```

#### (2) 进程管理

```
launch(opts)         → spawn runtime 进程到 tmux，return 进程 pid
stop()               → 优雅退出 runtime 进程（用于 restart_session 触发）
isRunning()          → boolean，进程是否活
getProcessPid()      → number / null，当前进程 pid（Guardian / ProcSampler 用）
```

#### (3) 健康检查

```
checkAuth() → { ok: boolean, reason?: string, output?: string }
              live probe（CLI subprocess / HTTP），Guardian 拉起前调
              失败时业务侧设 health=auth_failed + 180s 冷却
              （注：Guardian 前置 checkAuth 是否保留 / 简化是 v3 review 期间
               讨论中的话题——见 v3 §六 / Lark 群讨论）

getHeartbeatDeps() → { pendingKey: string, ... }
                     返回 runtime-specific heartbeat-pending 文件名
                     HealthEngine Layer 3 用
```

#### (4) API error catalog

```
getApiErrorPatterns() → catalog entry 数组（详 §3 schema）
                        HealthEngine 启动时调一次注入；后续 tick 第 ⑥ 步
                        Layer 2 scan 用此 catalog 做 dispatch
```

**只支持 `recoveryAction` 字段**——不提供 `action` 旧别名（避免字段漂移；v2.1 §六 约束）。

#### (5) 运行时差异

```
getContextMonitor() → context-monitor hook 配置（Claude statusline / Codex 不同）
getUsageStateFile() → usage tier 计算时读哪个 statusline 数据文件
getToolRules()      → ToolWatchdog 工具分类规则（PR #500 内部规则按 runtime 注入）
```

#### (6) 消息写入

```
sendMessage(text, opts) → 把文本送进 tmux pane（Claude / Codex 输入键序列不同）
                          opts 含 keystrokeMode / pasteMode 选项
                          供 ToolWatchdog 中断 / Guardian 控制操作用
                          **不**含 replyToInboundId 等参数（不引入 R4 token-passing）
```

#### (7) tmux

```
getTmuxTarget()   → tmux session:window 标识
getSessionName()  → tmux session 名（PM2 配置外部见，业务模块通过 adapter 拿）
```

### DI 注入路径

```
monitor.js startup:
  ① 读 config 决定 ACTIVE_RUNTIME = 'claude' | 'codex'
  ② new ClaudeAdapter(config) 或 new CodexAdapter(config)
  ③ new Guardian({ adapter, signalStore, ... })
  ④ new HealthEngine({ adapter, signalStore, ... })
  ⑤ new ToolWatchdog({ adapter, ... })
  ⑥ new MessageRouter({ signalStore, ... })  ← 不直接持 adapter
  ⑦ new TaskScheduler({ ... })
```

### 加新 runtime 流程

新增 runtime（如 Gemini）只需 4 步：

1. 新建 `scripts/adapters/gemini.js` 实现 6 类接口
2. 设计 Gemini 自己的 catalog entries（`getApiErrorPatterns` 返回的数组）
3. 配置 `getContextMonitor` / `getUsageStateFile` / `getToolRules` 指向 Gemini-specific 路径
4. config 加 `ACTIVE_RUNTIME='gemini'` 选项

业务模块零改动。

---

## 5. 错误处理与恢复逻辑

### Adapter 自身错误

Adapter 方法内部错误（如 `launch()` spawn 失败 / `checkAuth()` CLI 子进程 timeout）由 Adapter 实现处理：

| 方法 | 错误处理 |
|---|---|
| `launch()` | 抛错 → Guardian 接 → 计入 restartDelay 退避 |
| `stop()` | 静默吞错（best-effort）；如果 process 已死，stop 视为成功 |
| `isRunning()` | 返回 false（不抛错）|
| `checkAuth()` | 返回 `{ok: false, reason: ...}`（不抛错）|
| `sendMessage()` | 抛错 → ToolWatchdog 接 → 干预失败 log |

### catalog mismatch

如果业务模块发现 `getApiErrorPatterns` 返回的 entry 缺字段或字段类型错：

- monitor.js 启动时校验 catalog schema，错则启动失败 + 报错文案明确
- 业务模块 runtime 不做 schema 防御（启动期已校验过）

### 接口契约违反

如果 Adapter 实现的方法签名跟业务模块期待的不一致（比如 `launch()` 不返回 pid）：

- 单元测试覆盖每个 Adapter × 业务模块的契约（mock adapter 实现都符合签名）
- 上线前 E2E（Claude × Codex 各跑一遍）保证 production 不会遇到契约违反

---

## 6. 迁移策略

### Phase 1：基础设施

1. 新建 `scripts/adapters/claude.js` + `scripts/adapters/codex.js`
2. 定义 6 类接口签名（共享 abstract 接口或 TypeScript-style JSDoc 约束）
3. 把 main 分支当前 `ClaudeAdapter` / `CodexAdapter` 内现有逻辑迁移到新 Adapter（`launch` / `stop` / `checkAuth` 等已有实现保留语义）
4. **新加 `getApiErrorPatterns` 实现**——Phase 2 catalog-driven dispatch 的数据源（main 分支当前没这个接口，是新加）

### Phase 2：catalog-driven dispatch 上线

HealthEngine 从 main 分支硬编码的 5 种 health action 切换到 catalog dispatch；catalog 数据来自 Adapter `getApiErrorPatterns`。

### Phase 5：legacy 清理

删除 main 分支当前 hardcoded API error pattern 路径（如 `pattern.test(text)` 散落硬编码处）。

### 兼容性

- main 分支的 ClaudeAdapter / CodexAdapter 接口签名保持向后兼容；新加 `getApiErrorPatterns` 是增量
- 跨 runtime 行为差异通过 Adapter 隔离——同一个 AM 部署支持 Claude → Codex 切换无缝（zylos `runtime` 命令已实现）

---

## 7. 测试策略 + 验收标准

### 单元测试（mock adapter 注入业务模块）

- mock ClaudeAdapter 实现 6 类接口；注入 Guardian → Guardian 行为符合预期
- mock CodexAdapter 实现 6 类接口；注入 HealthEngine → catalog 不同时 dispatch 路径正确
- catalog schema 校验：缺字段 / 字段类型错时启动失败，错误文案明确

### E2E 测试

- Claude × catalog 4 entry × 5 recoveryAction 全部命中正确
- Codex × catalog 自家 entry 命中正确
- 加新 runtime（mock GeminiAdapter）4 步流程跑通

### 验收标准

- 6 类接口签名跨 ClaudeAdapter / CodexAdapter 一致（接口测试 0 mismatch）
- catalog `getApiErrorPatterns` 返回 entry 都含 7 字段（id / pattern / severity / recoveryAction / debounce / scanInterval / userMessage）
- Adapter 不持有 mutable 状态（grep `this.<state>` 跨 launch 调用残留为 0）
- 不引入 reply correlation 接口（grep `replyTo` / `inboundId` / `replyToInboundId` 残留为 0）

---

## 8. 与其他模块的依赖关系

| 上游 | 来源 | 用途 |
|---|---|---|
| monitor.js（启动时）| config 配置 | 决定 ACTIVE_RUNTIME + 注入 Adapter 实例 |

| 下游 | 行为 |
|---|---|
| [`guardian.md`](guardian.md) | 调 `launch` / `stop` / `isRunning` / `getProcessPid` / `checkAuth` |
| [`health-engine.md`](health-engine.md) | 调 `getApiErrorPatterns`（catalog 数据）+ `checkAuth`（active probe）+ `getHeartbeatDeps`（Layer 3 文件名）|
| [`tool-pipeline-watchdog-procsampler.md`](tool-pipeline-watchdog-procsampler.md) | 调 `getToolRules`（工具分类）+ `sendMessage`（中断键序列）+ `getProcessPid`（ProcSampler 监测目标）|
| [`signal-store-and-status-writer.md`](signal-store-and-status-writer.md) | 调 `getContextMonitor` / `getUsageStateFile`（runtime-specific 文件路径）+ `runtimeId`（schema 元数据）|
| [`task-scheduler.md`](task-scheduler.md) | 间接（通过 SignalStore 拿 runtime-specific 路径），少量 task 直接调 `runtimeId` 区分行为 |

### 跨模块约束

- **catalog 数据源唯一性**：HealthEngine 的 catalog 必须从 Adapter `getApiErrorPatterns` 注入，**不在 HealthEngine 内硬编码**（v3 §三.3 设计原则——Adapter 是 catalog 数据源）
- **接口签名稳定性**：增加新接口时（如未来某 runtime 需要额外 hook）必须保持现有接口签名向后兼容，避免破坏其他 runtime 的 Adapter 实现
- **不持业务状态**：业务状态归业务模块；Adapter 是纯转换层
