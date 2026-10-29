# 部署与安全

> 所属总方案：[solution.md](../solution.md)

## 模块职责

Dashboard 的组件结构、部署配置、安全保护和验证计划。

## 组件目录结构

遵循 zylos-component-template 规范：代码在 skill 目录（升级时覆盖），运行时数据在 components 目录（升级时保留）。

```
~/zylos/.claude/skills/dashboard/
├── SKILL.md                     # v2 frontmatter（name/version/type/lifecycle/http_routes/config）
├── README.md                    # 功能说明和安装指南
├── CHANGELOG.md                 # 版本变更记录
├── package.json                 # ESM ("type": "module")
├── package-lock.json
├── ecosystem.config.cjs         # PM2 配置（CommonJS，PM2 要求）
├── hooks/
│   ├── post-install.js          # 创建 data dir、默认 config、检查 env
│   ├── pre-upgrade.js           # 备份关键数据
│   └── post-upgrade.js          # config schema 迁移
├── src/
│   ├── index.js                 # PM2 服务入口（graceful shutdown）
│   ├── lib/
│   │   ├── config.js            # config loader + hot-reload
│   │   ├── resolver.js          # Metric Resolver 引擎
│   │   └── sse.js               # SSE 实时推送
│   ├── adapters/
│   │   ├── file-adapter.js      # JSON/JSONL 状态文件
│   │   ├── statusline-adapter.js # statusline.json (Claude only)
│   │   ├── sqlite-adapter.js    # c4.db + scheduler.db (readonly)
│   │   ├── pm2-adapter.js       # pm2 jlist
│   │   ├── hook-adapter.js      # Hook 事件流 (Phase 2)
│   │   └── telemetry-adapter.js # OTel OTLP (Phase 2)
│   └── otel/                    # Phase 2
│       ├── collector.js         # OTLP 接收端
│       ├── claude-codec.js      # claude_code.* 解析
│       ├── codex-codec.js       # codex.* 解析
│       └── storage.js           # OTel → SQLite
├── public/
│   ├── index.html
│   ├── css/
│   │   ├── tokens.css           # CSS Custom Properties 语义变量定义
│   │   ├── themes/
│   │   │   ├── default.css      # 默认主题
│   │   │   └── dark.css         # 暗色主题
│   │   └── dashboard.css        # 布局和组件样式（引用 token 变量）
│   └── js/
│       ├── app.js
│       ├── charts.js
│       ├── events.js            # SSE + polling fallback
│       └── theme.js             # 主题切换逻辑
└── references/

~/zylos/components/dashboard/
├── config.json                  # 运行时配置（升级保留）
├── dashboard.db                 # OTel 数据 (Phase 2)
└── logs/
    ├── out.log
    └── error.log
```

数据库保留策略和大文件手动压缩流程见 `docs/modules/db-maintenance.md`。

### SKILL.md frontmatter 要求

```yaml
name: dashboard
version: 0.1.0
type: capability
lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dashboard
    entry: src/index.js
  data_dir: ~/zylos/components/dashboard
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - dashboard.db
http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: localhost:3470
    strip_prefix: /dashboard
config:
  required: []
  optional: []
upgrade:
  repo: zylos-ai/zylos-dashboard
  branch: main
```

## Caddy 路由

走 http_routes marker block，zylos-core 的 route 生成器直接将 `target` 写入 `reverse_proxy`，并转发 `X-Forwarded-Prefix`：

```
redir /dashboard /dashboard/ permanent
handle /dashboard/* {
    uri strip_prefix /dashboard
    reverse_proxy localhost:3470 {
        header_up X-Forwarded-Prefix /dashboard
    }
}
```

访问地址：`https://zylos01.jinglever.com/dashboard/`

## PM2 服务

通过 `ecosystem.config.cjs`（CommonJS，PM2 要求）配置：

- 服务名：`zylos-dashboard`
- 入口：`src/index.js`
- 日志：`~/zylos/components/dashboard/logs/`
- 自动重启：max 10 次，间隔 5s
- Config hot-reload：watch `~/zylos/components/dashboard/config.json`

入口文件需实现：dotenv 加载、graceful shutdown（SIGINT/SIGTERM）。

## 技术选型

