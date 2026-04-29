# ProcSampler

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：通过 OS 级指标（pid 存活、context switch 计数）检测 runtime 进程是否冻结。

**输入**：runtime pid、`/proc` context switch 数据

**输出**：`proc-state.json`（冻结检测结果，供 SignalStore 下次 tick 读取）

**相关决策**：
- **D-25**：ProcSampler 检测到冻结后 kill 会话，下一 tick 自然进入 Offline → Guardian 拉起。frozen 不需要独立 ActivityState 枚举值，也不写入 agent-status.json 或日志。

## 2. 组件设计

### 功能清单

| 能力类别 | 功能 | 说明 |
|---------|------|------|
| **进程发现** | tmux PID 查询 | `tmux list-panes` 获取 pane PID |
| | 子进程定位 | `pgrep -P <panePid>` 获取 runtime 子进程 PID |
| | PID 变更检测 | PID 变化时自动重置采样基线 |
| **采样** | Linux 采样 | 读取 `/proc/<pid>/status` 的 voluntary + nonvoluntary context switches |
| | macOS 采样 | `top -l 1 -pid <pid> -stats pid,csw` 获取 CSW 计数 |
| | 定时采样 | 每 10s 一次（tick 每秒调用，内部 gate） |
| **冻结检测** | delta 计算 | 当前 context switch 总数 - 上次总数 |
| | 活跃判断 | delta > 0 → 存活；delta = 0 + isActive → 累积 frozenCount |
| | 空闲忽略 | delta = 0 但非 active（无活跃工具）→ 正常，不累积 |
| | 冻结判定 | frozenCount >= 60s → `isFrozen() = true` |
| **输出** | proc-state.json | 原子写入（write tmp → rename），每次采样更新 |
| | 外部读取 | `readProcState()` 导出函数供 dispatcher 读取（stale > 30s → null） |

### 冻结检测流程

```
tick(currentTime, { isActive })
  │
  ├─ 距上次采样 < 10s？ → 跳过
  │
  ├─ 查找 runtime PID
  │   └─ PID 未找到 → alive = null，写 proc-state，return
  │
  ├─ PID 变更？ → 重置基线（lastCtxTotal = null, frozenCount = 0）
  │
  ├─ 采样 context switches（Linux: /proc，macOS: top）
  │   └─ 采样失败 → alive = null，写 proc-state，return
  │
  ├─ 首次采样？ → 存储基线，alive = null，return
  │
  ├─ 计算 delta = current - last
  │   ├─ delta > 0
  │   │   └─ frozenCount = 0, alive = true
  │   ├─ delta = 0, isActive = true
  │   │   └─ frozenCount += 10s
  │   │       alive = (frozenCount < 60s)
  │   └─ delta = 0, isActive = false
  │       └─ frozenCount = 0, alive = true（idle 正常）
  │
  └─ 写 proc-state.json

Monitor Orchestrator 调用：
  if (procSampler.isFrozen()) {
    adapter.stop()     // kill session
    procSampler.reset()
    // 下一 tick Guardian 检测到 offline，自动拉起
  }
```

### 接口定义

```javascript
class ProcSampler {
  constructor({ sessionName: string, log: Function, sampleInterval?: number, frozenThreshold?: number })
  setSessionName(name: string): void      // runtime 切换时更新（自动 reset）
  reset(): void                           // 重置所有采样状态
  tick(currentTime: number, opts?: { isActive: boolean }): void  // 每 tick 调用
  isFrozen(): boolean                     // frozenCount >= threshold
  isAlive(): boolean | null               // true=活, false=冻结, null=数据不足
  getState(): ProcState                   // 当前状态快照
}

// 外部读取函数（供 dispatcher 等消费）
export function readProcState(): ProcState | null  // stale > 30s → null
```

### 与其他组件的交互

| 交互方 | 方向 | 方法/数据 | 用途 |
|-------|------|----------|------|
| **Monitor Orchestrator** | 调用 | `tick()` | 每 tick 驱动采样 |
| **Monitor Orchestrator** | 读取 | `isFrozen()` | 冻结时调用 `adapter.stop()` |
| **Adapter** | 读取 | `sessionName` | 构造时传入 tmux session 名称 |
| **SignalStore** | 消费 | `proc-state.json` | 下次 tick 读取（但当前架构中 proc-state 主要由 dispatcher 消费） |
| **ToolPipeline** | 间接 | `isActive` 参数来自 `apiActivity.active_tools > 0 && hookFresh` | 判断是否有活跃工具 |

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| SAMPLE_INTERVAL | 10s | 采样间隔 |
| FROZEN_THRESHOLD | 60s | 冻结判定阈值（6 次连续零 delta） |
| STALE_THRESHOLD | 30s | readProcState() 认为数据过期的阈值 |

## 3. 实施方案

**改动类型**：纯提取（已独立模块，无变更）

### 现有代码位置

| 现有位置 | 内容 |
|---------|------|
| `scripts/proc-sampler.js`（281行） | 完整实现：`ProcSampler` class + `readProcState()` |
| `activity-monitor.js:2007-2018` | Orchestrator 调用：`tick()` + `isFrozen()` → `adapter.stop()` |

### 实施步骤

1. 确认现有 `proc-sampler.js` 接口与本文档定义对齐 — **已对齐**
2. 无需新增逻辑
3. 冻结后的 kill 动作由 Monitor Orchestrator 负责，ProcSampler 本身只检测
