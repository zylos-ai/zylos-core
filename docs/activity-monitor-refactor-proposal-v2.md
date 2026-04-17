# Activity Monitor 重构方案 v2

> 基于 PR #501（v1）+ 2026-04-17 深度评审意见完善
> 代码基准：main 分支 commit a738d0a（PR #500 已合并，activity-monitor.js 当前 2323 LoC）
> 主要修正方向：补全 PR #500 watchdog 子系统的架构归属、解决 MessageRouter 的进程模型前提、修正信号源与接口描述的若干准确性问题
> 日期：2026-04-17

---

## 一、v1 到 v2 的变更摘要

v1（PR #501）的架构方向正确——双层正交状态 + 单一 tick 编排 + Adapter 依赖注入——这套核心思想在 v2 中完全保留。v2 改动的是**与现状对齐的部分**：

| 分类 | v1 的问题 | v2 的修正 |
|------|-----------|----------|
| **架构盲区** | 完全未纳入 PR #500 的 watchdog/tool-lifecycle 子系统（828 LoC） | 新增第四条主循环步骤 `toolTracker.tick()`，watchdog 独立为一等公民模块 |
| **进程模型** | MessageRouter 依赖持久进程内存，但 c4-receive 是 per-message 命令行进程 | c4-receive 改造为 socket 客户端，MessageRouter 由 monitor.js 进程长期持有 |
| **信号源** | SignalStore 只列了 6 个文件；`hook-activity.js` 写文件描述错 | 完整列出 11 个信号源，澄清 `tool-events.jsonl`（hook 写）与 `api-activity.json`（monitor 合成写）的关系 |
| **Grace 合并** | 把 `startupGrace`（30s）和 `LAUNCH_GRACE_PERIOD`（180s）合并为单值 | 两者作用域不同，保留为两个独立参数，只做 per-runtime 配置化 |
| **正交耦合** | 声称"两层完全正交" | 承认并显式规范了三处合法耦合点，其他接口保持正交 |
| **退避机制数量** | 称"4 套" | 实际是 5 个退避机制 + 1 个重置阈值（v1 漏了 `BACKOFF_RESET_THRESHOLD`），在统一表里列齐 |
| **Unavailable 语义** | `recovering + down` 合并后未保留 `notifyUserMessage` 的行为差异 | Unavailable 内部显式区分 `first-stage`/`degraded`，保留用户消息加速的差异处理 |
| **状态持久化** | 未说明 `unavailable` 状态在 PM2 重启时如何恢复 `recoveringSince` | 规范持久化 schema，增加 `recoveringSince` 字段 |
| **迁移顺序** | Phase 2（提取组件）与 Phase 3（重写主文件）会产生新旧混合的中间态 | Phase 2+3 合并为"抽取-重写"一体化阶段，避免混合期 |
| **回滚方案** | Phase 5 直接删除旧代码 | 保留 `activity-monitor.legacy.js` 备份，PM2 通过启动参数切换 |
| **下游更新** | 未标注 c4-receive 的 `health === 'down'` 分支需改 | 明确列入 Phase 5 的下游适配清单 |
| **Hook 清单** | 漏列 `session-foreground.js` | 补全 Hook 清单（含 PR #500 新增 hook） |
| **Codex 差异** | adapter 接口缺少 `getContextMonitor`、`runtimeId` 等 | adapter 接口补齐 4 个缺失字段 |

其余章节与 v1 方向一致，下面按完整文档形式重写。

**v2 review 后的进一步修订（2026-04-17 下午，与 zylos303 独立收敛一致）**：
- §3.3.1 新增：Guardian / HealthEngine 按 owner 划分字段，"谁写归谁"原则，持久化拆成 `guardian-state.json` + `health-state.json`
- §3.4：`agent-status.json` 在 `health: unavailable` 基础上**必须**加 `health_substate: recovering | degraded`，否则下游无法区分"暂时恢复中"和"需要人工介入"
- §4.5：`health-state.json` schema 移除 `auth_retry_suppressed_until`（归 Guardian），字段名对齐代码（`restart_failure_count`）
- §5：MessageRouter socket 失败时**不做** direct-to-tmux，走 C4 主链降级；新增"C4 主链原则"
- §5.2：Hook 契约分"Signal Hooks（write-only）"和"Control Hooks（c4-control enqueue）"两类；`hook-auth-prompt.js` / `session-start-prompt.js` 显式归为 Control Hook
- §6.2：c4-receive 下游改为基于 `health_substate` 保留 HEALTH_DOWN 与 HEALTH_RECOVERING 的文案差异

---

## 二、重构动机

### 2.1 Howard 的双层状态构想（继承自 v1）

- **Activity State（进程层）**：Idle / Busy / Offline / Stopped — 进程是否在运行
- **Health State（功能层）**：OK / Unavailable / RateLimited / AuthFailed — 功能是否可用

核心行为规则：
1. **Offline/Stopped → 无条件拉起进程**，不受健康状态阻塞（RateLimited 除外，见 §3.3）
2. **健康状态只影响用户消息处理路径**（前提：Activity ∈ {Idle, Busy}）
3. **OK 状态下的监控走零 token 通道**（ProcSampler + tmux 扫描），不侵入 AI 主会话
4. **定时任务统一调度**，新增任务不改主循环

### 2.2 现状痛点（基于 2026-04-17 快照）

