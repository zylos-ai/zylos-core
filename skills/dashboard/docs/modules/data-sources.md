# 数据来源

## 模块职责

Dashboard 汇总 Zylos Core 的权威会话状态、本机运行指标和只读业务数据，写入自身数据库并通过 API、SSE 和页面展示。当前实现不是通用 Adapter/OTel 平台；数据入口由代码中的具体 collector 和 reader 明确定义。

## 当前状态与用量

`src/lib/core-state.js` 通过 Core 的 `session-state-reader.js` 读取当前 Origin（单会话模式下为当前会话）的身份、状态、活跃工具、上下文用量和账号用量。该路径是页面当前状态、context 和 rate limit 的权威来源，默认每秒刷新。

Dashboard 不再通过自己的 runtime hook 推断当前会话状态。Core 负责发布会话状态和 activity hook；升级流程会移除旧 Dashboard hook。

## Collector

| Collector | 数据来源 | 主要用途 | Runtime |
|---|---|---|---|
| `PM2Collector` | PM2 进程列表 | 服务状态、CPU、内存、重启次数 | 通用 |
| `SystemCollector` | 本机系统采样 | CPU、内存、磁盘 | 通用 |
| `StatuslineCollector` | Core 会话状态（session-state-reader）与账号用量 | context、成本、cache、rate limit | 通用 |
| `ConversationCollector` | Claude conversation JSONL | token、成本、工具与会话历史 | Claude |
| `CodexRolloutCollector` | Codex rollout JSONL | token、context、turn 与工具历史 | Codex |

Collector 把标准化后的样本写入 `dashboard.db`。页面展示指标时再由 `MetricResolver` 按固定来源链、runtime 和 freshness 选择样本；详见 [指标模型](metric-model.md)。

## 其他只读来源

- `CoreLogImporter` 导入 Core 生成的诊断/历史 JSONL，用于历史记录和排障，不替代 `CoreState` 的实时状态。
- `C4Reader` 只读通信数据，用于消息统计与通信视图。
- Scheduler reader 只读调度数据，用于任务状态与历史展示。
- Dashboard 自身数据库保存已采集指标、事件与聚合所需记录；维护方式见 [数据库维护](db-maintenance.md)。

## Hook 边界

仓库中仍保留 `hook-installer.js`、`hook-ingest.cjs` 等迁移兼容代码和测试夹具，但当前生产入口不会实例化 Dashboard hook installer。运行时 hook 的安装、升级与归属由 Core 管理；不要再把 Dashboard 配置成独立 hook owner。

## 安全边界

- 外部数据库按只读方式访问；Dashboard 的写入仅落在自己的数据目录和数据库。
- API 只暴露展示所需的状态、计数、时间戳和脱敏事件，不返回 prompt、消息正文、环境变量或工具原始输入。
- Collector 失败应降级单个来源，不应中断其他采集器或修改上游数据。
