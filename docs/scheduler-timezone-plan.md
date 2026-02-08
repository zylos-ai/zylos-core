# Scheduler Timezone Standardization Plan (v2)

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
| Module-load timezone | `cron-utils.js:9` | `DEFAULT_TIMEZONE = process.env.TZ \|\| 'UTC'` — constant frozen at import time |
| parseTime ignores TZ | `time-utils.js:20-35` | `chrono.parseDate("tomorrow 9am")` interprets in system local time, not configured TZ |
| CLI hardcodes timezone | `cli.js:243` | Always stores `DEFAULT_TIMEZONE` (module-load frozen value) in task timezone column |
| No .env loading | scheduler scripts | No mechanism to read TZ from `~/zylos/.env` like zylos-memory does |

### What's NOT broken (verified)

| Item | Location | Why it's fine |
|------|----------|---------------|
| `formatTime` default | `time-utils.js:112` | `timezone = process.env.TZ \|\| 'UTC'` is a **function default parameter**, evaluated at each call — not at module load. Once `process.env.TZ` is set, this works correctly. |
| `getNextRun` tz param | `cron-utils.js:18-30` | Already accepts explicit timezone and passes it to `cron-parser`. Works correctly when called with a value. |
| Daemon cron recalc | `daemon.js:117` | `getNextRun(task.cron_expression, task.timezone)` — passes task's stored TZ. Correct. |

### Established pattern (zylos-memory)

`skills/zylos-memory/scripts/shared.js` already has:
- `loadTimezoneFromEnv()` — reads `~/zylos/.env`, parses TZ value, sets `process.env.TZ`
- `parseEnvValue()` — handles quoted values and inline comments

## Core Invariant: Internal Pipeline is UTC

**This is the most important design constraint. All maintainers must understand this.**

```
User Input                    Database (UTC)                 User Display
"tomorrow 9am"  ──parse──▶  Unix timestamp  ──format──▶  "Feb 9, 2026 09:00"
(in user's TZ)               (always UTC)                  (in user's TZ)
```

### What TZ affects (boundary only)

| Boundary | Direction | Example |
|----------|-----------|---------|
| **Input parsing** | user → system | "tomorrow 9am" + TZ=Asia/Shanghai → Unix ts for 9am Shanghai (= 01:00 UTC) |
| **Cron evaluation** | system → system | `0 9 * * *` + TZ=Asia/Shanghai → next occurrence at 9am Shanghai |
| **Display formatting** | system → user | Unix ts 1770598800 + TZ=Asia/Shanghai → "Feb 9, 2026 09:00" |

### What TZ does NOT affect (internal)

| Component | Code | Why UTC-safe |
|-----------|------|-------------|
| `now()` | `Math.floor(Date.now() / 1000)` | `Date.now()` always returns UTC milliseconds, unaffected by `process.env.TZ` |
| `Date.getTime()` | `result.getTime() / 1000` | Always returns UTC milliseconds, unaffected by `process.env.TZ` |
| Daemon scheduling loop | `next_run_at <= currentTime` | Both sides are UTC Unix timestamps — pure integer comparison |
| DB columns | `next_run_at`, `last_run_at`, `created_at`, `updated_at` | All stored as UTC Unix seconds |
| Relative time | `getRelativeTime()` | Computes difference between two UTC timestamps — TZ-irrelevant |
| Duration parsing | `parseDuration()` | Computes relative offset (seconds) — TZ-irrelevant |
| Log timestamps | `new Date().toISOString()` | `.toISOString()` always outputs UTC, unaffected by `process.env.TZ` |

**Verified experimentally**: Setting `process.env.TZ = 'Asia/Shanghai'` does NOT change `Date.now()`, does NOT change `.getTime()`, does NOT change `.toISOString()`. The daemon loop remains UTC-correct.

## Design Principles

1. **Internal pipeline is UTC** — DB stores UTC, daemon compares UTC, no TZ in the middle
2. **TZ only at boundaries** — input parsing and output formatting
3. **One system timezone from runtime config** — resolve from `.env` first, then external `process.env.TZ`; no per-task `--timezone` flag
4. **`process.env.TZ` at entry point** — set once in `main()`, all downstream code benefits automatically
5. **Reuse zylos-memory's pattern** — same `.env` parsing, same `parseEnvValue()` logic
6. **Skills are self-contained** — no cross-skill imports

