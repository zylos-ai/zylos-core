# Zylos Dashboard — 总方案

## 背景与问题

zylos agent 运行时积累了丰富的运行数据——状态、成本、工具调用、通信、任务调度——但分散在十余个 JSON 文件、JSONL 日志、SQLite 数据库和 PM2 进程中。运维者靠 `cat`、SQL 查询和 CLI 命令逐个查看，缺乏统一入口。

问题不是"数据不够"，而是"观测成本太高"：

- **状态碎片化**：agent 是否健康、context 是否快满、成本是否异常，需要分别打开不同文件
- **跨 runtime 不一致**：Claude Code 和 Codex CLI 提供的可观测性数据格式完全不同，没有统一的指标模型
- **缺乏趋势**：单点查看无法发现成本走势、工具失败率变化、LLM 延迟劣化等时序信号

Dashboard 要解决的核心问题：**用一个 Web 界面覆盖 zylos agent 的全部运行状态，无论底层 runtime 是什么**。

## 设计目标

### 核心目标

1. **状态总览**：一屏看到 agent 当前状态、健康度、活跃工具、context 使用率
2. **成本追踪**：session / 日 / 周 / 月级别的 token 和成本统计，含趋势
3. **工具监控**：调用频率、耗时分布、成功/失败率、时间线
4. **通信概览**：各渠道消息量、响应时间分布
5. **任务调度**：计划任务执行状态、成功率、下次执行时间
6. **服务健康**：PM2 服务运行状态、重启次数、内存/CPU
7. **Multi-runtime OTel**：接入 Claude Code 和 Codex CLI 原生遥测，实现请求级追踪

### 非目标

- **不是控制面板**：Dashboard 是纯观测层，不执行写操作（不修改配置、不重启服务、不发消息）
- **不修改现有组件**：零侵入 activity-monitor、scheduler、comm-bridge 的代码
- **不是外部 SaaS**：所有数据本地存储，不发送到第三方
- **不做跨实例汇聚**（Phase 3 之前）：当前聚焦单实例可观测性

## 设计原则

### 只读观测，不改变现有架构

Dashboard 是纯粹的消费者。它读取现有 activity-monitor 写入的状态文件，查询已有的 SQLite 数据库，接收 runtime 发出的 OTel 信号——但不向任何上游系统写入任何数据。这保证了 Dashboard 的引入和移除对 zylos 核心运行逻辑零影响。

### 统一指标模型，不是数据来源拼盘

用户看到的是面向业务的统一指标（agent 是否健康、一次交互耗时多少、成本趋势如何），不按底层数据获取途径（遥测 / hook / 状态文件）拆分版面。数据来源只是指标的 metadata，用于降级提示而非界面结构。

### 多 runtime 并集覆盖

同时支持 Claude Code 和 Codex CLI runtime。指标集取两个 runtime 的并集：某 runtime 不支持的指标标记为 unsupported，不假补数据。用户切 runtime 后 Dashboard 自动适配可用指标集。

### 渐进增强

Phase 1 只读已有文件，零侵入即可运行。Phase 2 接入 OTel 获得更深的观测能力。每个 phase 独立可用，不依赖后续 phase。

### 可换肤的前端

UI 通过 CSS Custom Properties 实现主题分离。所有视觉元素（颜色、间距、图表配色）绑定到语义化变量（如 `--bg-surface`、`--chart-palette-1`），切换皮肤只需翻转根元素的 `data-theme` 属性。每个主题是一个独立的 CSS 块，新增皮肤不需要修改 JavaScript。

### zylos 组件规范

Dashboard 是 zylos 组件，遵循 zylos-component-template 规范：ESM only、SKILL.md v2 frontmatter、lifecycle hooks（post-install / pre-upgrade / post-upgrade）、代码与数据分离（skill 目录放代码，components 目录放运行时数据）、PM2 服务管理、HTTP Base Path（X-Forwarded-Prefix）支持。

## 架构

### 系统上下文