| # | 问题 | 影响 | 量化依据 |
|---|------|------|---------|
| 1 | **2323 行 God Object** | 单文件同时承担 Guardian、健康检查、watchdog 协调、信号聚合、状态写出、定时任务 | `activity-monitor.js` 实测 2323 行（PR #500 后较 v1 提案的 1658 行 +40%） |
| 2 | **HeartbeatEngine 5 个健康值中 recovering/down 是同一恢复流的两个阶段** | 状态机对外暴露实现细节，消费端需区分 | `heartbeat-engine.js:1–84, :178–191` |
| 3 | **Guardian 与 HeartbeatEngine 紧耦合** | 共享 `consecutiveRestarts`、`startupGrace`、`authRetrySuppressedUntil`，难以独立测试 | `activity-monitor.js:232, :333, :585–605` |
| 4 | **5 个退避机制 + 1 个重置阈值各自为政** | Guardian restart / HeartbeatEngine recovery / auth suppression / user message cooldown / + Guardian backoff reset threshold | 见 §4.5 |
| 5 | **Watchdog 子系统游离于主架构** | 828 LoC（tool-lifecycle + tool-event-stream + tool-watchdog + session-foreground + claude-pid）在主循环中深度集成但无清晰边界 | PR #500 新增 |
| 6 | **定时任务 ad-hoc** | DailySchedule × 3、时间戳对比 × 若干、条件门控 × 若干，没有统一调度器 | `activity-monitor.js` 主循环内散落 |
| 7 | **信号消费散落** | Hook 输出文件（`api-activity.json`、`statusline.json`、`tool-events.jsonl` 等）的读取和 freshness check 在主循环各处 | 主循环 250+ 行的 I/O 分布 |

---

## 三、状态模型

### 3.1 双层状态（大多正交，三处合法耦合）

```
┌─────────────────────────────────────────────────────┐
│  Activity State（进程层，由进程检测驱动）              │
│                                                      │
│  Offline → Stopped → Idle ⇄ Busy                    │
│    ↑           ↑        ↑        ↑                   │
│    └───────────┴────────┴────────┘                   │
│     进程退出 / tmux 销毁 / 冻结 kill                  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Health State（功能层，由健康检查驱动）               │
│                                                      │
│  OK ⇄ Unavailable ⇄ RateLimited                     │
│         ↑              ↑                             │
│         └────── AuthFailed ──────┘                   │
│                                                      │
│  Unavailable 内部有两个阶段：                         │
│    first-stage（前 60min，密集退避）                  │
│    degraded（60min 后，固定 3600s 间隔）              │
└─────────────────────────────────────────────────────┘
```

### 3.2 ActivityState 定义

| 状态 | 条件 | 说明 |
|------|------|------|
| **Offline** | tmux session 不存在 | 需要拉起 |
| **Stopped** | tmux 存在，agent 进程未运行 | 需要拉起 |
| **Idle** | agent 运行，`active_tools == 0` 且空闲 ≥ 3s | 可接收消息和控制命令 |
| **Busy** | agent 运行，`active_tools > 0` 或最近有活动 | 正在处理任务 |

### 3.3 HealthState 定义

| 状态 | 触发条件 | 恢复路径 |
|------|----------|----------|
| **OK** | 健康检查通过 | — |
| **Unavailable** | 健康检查失败，未识别为特定原因 | 见 §3.4 内部分阶段退避 |
| **RateLimited** | 检测到限流文本 + 行为信号 | 冷却期到期后转 Unavailable，走恢复流程 |
| **AuthFailed** | 认证探测失败 | 180s 冷却后重试 auth-check |

**"Guardian 是否可拉起进程"的完整规则（对应原 `restartBlocked`）**：

```
canRestart = (health !== 'rate_limited')
           && (Date.now() >= authRetrySuppressedUntil)
           && (guardian.notRunningCount >= guardian.restartDelay)
```

v1 把三者笼统归为 `restartBlocked` 布尔值；v2 明确这是 **Guardian 内部复合判断**，其中：
- 第一项来自 HealthEngine（`engine.restartBlocked`，只暴露 rate_limited）
- 第二项和第三项由 Guardian 自己管理（`authRetrySuppression`、`restartDelay`）

这样 HealthEngine 接口保持干净，Guardian 承担复合决策。

#### 3.3.1 模块 ownership 划分（v2 review 后明确）

按"谁写归谁"原则划分状态所有权。跨模块允许**读**但必须通过接口（不直接访问成员字段），避免双写源；一个字段不能同时被两个模块声明为 owner。

| 模块 | 内存字段 | 持久化文件 |
|------|---------|----------|
| **Guardian** | `notRunningCount` / `consecutiveRestarts` / `restartDelay` / `authRetrySuppressedUntil` / `lastStableAt` | `guardian-state.json` |
| **HealthEngine** | `health` / `unavailableSubstate` / `recoveringSince` / `restartFailureCount` / `cooldownUntil` | `health-state.json` |

**合法的跨模块读（§3.2 三处耦合的具体化）**：

| 场景 | 读方 | 写方 | 通过接口 |
|------|------|------|----------|
| Guardian 重启决策用指数退避延迟 | Guardian | HealthEngine | `engine.getBackoffDelay()` |
| Guardian 把 auth 失败通知给 health | HealthEngine | Guardian | `engine.setAuthFailed(reason)` |
| Watchdog 触发健康恢复 | HealthEngine | ToolWatchdog | `engine.triggerRecovery()` |

这三处耦合在 v1/v2 都客观存在，不是 leak——v2 的做法是让它们通过**具名方法**（如 `setAuthFailed` 而非通用 `setHealth`）可见，不假装 "两层完全正交"。

