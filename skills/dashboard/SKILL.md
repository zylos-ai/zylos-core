---
name: dashboard
version: 0.6.9
description: Read-only Zylos observability dashboard for agent state, costs, tools, communication, scheduler, and PM2 service health. Full features on Claude runtime. PM2, system health, communication, and scheduler monitoring on all runtimes.
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dashboard
    entry: src/index.js
  data_dir: ~/zylos/components/dashboard
  preserve:
    - config.json
    - dashboard.db
    - spool/
    - backups/
  next-steps: "Dashboard is bundled with Core. Upgrade with zylos upgrade --self; Core owns activity hooks."

http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: 127.0.0.1:3470
    strip_prefix: /dashboard

config:
  required: []
  optional:
    - name: DASHBOARD_PORT
      description: Dashboard server port
      default: "3470"
    - name: DASHBOARD_HOST
      description: Dashboard bind address
      default: "127.0.0.1"
    - name: DASHBOARD_AUTH_PASSWORD
      description: Dashboard login password (independent from Web Console; generated on first install and never printed)
      sensitive: true


---

# Zylos Dashboard

Read-only observability dashboard for a local Zylos agent.

```bash
npm start
```

Default URL: `http://127.0.0.1:3470/`

A new installation creates an independent random password hash without printing
the password. Before first sign-in, set an owner-chosen Dashboard password through
the existing `hooks/configure.js` stdin JSON interface: supply
`DASHBOARD_AUTH_PASSWORD` as the scrypt value produced by
`hashPassword` from `src/lib/auth.js`. Point `ZYLOS_DATA_DIR` at this instance's
`components/dashboard` directory. Keep the plaintext in memory, out of command
arguments, files and logs; the configure input and saved config contain only the
hash. Restart Dashboard after changing its configuration. Existing installations
keep their configured password. Dashboard does not share Web Console credentials.

For optional terminal viewing, supported platforms and cleanup recovery, see
[Observer](docs/observer.md). Observer automatically selects the target Dashboard
host's platform: macOS Apple Silicon, Linux x64 or Linux ARM64. Install and enable
it from Settings; the linked guide lists host requirements and cleanup behavior.
