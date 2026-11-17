# Activity Monitor 重构方案 v3.1 — 📝 REVIEW DRAFT (v3 在 doc-coauthoring 工作流下的 readability 重排版)

> 日期：2026-04-28（基于 v3 commit `a711212` 二轮重排版）
> 分支：`docs/activity-monitor-refactor-proposal`
>
> **本文件状态：📝 REVIEW DRAFT**
>
> 本次 v3.1 **不是新设计、也不是 v3 的 design 修订**——是把 v3 顶层方案按 [`doc-coauthoring`](https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring) 工作流（Context Gathering → Refinement → Reader Testing）做 readability 重排版。**所有 design decision 与 v3 / v2.1 完全一致**——v2.1 baseline + zylos0t R6 两条窄 contract 修订（§六.H、§六.I）；R3+R4+R5 reply-resolution 整套不进 baseline（§六.G）。
>
> **本次相对 v3 的改动（仅排版 / 措辞 / 信息分层 / 重复消除）**：
>
> 1. §〇 TL;DR 7 条压缩 bullet → 开篇问题陈述 + 4 条自含 key insight + 边界 + 明确不做
> 2. §三.4 unhealthy 路径 5 段（含 numbered list） → 1-2 句 + 链向 §六.H 唯一权威
> 3. §五.2 17 行单图 → 拆成 3 路径分图（Probe-recovered / Probe-failed / IPC-down）
> 4. §六.G R6 决断 5 条 numbered + summary → 单段（密度对齐 §六.A-F）
> 5. §七 模块档索引"核心内容"列 4-6 bullet 分号挤一行 → 2-3 priority bullet 每行
> 6. §一 8 痛点 ↔ §〇 措辞对齐（v3 中 TL;DR 说"6 大痛点"vs §一 表 8 行的数字 mismatch 修复）
>
> **历史版本归属**（review pass 后切到本文件作为 baseline 时一并升降级）：
> - v2.1 [`activity-monitor-refactor-proposal-v2.1.md`](activity-monitor-refactor-proposal-v2.1.md) — **当前 IMPLEMENTATION BASELINE**，本文件 review pass 后转为 SUPERSEDED-by-content
> - v3 [`activity-monitor-refactor-proposal-v3.md`](activity-monitor-refactor-proposal-v3.md) — 📝 v3.1 review pass 后转为 SUPERSEDED-by-content（design 等同，仅 readability 升级）
> - v2 / v1 — SUPERSEDED 不变

---

## 〇、TL;DR

**这是什么 / 解决什么**

Activity Monitor (AM) 是守护 runtime（Claude / Codex）的 PM2 长驻进程。当前是单文件 2300+ 行的 God Object——状态语义不清、退避机制各自为政、定时任务三套混用、单元测试无从下手。本方案把 AM 按职责拆成 **12 个独立模块**（业务 11 + 运行时 Adapter 1），让主循环退化为 8 步编排器。

**4 个核心动作**（每条自含；术语在 §三 / §四 详细展开）

1. **状态机正交**：把"进程是否活着"（ActivityState：Offline / Idle / Busy）与"runtime 是否可用"（HealthState：OK / Unavailable / RateLimited / AuthFailed）拆为两个字段零互读。跨模块协作只走 SignalStore 只读快照（持续值）+ 具名事件接口（一次性动作）两条通道；反向查询路径不存在。
2. **API error 出口治理 catalog 化**：runtime 错误模式 + recovery 路径不再硬编码——由 Adapter 在构造时注入 catalog，HealthEngine 统一 dispatch 到 5 种 recoveryAction（restart_session / probe_only / mark_rate_limited / mark_auth_failed / notify_only）。**probe 失败不默认触发 restart**——只有 `restart_session` 才进程级重启。
3. **冷启动行为显式区分**：AM 重启后默认走 **bypass-once**——首次 probe 绕过持久化退避计时器试一次，失败回原水位（不重置）；operator 想真正清零退避走 `zylos am reset-backoff` 创建 marker 文件做 one-shot 重置。两路径解决"PM2 auto-restart 反复打外部 API"和"daily-upgrade 修好后还要等老退避到期"两难（详 §五.5、§六.C）。
4. **对外契约向后兼容**：Hook 物理路径不变、channel daemon 外部协议不动；对外状态文件加 `schema_version` + 字段向后兼容（消费端遇未知 reason 退化通用文案不报错）。

**核心边界**

