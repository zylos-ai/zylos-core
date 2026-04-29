# ProcSampler

## 1. 组件定义

> 来源：顶层设计 §3.1

**职责**：通过 OS 级指标（pid 存活、context switch 计数）检测 runtime 进程是否冻结。

**输入**：runtime pid、`/proc` context switch 数据

**输出**：`proc-state.json`（冻结检测结果，供 SignalStore 下次 tick 读取）

**相关决策**：
- **D-25**：ProcSampler 检测到冻结后 kill 会话，下一 tick 自然进入 Offline → Guardian 拉起。frozen 不需要独立 ActivityState 枚举值，也不写入 agent-status.json 或日志。

## 2. 组件设计

### 接口定义

```javascript
class ProcSampler {
  constructor(sessionName: string, options?: { sampleInterval: number, frozenThreshold: number })
  setSessionName(name: string): void
  reset(): void
  tick(currentTime: number, opts?: { isActive: boolean }): void
  isFrozen(): boolean
  isAlive(): boolean | null
  getState(): ProcState
}
```

### 冻结检测算法

1. 每 10s 采样一次 context switch 计数（`/proc/<pid>/status`）
2. delta = 当前 - 上次
3. delta > 0 → 存活，重置 frozenCount
4. delta == 0 且 isActive（有活跃工具）→ frozenCount += sampleInterval
5. delta == 0 且非 active → 正常（idle 不算冻结）
6. frozenCount >= 60s → 冻结

### 冻结处理（D-25）

ProcSampler 检测到冻结后，由调用方（Monitor Orchestrator tick 循环）执行 `adapter.stop()` kill 会话。下一 tick Guardian 自然检测到 offline 并拉起。frozen 不写入 agent-status.json 或日志。

### 与其他组件的交互

- **Monitor Orchestrator** → 每次 tick 调用 `tick()`，检测到冻结后调用 `adapter.stop()`
- **SignalStore** → 下一 tick 读取 `proc-state.json`

### 常量

| 常量 | 值 | 说明 |
|------|------|------|
| SAMPLE_INTERVAL | 10s | 采样间隔 |
| FROZEN_THRESHOLD | 60s | 冻结判定阈值 |

## 3. 实施方案

**改动类型**：纯提取（已独立模块，无变更）

### 现有代码位置

已独立为 `scripts/proc-sampler.js`。

### 实施步骤

1. 确认现有 `proc-sampler.js` 接口与本文档定义对齐
2. 无需新增逻辑
3. 冻结后的 kill 动作由 Monitor Orchestrator 负责，ProcSampler 本身只检测
