# Activity Monitor 全链路逻辑梳理

> 基于 `zylos-core` `main` 分支当前实现（`skills/activity-monitor/scripts/activity-monitor.js` v26 注释头）。  
> 本文描述的是“代码真实行为”，不是历史设计草案。

## 1. 目标与边界

`activity-monitor` 是一个常驻 PM2 守护进程，目标是让当前 runtime（Claude 或 Codex）在无人值守下保持可用，并在异常时自动恢复。

它负责四类事情：

1. 运行态监测：判断 `busy/idle/stopped/offline` 并写状态文件
2. 存活性校验：通过 heartbeat + C4 control queue 验证“功能可用”，不仅是进程存活
3. 自愈恢复：崩溃重启、失败回退、限流冷却、卡死检测、API 错误快恢复
4. 定时维护：健康检查、每日升级、每日 memory commit、每日升级检查、usage 监控

## 2. 核心组件

1. 主循环：`skills/activity-monitor/scripts/activity-monitor.js`
2. 心跳状态机：`skills/activity-monitor/scripts/heartbeat-engine.js`
3. 日调度器：`skills/activity-monitor/scripts/daily-schedule.js`
4. Hook 活动追踪：`skills/activity-monitor/scripts/hook-activity.js`
5. Claude statusLine 上下文监控：`skills/activity-monitor/scripts/context-monitor.js`
6. 冻结检测：`skills/activity-monitor/scripts/proc-sampler.js`
7. Runtime 适配层：
   - `cli/lib/runtime/claude.js`
   - `cli/lib/runtime/codex.js`
8. Runtime 心跳探针：
   - `cli/lib/heartbeat/claude-probe.js`
   - `cli/lib/heartbeat/codex-probe.js`

## 3. 启动初始化流程（`init()`）

启动时主流程如下：

1. 清理 `TMUX` 环境变量，避免重启后继承到失效 socket
2. 创建 `~/zylos/activity-monitor/` 目录
3. 读取 runtime 配置并装配 `adapter`（Claude/Codex）
4. 初始化 `ProcSampler`（冻结检测）
5. 从 `agent-status.json` 读取初始 `health`，初始化 `HeartbeatEngine`
6. 若初始状态是 `rate_limited`，恢复 `cooldown_until` 与 `rate_limit_reset`
7. 初始化 3 个 `DailySchedule`：
   - `daily-memory-commit`（03:00）
   - `daily-upgrade`（05:00，Claude only）
   - `daily-upgrade-check`（06:00）
8. 恢复 usage 监测状态（`usage.json`）
9. 若 adapter 提供 context monitor（Codex），启动 30s 轮询
10. 10 秒后尝试清理“另一个 runtime”的 tmux 会话（避免双 runtime 并存）

## 4. 主循环（每 1 秒）

主循环 `monitorLoop()` 每秒运行一次，分三条分支：

1. `offline`：tmux session 不存在
2. `stopped`：tmux 存在，但 runtime 进程不存在
3. `running`：runtime 进程存在

### 4.1 offline/stopped 分支

共同点：

1. 写 `agent-status.json`（`state=offline/stopped`）
2. 消费 `user-message-signal.json`（有用户消息时解除某些抑制）
3. 计算 guardian 重启延迟后决定是否 `startAgent()`
4. 驱动 heartbeat 状态机（`engine.processHeartbeat(false, now)`）
5. 运行 daily memory commit 调度

重启延迟公式（guardian 进程级 backoff）：

`restartDelay = min(BASE_RESTART_DELAY * 2^consecutiveRestarts, MAX_RESTART_DELAY)`

默认参数：

- `BASE_RESTART_DELAY=5s`
- `MAX_RESTART_DELAY=60s`

### 4.2 running 分支

运行态会做以下事情：

1. 复位 `startupGrace/notRunningCount`
2. 若稳定运行超过 60 秒，清空 `consecutiveRestarts`
3. 采集活动信号并判定 `busy/idle`
4. 写 `agent-status.json`
5. 执行冻结检测（`ProcSampler`）
6. 执行 3 分钟周期即时探针（非 `engine` 的 2 小时安全网）
7. 执行 15 秒主动 API 错误扫描（需连续 2 次命中）
8. 驱动 heartbeat 状态机（`engine.processHeartbeat(true, now)`）
9. 调度健康检查 / 日任务 / usage 检查

## 5. 活动信号与 busy/idle 判定

活动时间戳优先级：