## Implementation Plan

### 1. New file: `skills/scheduler/scripts/tz.js`

~30 lines. Timezone loader following zylos-memory's pattern:

```javascript
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const ENV_PATH = path.join(ZYLOS_DIR, '.env');

function parseEnvValue(raw) {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx > 0) return trimmed.slice(0, hashIdx).trimEnd();
  return trimmed;
}

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

class TimezoneConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TimezoneConfigError';
    this.code = code;
  }
}

function invalidTzError(source, value) {
  return new TimezoneConfigError(
    'INVALID_TZ',
    `Invalid TZ value "${value}" in ${source}. Use an IANA timezone like "Asia/Shanghai" or "America/New_York".`
  );
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
        if (!val) {
          throw new TimezoneConfigError('INVALID_TZ', `Invalid TZ in ${ENV_PATH}: TZ is empty`);
        }
        if (!isValidTimezone(val)) {
          throw invalidTzError(ENV_PATH, val);
        }
        return val;
      }
    }
  } catch (err) {
    if (err instanceof TimezoneConfigError) {
      throw err; // fail-fast for explicit TZ config errors
    }
    if (err.code !== 'ENOENT') {
      throw new TimezoneConfigError(
        'TZ_ENV_READ_ERROR',
        `Failed to read ${ENV_PATH}: ${err.message}`
      );
    }
  }
  // .env has no TZ — try external env (e.g., PM2 config), validate it too
  const external = process.env.TZ;
  if (external) {
    if (!isValidTimezone(external)) {
      throw invalidTzError('process.env', external);
    }
    return external;
  }
  return 'UTC';
}
```

**Resolution priority**: `.env` TZ → `process.env.TZ` (external injection) → `'UTC'`.
If a TZ value is present but invalid at any level, `loadTimezone()` throws an error (fail-fast) instead of silently falling back.

Key differences from v1 plan:
- **Validates ALL TZ candidates** with `Intl.DateTimeFormat` — both `.env` values and externally injected `process.env.TZ` are validated
- **Fail-fast on invalid TZ** — if TZ is present but invalid, throw and stop startup (do not schedule with wrong time)
- **Fail-fast on non-ENOENT read errors** — `.env` permissions/I/O errors throw `TZ_ENV_READ_ERROR` and stop startup
- **Structured error codes** — uses `TimezoneConfigError` (`INVALID_TZ`, `TZ_ENV_READ_ERROR`) instead of fragile string matching
- **Does NOT set `process.env.TZ`** — pure function, caller decides

**Why a separate file instead of importing from zylos-memory?** Skills should be self-contained. Cross-skill imports create tight coupling. The code is small enough to duplicate.

### 2. Update `skills/scheduler/scripts/cron-utils.js`

No new imports needed — `cron-utils.js` relies on `process.env.TZ` being set by the entry point (cli.js / daemon.js).

```diff
- export const DEFAULT_TIMEZONE = process.env.TZ || 'UTC';
+ export function getDefaultTimezone() {
+   return process.env.TZ || 'UTC';
+ }

  export function getNextRun(cronExpression, timezone, fromDate = new Date()) {
+   const tz = timezone || process.env.TZ || 'UTC';
    const options = {
      currentDate: fromDate,
-     tz: timezone
+     tz: tz
    };
```

Changes:
- Remove `DEFAULT_TIMEZONE` constant (the root cause — frozen at module load)
- Add `getDefaultTimezone()` that reads current `process.env.TZ` (evaluated at call time)
- `getNextRun()` falls back to `process.env.TZ || 'UTC'` if no timezone passed

### 3. `skills/scheduler/scripts/time-utils.js` — NO CHANGES

This is the key simplification from the v1 plan. Verified experimentally:

**`parseTime()`** — `chrono.parseDate("tomorrow 9am")` interprets "9am" using the process's local timezone. Setting `process.env.TZ = 'Asia/Shanghai'` makes chrono interpret "9am" as 9am Shanghai. The returned `Date.getTime()` is the correct UTC milliseconds. No signature change needed.

**`formatTime()`** — Default parameter `timezone = process.env.TZ || 'UTC'` is already evaluated at each call (function defaults are call-time in JS). Once `process.env.TZ` is set by the entry point, all `formatTime()` calls without explicit timezone automatically use the configured TZ. No change needed.