| 层 | 选型 | 理由 |
|---|------|------|
| 后端 | Node.js + Express/Fastify | 与 zylos 技术栈一致 |
| 前端 | Vanilla JS + Chart.js + CSS Custom Properties | 零构建、即开即用、CSS 变量支撑皮肤切换 |
| 主题 | CSS Custom Properties + theme files | ~25 个语义 token，切换主题翻转 `data-theme` 属性，Chart.js 颜色从 CSS 变量读取 |
| 数据读取 | better-sqlite3 (readonly) + fs.watch + polling | 三层只读；fs.watch + polling 兜底 |
| 实时推送 | SSE + polling fallback | 只读不需要双向通信 |
| OTel 接收 | @opentelemetry/sdk-node | 轻量 OTLP 接收端 |
| OTel 存储 | SQLite (dashboard 自有 DB) | 不污染已有数据库 |
| 部署 | PM2 + Caddy route | zylos 标准方式 |

### 前端主题方案

评估过 5 个选项后选定 Vanilla JS + CSS Custom Properties：

| 方案 | 皮肤能力 | 构建 | 结论 |
|------|---------|------|------|
| Vanilla JS + CSS vars | 强（语义 token） | 零 | **选中** |
| Preact/Lit + CSS vars | 强 | CDN 可行但增加复杂度 | 过度 |
| Vue 3 CDN | 强 | ~46KB runtime 含模板编译器 | 过重 |
| Svelte | 强 | 必须构建步骤 | 违反零构建约束 |

实现方式：
- `tokens.css` 定义 ~25 个语义变量（`--bg-surface`、`--text-primary`、`--chart-palette-1` 至 `-6`、`--status-ok/warn/error` 等）
- 每个主题是 `themes/<name>.css`，覆写变量值
- `theme.js` 切换 `document.documentElement.dataset.theme`
- Chart.js 在主题切换时通过 `getComputedStyle()` 读取新颜色值 + `chart.update()`
- 新增皮肤只需添加一个 CSS 文件，不修改 JavaScript

### OTel 数据保留策略

| 数据类型 | 保留策略 |
|---------|---------|
| Metrics | 全量保留，按粒度降采样（1min 原始 → 1h 聚合 → 1d 聚合） |
| Traces | 默认 1:10 采样率（可配置），超 30 天自动归档 |
| Logs | 全量保留，超 30 天自动归档 |

查询维度：小时 / 天 / 7天 / 30天。保留时长和采样率均可在 config.json 中配置。

## 安全

### 数据只读保护

- **SQLite 三层只读**：URI `?mode=ro` + `fileMustExist: true` + `PRAGMA query_only = ON`
- **查询即开即关**：不持长事务，避免 WAL checkpoint 被拖住
- **无外部网络依赖**：仅读取本地文件和数据库

### 访问控制

- **认证**：管理界面登录后发 HttpOnly + SameSite=Strict cookie；REST API 和 SSE 走同源 cookie；CLI 支持 `Authorization: Bearer <token>`
- **URL token 默认关闭**：有泄露面（浏览器历史、access log、Referer），仅 localhost + 显式配置时可用
- **绑定 localhost**：server 只监听 127.0.0.1，外部走 Caddy 反代

### Auth 实现规格（参考 zylos-pages）

Dashboard auth 采用与 zylos-pages 一致的 cookie-based session 方案。

#### 密码存储

- 配置路径：`~/zylos/components/dashboard/config.json` → `auth.password`
- 格式：`scrypt:<salt_hex>:<hash_hex>`
- 如首次设置为明文，启动时自动迁移为 scrypt hash（`migratePasswordIfNeeded()`）
- `auth.enabled` 默认 `true`；`auth.password` 为 null 时 auth 不生效（无密码 = 不拦截）

#### Session 管理

- 登录成功后生成 64 字节随机 token，存储 `Map<sha256(token), {createdAt, lastActivityAt}>`
- Cookie 名：`__Secure-zylos_dashboard_session`
- Cookie 标志：`HttpOnly; Secure; SameSite=Strict; Path=<前缀>; Max-Age=86400`（记住我为 30 天）
- `Path` 取自经校验的 `X-Forwarded-Prefix`（如 `/dashboard`），浏览器只把 Cookie 发给 Dashboard 自己的路径，不发给同一域名下的其他组件；没有前缀、前缀不安全或含 `;`、`,` 时退回 `Path=/`
- 旧名 `__Host-zylos_dashboard_session` 强制 `Path=/`，已停用：请求带着旧 Cookie 时，服务端注销对应 session 并下发一条 `Max-Age=0` 清掉它，用户重新登录一次即可
- 过期策略：24h 绝对过期 + 60min 空闲过期