- C4 DB 是消息可靠性边界——`c4-receive` 接受写入即 durable，runtime 异常**不算消息丢失**
- AM 不维护私有受害者识别 ledger，不记录"消息是否已回复"业务语义（这是 R6 production rollback 决断的核心；详 §六.G）
- Unhealthy 时 `c4-receive` 同步通过既有 `c4-send.js` 接口返回 outbound 状态文案——跟 agent 正常 reply 同路径，不发明新接口
- restart 后 agent 看 `c4-session-init` 注入的 context 自决策续接，**best-effort**——不承诺 unresolved-inbound completeness，接受 residual UX risk

**明确不做**（R3+R4+R5 reply-resolution 整套退出，参 §六.G）

不引入：`terminal_status` / `reply_to_inbound_id` / `claimed_at` 字段；reply command token-passing；C-Term-1~5 单调 invariant + hard/soft 两层校验；bounded pending exposure CLI；InputValidator；cron 解析器；主动 broadcast"我恢复了"。详 §二.2、§六.G。

---

## 一、背景与问题

AM 在过去一年随需求演进积累了多重结构性债务：

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态语义不清** | health 5 值（ok/recovering/down/rate_limited/auth_failed），其中 recovering 与 down 本质是同一恢复流两阶段 |
| 2 | **Guardian ↔ HeartbeatEngine 紧耦合** | 共享 5 个字段，跨模块直接读写，难独立测试 |
| 3 | **多套退避机制各自为政** | restart / recovery / auth retry / user cooldown / tool watchdog 语义不一致 |
| 4 | **God Object** | 单文件 2300+ 行塞了 Guardian / 健康检查 / 工具 watchdog / 调度全部职责 |
| 5 | **Watchdog 子系统游离** | PR #500 引入的工具生命周期+事件流主循环深度集成但无模块边界 |
| 6 | **定时任务 ad-hoc** | 三套调度方式混用（DailySchedule / 间隔 timestamp / 独立状态机） |
| 7 | **信号消费散落** | 12+ 状态文件在主循环各处单独 readJSON，无统一快照层 |
| 8 | **AM 冷启动未区分重启前后文与故障重试** | 持久化长退避压制首次 probe；daily-upgrade 修好根因后仍要等退避到期 |

**不解决的代价**：每加一类 runtime 错误、每加一个定时任务、每改一个 health 子状态都要碰 5 处；测试只能 E2E 不能单元；增量 ship 难度高。

---

## 二、目标 / 非目标

### 2.1 目标（解决什么）

1. **God Object 拆分**：业务职责模块化，主循环退化为编排器
2. **状态机正交**：ActivityState / HealthState 互不读字段，跨模块通过 SignalStore 只读快照 + 具名事件接口
3. **健康状态收敛**：5 → 4 种，子状态用时间戳差分而非枚举值
4. **三层健康监控**：OS 级冻结（10s）+ tmux scan（30s）+ heartbeat probe（30min）按成本/覆盖率分层
5. **API error 出口治理 catalog 化**：错误模式 + recovery 路径由 Adapter 注入；probe 与 restart 解耦
6. **冷启动行为显式化**：bypass-once 默认 + marker 显式重置两路径
7. **定时任务统一**：3 套合并为 TaskScheduler 注册式调度
8. **Usage 监测与告警拆分**：本地观测（零 token）与主动告警（消耗 token）由两个独立 gate 控制

### 2.2 非目标（明确不做）

| # | 不做的事 | 原因 |
|---|---------|------|
| N1 | **不在 AM 内重做 c4 DB 已覆盖的可靠性** | C4 DB 是消息可靠性边界（accepted-message durability）；AM 不私有受害者识别 ledger |
| N2 | **不记录"消息是否已回复"业务语义** | group / multi-msg / agent 主动消息 / 跨 session 等场景 C4 纯机械层无法稳定判断；维持 v2.1 决断不引入 `terminal_status` / `reply_to_inbound_id` 等字段 |
| N3 | **不引入 reply correlation 强机制（reply command token-passing 等）** | agent 手写 / 复制 / 跨 thread / 主动补充等场景 reply command discipline 易破，配对错从软错（agent 自决策错）变硬错（系统机制错）；R6 production rollback 决断 |
| N4 | **不引入 InputValidator 入口校验** | zylos 当前 multimodal 通过 path-as-text 投递（channel daemon 把附件下载本地后只把路径塞进 c4-receive content），不存在自动 multimodal 注入路径，sticky 4xx 链路不成立 |
| N5 | **不引入 cron 解析器** | `dailyHour` + `intervalSeconds` 覆盖当前需求；最小化外部依赖与测试面 |
| N6 | **不主动 broadcast"我恢复了"** | unhealthy 路径已在 c4-receive 同步返回状态文案；restart 后 agent 看 context 自决策续接；事后再发广播会造成双通知与语义冗余；main 旧的 `pending-channels` 异步恢复路径在本方案下废弃 |
| N7 | **不在 PR #501 同时上 pending exposure 强保证** | 任何"在 c4-session-init 显式注入 unresolved-inbound 列表 + bounded subset + continuation CLI"是产品语义而非 AM refactor 必要前置；不绑入本 PR scope |

