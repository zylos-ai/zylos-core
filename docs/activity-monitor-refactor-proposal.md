# Activity Monitor 重构方案

> 基于 Howard 的架构构想 + main 分支现状（v0.4.11, commit 1345d45）
> 协作团队：zylos01（方案主笔）、zylos0t（信息补充与角度审查）
> 日期：2026-04-02
> 分支：`refactor/activity-monitor`

---

## 一、重构动机

### 1.1 Howard 的构想

Howard 提出了一个清晰的双层状态模型，将进程存活和功能健康彻底解耦：

- **Activity State（活动状态）**：Idle / Busy / Offline — 描述进程是否在运行
- **Health State（健康状态）**：OK / Unavailable / Rate Limited / Auth Failed — 描述功能是否可用
  - OK + Unavailable = 基础状态
  - Rate Limited + Auth Failed = 特定状态（未来可扩展）

核心行为规则：
1. **Offline → 无条件拉起进程**，不受健康状态影响
2. **健康状态只影响用户消息处理路径**（前提：Activity ≠ Offline）：
   - OK → C4 直接投递 tmux
   - Unavailable → 触发基本健康检查 → 获得结果后才回复用户
   - Rate Limited → 触发限流恢复检查 → 获得结果后才回复用户
   - Auth Failed → 触发认证恢复检查 → 获得结果后才回复用户
3. **OK 状态下的监控**：后台轮询，不消耗 token，不侵入 AI 主会话
4. **定时任务和 Hook 脚本**用抽象概念承载，便于扩展
5. **Hook 脚本文件路径不变**，不动用户的 hook 配置

### 1.2 现状痛点

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态语义不清晰** | health 有 5 个值（ok/recovering/down/rate_limited/auth_failed），其中 recovering 和 down 本质是同一状态的不同退避阶段，不是独立健康状态 |
| 2 | **Guardian 和 HeartbeatEngine 紧耦合** | 共享计数器（consecutiveRestarts、startupGrace）和控制流，难以独立测试和推理 |
| 3 | **四套退避机制各自为政** | Guardian restart backoff、HeartbeatEngine recovery backoff、auth retry suppression、user message cooldown — 语义不一致，难以审计 |
| 4 | **1658 行 God Object** | activity-monitor.js 把 Guardian、周期任务、状态检测、日常调度全塞在一个文件里 |
| 5 | **定时任务 ad-hoc** | daily upgrade / memory commit / upgrade check 各自用 DailySchedule，health check 用时间戳对比，usage monitor 又是另一套 |
| 6 | **信号消费散落** | hook 输出文件（api-activity.json、statusline.json 等）的读取和 freshness check 分散在主循环各处 |

---

## 二、状态模型

### 2.1 双层正交状态

```
┌─────────────────────────────────────────────────────┐
│  Activity State（进程层，由进程检测驱动）              │
│                                                      │
│  Offline ──→ Stopped ──→ Idle ←──→ Busy             │
│     ↑            ↑         ↑         ↑               │
│     └────────────┴─────────┴─────────┘               │
│         进程退出 / tmux 销毁 / 冻结 kill              │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Health State（功能层，由健康检查驱动）               │
│                                                      │
│  OK ←──→ Unavailable ←──→ RateLimited               │
│  ↑            ↑                 ↑                    │
│  └────────────┴─────────────────┘                    │
│        AuthFailed ←──→ OK                            │
│                                                      │
│  基础状态: OK, Unavailable                           │
│  特定状态: RateLimited, AuthFailed（可扩展）          │
└─────────────────────────────────────────────────────┘
```

**关键设计：两层完全正交**
- Guardian 只看 ActivityState：Offline/Stopped → 拉起进程
- MessageRouter 只看 HealthState：决定用户消息如何处理
- 两者独立运行，互不干扰

### 2.2 ActivityState 定义