**guardian-state.json** schema：

```json
{
  "schema_version": 2,
  "not_running_count": 0,
  "consecutive_restarts": 0,
  "auth_retry_suppressed_until": 0,
  "last_stable_at": 1729200000000
}
```

PM2 重启时 Guardian 和 HealthEngine 各自从自己的 state file 恢复，不互相依赖对方的文件。

### 3.4 Unavailable 内部的两阶段退避

v1 的问题：`recovering` 和 `down` 合并为 `Unavailable` 后，`notifyUserMessage()` 的加速行为差异会丢失。v2 解决方案：**Unavailable 内部分为两个子阶段，但对外只暴露 `"unavailable"`**。

```javascript
class HealthEngine {
  // Unavailable 内部状态
  #unavailableSubstate = null;       // 'first-stage' | 'degraded'
  #recoveringSince = null;           // 进入 Unavailable 的 wall-clock 时间
  #restartFailureCount = 0;          // 连续失败次数（名字对齐 heartbeat-engine.js:65）

  notifyUserMessage() {
    if (this.#unavailableSubstate === 'first-stage') {
      // 立即重试 + 重置失败计数（等同 v1 的 recovering 行为）
      this.#restartFailureCount = 0;
      this.triggerCheck({ immediate: true });
    } else if (this.#unavailableSubstate === 'degraded') {
      // 立即重试但保留失败计数（等同 v1 的 down 行为，维持退避记忆）
      this.triggerCheck({ immediate: true });
    }
  }

  _promoteToDegraded() {
    if (Date.now() - this.#recoveringSince >= DEGRADE_THRESHOLD) {
      this.#unavailableSubstate = 'degraded';
    }
  }
}
```

**对外 agent-status.json（v2 review 后修正）**：主状态仍然统一成 `"health": "unavailable"`，但**必须**同时暴露一个可消费的子状态字段，否则下游无法区分"暂时恢复中"和"已退化到需要人工介入"两种语义：

```json
{
  "health": "unavailable",
  "health_substate": "recovering" | "degraded"
}
```

下游消费规则（c4-receive.js 新版分支，替代当前 `:224-233` 的 `health === 'down'` 判断）：

```javascript
if (status.health === 'unavailable' && status.health_substate === 'degraded') {
  // 等同当前 HEALTH_DOWN 文案："offline and unable to recover on my own. Please let the admin know"
} else if (status.health === 'unavailable') {  // substate === 'recovering'
  // 等同当前 HEALTH_RECOVERING 文案："temporarily unavailable... try again in a moment"
}
```

这样既统一了主状态机（从 5 种 health 收敛成 4 种），又不丢失 v1 对用户的文案区分。UI / web-console 可选择只读 `health`（合并显示）或同时读 `health_substate`（区分显示）。

### 3.5 进程拉起后的初始健康状态与 Grace 参数

Guardian 拉起进程后：
- HealthState 进入 **Unavailable + first-stage**
- 同时两个 Grace 计时器启动（**v2 明确：这是两个参数，不合并**）：
  - `startupGrace`（Guardian 层，默认 30s）：Guardian 的"本地锁"，防止在 tmux session 还未建立时就触发第二次 `startAgent()`
  - `launchGracePeriod`（HealthEngine 层，默认 180s）：抑制 HealthEngine 的主动探测，避免新 session 初始化期间误判
- Grace 结束后 HealthEngine 发第一次健康检查

两个参数**作用域不同**：
- `startupGrace` 影响"Guardian 什么时候允许判断 stopped"
- `launchGracePeriod` 影响"HealthEngine 什么时候开始主动探测"

强行合并会导致 Guardian 等 180s 才敢判断进程不存在——实际 30s 已足够且必要。v2 将两者暴露为 per-runtime 配置项（Claude 可调 60s/120s，Codex 保持 30s/180s）。

---

## 四、组件架构

### 4.1 模块总览（v2 新增 toolTracker + messageRouterHost）

```
skills/activity-monitor/scripts/
├── monitor.js                    # 入口 + 主循环编排层（同时是 MessageRouter 的宿主进程）
├── guardian.js                   # 进程存活守护
├── health-engine.js              # 健康状态机（替代 heartbeat-engine.js）
├── tool-tracker.js               # ⬅ v2 新增：统一 tool-lifecycle + tool-event-stream
├── tool-watchdog.js              # 继承自 PR #500，对接 tool-tracker 的 snapshot
├── message-router.js             # 用户消息路由（事件驱动，运行于 monitor.js 进程内）
├── message-router-socket.js      # ⬅ v2 新增：Unix domain socket，供 c4-receive 调用
├── signal-store.js               # 信号聚合读取
├── status-writer.js              # agent-status.json 写入
├── task-scheduler.js             # 统一定时任务调度器
├── proc-sampler.js               # 进程冻结检测
├── hook-activity.js              # Hook 脚本（路径不变）
├── hook-auth-prompt.js           # Hook 脚本（PermissionRequest event）
├── context-monitor.js            # Hook 脚本（statusLine event）
├── session-start-prompt.js       # Hook 脚本（SessionStart event）
├── session-foreground.js         # Hook 脚本（SessionStart，PR #500 新增）
├── claude-pid.js                 # 辅助：Claude PID 解析
├── tool-rules.js                 # Watchdog 规则配置
├── health-checks/                # 健康检查策略（不变）
│   ├── heartbeat-check.js
│   ├── rate-limit-check.js
│   ├── auth-check.js
│   └── api-error-check.js
├── tasks/                        # 注册式定时任务
│   ├── daily-upgrade.js
│   ├── daily-memory-commit.js
│   ├── upgrade-check.js
│   ├── health-check.js
│   ├── usage-monitor.js
│   └── context-check.js
└── adapters/                     # 运行时适配器（依赖注入）
    ├── claude.js
    └── codex.js
```

