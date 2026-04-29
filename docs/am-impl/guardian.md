# Guardian

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：守护 runtime 进程存活：检测进程退出后无条件拉起，拉起失败时按退避策略递增延迟重试。

**输入**：snapshot、guardian 内部状态（上次拉起时间、连续失败计数）

**输出**：调用 Runtime Adapter 拉起 runtime

**相关决策**：
- **D-1**：ActivityState 与 HealthState 双层正交。Guardian 不读 HealthState 决定是否拉起。
- **D-20**：Guardian 原则为「Offline → 无条件拉起进程」，不读 HealthState。拉起失败后通过退避逻辑（递增延迟）避免无限快速重启。进程状态与健康状态完全正交，Guardian 不因 RateLimited 或任何 HealthState 阻止拉起。
- **D-21**：PM2 重启 AM 自身时，Guardian 不从磁盘恢复退避计数器。AM 冷启动 = Guardian 全新开始，立即尝试拉起 tmux。
- **D-33**：保留 startupGrace (30s)，Guardian 拉起 runtime 后的启动保护窗口，防止 runtime 初始化期间被误判为 offline。

## 2. 组件设计

### 接口定义

```javascript
class Guardian {
  tick(snapshot: Snapshot): void   // 每次 tick 调用，检测是否需要拉起
}
```

### 行为规则

1. **无条件拉起**（D-20）：进程不存在（offline/stopped）→ 尝试拉起，不读 HealthState
2. **退避策略**：`restartDelay = min(BASE_RESTART_DELAY × 2^consecutiveRestarts, MAX_RESTART_DELAY)`
   - 序列：5s, 10s, 20s, 40s, 60s, 60s, ...
3. **退避重置**：agent 连续运行超过 BACKOFF_RESET_THRESHOLD 后重置 consecutiveRestarts
4. **启动保护**（D-33）：拉起成功后设置 startupGrace = 30 ticks，期间跳过 offline 检测
5. **维护等待**：拉起前检查是否有正在进行的 `restart-claude`、`upgrade-claude`、`claude.ai/install.sh` 进程，等待最多 300s
6. **Auth 抑制**：auth 失败后抑制 180s 不重试，user message signal 可清除抑制

### 内部状态

```javascript
{
  notRunningCount: number,         // 进程未运行的 tick 计数
  consecutiveRestarts: number,     // 连续重启次数（退避指数）
  stableRunningSince: number,      // 连续运行起始时间（epoch seconds）
  startupGrace: number,            // 启动保护倒计时（ticks）
  startAgentInProgress: boolean,   // 防止并发拉起
  authRetrySuppressedUntil: number,// auth 失败抑制截止时间
}
```

### 与其他组件的交互

- 调用 `adapter.launch()` 拉起 runtime
- 调用 `adapter.isRunning()` / `tmuxHasSession()` 检测进程存活
- 读取 `user-message-signal.json` 清除 auth 抑制
- **不读取** HealthEngine 状态（D-1、D-20）

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| BASE_RESTART_DELAY | 5s | 初始重启延迟 |
| MAX_RESTART_DELAY | 60s | 最大重启延迟 |
| BACKOFF_RESET_THRESHOLD | 60s | 连续运行多久后重置退避 |
| STARTUP_GRACE_TICKS | 30 | 启动保护 tick 数 |
| MAINTENANCE_WAIT_TIMEOUT | 300s | 维护等待超时 |
| AUTH_RETRY_SUPPRESSION | 180s | Auth 失败抑制时间 |

## 3. 实施方案

**改动类型**：纯提取

### 现有代码位置

从 `activity-monitor.js` 的 offline/stopped 分支提取。

### 实施步骤

1. 创建 `scripts/guardian.js`
2. 提取 offline/stopped 分支的所有逻辑：进程存活检测、拉起、退避、启动保护、维护等待、auth 抑制
3. 内部状态全部为运行时状态，AM 冷启动时重置为零（D-21）
4. 确保不引入任何 HealthEngine 依赖（D-1、D-20）
