# References

## Configuration Sources
- Environment: ~/zylos/.env (TZ, DOMAIN, PROXY, API keys)
- Installed components: ~/zylos/.zylos/components.json

## Key Paths
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/
- C4 Database: ~/zylos/comm-bridge/c4.db

## Services
- Scheduler: PM2-managed, see ~/zylos/pm2/ecosystem.config.cjs
- HTTP proxy: see .env PROXY

## Active IDs
- Telegram chat with Howard: 12345678
- Lark group "Dev Team": og_abcdef123

## Notes
- For TZ, domain, proxy: see .env
- This file is a pointer/index. Do NOT duplicate config values here.