非目标会在 §六 方案取舍中给出更详细的 reasoning。

---

## 三、核心设计原则

### 1. 双层正交状态机

ActivityState（进程层）与 HealthState（功能层）之间**零字段互读**。跨模块协作只走两类通道——状态走 SignalStore 只读快照，事件走具名事件接口（如 `setAuthFailed` / `onProcessRestarted` / `triggerRecovery` / `notifyUserMessage`）。

**Guardian 只看 ActivityState**（Offline → 拉起进程，不读 HealthState）。**MessageRouter 只看 HealthState**（决定用户消息处理路径）。**进程拉起 ≠ 健康变化**（restart 后 HealthEngine 从持久化状态回填，不强制置 Unavailable，避免"重启重置故障认知"）。

### 2. C4 DB 是消息可靠性边界

c4-receive 在 health=OK 时把消息写入 c4 DB inbound 即视为 accepted；后续 runtime 异常（包括 sticky API error 触发的 session restart）**不算消息丢失**——既有 inbound 完整保留。AM **不**维护私有受害者识别 ledger（不在 AM scope 重做 c4 DB 已经做的事）。

### 3. 出口治理 catalog 化（probe / restart 解耦）

Layer 2 tmux scan 检测到 API error 时**不硬编码 pattern + action**——通过 Adapter 注入 catalog，HealthEngine 统一 dispatch 到 5 种 recoveryAction（`restart_session` / `probe_only` / `mark_rate_limited` / `mark_auth_failed` / `notify_only`）。**heartbeat / probe 失败不默认 trigger restart**：只有 `restart_session` 路径触发进程重启；其他 action 即使 probe 失败也不 restart（restart 没意义）。

Catalog 是**活的知识库**：unknown error 走 `probe_only` 兜底 + 写入 unknown-error 日志，weekly review 增补 catalog；同时设持续未匹配升级（连续 5 分钟命中）→ 强制 `restart_session` 自愈，避免在 sticky context 下退避永远卡死。

### 4. Unhealthy 路径同步返回状态文案（用既有 c4 接口闭环）

c4-receive 在 health 非 OK 时同步给用户返回状态文案，**全部用既有 c4 接口完成**——既不引入新字段（不引入 `terminal_status` 等）也不发明新投递路径，跟 agent 正常 reply 走同一条 c4-send 路径。

精确机制（DB 双行 / dispatcher 跳过策略 / c4-send spawn 协议）见 §五.2 流程图与 §六.H 取舍——**§六.H 是本约束的唯一权威落点**（zylos0t R6 TODO 1 精确措辞）。

### 5. Session restart continuation 是 best-effort

session_restart 触发后流程：

1. `adapter.stop()` → Guardian 拉新 session
2. c4-session-init 注入 last checkpoint summary + recent unsummarized 对话作为 startup context（既有机制）
3. agent 看 startup context（包括恢复前可能未回复的 inbound）→ **自行判断**是否补 reply
4. **不**主动 broadcast"我恢复了"——unhealthy 时用户已经同步收到状态文案

**Continuation 的 contract 边界**：

- C4 DB 承诺 **accepted-message durability**（已写入的 inbound 不丢）
- restart 后由 c4-session-init recent / unsummarized context + agent 自治做 **best-effort continuation**
- **不承诺 unresolved-inbound completeness**（例如 100+ pending 时 startup context 受 token 预算约束可能截断）
- 接受由此产生的 **residual UX risk**（restart 时刚到达但未投递的消息可能被 agent 漏答；user 凭文案重发是兜底机制）

详 §六.I 取舍说明（zylos0t R6 TODO 2 落点）。

### 6. Hook 路径不变 / 对外契约向后兼容

所有 Hook 脚本物理路径不变，用户 settings 无需修改。对外状态文件加 schema 版本号；新增字段保持向后兼容（消费端遇未知 reason 退化到通用文案不报错）。

---

## 四、总体架构

### 4.1 模块全景（11 业务模块 + 1 Adapter）