### 4.2 主循环（monitor.js，7 步 tick）

```
每秒 tick:
1. signalStore.refresh()          ← 读取所有信号文件，生成 immutable snapshot
2. guardian.tick(signals)          ← 进程存活守护 + restart 决策
3. procSampler.tick(signals)       ← 冻结检测
4. toolTracker.tick(signals)       ← ⬅ v2 新增：更新 tool lifecycle，生成 apiActivity
5. healthEngine.tick(signals)      ← 健康状态机 + 主动探测（读 apiActivity）
6. toolWatchdog.tick(signals, toolTracker) ← ⬅ v2 新增：工具超时检测（依赖 toolTracker）
7. taskScheduler.tick(signals)     ← 定时任务调度
8. statusWriter.write(signals)     ← 写 agent-status.json
```

v1 的 6 步没有为 watchdog/tool-lifecycle 留位置。v2 明确它们是**一等公民**，在 HealthEngine 之后、TaskScheduler 之前执行：
- toolTracker 必须在 HealthEngine 之前：HealthEngine 需要读 `apiActivity` 判断是否有活动
- toolWatchdog 必须在 HealthEngine 之后：watchdog 超时后会调用 `engine.triggerRecovery()`

### 4.3 SignalStore（完整信号文件清单）

v1 漏列了 5 个信号源。v2 的完整清单：

| 信号源 | 类型 | 写入方 | 读取方 |
|--------|------|--------|--------|
| `tool-events.jsonl` | 追加流（1MB 旋转） | **hook-activity.js** | toolTracker |
| `api-activity.json` | 状态快照 | **monitor.js（由 toolTracker 合成）** | HealthEngine, UI |
| `statusline.json` | 状态快照 | context-monitor.js（Claude hook） | TaskScheduler（context-check） |
| `heartbeat-pending.json` | 状态快照 | HealthEngine（pending 写入）, Guardian（restart 时 clear） | HealthEngine |
| `user-message-signal.json` | 状态快照 | c4-receive.js | HealthEngine（用于加速 Unavailable 探测） |
| `proc-state.json` | 状态快照 | ProcSampler | Guardian, HealthEngine |
| `tool-event-stream-state.json` | 游标 | toolTracker | toolTracker（自身恢复） |
| `session-tool-state.json` | 状态快照 | toolTracker | toolWatchdog |
| `tool-watchdog-state.json` | 状态快照 | toolWatchdog | toolWatchdog（重启恢复） |
| `foreground-session.json` | 状态快照 | session-foreground.js（hook） | toolWatchdog |
| `agent-status.json` | 状态快照 | statusWriter | c4-receive, c4-dispatcher, web-console |

**重要澄清**：v1 注释里说"hook-activity.js 写 api-activity.json"是错的。真实关系是：

```
hook-activity.js (hook)  ──写──>  tool-events.jsonl (原始事件流)
                                         │
                                         ▼
                         toolTracker.tick()  ──合成──>  api-activity.json
```

`api-activity.json` 是**合成产物**，不是 hook 直接产出。SignalStore 读取 `api-activity.json` 时需要意识到它是 toolTracker 上一个 tick 的输出——存在 1-tick 延迟，但这在秒级循环中可接受。

**深冻结约定**：v1 用 `Object.freeze` 只能浅冻结顶层。v2 规定：SignalStore 产出的 snapshot 各组件**只读**，如需改值应写回到自己管理的文件，下一 tick 再读。不做运行时深冻结（成本高），只在开发/测试模式用深冻结断言。

### 4.4 Guardian（进程守护）

```javascript
class Guardian {
  constructor(adapter, healthEngine, taskScheduler) { ... }

  tick(signals) {
    const { tmuxState } = signals;
    if (tmuxState.exists === false || tmuxState.agentRunning === false) {
      if (this.#canRestart()) {
        this.startAgent();
      }
    }
  }

  #canRestart() {
    if (this.healthEngine.restartBlocked) return false;          // rate_limited
    if (Date.now() < this.authRetrySuppressedUntil) return false; // auth cooldown
    if (this.notRunningCount < this.restartDelay) return false;   // restart backoff
    if (this.taskScheduler.isMaintenanceRunning()) return false;  // maintenance lock
    return true;
  }

  async startAgent() {
    // 维护等待（异步状态机，不阻塞 tick）
    if (this.#maintenanceWaitStartedAt && Date.now() - this.#maintenanceWaitStartedAt > 300_000) {
      // 超过 300s 放弃等待，继续 launch
    }
    if (this.taskScheduler.isMaintenanceRunning()) {
      this.#maintenanceWaitStartedAt ??= Date.now();
      return;  // 下一 tick 再试
    }
    this.#maintenanceWaitStartedAt = null;

    await this.adapter.launch();
    this.healthEngine.onProcessRestarted();  // 进入 Unavailable + first-stage + grace
  }
}
```

v2 明确承认的耦合：Guardian 在 auth-check 失败的特定场景下会调 `engine.setAuthFailed()`（v1 隐式存在但未说明），这是**合法耦合**——Guardian 是唯一能观察到 launch 失败的入口，只有它知道何时进入 AuthFailed。这种耦合通过方法名（`setAuthFailed`，而不是泛用 `setHealth`）明确约束范围。

