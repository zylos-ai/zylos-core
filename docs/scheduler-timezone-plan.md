# Scheduler Timezone Standardization Plan

## Context

The scheduler skill needs proper timezone support. Currently timezone handling is inconsistent across the scheduler codebase, causing times to be interpreted and displayed incorrectly when the system timezone differs from the user's intended timezone.

**Recorded as TODO in memory/projects.md on 2026-02-07.**

## Current State Analysis

### What works

- Database stores all times as **Unix timestamps** (seconds since epoch) — timezone-agnostic
- Each task has a `timezone TEXT DEFAULT 'UTC'` column
- `getNextRun()` in cron-utils.js accepts a timezone parameter and passes it to `cron-parser`
- `formatTime()` in time-utils.js accepts a timezone parameter and uses `Intl` for display
- Daemon's `updateNextRunTime()` reads `task.timezone` for cron recalculation

### What's broken

| Issue | Location | Problem |
|-------|----------|---------|
| Module-load timezone | `cron-utils.js:9` | `DEFAULT_TIMEZONE = process.env.TZ \|\| 'UTC'` evaluated once at import, not at call time |
| parseTime ignores TZ | `time-utils.js:20-35` | `chrono.parseDate("tomorrow 9am")` interprets in system local time, not configured TZ |
| formatTime default | `time-utils.js:112` | Default `process.env.TZ \|\| 'UTC'` evaluated at module load |
| CLI hardcodes timezone | `cli.js:243` | Always stores `DEFAULT_TIMEZONE` (module-load value) in task timezone column |
| CLI display ignores task TZ | `cli.js:133` | `formatTime(task.next_run_at)` doesn't pass task's timezone |
| No --timezone CLI flag | `cli.js` | Users can't specify timezone when creating tasks |
| No .env loading | scheduler scripts | No mechanism to read TZ from `~/zylos/.env` like zylos-memory does |

### Established pattern (zylos-memory)

`skills/zylos-memory/scripts/shared.js` already has:
- `loadTimezoneFromEnv()` — reads `~/zylos/.env`, parses TZ value, sets `process.env.TZ`
- `parseEnvValue()` — handles quoted values and inline comments
- `dateInTimeZone()` — timezone-aware date formatting via `Intl.DateTimeFormat`

## Design Principles

1. **Database stores UTC** — already done, no migration needed
2. **One system timezone from .env** — not per-task timezones (simplifies everything; the per-task column becomes a record of what TZ was active when the task was created)
3. **Load TZ at runtime, not module load** — read from .env when the function is called
4. **Reuse zylos-memory's pattern** — same `.env` parsing, same `parseEnvValue()` logic

## Implementation Plan

### 1. New file: `skills/scheduler/scripts/tz.js`

~20 lines. Timezone loader following zylos-memory's pattern:

```javascript
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const ENV_PATH = path.join(ZYLOS_DIR, '.env');

function parseEnvValue(raw) {
  // Same logic as zylos-memory/scripts/shared.js:parseEnvValue
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx > 0) return trimmed.slice(0, hashIdx).trimEnd();
  return trimmed;
}

export function loadTimezone() {
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx < 0) continue;
      if (t.slice(0, idx).trim() === 'TZ') {
        const val = parseEnvValue(t.slice(idx + 1));
        if (val) return val;
      }
    }
  } catch { /* .env may not exist */ }
  return 'UTC';
}
```

**Why a separate file instead of importing from zylos-memory?** Skills should be self-contained. Cross-skill imports create tight coupling. The code is small enough to duplicate.

### 2. Update `skills/scheduler/scripts/cron-utils.js`

```diff
- export const DEFAULT_TIMEZONE = process.env.TZ || 'UTC';
+ import { loadTimezone } from './tz.js';
+
+ export function getDefaultTimezone() {
+   return loadTimezone();
+ }

  export function getNextRun(cronExpression, timezone, fromDate = new Date()) {
+   const tz = timezone || loadTimezone();
    const options = {
      currentDate: fromDate,
-     tz: timezone
+     tz: tz
    };
    // ...
  }
```

- Remove `DEFAULT_TIMEZONE` constant
- Add `getDefaultTimezone()` for callers that need the value
- `getNextRun()` falls back to `loadTimezone()` if no timezone passed

### 3. Update `skills/scheduler/scripts/time-utils.js`

**parseTime — add timezone awareness:**

```diff
- export function parseTime(timeStr, referenceDate = new Date()) {
-   const result = chrono.parseDate(timeStr, referenceDate, { forwardDate: true });
+ export function parseTime(timeStr, timezone, referenceDate = new Date()) {
+   // Build a timezone-aware reference for chrono-node
+   const ref = timezone ? { timezone } : undefined;
+   const result = chrono.parseDate(timeStr, { instant: referenceDate, ...ref }, { forwardDate: true });
```