按职责划分 11 个业务模块 + 1 个 Adapter DI 层。每模块的具体实现见对应 [模块实施档](activity-monitor/modules/)：

| 模块 | 一句话职责 | 实施档 |
|------|-----------|--------|
| **monitor** | 入口 + 主循环编排 + MessageRouter 宿主进程 | (索引在主循环, 不独立成档) |
| **SignalStore** | 每 tick 开头刷新一次，产出 immutable 信号快照 | [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md) |
| **StatusWriter** | 写对外状态文件（对外契约唯一发布者） | 同上 |
| **Guardian** | 进程存活守护 + 拉起决策 + bypass-once / marker 重置 | [`guardian.md`](activity-monitor/modules/guardian.md) |
| **ProcSampler** | OS 级冻结检测（context switch 采样） | [`tool-pipeline-watchdog-procsampler.md`](activity-monitor/modules/tool-pipeline-watchdog-procsampler.md) |
| **ToolPipeline** | 工具生命周期 + 事件流合成 | 同上 |
| **ToolWatchdog** | 工具超时检测与干预 | 同上 |
| **HealthEngine** | 健康状态机 + 主动探针编排 + api-error catalog dispatch | [`health-engine.md`](activity-monitor/modules/health-engine.md) |
| **TaskScheduler** | 统一定时任务调度器（注册式 + usage 双 gate） | [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md) |
| **MessageRouter** | 用户消息路由（事件驱动，**不在 tick 里**）+ unhealthy queue-status 处理 | [`message-router.md`](activity-monitor/modules/message-router.md) |
| **Adapter** | 运行时差异封装（构造时依赖注入） | [`runtime-adapter.md`](activity-monitor/modules/runtime-adapter.md) |
| **(跨模块契约)** | session restart 后续接 contract + 边界声明 | [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) |

### 4.2 三种通信通道

| 通道 | 用途 | 实现 | 一致性 |
|------|------|------|--------|
| 🔵 **State via SignalStore** | 跨模块共享"当前持续值" | 生产者写文件，SignalStore 每 tick refresh；消费者读快照 | Eventual（≤ 1 tick ≈ 1s） |
| 🔴 **Event via 具名接口** | 跨模块触发"一次性动作" | 单向方法调用 | Synchronous |
| 🟢 **C4 主链** | 用户消息投递 | c4-receive → DB → c4-dispatcher → tmux（健康门控 + priority + require_idle） | — |

**关键不变量**：Guardian 决策闭环中**不同步查询**任何其他模块；HealthEngine 不对外暴露 getter；c4-dispatcher 独占 tmux 写入。

### 4.3 主循环 tick（每秒 8 步）

```
每秒 tick:
 ① SignalStore.refresh         ← 刷新快照
 ② Guardian.tick               ← 进程存活 + 拉起决策
 ③ ProcSampler.tick            ← 冻结检测
 ④ ToolPipeline.tick           ← 工具生命周期 + api-activity 合成
 ⑤ ToolWatchdog.tick           ← 工具超时检测
 ⑥ HealthEngine.tick           ← 健康状态机 + api-error catalog dispatch
 ⑦ TaskScheduler.tick          ← 定时任务调度
 ⑧ StatusWriter.write          ← 写对外状态文件
```

**顺序硬约束**：④ 在 ⑥ 前（健康判定要读工具活动视图）；⑤ 在 ④ 后 ⑥ 前（watchdog 干预可能触发 health 降级）；MessageRouter 不在 tick 里，由 c4-receive IPC 触发。

### 4.4 状态模型

**ActivityState（3 种，无状态投射）**：Offline / Idle / Busy。每 tick 结束时根据当下信号 snapshot 投射，无历史依赖。冻结的瞬态由 ProcSampler 判死后直接 kill，下一 tick 自然投射为 Offline。

**HealthState（4 种，FSM）**：OK / Unavailable / RateLimited / AuthFailed。对外只暴露 `health` + `unavailable_since` 两个字段；不写子状态——消费端读时间戳自行判断文案差分（< 60min 转 ≥ 60min 文案不同）。

详细转换表 / 决策规则 / 字段定义见 [`health-engine.md`](activity-monitor/modules/health-engine.md)。

---

## 五、关键流程

### 5.1 OK 直通路径

```
user → c4-receive (insertConv 'in') → MessageRouter (health=OK) → dispatcher → tmux → agent 实回复
```

agent 看消息回复；DB 既有 inbound 与后续 outbound 完整持久化。runtime 后续异常**不算消息丢失**（参 §三.2、§三.5）。