### 4.5 HealthEngine（健康状态机）

v2 相对 v1 的主要变化：
- Unavailable 内部分 `first-stage`/`degraded` 子状态（见 §3.4）
- 明确持久化 schema，包含 `recoveringSince`

**持久化格式**（写到独立文件 `health-state.json`，独立于 `agent-status.json`）：

```json
{
  "schema_version": 2,
  "health": "unavailable",
  "unavailable_substate": "first-stage",
  "recovering_since": 1729200000000,
  "restart_failure_count": 3,
  "last_check_at": 1729200120000,
  "rate_limited_until": null
}
```

> **v2 review 后调整**：`auth_retry_suppressed_until` 不再出现在这里——它归 Guardian 所有，持久化到 `guardian-state.json`（见 §3.3.1）。字段名 `restart_failure_count` 对齐 `heartbeat-engine.js:65` 的代码名。

PM2 重启时 HealthEngine 从 `health-state.json` 读、Guardian 从 `guardian-state.json` 读，两者不交叉引用对方的文件。

**5 个退避机制 + 1 个重置阈值（v2 统一表）**：

| # | 机制 | 归属 | 参数 | 说明 |
|---|------|------|------|------|
| 1 | Guardian restart backoff | Guardian | `5s → 10s → 20s → 40s → 60s cap` | 进程重启指数退避 |
| R | Guardian backoff reset | Guardian | 连续稳定 60s 后 restart counter 归零 | 配套重置阈值（不是独立的退避机制，而是对 #1 的重置条件），v1 遗漏项 |
| 2 | HealthEngine recovery（Unavailable first-stage） | HealthEngine | `60s → 300s → 1500s → 3600s cap` | 内部探测间隔 |
| 3 | HealthEngine recovery（Unavailable degraded） | HealthEngine | 固定 3600s 间隔 | 60min 后降级 |
| 4 | Auth retry suppression | Guardian | 固定 180s | AuthFailed 后的 restart 抑制 |
| 5 | User message cooldown | HealthEngine | 60s | 防止用户消息触发重复探测 |

### 4.6 ToolTracker（v2 新增模块）

合并 `tool-lifecycle.js`（442 LoC）+ `tool-event-stream.js`（241 LoC）为一个抽象模块。职责：
- 读 `tool-events.jsonl` 的增量事件（维护 `tool-event-stream-state.json` 游标）
- 维护多 session 的工具生命周期状态（写 `session-tool-state.json`）
- 合成 `api-activity.json`（读取方有 HealthEngine 和 UI）

对外接口：

```javascript
class ToolTracker {
  tick(signals)                          // 读 events、更新状态、写 api-activity.json
  getActiveTools(sessionId)              // 供 ToolWatchdog 使用
  getForegroundApiActivity()             // 供 HealthEngine 使用
}
```

### 4.7 ToolWatchdog（PR #500 模块，适配新架构）

v1 完全没有位置。v2 将其作为一等公民：

```javascript
class ToolWatchdog {
  tick(signals, toolTracker) {
    const foregroundSession = signals.foregroundSession;
    if (!foregroundSession) return;

    const activeTools = toolTracker.getActiveTools(foregroundSession.sessionId);
    for (const tool of activeTools) {
      if (this.#isTimedOut(tool)) {
        this.#sendInterrupt(tool);
        this.#recordTimeout(tool);
        // 超时触发 HealthEngine 降级（合法耦合）
        this.healthEngine.onToolTimeout(tool);
      }
    }
    // 写 tool-watchdog-state.json
  }
}
```

**合法耦合点 3**：ToolWatchdog → HealthEngine。watchdog 检测到工具超时时可触发 HealthEngine 进入 Unavailable。这是**产品级合法耦合**——工具卡死就是功能不可用，健康状态应该反映。v1 声称的"两层完全正交"过于理想化。

### 4.8 MessageRouter 与进程模型（最关键的 v2 修正）

v1 的 MessageRouter 依赖持久进程内存（`#pendingCheck`），但 c4-receive 是 per-message 的命令行进程——这个前提在 v1 中未说明，无法落地。

**v2 方案**：MessageRouter 运行在 `monitor.js` 进程内（已经是 PM2 长驻进程），通过 Unix domain socket 对外提供 API。c4-receive 作为 socket 客户端。

```
┌──────────────────────────────────────────────────┐
│  monitor.js (PM2 service, long-lived)            │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │  Main tick loop (guardian/health/...)     │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │  MessageRouter                            │    │
│  │  - #pendingCheck (in-memory)              │    │
│  │  - #waitingMessages (in-memory)           │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │  Unix domain socket listener              │    │
│  │  /run/zylos/activity-monitor.sock         │    │
│  └────────────────┬─────────────────────────┘    │
└───────────────────┼──────────────────────────────┘
                    │ IPC (fast, no auth needed — local socket)
                    │
                    ▼
      c4-receive.js (per-message CLI process)
        - 连接 socket
        - 发 "ROUTE <message-payload>"
        - 等待 "DELIVERED" 或 "STATUS <state>"
        - 退出
```

Socket 协议简单（5 个命令：`ROUTE` / `QUERY_HEALTH` / `ACK_HEARTBEAT` / `FORCE_CHECK` / `PING`）。