1. Claude 下优先对话文件 mtime（`~/.claude/projects/.../*.jsonl`）
2. 失败时回退 tmux `window_activity`
3. 再失败回退当前时间（兜底）
4. 若 hook 报告 `active=true` 且更“新”，覆盖活动时间戳

Hook 数据来自 `api-activity.json`，关键字段：

- `active_tools`
- `active`
- `in_prompt`
- `updated_at`

状态判定规则：

- `active_tools > 0` 或 `inactive_seconds < IDLE_THRESHOLD(3s)` => `busy`
- 否则 => `idle`

并且有 hook 新鲜度保护：

- `api-activity.json` 超过 60 秒未更新，`active_tools` 视为陈旧，不参与“确认活跃”

## 6. Heartbeat 状态机（功能存活性）

`HeartbeatEngine` 维护健康状态：

- `ok`
- `recovering`
- `down`
- `rate_limited`
- `auth_failed`（由 guardian 的认证失败路径设置）

### 6.1 探针与 pending

探针通过 C4 control queue 下发：

1. `enqueueHeartbeat()` 发送 `"Heartbeat check."`，写 pending 文件
2. agent 执行 `c4-control ack --id <id>`
3. `getHeartbeatStatus()` 轮询状态
4. done => 成功；timeout/failed/not_found => 失败

pending 超时保护：

- pending 状态最长容忍 10 分钟（`maxPendingAge=600s`）

fast API error 检测：

- pending 超过 30 秒后，每 15 秒扫描一次 tmux pane
- 命中 API error 即提前失败恢复，不等 ack deadline

### 6.2 状态机策略

1. `ok`：失败即进入 `recovering`（无 verify phase）
2. `recovering`：指数退避重试，失败持续超 1 小时降级为 `down`
3. `down`：每 60 分钟做一次探测
4. `rate_limited`：禁止 guardian 重启，等待冷却到期再转 `recovering`
5. `auth_failed`：允许用户消息触发即时重试

恢复重试退避（heartbeat 级别）：

`delay = min(3600, 60 * 5^(n-1))`

即：`60s -> 300s -> 1500s -> 3600s -> ...`

过程信号加速（false->true）：

- 若检测到进程从不运行变为运行，等待 30 秒后立即发加速探针

### 6.3 定时探针（两层）

1. 心跳安全网：`HEARTBEAT_INTERVAL=7200s`（2 小时）
2. 运行态即时探针：每 3 分钟（`PERIODIC_PROBE_INTERVAL=180s`）

3 分钟探针会在以下条件触发：

- `health=ok`
- 不在 launch grace（启动后 180 秒内不探）
- `active_tools=0`（不打断工具执行）

## 7. Guardian 重启策略（`startAgent()`）

触发重启前会做：

1. 维护脚本冲突检测（目前只识别 Claude 维护脚本）
2. `adapter.checkAuth()` 实时认证检查
3. 认证失败时：
   - 进入 `auth_failed`
   - 抑制 3 分钟重试
   - 每小时最多发一次高优先级告警控制消息

认证通过后：

1. 增加 `consecutiveRestarts`
2. 设置 `startupGrace=30`（避免启动窗口被立即判死）
3. 清理陈旧 heartbeat pending 与旧 context 临时文件
4. 重置 hook 状态文件
5. 异步 `adapter.launch()`（不阻塞主循环）
6. 若无 session-start hook，fallback enqueue 启动提示控制消息

## 8. ProcSampler 冻结检测

`ProcSampler` 每 10 秒采样一次上下文切换计数：

- Linux：`/proc/<pid>/status` 的 voluntary + nonvoluntary ctxt switches
- macOS：`top -l 1 -pid <pid> -stats pid,csw`

判定规则：

- 仅在 `isActive=true`（fresh hook 且 `active_tools>0`）时累计冻结时间
- 连续 60 秒 `delta=0` => 判定 frozen
- frozen 后直接 `adapter.stop()`，交给 guardian 下一轮拉起

同时写 `proc-state.json` 供外部（如 dispatcher）读取。

## 9. 定时任务矩阵

| 任务 | 触发 | 额外门控 | 行为 |
| --- | --- | --- | --- |
| 健康检查 | 每 6 小时 | `agentRunning && health=ok` | enqueue 控制消息，让 agent 执行 PM2/磁盘/内存检查并写日志 |
| Daily memory commit | 每天 03:00 | 无 health 门控 | 直接执行 `zylos-memory/scripts/daily-commit.js` |
| Daily upgrade | 每天 05:00 | `health=ok` 且 runtime=Claude | enqueue `upgrade-claude` 控制消息 |
| Daily upgrade check | 每天 06:00 | `health=ok` | 后台 spawn `upgrade-check.js`，检查 core/components 可升级版本并通知 |
| Usage monitor | 配置化周期（默认 1h） | Claude + idle + 活跃时段 + 无 pending 控制消息 | 自动 `/usage` 解析并按阈值告警 |

