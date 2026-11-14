# Deployment and Security

## Lifecycle Ownership

Dashboard is built into Zylos Core, rather than a component that can be installed or upgraded independently.

- Code ships with Core at `~/zylos/.claude/skills/dashboard/`.
- Runtime data lives in `~/zylos/components/dashboard/`; Core upgrades preserve `config.json`, `dashboard.db`, `spool/`, and `backups/`.
- `zylos init` handles initialization; use `zylos upgrade --self` for upgrades.
- Standalone `upgrade` still returns `core_managed`; on 1.0, `uninstall` removes only a leftover standalone Dashboard registration (preserving data and the built-in Dashboard), or returns `core_managed` if no such registration remains.

The Core finalizer handles component registration, Caddy routes, PM2 services, database migration/backup restoration, runtime hook publication, and old Dashboard hook cleanup. Dashboard's `hooks/post-install.js` only creates missing data directories and default configuration; it does not take ownership of runtime hooks.

## Runtime Structure

Key paths:

```text
~/zylos/.claude/skills/dashboard/
├── SKILL.md
├── package.json
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

For database retention, compaction, and recovery, see [Database Maintenance](db-maintenance.md).

## Services and Routing

- PM2 service name: `zylos-dashboard`; its entry comes from Core's `~/zylos/pm2/ecosystem.config.cjs`.
- Default listener: `127.0.0.1:3470`.
- Caddy's external path: `/dashboard/*`; it strips `/dashboard` before forwarding and sets `X-Forwarded-Prefix: /dashboard`.
- When accessed directly without a prefix, page URLs fall back to root-relative paths.

The Core installation process writes routes and starts/verifies PM2; do not manually add Dashboard to a second lifecycle configuration outside Core.

## Runtime Dependencies

- Node.js 20 or later.
- A native Node HTTP server and a frontend requiring no build step.
- The comm-bridge skill installs the SQLite driver `better-sqlite3`. Dashboard's own storage and read-only queries both load this same driver through `skills/comm-bridge/scripts/sqlite-driver.js`; Dashboard's `package.json` no longer lists it.
- `package.json` and the lockfile define dependencies such as Chart.js and date-fns.

Dashboard currently runs no OTLP collector and does not require an OpenTelemetry SDK.

## Configuration and Upgrades

`config.json` is the source of instance configuration; initial installation generates default configuration and a separate random password hash only if the file does not exist. Post-install does not overwrite existing configuration.

Core self-upgrades handle:

1. Preserving instance data and creating backups when needed;
2. Updating Dashboard code and dependencies distributed with Core;
3. Running database migrations and recovery safeguards;
4. Updating Caddy, PM2, and Core-owned hooks;
5. Verifying health endpoints and service state.

Dashboard backup, migration, and upgrade behavior is governed by Core's current implementation; the standalone repository's pre-upgrade/post-upgrade contracts are no longer maintained.

## Access Control

- The service listens only on loopback; external access goes through Caddy.
- Browser login uses a separate scrypt password hash and an HttpOnly, Secure, SameSite=Strict cookie.
- REST APIs and SSE use same-origin sessions; CLI/internal calls may use a Bearer token.
- URL token login is not supported.
- Login failures have per-IP lockout and global rate limiting.
- Logout, Observer unsafe requests, and WebSocket handshakes validate Origin/Fetch Metadata; Observer tickets serve only as a restricted, one-time proxy compatibility mechanism.

## Base Path

A trusted proxy sets the external prefix in `X-Forwarded-Prefix`. `browser-base.js` validates the prefix and generates correct paths for login, static assets, redirects, and browser API URLs. Prefixes containing control characters, queries/fragments, schemes, dot segments, percent encoding, or HTML metacharacters must be rejected.

## Data Protection

- Dashboard accesses upstream databases such as C4 and scheduler read-only and holds no write transactions.
- APIs return only state, aggregates, and sanitized events, never prompts, message bodies, environment variables, or raw tool inputs.
- Dashboard's own data stays in `components/dashboard` and is not uploaded to external telemetry services.
- For Observer execution, lease, and cleanup security boundaries, see [Observer](../observer.md).