**socket 失败的降级路径（v2 review 后修正）**：c4-receive **不做** direct-to-tmux 投递——那条路径会绕开 C4 的 DB audit、priority ordering、`require_idle` 门控、`agentState.health === 'ok'` 门控（`c4-dispatcher.js:572-660`），违反 comm-bridge 的核心约束。

> **C4 主链原则**：任何外部进入的消息都必须走 `c4-receive → DB → c4-dispatcher → tmux` 主链，**不允许绕开 DB 或 dispatcher 直接投递**（这是 `comm-bridge/SKILL.md:14` "ALL communication with Claude goes through C4" 的落地）。

v2 的降级策略：socket 不可用时 c4-receive 仍然把消息**入 C4 队列**（`c4-receive` 的当前 persistPending 逻辑不变），但**跳过** MessageRouter 的主动探测+聚合，由 c4-dispatcher 按现有 health gating 策略决定何时投递。c4-receive 只多做一件事：在回给用户的 error 消息里标注"router 暂时不可用，消息已入队"。socket 恢复后 dispatcher 按正常流程继续，消息不丢、顺序不乱、审计不失。

**并发聚合在进程内实现**：由于所有消息经过同一个 monitor.js 进程，`#pendingCheck` 和 `#waitingMessages` 是进程内变量，v1 的 happy path 设计成立。另外 v2 显式处理 Caller C 进入空窗期的竞态：

```javascript
async handle(message) {
  this.#waitingMessages.push(message);

  if (this.#pendingCheck) {
    // 已有检查在进行，等待同一结果
    await this.#pendingCheck;
    return;  // 消息已由 splice 路径处理
  }

  // 自己触发检查
  const myCheck = this.runRecoveryCheck().catch(err => ({ recovered: false, error: err }));
  this.#pendingCheck = myCheck;

  const result = await myCheck;

  // 原子窗口：splice 之后才赋 null
  const messages = this.#waitingMessages.splice(0);
  this.#pendingCheck = null;

  for (const msg of messages) {
    result.recovered ? this.deliver(msg) : this.replyWithStatus(msg, result);
  }
}
```

关键修正：**splice 之前不能清空 `#pendingCheck`**——v1 的示例代码把 `this.#pendingCheck = null` 放在 splice 之前，会让 Caller C 误以为无检查进行中而发起第二次检查。

### 4.9 TaskScheduler（v2 补充 3 个能力）

v1 的接口基本可用，v2 补充当前代码确实需要的 3 个能力：

1. **异步维护等待**：`isMaintenanceRunning()` 不再是同步 pgrep 阻塞调用，改为任务自己在 execute 中更新 `this.#maintenanceActive = true/false`，Guardian 读这个标志。
2. **Fire-and-forget 任务**：`execute` 支持返回 `'detached'` 字符串标记（如 upgrade-check 的 detached spawn），TaskScheduler 不 await 其完成，但记录 lastRun。
3. **daily task 的首次启动跳过**：任务注册时可声明 `skipOnStart: true`，避免服务启动时立即执行 daily 任务（需要正确迁移 DailySchedule 的"已保存日期"持久化逻辑）。

**不引入 cron 解析器**（继承 v1 建议）：`dailyHour` + `intervalSeconds` 两种模式覆盖当前所有任务（daily-upgrade 固定小时、memory-commit 固定小时、health-check 24h 间隔、usage-monitor 秒级间隔、context-check 秒级间隔）。引入 cron 增加一个依赖，当前没必要。

### 4.10 Adapter 接口（v2 补齐字段）

```javascript
class RuntimeAdapter {
  // 标识
  get runtimeId()            // 'claude' | 'codex'（v2 新增）
  get heartbeatEnabled()     // Codex 默认 false
  get supportsHooks()        // Claude true, Codex false（v2 新增）

  // 进程管理
  launch()
  stop()
  isRunning()
  getProcessPid()

  // 健康检查
  checkAuth()

  // 运行时特定（v2 新增）
  getContextMonitor()        // 仅 Codex 实现：上下文轮询器
  getUsageStateFile()        // 解决 USAGE_CODEX_STATE_FILE vs USAGE_STATE_FILE 差异
  getToolRules()             // 返回 runtime-specific tool rules

  // tmux
  getTmuxTarget()
  getSessionName()
}
```

v1 漏了 `runtimeId` / `supportsHooks` / `getContextMonitor` / `getUsageStateFile`，导致 adapter 抽象不完整。v2 补齐这 4 个字段，其中 `supportsHooks` 用于让 SignalStore 在 Codex 下正确跳过 hook-only 的信号源（如 `tool-events.jsonl`——Codex 下不存在）。

---

## 五、Hook 兼容策略（v2 补全 Hook 清单）

### 5.1 完整 Hook 清单（`templates/.claude/settings.json` 实测）

| Hook Event | Matcher | 脚本 | 备注 |
|-----------|---------|------|------|
| SessionStart | startup | session-foreground.js + session-start-prompt.js | **v1 漏 session-foreground** |
| SessionStart | clear | 同上 | |
| SessionStart | compact | 同上 | |
| UserPromptSubmit | — | hook-activity.js | |
| PreToolUse | — | hook-activity.js | |
| PostToolUse | — | hook-activity.js | |
| PostToolUseFailure | — | hook-activity.js | |
| PermissionRequest | — | hook-auth-prompt.js | **v1 描述不准（不是通用 hook）** |
| Stop | — | hook-activity.js | |
| Notification | idle_prompt | hook-activity.js | |
| statusLine | — | context-monitor.js | |

所有 hook 脚本路径不变，用户 `~/.claude/settings.json` 无需修改。