```
┌────────────┐     OTel OTLP      ┌────────────────────┐
│ Claude Code│────────────────────▶│                    │
│ / Codex CLI│                     │  Zylos Dashboard   │
└────────────┘                     │  (观测层)           │
                                   │                    │
┌────────────┐     文件 / DB       │                    │
│ activity-  │────────────────────▶│                    │
│ monitor    │                     └────────┬───────────┘
└────────────┘                              │
                                            │ HTTPS
┌────────────┐     SQLite readonly          ▼
│ comm-bridge│─────────────────▶   ┌────────────────────┐
│ scheduler  │                     │   Browser (Web UI)  │
└────────────┘                     └────────────────────┘
```

Dashboard 是 zylos 生态中的纯观测节点：不向任何上游写入，只读取和接收数据。

### 容器视图

Dashboard 由两个容器组成：

**API Server（Node.js, PM2 服务）**
- 统一 REST API + SSE 实时推送
- 内嵌轻量 OTel OTLP 接收端（Phase 2）
- 挂在 Caddy 反代的 `/dashboard/` 路径下

**Web UI（Vanilla JS + Chart.js）**
- 静态前端，零构建
- SSE 推送 + REST 拉取 + polling 兜底

### 核心组件

API Server 内部由三层组成：**Adapter → Resolver → API**。

```
┌───────────────────── API Server ─────────────────────┐
│                                                       │
│  REST API + SSE        ← 面向前端的统一接口            │
│       │                                               │
│  ┌────┴─────┐                                         │
│  │ Resolver │          ← 面向指标的仲裁层              │
│  └────┬─────┘            per-metric 选出最佳数据源     │
│       │                                               │
│  ┌────┴──────────────────────────────────────────┐    │
│  │              Adapter Layer                     │    │
│  │                                               │    │
│  │  FileAdapter     StatusLineAdapter  SQLiteAdapter  │
│  │  PM2Adapter      HookAdapter        TelemetryAdapter│
│  └───────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

- **Adapter**：封装一种数据来源。每个 adapter 声明自己支持哪些指标（capability）、对每个指标返回数据和可用性状态（availability）
- **Resolver**：接收指标查询请求，收集所有 adapter 的结果，按 freshness > source priority 排序选出最佳答案
- **API / SSE**：将 resolver 结果暴露为 REST 端点和实时事件流

### 数据流

正常路径（以 agent 状态为例）：

```
runtime hook → activity-monitor 写入状态文件
                        │
Dashboard adapter ── fs.watch 检测变更 ── resolver 选出最佳来源
                        │
              REST 返回指标值 + 来源信息 + 可用性状态
                        │
              SSE 推送变更通知 → 浏览器更新状态灯
```

降级路径（以 token 消耗为例）：

```
resolver 查询所有 adapter：
  遥测 adapter → 5 分钟无数据（stale）
  状态文件 adapter → 2 秒前更新（ok）