### 5.2 Unhealthy 同步状态文案路径

进入 c4-receive 后，先经一次 MessageRouter IPC 聚合的 recovery probe，再分 3 路径走。

**Path A — Probe recovers**（API 已恢复）：

```
user → c4-receive → MessageRouter IPC (probe agg)
                                       ↓ recovered=true
                            → 重走 §5.1 OK 直通路径
```

**Path B — Probe fails**（unhealthy 核心路径）：

```
user → c4-receive → MessageRouter IPC (probe agg) → recovered=false
                            ↓
       insertConv('in', ..., status='delivered')   ← 显式覆盖 default 'pending'
                            ↓                       (dispatcher SELECT pending 自然跳过)
       c4-receive 调 c4-send.js (catalog.userMessage)
                            ↓ c4-send 内部：
                              ├── insertConv('out', ..., status='delivered')
                              └── spawn <channel>/scripts/send.js
                            ↓
       user 收到 "bot 状态消息"（跟 agent reply 同路径）
                            ↓
       c4-receive exit 0
```

**Path C — IPC degraded**（MessageRouter 不可达，monitor crash 级罕见异常）：c4-receive 不做"假入队"承诺，文案诚实告知 operator 需要重发。详 §六.D。

**关键约束**（zylos0t R6 TODO 1 精确落点）：

- inbound `status='delivered'` 是显式覆盖 c4-db.js:107 的 default `'pending'`——dispatcher SQL `WHERE status='pending'`（c4-db.js:140）自然跳过这条 inbound
- outbound 通过 c4-send.js 既有接口投递——跟 agent 正常 reply 同路径，**不发明新 path**
- 全程**不引入新字段** `terminal_status`、**不引入 reply correlation token**、**不引入新表 / 新接口**

### 5.3 API error catalog dispatch 路径

```
Layer 2 tmux scan 命中 API error pattern
  → catalog entry lookup
  → 按 entry.recoveryAction 分派：
     ├── restart_session   → adapter.stop + 进 Unavailable + 等 Guardian 拉新 session
     ├── probe_only        → 进 Unavailable + 持续 probe（**不 stop**）
     ├── mark_rate_limited → 进 RateLimited（**不 stop**）
     ├── mark_auth_failed  → 进 AuthFailed（**不 stop**）
     └── notify_only       → 仅 log + 可选用户即时通知（不改 health, 不 stop）
```

5 种 recoveryAction × HealthState 转换 × DB 记录路径的完整矩阵见 [`health-engine.md`](activity-monitor/modules/health-engine.md) §3。

**Unknown 升级路径**：catalog 未匹配但通用 Error/FATAL 命中 → 默认 `probe_only` 兜底 + 写未知错误日志；同一 unknown 错误连续 5min 命中 → 强制升级为 `restart_session` 自愈，防退避永远卡死。

### 5.4 Session restart continuation 路径

```
restart_session 触发
  → adapter.stop
  → Guardian 看 ActivityState=Offline → 拉新 session
  → c4-session-init 注入 startup context (last checkpoint + recent unsummarized)
  → agent 看 context → 自决策是否补 reply
```

**Contract**（zylos0t R6 TODO 2 落点）：

- C4 DB 保 accepted-message durability
- restart 后 best-effort continuation
- 不承诺 unresolved-inbound completeness
- 接受 residual UX risk（user 凭 unhealthy 时已收到的状态文案重发是兜底）

详 [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) §2。

### 5.5 Guardian 冷启动 bypass-once 路径

Guardian 拉起 4 条件（详 [`guardian.md`](activity-monitor/modules/guardian.md) §3）：#1 rate limit / #2 auth retry suppress / #3 restartDelay（指数退避计时器）/ #4 维护窗口互斥锁。"4 字段持久化状态" = 这 4 条件涉及的退避水位与失败计数。

```
AM 冷启动
  ├── marker 文件存在  → 清空 4 字段持久化状态 + unlink marker (one-shot)
  │                      → 关闭 bypass-once → 走 initial_delay
  └── marker 不存在    → 从持久化恢复 4 字段（保留故障认知）
                        → 首次 probe bypass 时间驱动退避（条件 #1/#2/#3）
                        → **不绕** #4 维护窗口（operator 显式语义不能绕）
                        → 成功 → 清空 4 字段
                        → 失败 → 回到持久化退避水位（不退回 initial_delay）
```

详 [`guardian.md`](activity-monitor/modules/guardian.md) §5。

---

## 六、方案取舍

### A. 为什么 HealthState 合并 recovering / down 为 Unavailable