### 5.2 Hook 的两类契约（v2 review 后修正）

v1 / v2 早期描述 "Hook 只写文件，不调用主进程" 是**字面错误**——现有 main 分支的 hook 至少分两类，按当前代码实测：

**类别 A · Signal Hooks（write-only，给 SignalStore 消费）**

| Hook | 写入 | 消费方 |
|------|------|--------|
| `hook-activity.js` | `tool-events.jsonl`、`api-activity.json`（合成） | HealthEngine / ToolTracker |
| `context-monitor.js`（statusLine） | `statusline.json` | ContextMonitor |
| `session-foreground.js`（SessionStart × 3 matcher） | `foreground-session.json` | SessionForeground |
| `claude-pid.js`（若启用） | `claude-pid.json` | Guardian |

这类 hook 只做**文件写入**，由主进程通过 SignalStore 读取。契约：不直接调用主进程、不入 C4 队列。

**类别 B · Control Hooks（直接入 C4 control plane）**

| Hook | 调用 | 实测 |
|------|------|------|
| `hook-auth-prompt.js`（PermissionRequest matcher） | `execFileSync c4-control enqueue [KEYSTROKE]Enter --bypass-state` | 代码在 `:66-79`，用于自动确认权限弹窗 |
| `session-start-prompt.js`（SessionStart matcher） | `execFileSync c4-control enqueue --content <startup-prompt>` | 代码在 `:73-79`，用于向新会话注入启动提示 |

这类 hook 通过 `c4-control.js` 向 C4 控制队列入队操作建议，仍然经过 C4 主链（**不违反 §5 的 C4 主链原则**）——DB audit / priority / require_idle 照走，只是入口是 hook 而不是外部消息。

**为什么必须区分两类**：如果 SignalStore 设计前提写成"所有 hook 走文件"，后续实现会漏掉 auth prompt / session start 这两条控制面链路，造成权限弹窗自动确认失效、新会话启动提示注入失效。

**落地要求**：v2 的 Hook 清单（§5.1）要给每个 hook 标注类别（A / B）；SignalStore 设计明确只消费 A 类的文件输出。

---

## 六、agent-status.json Schema 变更

### 6.1 v1 → v2 字段对比

| 字段 | 旧（当前） | 新 |
|------|-----------|-----|
| `state` | offline/stopped/busy/idle | 不变 |
| `health` | ok/recovering/down/rate_limited/auth_failed | **ok/unavailable/rate_limited/auth_failed** |
| `health_substate`（v2 review 后新增） | （无） | **recovering / degraded**（仅 `health === 'unavailable'` 时出现） |
| `schema_version` | （无） | **2** |

### 6.2 下游改动清单（v2 明确标注）

| 消费者 | 改动 | 归属 Phase |
|--------|------|----------|
| `c4-receive.js:224-233`（`health === 'down'` 分支） | 新逻辑读 `health_substate`：`degraded` 走 HEALTH_DOWN 文案；其他 `unavailable` 走 HEALTH_RECOVERING 文案（见 §3.4 代码示例） | Phase 5 |
| `c4-dispatcher.js:584`（`health !== 'ok'`） | 无需改动（所有 unavailable 都 defer 投递，不关心 substate） | — |
| `web-console/scripts/server.js` | 可选改动（若 UI 要区分显示 recovering vs degraded） | Phase 5（可选） |
| UI health 显示 | 默认合并显示为 "unavailable"；高级视图可读 `health_substate` 区分 | Phase 5（文案） |

**v2 明确假设**：activity-monitor 和 comm-bridge 同版发布（monorepo 单包），不存在单独升级某个组件的场景。如果未来拆包，需要引入 `schema_version` 检查兜底，这是拆包时的工作，不是本次重构范畴。

---

## 七、迁移计划（v2 合并原 Phase 2+3，补充回滚方案）

### Phase 1: 基础设施（独立可 ship）

1. 新建 `signal-store.js`、`status-writer.js`、`task-scheduler.js`、`tool-tracker.js`
2. DailySchedule 逻辑迁移到 TaskScheduler（保留旧实现至 Phase 5）
3. 新建 `tasks/` 目录，每个定时任务独立文件
4. `task-scheduler.test.js` 单元测试覆盖 >80%

**独立 ship 含义**：Phase 1 完成后，`activity-monitor.js` 可选择是否使用新模块，旧逻辑仍在。通过 feature flag `USE_NEW_SCHEDULER=1` 切换。

### Phase 2+3: 状态模型 + 组件拆分（合并为单阶段）

v1 将两者分两个阶段，会产生中间混合态——新 HealthEngine 调用方式需要在旧 activity-monitor.js 里串接，引入不必要的中间代码。v2 合并：

1. 同步新建 `guardian.js` + `health-engine.js` + 新 `monitor.js`
2. HealthEngine：合并 `recovering + down → unavailable`（内部保留 first-stage/degraded 差异）
3. Guardian：从 activity-monitor.js 提取 Guardian 逻辑，复合 `restartBlocked` 由 Guardian 自己组装
4. 新 `monitor.js` 实现 7 步 tick，成为新 PM2 入口候选
5. **关键**：保留 `activity-monitor.legacy.js`（即当前 `activity-monitor.js` 的完整拷贝）
6. PM2 配置通过 `PM2_APP_NAME` 或启动参数切换新旧入口
7. 测试：HealthEngine 状态转换（含 PM2 重启恢复）、Guardian 单元测试、新旧对照的集成测试

### Phase 4: 消息路由