**`parseDuration()`** — Computes relative offsets (seconds). TZ-irrelevant. No change needed.

**`getRelativeTime()`** — Computes UTC timestamp differences. TZ-irrelevant. No change needed.

### 4. Update `skills/scheduler/scripts/cli.js`

```diff
+ import { loadTimezone } from './tz.js';
- import { getNextRun, isValidCron, describeCron, DEFAULT_TIMEZONE } from './cron-utils.js';
+ import { getNextRun, isValidCron, describeCron, getDefaultTimezone } from './cron-utils.js';

  function cmdList() {
-   console.log('\n  Tasks:\n');
+   console.log(`\n  Tasks (TZ: ${getDefaultTimezone()}):\n`);

  function main() {
+   try {
+     process.env.TZ = loadTimezone();
+   } catch (err) {
+     const code = err.code || 'UNKNOWN_TZ_ERROR';
+     console.error(`Error [${code}]: ${err.message}`);
+     process.exit(1);
+   }
    const { command, args, options } = parseArgs(process.argv.slice(2));
```

And in `cmdAdd` (line 243):
```diff
-    DEFAULT_TIMEZONE
+    getDefaultTimezone()
```

**cmdUpdate — sync timezone column on schedule change (P1 fix):**

When `cmdUpdate` changes a task's schedule (`--cron`, `--at`, `--every`, `--in`), the first `next_run_at` is computed using the current `process.env.TZ`. But the daemon uses `task.timezone` for subsequent cron recalculations (`daemon.js:117`). If the `timezone` column isn't updated, the task drifts: first run in the new TZ, all subsequent runs in the old TZ.

```diff
  // In ALLOWED_UPDATE_COLUMNS:
+ 'timezone',

  // After the schedule update block:
  if (scheduleUpdated) {
+   updates.timezone = getDefaultTimezone();
    updatedFields.push('type', 'schedule');
  }
```

This ensures the `timezone` column stays in sync with the TZ that was used to compute `next_run_at`.

All other `formatTime()` and `parseTime()` calls throughout cli.js (`cmdList`, `cmdAdd`, `cmdUpdate`, `cmdHistory`, `cmdRunning`) work automatically because:
- `formatTime` default param reads `process.env.TZ` at call time
- `parseTime` uses chrono-node which reads local TZ at call time
- `process.env.TZ` was set in `main()` before any command runs

### 5. Update `skills/scheduler/scripts/daemon.js`

```diff
+ import { loadTimezone } from './tz.js';

+ try {
+   process.env.TZ = loadTimezone();
+ } catch (err) {
+   const code = err.code || 'UNKNOWN_TZ_ERROR';
+   console.error(`[${new Date().toISOString()}] Fatal timezone config error [${code}]: ${err.message}`);
+   process.exit(1);
+ }

  async function mainLoop() {
-   console.log(`[${new Date().toISOString()}] Scheduler V2 started`);
+   console.log(`[${new Date().toISOString()}] Scheduler V2 started (TZ: ${process.env.TZ})`);
```

Daemon sets `process.env.TZ` at module level (outside `mainLoop`), once at process start. All `formatTime(nextRun)` calls in the daemon (line 130) automatically pick up the correct TZ via the default parameter.

No need to pass `tz` as a local variable through `mainLoop` → `processCompletedTasks` → `updateNextRunTime` — the v1 plan's variable scoping problem is eliminated.

Note: `updateNextRunTime` (line 117) already passes `task.timezone` to `getNextRun()` explicitly. Old tasks with `timezone='UTC'` continue to have their cron evaluated in UTC. New tasks with `timezone='Asia/Shanghai'` get their cron evaluated in Shanghai time. Correct.

TZ changes in `.env` require `pm2 restart scheduler` — this is expected and documented.

### 6. Update `skills/scheduler/SKILL.md`

Add a Timezone section:

```markdown
## Timezone

The scheduler resolves `TZ` using this chain:

1. `~/zylos/.env` (`TZ=...`)
2. external `process.env.TZ` (e.g., PM2 env block)
3. `'UTC'` only if both are unset

Example `.env`:

```
TZ=Asia/Shanghai
```

- Natural language times ("tomorrow 9am") are interpreted in the configured timezone
- Cron expressions evaluate in the configured timezone
- CLI displays times in the configured timezone
- Database always stores UTC (Unix timestamps) — timezone-agnostic internally
- If TZ is present but invalid, CLI/daemon exits with error (fail-fast, no silent fallback)

After changing TZ in .env, restart the scheduler daemon:
```bash
pm2 restart scheduler
```
```