| 状态 | 条件 | 说明 |
|------|------|------|
| **Offline** | tmux session 不存在 | 需要拉起 |
| **Stopped** | tmux 存在，agent 进程未运行 | 需要拉起 |
| **Idle** | agent 运行，空闲 ≥ 3s | 可接收消息和控制命令 |
| **Busy** | agent 运行，active_tools > 0 或最近有活动 | 正在处理任务 |

### 2.3 HealthState 定义

| 状态 | 触发条件 | 恢复路径 |
|------|----------|----------|
| **OK** | 健康检查通过 | — |
| **Unavailable** | 检查失败，未识别为特定原因 | 指数退避重试（60s→300s→1500s→3600s cap），超 60min 转为固定 3600s 间隔 |
| **RateLimited** | 检测到限流文本 + 行为信号 | 冷却期到期后进入 Unavailable 恢复流程 |
| **AuthFailed** | 认证探测失败 | 180s 冷却后重试认证 |

**Unavailable 的内部退避策略**（外部不可见）：

Unavailable 统一了当前的 recovering 和 down。内部用 **时间驱动**（`recoveringSince` + `degradeThreshold`）控制退避升级：
- 进入 Unavailable 时记录 `recoveringSince = Date.now()`
- 前 60 分钟（`Date.now() - recoveringSince < degradeThreshold`）：指数退避探测，间隔 60s → 300s → 1500s → 3600s cap
- 超过 60 分钟：固定 3600s 间隔重试

退避升级基于 **wall-clock 时间**而非探测计数。理由：时间驱动对用户语义更明确（"1 小时内密集重试，之后降为每小时"），且不受探测耗时、网络延迟等因素影响。

对外 agent-status.json 只写 `"health": "unavailable"`，消费端无需区分。

### 2.4 进程拉起后的初始健康状态

Guardian 拉起进程后，HealthState 进入 **Unavailable + Launch Grace**：
- 进入 Unavailable 状态
- 启动 `launchGracePeriod`（统一当前的 startupGrace 30s + LAUNCH_GRACE_PERIOD 180s）
- Grace 期间：不发送任何探测（避免新进程初始化期间误判）
- Grace 结束后：发第一次健康检查
- 检查通过 → OK；失败 → 保持 Unavailable，进入退避重试

Guardian 在 restart 流程中还负责：
- 显式 clear heartbeat-pending（防止旧 pending 超时误判）
- 重置 HealthEngine 退避计数

---

## 三、组件架构

### 3.1 模块总览

```
activity-monitor/
├── scripts/
│   ├── monitor.js               # 入口 + 主循环编排层
│   ├── guardian.js               # 进程存活守护
│   ├── health-engine.js          # 健康状态机
│   ├── message-router.js         # 用户消息路由（事件驱动）
│   ├── signal-store.js           # 信号聚合读取
│   ├── status-writer.js          # agent-status.json 写入
│   ├── task-scheduler.js         # 统一定时任务调度器
│   ├── proc-sampler.js           # 进程冻结检测（保留）
│   ├── hook-activity.js          # Hook 脚本（路径不变）
│   ├── hook-auth-prompt.js       # Hook 脚本（路径不变）
│   ├── context-monitor.js        # Hook 脚本（路径不变）
│   ├── session-start-prompt.js   # Hook 脚本（路径不变）
│   ├── health-checks/            # 健康检查策略
│   │   ├── heartbeat-check.js    # C4 控制消息 ack 检查
│   │   ├── rate-limit-check.js   # tmux 限流文本扫描
│   │   ├── auth-check.js         # CLI probe 认证检查
│   │   └── api-error-check.js    # tmux API 错误扫描
│   ├── tasks/                    # 注册式定时任务
│   │   ├── daily-upgrade.js
│   │   ├── daily-memory-commit.js
│   │   ├── upgrade-check.js
│   │   ├── health-check.js       # PM2/disk/memory
│   │   ├── usage-monitor.js
│   │   └── context-check.js      # 上下文占用检查（Codex 轮询 + Claude statusLine 二次判断）
│   └── adapters/                 # 运行时适配器（依赖注入）
│       ├── claude.js
│       └── codex.js
```