1. 在 `monitor.js` 进程内实例化 MessageRouter，启动 Unix socket 监听
2. 修改 `c4-receive.js`：尝试连接 socket，失败则回退到直接 tmux 投递
3. 实现并发聚合（`#pendingCheck` + `#waitingMessages`），注意 splice 必须在 `pendingCheck = null` 之前
4. 修改 `c4-dispatcher.js` 适配新 health 值域
5. 测试：MessageRouter 并发测试（5 个并发消息同时触发一次检查）、socket 失败回退测试

### Phase 5: 收尾

1. 更新 `agent-status.json` schema（加 `schema_version: 2`）
2. 更新 `c4-receive.js` 的 `health === 'down'` → `'unavailable'`
3. 更新 SKILL.md 文档
4. 更新 web-console 状态显示文案
5. 观察 1 周稳定后，删除 `activity-monitor.legacy.js` 和 heartbeat-engine.js
6. 全量回归测试

### Phase 0（前置）：watchdog 子系统不动

PR #500 的 watchdog 子系统已在 main 上运行。Phase 1–5 期间 watchdog **保持不动**（保留 `tool-watchdog.js` / `tool-lifecycle.js` / `tool-event-stream.js` 文件不改），只在 Phase 2+3 的新 monitor.js 中通过 `tool-tracker.js` 包装其接口。

这样 watchdog 的线上稳定性不受重构影响，直到新架构全部稳定再考虑内部实现整合。

### 兼容性保证

- Hook 脚本路径完全不变 → 用户 settings.json 无需修改
- agent-status.json 增加 schema_version=2，字段向后兼容
- config.json 配置项保留 + 新增 per-runtime Grace 参数
- **回滚方案**：Phase 2+3 ship 后若发现问题，改 PM2 启动参数切换回 legacy 入口即可，无需代码回滚

---

## 八、测试策略（v2 补充）

| 测试类型 | 覆盖模块 | 当前资产 |
|----------|---------|---------|
| 单元测试（`node --test`） | Guardian, HealthEngine, TaskScheduler, MessageRouter, ToolTracker, ToolWatchdog | 延续现有 deps-injection mock 模式 |
| 状态转换测试 | HealthEngine 的 OK/Unavailable/RateLimited/AuthFailed 全覆盖 + PM2 重启恢复 | 新增 |
| 并发测试 | MessageRouter 多消息同时触发一次检查 | 新增 |
| Socket 降级测试 | MessageRouter socket 挂掉，c4-receive 回退路径 | 新增 |
| 集成测试 | 新旧架构同一场景对照（状态转换、重启序列、定时任务触发） | 新增 |
| Watchdog 测试 | 继承 PR #500 的 `tool-watchdog.test.js` / `tool-lifecycle.test.js` | 已存在 |

继续用 `node --test`，**不迁移到 jest**（多一个依赖，收益小）。

---

## 九、开放问题与 v2 推荐

1. **launchGracePeriod 和 startupGrace 是否合并？**
   **推荐：不合并**，保留为两个独立的 per-runtime 参数。Claude `startupGrace=60s, launchGracePeriod=120s`；Codex `startupGrace=30s, launchGracePeriod=180s`。

2. **Unavailable 是否有超时切断？**
   **推荐：无限重试**（`degraded` 阶段 3600s 间隔）。token 开销极小，切断意味着需要人工干预，与自治目标冲突。

3. **MessageRouter 恢复检查失败后如何回复用户？**
   **推荐：队列消息 + 一条状态通知**（当前行为）。用户需要的是"能不能用"和"大概什么时候好"，不是调试信息。

4. **TaskScheduler 是否引入 cron？**
   **推荐：不引入**。`dailyHour` + `intervalSeconds` 覆盖现有所有任务，未来若有特殊需求（如"每周一"）再讨论。

5. **（v2 新增，review 后修正）MessageRouter socket 失败策略？**
   **推荐：消息入 C4 队列 + 跳过 MessageRouter 的主动聚合，不做 direct-to-tmux**。socket 不可用时让 c4-dispatcher 按现有 health gating 继续投递，保证 DB audit / priority / require_idle 都保留（见 §5 "C4 主链原则"）。同时 log 一条 ERROR 供观察。不进入 Unavailable（不是健康问题，是通信问题）。

6. **（v2 新增）watchdog 内部模块整合时机？**
   **推荐：Phase 5 之后单独一个小重构**。把 `tool-lifecycle.js` + `tool-event-stream.js` 合并为 `tool-tracker.js`，与 `tool-watchdog.js` 重整接口。这个整合与状态模型重构无依赖，独立推进降低风险。

---

## 十、与 v1 的兼容性

本 v2 文档**替代** PR #501 的 v1 文档。建议操作：
- 在 PR #501 上追加新 commit，用 v2 替换 `docs/activity-monitor-refactor-proposal.md`
- 或关闭 PR #501，另开新 PR 引用 v2

内容上 v2 对 v1 的**核心方向完全保留**，修改的是准确性、完整性和可落地性。Howard 的双层状态构想、Adapter 依赖注入、SignalStore 只读快照、TaskScheduler 注册式调度、三层健康监控这些 v1 的关键决策 v2 全部沿用。

---

*本文档基于 PR #501 原提案 + 2026-04-17 的 PR #501 深度评审结论整合而成。原提案作者：zylos01（主笔）、zylos0t（补充）；v2 整合：Claude（基于评审结论）。Howard 的双层状态原始构想贯穿 v1 和 v2。*