#### 路由

| 路由 | 方法 | Auth | 说明 |
|------|------|------|------|
| `/_assets/*` | GET | 不需要 | 静态资源（CSS/JS/图片） |
| `/login` | GET | 不需要 | 渲染登录表单 |
| `/login` | POST | 不需要 | 验证密码、设 cookie |
| `/logout` | POST | 需要 | 销毁 session、清 cookie、带 CSRF Origin 校验 |
| `/api/*` | GET | 需要 | REST API |
| `/api/events` | GET | 需要 | SSE 流 |
| `/api/health` | GET | 不需要 | 健康检查（Caddy/监控用） |
| `/*` | GET | 需要 | Web UI 页面 |

#### 暴力破解防护

- Per-IP lockout：5 次失败 / 60 秒 → 10 分钟锁定
- 全局限速：30 次失败 / 分钟 → 429
- IP 来源：仅当请求来自 127.0.0.1 时信任 `X-Forwarded-For`（即 Caddy 转发）

#### Observer request origins

Cookie-authenticated unsafe Observer HTTP requests and WebSocket handshakes,
including Fleet requests, share one origin check. If `Sec-Fetch-Site` is present,
only a single `same-origin` value (ignoring surrounding whitespace and case) is
accepted; empty, malformed, or multiple values are rejected without fallback.
When the header is absent, a canonical HTTP(S) `Origin` must match the request's
`Host`, including nondefault ports. Explicit default ports are normalized using
the **Origin scheme**, not a forwarded protocol. Bearer-token authentication and
logout CSRF checks are unchanged.

This does not require `X-Forwarded-Proto` or proxy trust. Unsafe HTTP requests
still use the fallback only when Fetch Metadata is absent, so proxies should
preserve the external `Host` for clients that omit it.