### 3.2 主循环（monitor.js）

精简为纯编排层，每秒执行：

```
每秒 tick:
1. signalStore.refresh()          ← 读取所有信号文件（一次 I/O，全局 snapshot）
2. guardian.tick(signals)          ← 进程存活守护 + restart 决策
3. procSampler.tick(signals)      ← 冻结检测
4. healthEngine.tick(signals)     ← 健康状态机转换
5. taskScheduler.tick(signals)    ← 定时任务调度
6. statusWriter.write(signals)    ← 写 agent-status.json
```

每个组件的 `tick()` 接收同一份 signals snapshot，组件之间不互相调用，顺序明确。

messageRouter **不在 tick 循环中** — 它是事件驱动的，由 c4-receive 在消息到达时调用。

### 3.3 各组件职责

#### SignalStore（信号聚合）

每 tick 开头刷新一次的 **只读 snapshot**：

```javascript
class SignalStore {
  refresh() {
    // 一次性读取所有信号文件，生成 immutable snapshot
    this.signals = Object.freeze({
      hookActivity: readJSON('api-activity.json'),      // hook-activity.js 写入
      statusLine: readJSON('statusline.json'),           // context-monitor.js 写入
      heartbeatPending: readJSON('heartbeat-pending.json'),
      userMessageSignal: readJSON('user-message-signal.json'),
      procState: readJSON('proc-state.json'),
      tmuxState: { exists, agentRunning, paneContent },  // tmux 状态采集
    });
  }
}
```

写入仍由各模块直接写文件（hook-activity.js → api-activity.json 等），SignalStore 只读取和聚合。不引入新的进程间通信机制。

#### Guardian（进程守护）

只关心进程是否在运行，不关心为什么不健康。

```javascript
class Guardian {
  constructor(adapter, healthEngine) { ... }

  tick(signals) {
    const { tmuxState } = signals;
    if (tmuxState.exists === false || tmuxState.agentRunning === false) {
      if (!this.healthEngine.restartBlocked) {  // 唯一的 health 交互
        this.startAgent();
      }
    }
  }
}
```

**restartBlocked**：HealthEngine 暴露的布尔值属性，Guardian 不直接读 health 值。语义：Guardian 问"我能 restart 吗"，不是"当前健康状态是什么"。

内部管理：
- restart 退避（指数 backoff: 5s→10s→20s→40s→60s）
- authRetrySuppression（180s 冷却）— 这是 restart 决策的一部分，不是 health state
- 显式 clear heartbeat-pending + 重置 HealthEngine 退避（调用 `healthEngine.onProcessRestarted()`）
- maintenance 等待：launch 前检查 TaskScheduler 是否有维护任务在跑（daily-upgrade 等），等待完成后再 launch（最长 300s），防止维护脚本与 launch 并发冲突

#### HealthEngine（健康状态机）

替代当前的 HeartbeatEngine，核心变化：

| 维度 | 当前 HeartbeatEngine | 新 HealthEngine |
|------|---------------------|-----------------|
| 状态数 | 5 (ok/recovering/down/rate_limited/auth_failed) | 4 (ok/unavailable/rate_limited/auth_failed) |
| 退避策略 | recovering 和 down 分开管理 | Unavailable 内部统一管理 |
| 对外接口 | 直接暴露 health 值 | 暴露 health + restartBlocked |
| Grace 机制 | 两层（startupGrace + LAUNCH_GRACE_PERIOD） | 合并为 launchGracePeriod |
| 依赖 | 直接 import adapter | 构造时注入 adapter |

**HealthEngine 对外接口：**

```javascript
class HealthEngine {
  get health()            // 当前健康状态: 'ok' | 'unavailable' | 'rate_limited' | 'auth_failed'
  get restartBlocked()    // Guardian 查询：是否阻止 restart（rate_limited 期间为 true）
  onProcessRestarted()    // Guardian restart 后调用：进入 Unavailable + launchGrace，重置退避，clear pending
  notifyUserMessage()     // MessageRouter 转发：用户消息到达信号，可加速恢复探测
  tick(signals)           // 主循环每秒调用
}
```