### 7. No database migration

- `timezone` column already exists (DEFAULT 'UTC')
- All timestamps are Unix seconds — timezone-agnostic
- Existing tasks keep working; their `timezone` column stays 'UTC', cron recalculation uses it
- New tasks get the configured timezone

## Files Summary

| File | Action | Lines changed (est.) |
|------|--------|---------------------|
| `skills/scheduler/scripts/tz.js` | **New** | ~35 |
| `skills/scheduler/scripts/cron-utils.js` | Modify | ~5 |
| `skills/scheduler/scripts/time-utils.js` | **No change** | 0 |
| `skills/scheduler/scripts/cli.js` | Modify | ~12 (import, TZ set with fail-fast, cmdList header, cmdAdd tz col, cmdUpdate tz sync, ALLOWED_UPDATE_COLUMNS) |
| `skills/scheduler/scripts/daemon.js` | Modify | ~6 (TZ set with fail-fast, startup log) |
| `skills/scheduler/SKILL.md` | Add section | ~15 |

**Total: ~73 lines changed/added across 5 files** (down from v1's ~100 lines across 6 files).

## Why This Approach Works (vs v1 Plan)

The v1 plan proposed explicit timezone parameter passing through all function calls. The v2 plan uses `process.env.TZ` instead. This is simpler and more correct:

| Issue | v1 approach | v2 approach |
|-------|-------------|-------------|
| chrono-node TZ | Pass `{ timezone: "Asia/Shanghai" }` — **BROKEN**: chrono-node v2 only accepts abbreviations (CST, EST) or numeric offsets, not IANA names. Silently falls back to system TZ. | Set `process.env.TZ` — chrono-node automatically uses correct local TZ. **Verified experimentally.** |
| formatTime calls | Change all callers to pass tz — many call sites, easy to miss | No caller changes needed — default param reads `process.env.TZ` at call time |
| parseTime signature | Break API: `(timeStr, tz, refDate)` — all callers must update | No API change — chrono-node reads local TZ automatically |
| Variable scoping in daemon | `tz` local to `mainLoop`, needs threading through nested functions | `process.env.TZ` globally available, no scoping issues |
| Missed call sites | cmdUpdate parseTime, cmdHistory formatTime, cmdRunning formatTime — all missed in v1 | All call sites automatically correct |

## Verification

1. `cli.js list` — times display in configured TZ, header shows `(TZ: Asia/Shanghai)`
2. `cli.js add "test" --at "tomorrow 9am"` — schedules 9am in configured TZ (not UTC)
3. `cli.js add "test" --cron "0 8 * * *"` — next run is 8am configured TZ
4. `cli.js update <task> --cron "0 10 * * *"` — verify `timezone` column updated to current TZ (no drift on subsequent daemon recalculations)
5. Restart daemon (`pm2 restart scheduler`) — logs show `Scheduler V2 started (TZ: Asia/Shanghai)`
6. Existing tasks with `timezone='UTC'` continue running with cron in UTC
7. New tasks get `timezone='Asia/Shanghai'` in DB
8. `Date.now()` and `.toISOString()` in daemon logs remain UTC — verify no drift
9. Without `.env` TZ, but with `TZ=Asia/Tokyo` in PM2 env — verify Tokyo is used
10. With invalid TZ (e.g., `TZ=Asia/NotAZone`) in `.env` or PM2 env — CLI/daemon exits non-zero with clear error; no scheduling starts

## Automated Tests

Minimum regression test suite (file: `skills/scheduler/scripts/__tests__/timezone.test.js`):

**1. `parseTime` multi-TZ (deterministic)** — verify with fixed `referenceDate`:
```javascript
const ref = new Date('2026-02-08T00:00:00Z');

process.env.TZ = 'UTC';
const utcTs = parseTime('tomorrow at 9am', ref);
process.env.TZ = 'Asia/Shanghai';
const shTs = parseTime('tomorrow at 9am', ref);

assert.equal(utcTs, 1770627600); // 2026-02-09T09:00:00Z
assert.equal(shTs, 1770598800);  // 2026-02-09T01:00:00Z
```

**2. `getNextRun` cron + TZ (deterministic)** — verify with fixed `fromDate`:
```javascript
const fromDate = new Date('2026-02-08T00:00:00Z');
const utcNext = getNextRun('0 9 * * *', 'UTC', fromDate);
const shNext = getNextRun('0 9 * * *', 'Asia/Shanghai', fromDate);

assert.equal(utcNext, 1770541200); // 2026-02-08T09:00:00Z
assert.equal(shNext, 1770512400);  // 2026-02-08T01:00:00Z
```

**3. `getNextRun` DST boundary (deterministic)** — verify US spring-forward behavior:
```javascript
// 2026-03-08 is US DST spring-forward (2am → 3am)
const beforeDST = new Date('2026-03-07T12:00:00Z');
const nextFromBefore = getNextRun('0 2 * * *', 'America/New_York', beforeDST);
assert.equal(nextFromBefore, 1772953200); // 2026-03-08T07:00:00Z (DST day)

const afterJump = new Date('2026-03-08T07:01:00Z');
const nextAfterJump = getNextRun('0 2 * * *', 'America/New_York', afterJump);
assert.equal(nextAfterJump, 1773036000); // 2026-03-09T06:00:00Z
```

**4. `loadTimezone` validation + fail-fast**:
```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-test-'));
const envPath = path.join(tmp, '.env');
process.env.ZYLOS_DIR = tmp;
const { loadTimezone } = await import('../tz.js');

// .env valid → use it
fs.writeFileSync(envPath, 'TZ=Asia/Shanghai\n');
assert.equal(loadTimezone(), 'Asia/Shanghai');

// .env invalid (or empty) TZ → INVALID_TZ
fs.writeFileSync(envPath, 'TZ=Asia/NotAZone\n');
assert.throws(() => loadTimezone(), (err) => err.code === 'INVALID_TZ');
fs.writeFileSync(envPath, 'TZ=\n');
assert.throws(() => loadTimezone(), (err) => err.code === 'INVALID_TZ');

// .env unreadable (EACCES, etc.) → TZ_ENV_READ_ERROR
fs.chmodSync(envPath, 0o000);
assert.throws(() => loadTimezone(), (err) => err.code === 'TZ_ENV_READ_ERROR');
fs.chmodSync(envPath, 0o644);

// .env missing + external valid → use external
fs.unlinkSync(envPath);
process.env.TZ = 'Asia/Tokyo';
assert.equal(loadTimezone(), 'Asia/Tokyo');

// .env missing + external invalid → INVALID_TZ
process.env.TZ = 'Asia/NotAZone';
assert.throws(() => loadTimezone(), (err) => err.code === 'INVALID_TZ');

// all missing → UTC
delete process.env.TZ;
assert.equal(loadTimezone(), 'UTC');
```

**5. `cmdUpdate` timezone column sync** — verify DB `timezone` column updates when schedule changes:
```javascript
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-tz-'));
const cli = path.resolve('skills/scheduler/scripts/cli.js');
const dbPath = path.join(tmp, 'scheduler', 'scheduler.db');

// Create task under UTC
execFileSync('node', [cli, 'add', 'test-task', '--cron', '0 9 * * *'], {
  env: { ...process.env, ZYLOS_DIR: tmp, TZ: 'UTC' }
});
const db = new Database(dbPath);
const task = db.prepare('SELECT id, timezone FROM tasks LIMIT 1').get();
assert.equal(task.timezone, 'UTC');

// Update schedule under Asia/Shanghai, timezone column must sync
execFileSync('node', [cli, 'update', task.id, '--cron', '0 10 * * *'], {
  env: { ...process.env, ZYLOS_DIR: tmp, TZ: 'Asia/Shanghai' }
});
const updated = db.prepare('SELECT timezone FROM tasks WHERE id = ?').get(task.id);
assert.equal(updated.timezone, 'Asia/Shanghai');
db.close();
```

## Edge Cases

- **Missing .env**: Falls back to `process.env.TZ` (external injection, e.g., PM2 env), then to UTC. Resolution chain: `.env` TZ → `process.env.TZ` → `'UTC'`
- **Invalid TZ value**: fail-fast. If TZ is present but invalid (in `.env` or external env), startup throws and exits non-zero. No silent fallback to prevent wrong scheduling times.
- **ENOENT vs permission/I/O error**: `ENOENT` means `.env` missing (allowed, continue chain). Any other read error throws `TZ_ENV_READ_ERROR` and exits.
- **DST transitions**: Handled by `cron-parser` (supports IANA zones with DST) and `Intl` (display). `process.env.TZ` with IANA names handles DST correctly in Node.js.
- **Server migration**: Change TZ in .env, restart daemon. DB timestamps are UTC, unaffected.
- **Platform note**: `process.env.TZ` runtime behavior is well-supported on Linux and macOS (glibc `localtime_r` reads TZ from environment). This project targets PM2-managed Linux/macOS environments.

## Review History

- **v1 (2026-02-07)**: Initial plan with explicit timezone parameter passing
- **v2 (2026-02-08)**: Rewritten after 3-agent review (architecture, code quality, security). Key changes:
  - Fixed P0: chrono-node does not support IANA names in `timezone` field — switched to `process.env.TZ` approach
  - Fixed P0: cmdUpdate `parseTime`/`getNextRun` calls were missed — no longer relevant (no API changes)
  - Removed `--timezone` per-task flag (contradicted "one system TZ" design principle)
  - Added TZ value validation with `Intl.DateTimeFormat`
  - Added Core Invariant section documenting UTC pipeline guarantee
  - Eliminated all time-utils.js changes (function defaults already evaluated at call time)
  - Reduced scope from ~100 lines/6 files to ~63 lines/5 files
- **v2.1 (2026-02-08)**: Post-review fixes for 2 P1 and 1 P2:
  - P1 fix: `cmdUpdate` now syncs `timezone` column when schedule changes — prevents cron drift between first run (new TZ) and subsequent runs (old TZ stored in DB)
  - P1 fix: PM2 service name corrected from `scheduler-v2` to `scheduler` (matches `ecosystem.config.cjs:42` and `SKILL.md:209`)
  - P2 fix: `loadTimezone()` fallback changed from hard `'UTC'` to `process.env.TZ || 'UTC'` — preserves externally injected TZ (e.g., from PM2 env block)
- **v2.2 (2026-02-08)**: Final polish (2 P2 + 2 P3):
  - P2 fix: `loadTimezone()` now validates ALL TZ candidates (both `.env` and external `process.env.TZ`) with `isValidTimezone()` — prevents invalid external TZ from propagating
  - P2 fix: Added automated test section with 5 minimum regression cases (parseTime multi-TZ, getNextRun DST, cmdUpdate tz sync, loadTimezone fallback chain)
  - P3 fix: Unified fallback semantics across plan — resolution chain: `.env` TZ → `process.env.TZ` → `'UTC'`, consistently described in code, edge cases, and key differences
  - P3 fix: Removed dual diff in cron-utils.js section — single authoritative diff only
- **v2.3 (2026-02-08)**: Safety tightening for correctness-first scheduling:
  - Changed TZ handling to fail-fast: if TZ is present but invalid, `loadTimezone()` throws and CLI/daemon exits instead of falling back
  - Added startup error-handling snippets in both `cli.js` and `daemon.js` (clear actionable error + non-zero exit)
  - Fixed remaining wording drift in SKILL.md section (runtime chain + invalid TZ behavior)
  - Hardened automated test examples to deterministic assertions (fixed reference dates and concrete DST expected timestamps)
- **v2.4 (2026-02-08)**: Reliability hardening after final review:
  - Non-ENOENT `.env` read failures (permission/I/O) now fail-fast with `TZ_ENV_READ_ERROR` instead of warning-and-continue
  - Replaced fragile message-prefix checks with structured `TimezoneConfigError` codes (`INVALID_TZ`, `TZ_ENV_READ_ERROR`)
  - Expanded test expectations to assert error codes for invalid/unreadable TZ configuration
- **v2.5 (2026-02-08)**: Testability and operability hardening:
  - Startup fatal logs now include structured error codes for easier AI/ops routing (`INVALID_TZ`, `TZ_ENV_READ_ERROR`)
  - Replaced test placeholders with executable regression examples for `loadTimezone` error-code assertions and `cmdUpdate` timezone-column sync