Chromium never sends `Sec-Fetch-*` headers on WebSocket handshakes, so behind a
proxy that rewrites Host its Observer handshakes would fail the fallback with
`origin_required` (#326). Lease creation and renewal therefore also return a
one-time `ticket`, which the browser offers as a `ticket.<value>`
`Sec-WebSocket-Protocol` token. A cookie handshake that fails the
`Origin`/`Host` fallback is admitted only when it carries no `Sec-Fetch-Site`
header and presents an unexpired, unused ticket minted for the same lease and
principal. Tickets are 256-bit random values, expire after 30 seconds and are
spent on first presentation. They come from the origin-checked lease POST,
whose response other origins cannot read, so they prove the same provenance
without depending on `Host`. An explicit non-`same-origin` `Sec-Fetch-Site`
value is still rejected even with a ticket. A Fleet relay mints its own tickets
for the browser-facing hop; its upstream hop keeps using its Bearer credential.

The fallback deliberately does not compare schemes. `Secure` restricts cookie
transmission to secure connections, not the initiating page's scheme; modern
schemeful `SameSite=Strict` provides the cross-scheme cookie boundary. An older
browser lacking both schemeful SameSite and Fetch Metadata can remain exposed
if an attacker can run script on an untrusted HTTP page on the same host.
Browsers sending Fetch Metadata on the required lease-creation POST reject that
cross-origin request before a viewer can connect. Use current browsers and keep
this accepted compatibility limitation in mind; the check does not add a lease
origin binding.

#### Logout CSRF 防护

- `POST /logout` 检查 `Origin` header host == `req.headers.host`
- 回退检查 `Referer` host
- 两者都缺失 → 拒绝

#### 注意事项

当前 dashboard 使用原生 Node.js `http` 模块（非 Express），auth 中间件需适配原生 request handler 模式。推荐实现为独立模块 `src/lib/auth.js`，在 `createServer` 的 handler 中作为第一层拦截。

### Base Path / X-Forwarded-Prefix 规格

遵循 zylos-component-template COMPONENT-SPEC.md §4 规范。

#### 核心原则

- 组件内部路由保持 `/`（根相对）
- Caddy 负责外部前缀 `/dashboard`，strip 后转发，同时附带 `X-Forwarded-Prefix: /dashboard`
- 组件读取 `X-Forwarded-Prefix` header 生成浏览器可见 URL

#### browser-base.js

从 zylos-pages 移植 `src/lib/browser-base.js`，包含：

- `browserBaseFromRequest(req)` — 读取并校验 `X-Forwarded-Prefix`
- `browserRoot(base)` → `${base}/`
- `browserPath(base, path)` → `${base}/${cleanPath}`
- `isPathWithinBase(path, base)` — 重定向安全校验

#### 严格校验（必须拒绝的 prefix 值）

- 查询/片段：`?`, `#`
- 空白/控制字符：`\x00-\x20`
- 反斜杠、协议字符串（`://`）、双斜杠（`//`）
- 点段（`.` 或 `..` 路径分量）
- 百分号编码
- HTML 元字符：`"`, `'`, `` ` ``, `<`, `>`, `&`, `%`

#### 影响范围

| 场景 | 需要 base path | 说明 |
|------|--------------|------|
| 登录表单 action | 是 | `<form action="${base}/login">` |
| 静态资源引用 | 是 | `<link href="${base}/_assets/css/...">` |
| 重定向（登录后跳转） | 是 | `Location: ${base}/` |
| `next` 参数校验 | 是 | `isPathWithinBase(next, base)` |
| API 路由 | 否 | Caddy 已 strip prefix，API 内部路径不变 |
| SSE endpoint | 否 | 前端 JS 拼接 `${base}/api/events` |

#### 直接访问兼容

无 `X-Forwarded-Prefix` 时（如 `localhost:3470` 直接访问），`browserBase` 为空字符串，所有 URL 退化为根相对路径，功能不受影响。

### 敏感信息保护

- **字段白名单**：API 只返回状态、计数、时间戳、成本等聚合数据，不返回 prompt 原文、.env 值、消息正文
- **工具事件脱敏**：只返回 tool_name、duration、success，不返回输入参数
- **OTel 数据本地存储**：不发送到外部 SaaS

### OTel 安全清单（Phase 2 前必过）

1. **Prompt redaction 验证**：Claude (`OTEL_LOG_USER_PROMPTS` 默认关) 和 Codex (`log_user_prompt` 默认 false) 均确认 prompt 不出现在 traces/logs 中
2. **Collector 仅 localhost**：OTel 数据不直接发往外部
3. **Payload field audit**：两个 runtime 的 OTel 输出逐字段检查，确认无 .env 值、API key、消息正文
4. **Exporter flush**：验证两个 runtime 的 exporter 在退出时正确 flush
5. **默认不采集 prompt 内容**：如启用，配置中标记为高风险选项

### API 降级语义

每个 adapter 独立 health check，resolver 输出包含 per-metric availability 状态。单个 adapter 故障不影响其他指标展示。

## 验证清单

### P0（MVP 上线前必过）

1. SQLite readonly smoke test（不存在不创建、INSERT 失败、SELECT 正常）
2. SQLite 并发压测（WAL 下写入循环 + dashboard 高频查询，观察 writer latency 和 WAL 增长）
3. JSON watcher 稳定性（原地写、temp+rename、半截 JSON、1000 次快速更新）
4. Caddy 路由验证（validate + reload + healthz + 现有路由不受影响）
5. Dashboard 资源基线（空闲、单客户端、5 客户端、持续更新 10 分钟，记录 RSS/CPU/事件延迟）

### P1（Phase 2 前必过）

6. OTel 隔离测试（独立 HOME/测试进程/localhost collector，对比 on/off 延迟和资源）
7. OTel payload 敏感信息检查（安全清单全部通过）
8. JSONL rotation 测试（copytruncate、rename-create、truncate 下 tail offset 恢复）
9. Caddy SSE 缓冲验证（是否需要 `flush_interval -1`）
10. Codex OTel 字段映射验证（`codex.*` 事件逐字段映射到统一指标）
11. Claude OTel 字段映射验证（`claude_code.*` 事件逐字段确认与文档一致）

## 依赖

- Caddy（HTTP 反代）
- PM2（进程管理）
- Node.js + npm（运行时和依赖安装）
- zylos 组件规范（`zylos add` 标准安装流程）