chrono-node v2 supports a `timezone` field in the reference object (IANA name or offset). This makes "tomorrow 9am" mean 9am in the configured timezone.

**formatTime — remove lazy default:**

```diff
- export function formatTime(timestamp, timezone = process.env.TZ || 'UTC') {
+ export function formatTime(timestamp, timezone = 'UTC') {
```

Make the default explicit `'UTC'` — callers are now required to pass the timezone they want. This eliminates the module-load-time evaluation issue.

### 4. Update `skills/scheduler/scripts/cli.js`

```diff
+ import { loadTimezone } from './tz.js';
- import { getNextRun, isValidCron, describeCron, DEFAULT_TIMEZONE } from './cron-utils.js';
+ import { getNextRun, isValidCron, describeCron, getDefaultTimezone } from './cron-utils.js';

  function main() {
+   const tz = loadTimezone();
    const { command, args, options } = parseArgs(process.argv.slice(2));
+   // Allow per-task override
+   const taskTz = options.timezone || tz;
```

Then throughout cli.js:
- `formatTime(task.next_run_at)` → `formatTime(task.next_run_at, tz)`
- `getNextRun(cronExpression)` → `getNextRun(cronExpression, taskTz)`
- `parseTime(options.at)` → `parseTime(options.at, taskTz)`
- Store `taskTz` instead of `DEFAULT_TIMEZONE` in the timezone column
- `cmdList()` header: show `(TZ: ${tz})` so user sees which timezone is active

Add `--timezone` to HELP text and `parseArgs` options.

### 5. Update `skills/scheduler/scripts/daemon.js`

```diff
+ import { loadTimezone } from './tz.js';

  async function mainLoop() {
+   const tz = loadTimezone();
-   console.log(`[${new Date().toISOString()}] Scheduler V2 started`);
+   console.log(`[${new Date().toISOString()}] Scheduler V2 started (TZ: ${tz})`);

    // In log messages:
-   console.log(`... ${formatTime(nextRun)}`);
+   console.log(`... ${formatTime(nextRun, tz)}`);
```

The daemon loads TZ once at startup. Since it's a long-running process, TZ changes require daemon restart (which is fine — PM2 restart is the normal flow).

### 6. Update `skills/scheduler/SKILL.md`

Add a Timezone section:

```markdown
## Timezone

The scheduler reads `TZ` from `~/zylos/.env`:

\`\`\`
TZ=Asia/Shanghai
\`\`\`

- All cron expressions evaluate in the configured timezone
- CLI displays times in the configured timezone
- Database always stores UTC (Unix timestamps)
- Override per-task with `--timezone "America/New_York"`
- Default: UTC (if .env has no TZ)

After changing TZ in .env, restart the scheduler daemon:
\`\`\`bash
pm2 restart scheduler-v2
\`\`\`
```

Add `--timezone` to the CLI options table.

### 7. No database migration

- `timezone` column already exists (DEFAULT 'UTC')
- All timestamps are Unix seconds — timezone-agnostic
- Existing tasks keep working; their `timezone` column stays 'UTC'
- New tasks get the configured timezone

## Files Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `skills/scheduler/scripts/tz.js` | **New** | ~30 |
| `skills/scheduler/scripts/cron-utils.js` | Modify | ~10 changed |
| `skills/scheduler/scripts/time-utils.js` | Modify | ~10 changed |
| `skills/scheduler/scripts/cli.js` | Modify | ~20 changed |
| `skills/scheduler/scripts/daemon.js` | Modify | ~10 changed |
| `skills/scheduler/SKILL.md` | Add section | ~20 added |

**Total estimated: ~100 lines changed/added across 6 files.**

## Verification

1. `cli.js list` — times display in configured TZ, header shows `(TZ: Asia/Shanghai)`
2. `cli.js add "test" --at "tomorrow 9am"` — schedules 9am in configured TZ (not UTC)
3. `cli.js add "test" --cron "0 8 * * *"` — next run is 8am configured TZ
4. `cli.js add "test" --at "9am" --timezone "America/New_York"` — per-task override works
5. Restart daemon — logs show `Scheduler V2 started (TZ: Asia/Shanghai)`
6. Existing tasks continue running without issues

## Edge Cases

- **Missing .env**: Falls back to UTC (same as current behavior)
- **Invalid TZ value**: `Intl.DateTimeFormat` throws, caught by existing try/catch in `formatTime()`
- **DST transitions**: Handled by `cron-parser` and `Intl` (both support IANA zones with DST)
- **Server migration**: Change TZ in .env, restart daemon. Timestamps in DB are UTC, unaffected.