三层健康监控（OK 状态下）：

| 层级 | 间隔 | 检测内容 | Token 消耗 |
|------|------|----------|------------|
| Layer 1 | 10s | ProcSampler — 进程冻结检测（context switch 采样） | 零 |
| Layer 2 | 30s | tmux pane scan — 限流/API error/crash 文本信号 | 零 |
| Layer 3 | 30min | Heartbeat probe — C4 control ack 端到端检查 | 极少（一次 ack） |

Layer 1 + Layer 2 覆盖绝大部分故障场景且零 token。Layer 3 是 safety net。

#### MessageRouter（消息路由）

事件驱动模块，由 c4-receive 调用（不在 tick 循环中）。

```
c4-receive 收到用户消息
    ↓
messageRouter.handle(message)
    ↓
读取 healthState
    ├─ OK → 直接投递 tmux → 完成
    ├─ Unavailable → triggerHealthCheck()
    │       ↓
    │   等待检查结果（Promise）
    │       ├─ 恢复 OK → 投递消息
    │       └─ 仍然异常 → 回复用户状态信息
    ├─ RateLimited → triggerRateLimitRecovery()
    │       ↓
    │   等待恢复结果 → 回复用户
    └─ AuthFailed → triggerAuthRecovery()
            ↓
        等待恢复结果 → 回复用户
```

**并发聚合**（Howard 特别提到的）：

恢复检查可能耗时 10-30s，期间多条消息可能到达。方案：

```javascript
class MessageRouter {
  #pendingCheck = null;  // 当前进行中的检查 Promise
  #waitingMessages = []; // 排队等待的消息

  async handle(message) {
    if (this.healthState === 'ok') {
      return this.deliver(message);
    }

    this.#waitingMessages.push(message);

    if (!this.#pendingCheck) {
      // 第一条消息触发检查（catch 保证 reject 不会 unhandled）
      this.#pendingCheck = this.runRecoveryCheck()
        .catch(err => ({ recovered: false, error: err }));
      const result = await this.#pendingCheck;
      this.#pendingCheck = null;

      // 检查完成，一次性处理所有排队消息
      const messages = this.#waitingMessages.splice(0);
      for (const msg of messages) {
        if (result.recovered) {
          this.deliver(msg);
        } else {
          this.replyWithStatus(msg, result);
        }
      }
    } else {
      // 已有检查在进行，等待同一结果
      // 消息已在 waitingMessages 中，由第一个 handler 的 splice(0) 抓走处理
      await this.#pendingCheck;
    }
  }
}
```

#### TaskScheduler（统一定时任务调度器）

所有定时任务注册到 TaskScheduler，主循环每秒 tick 时统一调度。

```javascript
class TaskScheduler {
  register(name, {
    interval,     // 固定间隔（秒）或 cron 表达式
    condition,    // (signals) => boolean — 执行前置条件
    execute,      // (signals) => Promise<void> — 执行体
    runOnStart,   // boolean — 是否在注册后立即执行一次
  }) { ... }

  tick(signals) {
    for (const task of this.tasks) {
      if (this.shouldRun(task, signals)) {
        task.execute(signals).catch(err => this.logError(task.name, err));
        task.lastRun = Date.now();
      }
    }
  }
}
```

新增任务只需在 `tasks/` 下新建文件 + 注册：

```javascript
// tasks/daily-upgrade.js
export default {
  name: 'daily-upgrade',
  interval: '0 5 * * *',  // cron: 每天 5:00
  condition: (signals) => signals.tmuxState.agentRunning && signals.health === 'ok',
  execute: async () => { /* enqueue upgrade control */ },
};
```

好处：
- 新增任务不修改主循环
- 统一的执行日志和错误处理
- 条件检查集中，便于审计

