---
name: health-check
description: |
  System health check dispatched by the activity monitor via Control queue.
  Checks PM2 services, disk space, and memory usage.
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
pm2 jlist
```

Parse the JSON output. Every service should have `status: "online"`.
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

### 4. Report Results

If all checks pass, log to `~/zylos/logs/health.log`:

```
[YYYY-MM-DD HH:MM:SS] Health Check: PM2 X/X online, Disk XX%, Memory XX% - ALL OK
```

If any issues found, notify whoever is most likely to help:
1. Check your memory files for a designated owner or ops person
2. If none designated, notify the person you normally work with most
3. Use `c4-send.js` with the appropriate channel and endpoint to send the alert

### 5. Acknowledge Control

After completing the check, acknowledge the control message:

```bash
node <path-to-c4-control.js> ack --id <CONTROL_ID>
```

The control ID is provided in the message content.

## Issue Resolution

| Issue | Action |
|-------|--------|
| PM2 service stopped | `pm2 restart <service>` and report |
| High disk usage | Check logs directories, report findings |
| High memory / swap | Report findings, check for runaway processes |
