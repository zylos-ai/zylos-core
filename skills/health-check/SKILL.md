---
name: health-check
description: |
  System health check dispatched by the activity monitor via Control queue.
  Checks PM2 services, disk space, memory usage, and that the C4 message
  database can list session groups.
  Use when receiving a control message containing "health-check".
user-invocable: false
allowed-tools: Bash, Read, Grep
---

# System Health Check

Periodic system health check delivered via the C4 Control queue.

## When to Use

- Receiving a control message with "health-check" in the content
- The activity monitor enqueues this automatically at regular intervals

## Steps

### 1. Check PM2 Services

```bash
node ~/zylos/.claude/skills/health-check/scripts/pm2-snapshot.js
```

The helper parses `pm2 jlist` internally and prints only the allowlisted health
fields (`name`, `status`, `pid`, and `restart_time`). Never run or print raw
`pm2 jlist` output because it contains each process's inherited environment.
Every service should have `status: "online"`.
Record which services are stopped or errored.

### 2. Check Disk Space

```bash
df -h / /home 2>/dev/null || df -h /
```

Thresholds:
- OK: < 80% used
- Warning: 80-90% used
- Critical: > 90% used

### 3. Check Memory

```bash
free -m
```

Thresholds:
- OK: < 80% used
- Warning: 80-90% used
- Critical: > 90% used (or swap > 50% used)

### 4. Check C4 Session Group List

```bash
node ~/zylos/.claude/skills/health-check/scripts/c4-groups-check.js
```

The helper reads the session group list through the existing C4 read command
without changing the database. On success it prints
`C4 session groups OK: N groups listed` and exits 0. On failure it prints
`C4 session groups FAILED [CODE]: reason` and exits non-zero. It never prints
message content. A failure means the session group list (including the
Dashboard workbench list) cannot be read: treat it like a stopped service and
record the code and reason.

### 5. Report Results

If all checks pass, log to `~/zylos/logs/health.log`:

```
[YYYY-MM-DD HH:MM:SS] Health Check: PM2 X/X online, Disk XX%, Memory XX%, C4 groups OK - ALL OK
```

If any issues found, notify whoever is most likely to help:
1. Check your memory files for a designated owner or ops person
2. If none designated, notify the person you normally work with most
3. Use `c4-send.js` with the appropriate channel and endpoint to send the alert

## Issue Resolution

| Issue | Action |
|-------|--------|
| PM2 service stopped | `pm2 restart <service>` and report |
| High disk usage | Check logs directories, report findings |
| High memory / swap | Report findings, check for runaway processes |
| C4 session group list unreadable | Report the error code and reason; do not modify or repair the database |