**context-check.js 与 context-monitor.js 的分工**：
- `context-monitor.js`（Hook 脚本）：Claude 的 statusLine hook，每次 turn 结束后写 statusline.json（事件驱动，零轮询）
- `tasks/context-check.js`（定时任务）：Codex 运行时的上下文轮询（30s 间隔），以及 Claude 侧的二次判断（读 statusline.json → 判断是否触发 new-session / early memory sync）。它消费 context-monitor.js 的输出，不重复采集。

**maintenance 标记**：TaskScheduler 暴露 `isMaintenanceRunning()` 方法，供 Guardian 在 launch 前查询。维护型任务（daily-upgrade、daily-memory-commit）注册时标记 `maintenance: true`。

---

## 四、健康检查策略

### 4.1 检查类型

每种健康检查独立为一个模块，放在 `health-checks/` 目录：

| 检查 | 触发场景 | 方法 | Token | 耗时 |
|------|---------|------|-------|------|
| **heartbeat-check** | Layer 3 (30min) + 恢复重试 | C4 control 消息 enqueue → 等待 ack | 极少 | 2-120s |
| **rate-limit-check** | Layer 2 (30s) + 恢复检查 | tmux capture-pane → regex 匹配 | 零 | <100ms |
| **auth-check** | 进程启动后 + AuthFailed 恢复 | `claude -p ping` / `codex --version` | 零 | 1-5s |
| **api-error-check** | Layer 2 (30s)，heartbeat pending 时 | tmux capture-pane → API error pattern | 零 | <100ms |

### 4.2 检查编排

HealthEngine 在不同状态下调用不同的检查组合：

```
OK 状态（后台监控）:
  Layer 1 (10s): ProcSampler
  Layer 2 (30s): rate-limit-check + api-error-check
  Layer 3 (30min): heartbeat-check

Unavailable 状态（恢复探测）:
  按退避间隔执行: heartbeat-check
  持续执行: rate-limit-check（识别是否实为限流）

RateLimited 状态（等待冷却）:
  定期执行: rate-limit-check（检测限流是否解除）
  冷却到期后: 转 Unavailable，走恢复流程

AuthFailed 状态（等待认证恢复）:
  180s 冷却后: auth-check
  用户消息到达: 立即触发 auth-check
```

---

## 五、Adapter 依赖注入

运行时差异通过 adapter 封装，构造时注入 Guardian 和 HealthEngine：

```javascript
// monitor.js
const adapter = runtime === 'codex' ? new CodexAdapter(config) : new ClaudeAdapter(config);

const guardian = new Guardian(adapter, healthEngine);
const healthEngine = new HealthEngine(adapter, config);
```

Adapter 接口：

```javascript
class RuntimeAdapter {
  launch()          // 启动 agent 进程
  stop()            // 停止 agent 进程
  isRunning()       // 检查进程是否在运行
  checkAuth()       // 认证探测
  getProcessPid()   // agent 进程 PID（ProcSampler 需要）
  get heartbeatEnabled()  // 是否启用心跳
  getTmuxTarget()   // tmux pane 标识
  getSessionName()  // tmux session 名
}
```

测试时传入 mock adapter，实现完全隔离的单元测试。

---

## 六、Hook 兼容策略

### 6.1 路径不变

Hook 脚本在 `scripts/` 目录下的物理路径 **不变**：

```
scripts/hook-activity.js        ← 用户 settings.json 引用的路径
scripts/hook-auth-prompt.js     ← 用户 settings.json 引用的路径
scripts/context-monitor.js      ← 用户 settings.json 引用的路径
scripts/session-start-prompt.js ← 用户 settings.json 引用的路径
```

用户的 `~/.claude/settings.json` 无需任何修改。

### 6.2 Hook 输出消费

Hook 脚本写入的文件（api-activity.json、statusline.json 等）通过 SignalStore 统一读取。Hook 脚本本身不需要知道新架构的存在 — 它们的契约是"写文件"，消费端是谁不影响它们。