recovering 是"暂时重试中"，down 是"长期失败"——本质同一恢复流两阶段，60min 阈值是 HealthEngine 的内部退避升级时机却被暴露为对外状态枚举。合并后用 `unavailable_since` 时间戳替代子状态区分，消费端保有文案差分能力，对外契约更简洁。

### B. 为什么 SignalStore 采用 eventual consistency

Guardian → HealthEngine 反向查询路径被消除的代价。原同步内存查询是 O(1) strong consistency；新通道是"写文件 → SignalStore refresh → 读快照"三跳，上界 1 tick (≈1s)——限流解除后 Guardian 最多慢 1s 拉起，代价可控；收益是同步调用路径完全消除，模块独立可测。

### C. 为什么 bypass-once 不是"所有 cold start 清零"

简单"所有清零"无法区分 operator 意图重试（应清零）与 PM2 auto-restart（应保留故障认知）。后者每次从 initial_delay 重爬会对外部 API 产生持续脉冲。marker 文件做 operator 显式 opt-in，两端取得合适语义；marker 用完即焚（one-shot）防止退化为"所有清零"。

### D. 为什么 IPC 降级不入队

原设计 IPC 降级时仍 insertConversation + "消息已入队" 文案是"不丢消息优先"妥协，代价是一条 receive 可能产出 2 条回复（interim error + 后续 AI），违反"一次 c4-receive 一次真实答案"不变量。新设计选择"不做假入队承诺"，文案诚实告知 operator 需要重发。不变量 100% 成立；IPC 降级是 monitor crash 级罕见异常场景，可接受。

### E. 为什么 ActivityState 是无状态投射而不是 FSM

ActivityState 无历史依赖——任何 tick 看到同样信号都得同样 state。FSM 会引入"从自己写的对外状态文件恢复状态"的反向依赖，重启 AM 后可能与现实信号不一致。无状态投射下第一 tick 直接算出真值，契合"进程拉起 ≠ 健康变化"哲学。

### F. 为什么不引入 cron 解析器

依赖最小化 + 可测试。cron 库约 50KB 代码，表达式解析有 bug 历史。`dailyHour` + `intervalSeconds` 两字段语义明确，测试只需 mock 时间。未来如有"每周三 03:00"需求加 `weeklySchedule` 字段即可。

### G. 为什么不引入 reply-resolution / terminal_status / token-passing 整套（R6 production rollback 决断）

PR #501 早期 R3+R4+R5 演进路径尝试在 C4 DB 引入 reply-resolution 整套（`terminal_status` / `reply_to_inbound_id` / `claimed_at` 字段 + reply command token-passing + C-Term-1~5 单调 invariant + hard/soft 两层校验 + bounded pending exposure CLI），R6 production trade-off 评估后整套退出 baseline——核心五点：(1) **违背 prior decision**：早期讨论已明确"C4 不记录消息已回复状态"，R3 把 C4 纯机械层升级为业务语义；(2) **discipline 假设过强**：token-passing 假设 agent / dispatcher / channel daemon 都按规矩玩，agent 手写命令 / 跨 thread 回复 / 主动补充任一场景 break 即出现 stale/missing/mismatch，配对错从 v2.1 的"软错"（agent 自决策）变"硬错"（系统机制写错 DB）；(3) **state 矩阵未拼完**：R3+R4 引入字段跟既有 `conversations.status`（pending / running / delivered / failed）交互**完全未讨论**，5 轮 review 未抓到 blind spot；(4) **大机制解小问题**：unhealthy status reply 真正需求是"状态文案返回后 inbound 不进 dispatcher 主队列"——用既有 `status='delivered'` 显式覆盖即解（§六.H），无需 terminal_status 全套；(5) **scope 蔓延**：pending exposure 是产品语义不是 AM refactor 必要前置，塞进 PR #501 会让 refactor 变成 C4 reply ledger 重构。

R6 决断保留 v2.1 已收敛的所有有效产物（catalog-driven api error / probe-restart 解耦 / 11 模块拆分 / bypass-once+marker / usage 双 gate），仅退出 R3+R4+R5 增量。本 v3.1 在此决断基础上做 spec 化 + 落地 §六.H、§六.I 两条窄修订。

### H. zylos0t R6 TODO 1：Unhealthy inbound 用 status='delivered' 表达非待投递（精确措辞）

**问题**：v2.1 多处描述 unhealthy 路径写入 `insertConv('in') + insertConv('out', 状态文案)`，但**没有显式声明**这条 inbound 在 dispatcher 视角的处理状态——理论上 dispatcher 看 inbound queue 仍可能尝试再次投递，造成双答（status outbound 已发 + dispatcher 又投递 → agent 又答一次）。