freshness 优先于 source priority → 选中状态文件 adapter
→ 前端：数值正常展示 + 黄灯提示"数据来源降级至状态文件"
```

Resolver 的完整排序规则、输出结构和更多示例见 → [指标模型模块文档](modules/metric-model.md)

### 统一指标模型

Dashboard 的核心抽象是统一指标模型。所有指标对用户呈现统一的语义，底层由哪个 adapter 提供由 resolver 自动决定。

每个指标对每个 runtime 有两层状态：

- **capability**（静态，文档定义）：supported / supported-beta / unsupported / planned
- **availability**（动态，resolver 实时判断）：ok / degraded / stale / missing / error

前端根据这两层状态决定展示方式：unsupported 灰态隐藏、ok 正常、degraded/stale 黄灯、error 红灯。

当前指标目录包含 18 个统一指标，覆盖状态、成本、工具、性能、通信、任务六个域。每个指标的 resolver chain 定义了 adapter 优先级：**telemetry > hook > 状态文件**，但 freshness 优先于 source priority。

完整指标目录、resolver 规则、freshness 阈值见 → [指标模型模块文档](modules/metric-model.md)

### Adapter 层

六个 adapter 按数据来源分工：

| Adapter | 数据来源 | 引入 Phase | 职责 |
|---------|---------|-----------|------|
| FileAdapter | activity-monitor JSON/JSONL | Phase 1 | 状态文件和事件日志读取 |
| StatusLineAdapter | statusline.json | Phase 1 | Claude runtime 的 context/cost/token 实时状态 |
| SQLiteAdapter | c4.db, scheduler.db | Phase 1 | 通信记录和任务调度数据（只读） |
| PM2Adapter | pm2 jlist | Phase 1 | 进程级监控 |
| HookAdapter | Hook 事件流 | Phase 2 | 直接接收 runtime hook 事件，替代文件轮询 |
| TelemetryAdapter | OTel OTLP | Phase 2 | 接收 Claude Code 和 Codex CLI 的原生遥测 |

每个 adapter 实现统一的 capabilities / resolve / health 接口。TelemetryAdapter 内部按 runtime 分 codec：Claude 主信号走 metrics pipeline，Codex 主信号走 log-based aggregation——这是两个 runtime OTel 实现的根本架构差异。

各 adapter 详细规格见 → [数据源与 Adapter 模块文档](modules/data-sources.md)

### 安全模型

**数据只读保护**：SQLite 三层只读（URI readonly + fileMustExist + PRAGMA query_only），文件系统只 watch 不写入。

**访问控制**：与 zylos-pages 一致的 cookie-based session auth。scrypt 密码哈希、内存 session 存储、HttpOnly+SameSite=Strict cookie、暴力破解防护（per-IP lockout + 全局限速）。`/api/health` 和静态资源不需要登录，其余 API 和页面均需认证。CLI 支持 Bearer token。Server 绑定 localhost，外部走 Caddy 反代。

**Base Path**：遵循 zylos-component-template COMPONENT-SPEC.md §4 规范，通过 `X-Forwarded-Prefix` 支持 Caddy strip_prefix 反代下的正确 URL 生成。从 zylos-pages 移植 `browser-base.js` 模块，严格校验 prefix 值。

**敏感信息隔离**：API 只返回聚合数据（状态、计数、时间戳、成本），不返回 prompt 原文、.env 值、消息正文。OTel 数据本地存储，不发外部。

**OTel 安全清单**（Phase 2 前必过）：prompt redaction 验证、collector 仅 localhost、payload 字段审计、exporter flush 验证。

完整安全规格（含 auth 实现细节和 base path 规格）见 → [部署与安全模块文档](modules/deployment.md)

## Phase 规划

### Phase 1 — MVP（1-2 周）

**目标**：零侵入，只读已有数据，立即可用。

**数据来源**：状态文件 + JSONL + SQLite + PM2 + StatusLine。

**功能面板**：
- 实时状态面板（agent 状态灯、当前工具、context 使用率、配额）
- 成本分析（日/周/月趋势、单 session 分布）
- 工具调用分析（频率排行、耗时分布、成功率、时间线）
- 通信概览（渠道消息量、趋势、响应时间）
- 任务调度监控（活跃任务、执行历史、下次执行）
- PM2 服务健康（运行状态、重启次数、内存/CPU）

**依赖**：P0 验证清单通过即可上线。Dashboard 自身无外部依赖。Codex runtime 的 context_usage 在 Phase 1 为 degraded 状态（上游 activity-monitor 尚未写入 state file），不阻塞上线。

### Phase 2 — Multi-Runtime OTel + Hook（1-2 周）

**目标**：接入两个 runtime 的原生遥测，实现请求级深度可观测性。

**新增能力**：
- 请求追踪瀑布图（Interaction → LLM request → Tool 链路）
- LLM 延迟分析（P50/P95/P99）
- Prompt cache 命中率追踪
- 首 token 延迟（TTFT）
- 异常检测（超时、高 token 消耗、连续失败）
- HookAdapter 直接 ingestion（替代文件轮询）

**依赖**：P1 验证清单通过、OTel 安全清单通过。

### Phase 3 — 多实例（TBD）

**目标**：多个 zylos 实例的集中监控。

多 agent 状态对比、跨实例成本汇总、性能对比。通过 `OTEL_RESOURCE_ATTRIBUTES` 区分实例。

## 关键决策

| 决策 | 结论 | 关键 tradeoff |
|------|------|--------------|
| 架构定位 | 纯只读观测层 | 放弃控制能力，换取零侵入和安全性 |
| 前端技术 | Vanilla JS + Chart.js + CSS Custom Properties 主题层 | 零构建即开即用，CSS 变量支撑皮肤切换（~25 个语义 token），切换主题只需翻转 `data-theme` 属性。评估过 Preact/Vue CDN/Svelte，均不值得引入框架开销 |
| 实时推送 | SSE + polling fallback | 只读场景不需要 WebSocket 双向通信，SSE 更轻量 |
| 数据库访问 | SQLite 三层只读 | 性能有代价（无法用 WAL 优化），但绝对防止意外写入 |
| 文件监控 | fs.watch + 5-10s polling 兜底 | inotify 在 temp+rename 模式下不可靠，polling 兜底保正确性 |
| OTel 时机 | Phase 2，不进 MVP | MVP 零侵入可以更快验证价值，OTel 需要额外配置和验证 |
| 多 runtime | 指标并集覆盖，unsupported 不假补 | 每个 runtime 有不可用指标，但不会误导用户 |
| 指标来源 | telemetry > hook > 状态文件 | 遥测精度最高但依赖配置，状态文件兜底 |
| Resolver 仲裁 | freshness > source priority | fresh 低优来源优于 stale 高优来源，优先保证数据新鲜度 |
| 认证 | 与 zylos-pages 一致的 cookie-based session auth（scrypt 密码、内存 session、暴力破解防护）。URL token 默认关 | URL token 有 Referer/日志泄露风险。复用 Pages 验证过的 auth 方案降低实现风险 |
| Base Path | X-Forwarded-Prefix + browser-base.js（从 zylos-pages 移植） | 遵循 zylos-component-template COMPONENT-SPEC.md §4 规范 |
| OTel 存储 | 本地 SQLite | 不污染已有数据库，不依赖外部 SaaS |
| TelemetryAdapter 分 codec | Claude=metrics pipeline, Codex=log-based aggregation | 两个 runtime OTel 架构根本不同，不强行统一 |
| capability/availability 拆两层 | 静态能力 vs 动态状态 | 避免"capability=supported 但此刻收不到数据"的混淆 |

## 已决议的开放问题

| 问题 | 决议 |
|------|------|
| OTel 数据量管理 | 保留时长可配置，默认全保留。查询维度支持小时/天/7天/30天。Metrics 和 logs 全量保留；traces 默认 1:10 采样（可配置）。超 30 天的 traces 和 logs 自动归档 |
| 多实例数据汇聚 | Dashboard 自身闭环，不依赖 HXA。Push vs pull 方式延迟到 Phase 3 实施时决定 |
| Codex OTel 字段映射 | Phase 2 实测建立映射表，按 data-sources.md 中已验证的字段为准 |
| Codex context_usage | 不等 activity-monitor 迭代。Phase 1 标记为 degraded，Dashboard 自身不阻塞 |
| llm_latency 语义对齐 | 如果两个 runtime 的延迟语义不等价，各成一套指标，选择性展示（不强行统一为一个数字） |

## 与 COCO Dashboard 的关系

| | Zylos Dashboard | COCO Dashboard |
|---|---|---|
| 目标用户 | Agent 运维者（开发团队） | COCO 平台客户（企业管理者） |
| 监控对象 | 单个 zylos agent 实例 | 企业 AI 员工管理 |
| 数据来源 | 本地文件/DB/OTel | COCO 平台 API |
| 部署 | 每个 zylos 实例自带 | COCO 平台 SaaS |

Zylos Dashboard 的 agent 可观测性探索可反哺 COCO Dashboard 的 AI Ops 模块。

## 模块文档索引

| 模块 | 职责 | 文档 |
|------|------|------|
| 指标模型 | 统一指标目录、capability/availability 模型、resolver 引擎、freshness 规则 | [metric-model.md](modules/metric-model.md) |
| 数据源与 Adapter | OTel 事件/指标目录（Claude + Codex）、hook 事件对比、文件数据源、adapter 接口规格 | [data-sources.md](modules/data-sources.md) |
| 部署与安全 | 组件目录结构、Caddy 路由、PM2 服务、认证、只读保护、OTel 安全清单、验证清单 | [deployment.md](modules/deployment.md) |

原始素材与历史实施计划已迁至内部文档仓库。

---

*文档版本: v3.2*
*创建日期: 2026-05-02*
*最后更新: 2026-05-08 — 新增 Auth 实现规格和 Base Path 规格*
*作者: zylos01*