---

## 七、agent-status.json Schema 变更

### 7.1 v1 → v2 对比

| 字段 | v1（当前） | v2（新） |
|------|-----------|---------|
| state | offline/stopped/busy/idle | offline/stopped/busy/idle（不变） |
| health | ok/recovering/down/rate_limited/auth_failed | ok/unavailable/rate_limited/auth_failed |
| schema_version | (无) | 2 |

### 7.2 下游影响

| 消费者 | 影响 | 改动量 |
|--------|------|--------|
| c4-dispatcher | health 值域变化：recovering/down → unavailable | 极小（已只看 ok vs 其他） |
| c4-receive | 写 user-message-signal 时只看 health !== 'ok' | 无影响 |
| web-console | 显示 health 状态 | 更新显示映射 |

实际上 activity-monitor 和 comm-bridge 同版发布，不需要灰度兼容。

---

## 八、迁移计划

### Phase 1: 基础设施

1. 新建 `signal-store.js`、`status-writer.js`、`task-scheduler.js`
2. 将 DailySchedule 逻辑迁移到 TaskScheduler
3. 新建 `tasks/` 目录，每个定时任务独立文件
4. 测试：TaskScheduler 单元测试

### Phase 2: 状态模型

1. 新建 `health-engine.js`（从 heartbeat-engine.js 演化）
2. 合并 recovering + down → Unavailable（内部保留退避逻辑）
3. 统一 launchGracePeriod
4. 新建 `guardian.js`（从 activity-monitor.js 提取 Guardian 逻辑）
5. 实现 restartBlocked 接口
6. 测试：HealthEngine 状态转换测试、Guardian 单元测试

### Phase 3: 组件拆分

1. 新建 `monitor.js` 编排层（tick 循环）
2. 新建 `health-checks/` 目录，提取各类检查为独立模块
3. 将 ProcSampler 调整为 tick 接口
4. 重写 activity-monitor.js → 作为 PM2 入口，启动 monitor.js
5. 测试：集成测试（模拟完整 tick 序列）

### Phase 4: 消息路由

1. 新建 `message-router.js`
2. 修改 c4-receive 调用 MessageRouter
3. 实现并发聚合（pendingCheck + waitingMessages）
4. 修改 c4-dispatcher 适配新 health 值域
5. 测试：MessageRouter 并发测试

### Phase 5: 收尾

1. 更新 agent-status.json schema（加 version: 2）
2. 更新 SKILL.md 文档
3. 更新 web-console 状态显示
4. 删除废弃代码（旧 heartbeat-engine.js 等）
5. 全量回归测试

### 兼容性保证

- Hook 脚本路径不变 → 用户 settings.json 无需修改
- agent-status.json 字段兼容 → 同版发布，无灰度风险
- config.json 配置项保留 → heartbeat_enabled、new_session_threshold 等不变

---

## 九、开放问题（待 Howard 确认）

1. **launchGracePeriod 时长**：当前有 30s（startupGrace）和 180s（LAUNCH_GRACE_PERIOD）两个。建议合并为 per-runtime 配置：Claude 60s（hook 初始化快），Codex 180s（启动链长）。

2. **Unavailable 超时策略**：当前 down 状态后以 60min 间隔无限重试。建议保持无限重试 — 3600s 间隔开销极小，设置 24h 切断意味着需要人工干预，与自治目标冲突。

3. **MessageRouter 的回复内容**：当健康检查完成但仍异常时，回复用户什么？建议保持当前行为（队列消息 + 一条状态通知），用户只关心"能不能用"和"大概什么时候好"。

4. **定时任务调度模式**：建议不引入 cron 解析器。`dailyHour`（每日固定时间）+ `intervalSeconds`（固定间隔）两种模式覆盖所有当前任务，减少一个依赖。

---

*本文档由 zylos01 主笔，zylos0t 提供代码层面的信息补充和设计角度审查。*