**精确收敛**：用既有 `conversations.status` 字段（不引入新字段），c4-receive 调 `insertConversation('in', channel, endpoint, content, 'delivered')`——第 5 个参数**显式覆盖 default 'pending'**，dispatcher SQL `getNextPending: WHERE direction='in' AND status='pending'`（c4-db.js:140）自然跳过这条 inbound。

**不用模糊的"audit 语义"措辞**：早期讨论曾用过"audit inbound"等措辞，最终采用既有 `'delivered'` 值（c4-db.js:107 default 已为 outbound 使用此值）——既有字段值复用，**零新概念**，dispatcher 不需要任何额外判断逻辑。

**outbound 走 c4-send.js 既有接口**：c4-receive 调用 `c4-send.js` 投递 catalog.userMessage——c4-send.js 内部完成 outbound DB 行写入（status='delivered' 默认）+ spawn `<channel>/scripts/send.js` 实际投递。**不发明新接口**——AM scope 内不直接管 channel 投递；用户感知统一为"bot 发的消息"，跟 agent 正常 reply 同路径。

**为什么不引入 terminal_status**：`terminal_status` 把"是否已回复"做成 C4 业务语义，而 group / multi-msg / agent 主动消息等场景这件事 C4 纯机械层无法稳定判断（参 §六.G #1）。本 TODO 用既有 queue status + 既有 c4-send 接口的窄修订，避免再次进入 reply-resolution scope。

**落点**：[`message-router.md`](activity-monitor/modules/message-router.md) §3 不变量 + §5 c4-receive 适配（含调 c4-send.js 流程）；[`health-engine.md`](activity-monitor/modules/health-engine.md) §3 catalog × HealthState × DB 路径矩阵；Phase 3 c4-receive 改造说明（§八）。

### I. zylos0t R6 TODO 2：Session restart continuation 降级 best-effort

**问题**：v2.1 §5.3.2 表述"c4 DB + c4-session-init 已经覆盖正确性边界"过强——v2.1 明确不做 unanswered-inbound 注入，只靠 c4-session-init 的 checkpoint summary + unsummarized / recent context。但 recent context 受 token 预算约束（典型 6 条），100+ pending 时不能完整暴露。

**收敛**：把 contract 拆为 3 句：

1. **C4 DB 保 accepted-message durability**——已 insertConv 的 inbound 不丢
2. **restart 后 best-effort continuation**——c4-session-init recent / unsummarized + agent 自治
3. **不承诺 unresolved-inbound completeness**——接受 residual UX risk（user 凭 unhealthy 时已收到的状态文案重发是兜底）

**为什么不补 unresolved-inbound 完整注入**：要求 100% 完整性等于回到 R3 引入 terminal_status / pending exposure 整套（参 §六.G #5）。本 TODO 走"诚实声明边界"的窄修订，把 production trade-off 写在 contract 里，避免假装承诺。

