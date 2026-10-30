# 部署与安全

## 生命周期归属

Dashboard 是 Zylos Core 的内置能力，不是可独立安装或升级的组件。

- 代码随 Core 发布，位于 `~/.claude/skills/dashboard/`。
- 运行数据位于 `~/zylos/components/dashboard/`，Core 升级时保留 `config.json`、`dashboard.db`、`spool/` 和 `backups/`。
- 初始化由 `zylos init` 完成；升级使用 `zylos upgrade --self`。
- 组件命令会拒绝对 Dashboard 执行独立 upgrade/uninstall，并返回 `core_managed`。

Core finalizer 负责组件注册、Caddy 路由、PM2 服务、数据库迁移/备份恢复，以及 runtime hook 的发布和旧 Dashboard hook 的清理。Dashboard 的 `hooks/post-install.js` 只负责创建缺失的数据目录和默认配置，不接管 runtime hook。

## 运行结构

关键路径：

```text
~/.claude/skills/dashboard/
├── SKILL.md
├── package.json
├── ecosystem.config.cjs
├── hooks/post-install.js
├── src/
│   ├── index.js
│   └── lib/
├── public/
└── docs/

~/zylos/components/dashboard/
├── config.json
├── dashboard.db
├── spool/
├── backups/
└── logs/
```

数据库保留、压缩和恢复说明见 [数据库维护](db-maintenance.md)。

## 服务与路由

- PM2 服务名：`zylos-dashboard`。
- 默认监听：`127.0.0.1:3470`。
- Caddy 对外路径：`/dashboard/*`，转发前剥离 `/dashboard`，并设置 `X-Forwarded-Prefix: /dashboard`。
- 无前缀直接访问时，页面 URL 退化为根相对路径。

Core 安装流程负责写入路由和启动/校验 PM2；不要手工把 Dashboard 添加到 Core 之外的第二套生命周期配置。

## 运行依赖

- Node.js 20 或更高版本。
- 原生 Node HTTP 服务和零构建前端。
- `better-sqlite3` 用于 Dashboard 自有存储及只读数据查询。
- Chart.js、date-fns 等依赖以 `package.json` 和 lockfile 为准。

Dashboard 当前不运行 OTLP collector，也不要求 OpenTelemetry SDK。

## 配置与升级

`config.json` 是实例配置的来源；首次安装只在文件不存在时生成默认配置和独立随机密码 hash。已有配置不会被 post-install 覆盖。

Core 自升级负责：

1. 保留实例数据并在需要时创建备份；
2. 更新随 Core 分发的 Dashboard 代码和依赖；
3. 执行数据库迁移与恢复保护；
4. 更新 Caddy、PM2 和 Core-owned hooks；
5. 验证健康端点和服务状态。

Dashboard 的备份、迁移和升级结论应以 Core 当前实现为准，不再维护 standalone repo 的 pre-upgrade/post-upgrade 合同。

## 访问控制

- 服务仅监听 loopback，外部访问经 Caddy。
- 浏览器登录使用独立的 scrypt password hash 和 HttpOnly、Secure、SameSite=Strict cookie。
- REST API 与 SSE 使用同源 session；CLI/内部调用可使用 Bearer token。
- URL token 默认关闭，避免浏览器历史、日志和 Referer 泄露。
- 登录失败具有 per-IP lockout 和全局限速。
- logout、Observer unsafe requests 与 WebSocket handshake 执行 Origin/Fetch Metadata 校验；Observer ticket 仅作为受限的一次性代理兼容机制。

## Base path

外部前缀由可信代理写入 `X-Forwarded-Prefix`。`browser-base.js` 校验前缀并为登录、静态资源、重定向和浏览器 API URL 生成正确路径。含控制字符、查询/片段、协议、点段、百分号编码或 HTML 元字符的前缀必须拒绝。

## 数据保护

- Dashboard 对 C4、scheduler 等上游数据库只读访问，不持有写事务。
- API 仅返回状态、聚合和脱敏事件，不返回 prompt、消息正文、环境变量或原始工具输入。
- Dashboard 自有数据留在 `components/dashboard`，不会上传到外部 telemetry 服务。
- Observer 的执行、租约和清理安全边界见 [Observer](../observer.md)。