### 9.1 Memory Sync 触发职责拆分

下面这张表用于区分“谁负责检测/提示”与“谁真正执行 sync”，避免把 `daily-memory-commit` 和 `Memory Sync` 混为一件事。

| 职责 | 负责组件 | 触发条件 | 实际动作 |
| --- | --- | --- | --- |
| 检测未汇总对话是否超阈值 | `comm-bridge` (`c4-session-init.js`) | session init 时 `unsummarized.count > CHECKPOINT_THRESHOLD` | 计算范围并判定 `needsSync=true` |
| 向会话注入“需要同步”提示 | `comm-bridge` (`c4-session-init.js`) | `needsSync=true` | 在启动注入文本追加 `Please use zylos-memory skill ...` |
| 执行 Memory Sync 主流程 | 当前 runtime agent（按 `zylos-memory/SKILL.md`） | 收到/识别提示后 | 拉取 unsummarized、更新 memory 文件、生成 summary |
| 写入 C4 checkpoint | `comm-bridge` CLI (`c4-checkpoint.js create`) | Memory Sync 完成且有新对话 | 按 sync 结果写 checkpoint |
| 每日 memory 快照提交 | `activity-monitor` (`daily-memory-commit`) | 每天 03:00 | 执行 `zylos-memory/scripts/daily-commit.js` 做本地 git snapshot |

结论：`activity-monitor` 不直接执行 Memory Sync 的 summary/checkpoint 逻辑；它只负责每日快照任务与会话恢复链路。

## 10. Context 监控与会话轮换

### 10.1 Claude 路径（statusLine）

`context-monitor.js` 作为 statusLine command 在每次 turn 后执行：

1. 写 `statusline.json`
2. 记录会话成本到 `context-monitor-state.json` / `cost-log.jsonl`
3. 当 `used_percentage >= 70` 且超过 5 分钟 cooldown 时：
   - enqueue `new-session` 控制消息（`priority=1` + `bypass-state`）

### 10.2 Codex 路径（polling）

Codex adapter 提供 `CodexContextMonitor`：

1. 每 30 秒轮询 context 使用率（JSONL token_count 优先，SQLite 回退）
2. 超阈值（默认 75%）触发 onExceed：
   - enqueue `new-session` 控制消息（`priority=1` + `bypass-state`）
   - 后续由 runtime 内执行 `new-session` skill 完成 handoff

## 11. 关键状态文件

默认都在 `~/zylos/activity-monitor/`：

1. `agent-status.json`：主状态（busy/idle/offline/stopped + health）
2. `activity.log`：主日志（每日截断到 500 行）
3. `api-activity.json` / `hook-state.json`：hook 活动状态
4. `heartbeat-pending.json` / `codex-heartbeat-pending.json`：心跳 pending
5. `pending-channels.jsonl`：不可用期间被拒收的 channel 列表（恢复后通知）
6. `proc-state.json`：冻结检测状态快照
7. `health-check-state.json`：最近健康检查时间
8. `daily-upgrade-state.json`：每日升级去重
9. `daily-memory-commit-state.json`：每日 memory commit 去重
10. `upgrade-check-state.json`：每日升级检查去重
11. `usage.json`：usage 采样与告警状态
12. `statusline.json` / `context-monitor-state.json` / `cost-log.jsonl`：Claude context 监控相关

## 12. 运行时差异（Claude vs Codex）

1. tmux session 名不同：`claude-main` / `codex-main`
2. 心跳 pending 文件不同：`heartbeat-pending.json` / `codex-heartbeat-pending.json`
3. `detectRateLimit`：
   - Claude probe 有真实检测
   - Codex probe 固定返回 `detected=false`
4. context 轮换路径不同：
   - Claude 用 statusLine + `new-session` 控制消息（优雅）
   - Codex 用 polling + `new-session` 控制消息（skill 驱动切换）
5. Daily upgrade 只对 Claude 生效

## 13. 当前实现里的已知边界

1. 维护脚本检测目前仅覆盖 Claude（代码内有 TODO）
2. usage 监控只在 Claude runtime 启用
3. `activity-monitor` 与 runtime adapter 仍有并行逻辑（注释中标记“待迁移阶段”）