**落点**：[`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) §2 不变量 + §5 边界声明；本文件 §三.5。

---

## 七、模块实施档索引

每份模块档按 [`tech-doc-spec`](../.claude/skills/tech-doc-spec/SKILL.md) 8 项结构（职责边界 / 输入输出契约 / 数据结构 / 关键接口 / 错误处理 / 迁移策略 / 测试策略 / 跨模块依赖）独立可加载。本节给出索引；具体实施细节去对应模块档读。

| # | 模块档 | 涵盖模块 | 一句话核心 |
|---|--------|---------|----------|
| 1 | [`runtime-adapter.md`](activity-monitor/modules/runtime-adapter.md) | Adapter | DI 注入入口 + 6 类运行时接口（标识 / 进程 / 健康 / catalog / 差异 / 消息）；加新 runtime 流程 |
| 2 | [`signal-store-and-status-writer.md`](activity-monitor/modules/signal-store-and-status-writer.md) | SignalStore + StatusWriter | 13 状态文件统一快照层 + 对外 schema（含 `schema_version` / `unavailable_since`）|
| 3 | [`guardian.md`](activity-monitor/modules/guardian.md) | Guardian | 4 拉起条件 + 指数退避；bypass-once + marker 三场景 |
| 4 | [`health-engine.md`](activity-monitor/modules/health-engine.md) | HealthEngine | 4-state FSM + 3 层健康监控；catalog-driven dispatch × 5 recoveryAction × DB 路径矩阵；unknown 5min 升级 |
| 5 | [`tool-pipeline-watchdog-procsampler.md`](activity-monitor/modules/tool-pipeline-watchdog-procsampler.md) | ProcSampler + ToolPipeline + ToolWatchdog | 三模块物理共置；5-stage watchdog；60s 滑动窗冻结判定 |
| 6 | [`task-scheduler.md`](activity-monitor/modules/task-scheduler.md) | TaskScheduler | 注册式调度 + 7 任务清单；usage-monitor / usage-alerter 双 gate 拆分 |
| 7 | [`message-router.md`](activity-monitor/modules/message-router.md) | MessageRouter | 4 约束 C1~C4；4 路径（OK / Unhealthy / Probe-recovered / IPC-down）；**unhealthy `status='delivered'` + c4-send.js 投递**（§六.H 落点）|
| 8 | [`session-restart-continuation.md`](activity-monitor/modules/session-restart-continuation.md) | (跨模块契约) | restart 后 startup context 注入 + agent 自治续接边界；**best-effort 三句契约**（§六.I 落点）|
| 9 | [`c4-receive-adaptation.md`](activity-monitor/modules/c4-receive-adaptation.md) | (跨组件契约：comm-bridge) | c4-receive Phase 3 改造范围 + vs main 路径精确对比；MessageRouter IPC + c4-send spawn 协议 |

**移除的模块档**（R3+R4+R5 引入，R6 production rollback 决断后退出）：

- ❌ `c4-reliability-contract.md` — 三层契约（durability + terminal_status + unresolved-inbound exposure）整套；本方案下 durability 由 §三.2 + 模块档 7 cover，terminal_status / unresolved-inbound exposure 不进 baseline

---

## 八、迁移路线图 + 兼容性 + 回滚

### 8.1 落地阶段

| Phase | 范围 | 关键改动 |
|-------|------|---------|
| **Phase 0** | Watchdog 边界适配 | 内部语义不动；ToolPipeline 物理合并；Adapter DI 接管工具规则 |
| **Phase 1** | 基础设施 | 新建 SignalStore / StatusWriter / TaskScheduler + 7 任务文件；feature flag 挂接，独立可 ship |
| **Phase 2** | 状态模型 + 组件拆分 | 新建 Guardian + HealthEngine + 新主循环；catalog-driven dispatch + unknown 5min 升级；保留 legacy 入口作回滚路径 |
| **Phase 3** | 消息路由 + c4-receive 适配 | MessageRouter IPC；c4-receive 同步等 + unhealthy 路径 `insertConv('in', ..., 'delivered')` 显式覆盖 + spawn c4-send 投递 catalog.userMessage（§六.H 落地，详 [`c4-receive-adaptation.md`](activity-monitor/modules/c4-receive-adaptation.md)）；c4-dispatcher 适配新 health 值域 |
| **Phase 4** | Schema + 下游文案 | 对外状态文件 schema_version；c4-receive 按 unavailable_since 差分文案；web-console |
| **Phase 5** | 收尾 | 观察 1 周稳定后删除 legacy 入口；全量回归 |

具体每 Phase 的任务列表 / 测试矩阵 / 验收标准下放到对应 [模块实施档](activity-monitor/modules/) §6 迁移策略 + §7 测试策略。

### 8.2 兼容性

- **Hook 路径完全不变** → 用户 settings 无需修改
- **对外状态文件加 schema_version**，新增字段保持向后兼容；消费端遇未知 reason 退化通用文案不报错
- **AM 与 comm-bridge 同版发布**（monorepo 单包），无需灰度兼容窗口
- **config 保留旧字段** + 新增 per-runtime Grace 参数；usage 拆分采升级兼容路径 B（旧 config `usage_monitor_enabled=true` 时新版 default `usage_alert_enabled=false`，启动 warning 鼓励 opt-in）

### 8.3 回滚

PM2 启动参数切换回 legacy 入口即可，无需代码回滚。Phase 2 起 legacy 入口与新入口共存，Phase 5 才删除 legacy。

---

*主笔 zylos01；代码层细节 / 设计审查 zylos0t。本文件按 [`tech-doc-spec`](../.claude/skills/tech-doc-spec/SKILL.md) 两层格式（PR #501 R1 review 后规范）产出，并按 [`doc-coauthoring`](https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring) 工作流做 readability 重排版（v3 → v3.1）。*

*v2.1 是面向 reviewer 的详细稿；本 v3.1 是规范化的顶层方案档（去除字段 / 接口 / 测试细节，下放到 [模块实施档](activity-monitor/modules/)）。*
