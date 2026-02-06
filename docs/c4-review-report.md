# C4 Communication Bridge - Consolidated Review Report

**Date:** 2026-02-06
**Reviewers:** Architecture, Reliability, Security & Code Quality, Performance
**Scope:** All files in `zylos-core/skills/comm-bridge/`

---

## Executive Summary

The C4 Communication Bridge has a solid foundation — clean separation of concerns, correct use of parameterized SQL, appropriate SQLite WAL mode, and pragmatic design for the expected message volume. However, **3 categories of issues need urgent attention** before production use:

1. **Queue reliability** — A single undeliverable message can block the entire queue permanently (Critical)
2. **Input validation gaps** — Path traversal and injection risks from unvalidated `source`/`endpoint` parameters (High)
3. **Race conditions** — Shutdown and recovery have data loss/duplication edge cases (High)

Total findings: **1 Critical, 9 High, 15 Medium, 10 Low**

---

## Critical Findings

### C1. Poison Message Blocks Entire Queue
**Severity:** CRITICAL | **File:** `c4-dispatcher.js:124-173`

No retry count, no dead-letter mechanism, no backoff. If a message fails delivery (e.g., tmux paste fails), the dispatcher logs "will retry" but has no mechanism to skip it. The same message is retried forever, blocking all subsequent messages.

**Impact:** A single bad message permanently blocks all communication.

**Recommendation:**
- Add `retry_count` column to conversations table
- After N retries (e.g., 3), move message to `status='dead_letter'`
- Add `max_retries` configurable value
- Log dead-lettered messages prominently for investigation

---

## High Severity Findings

### H1. Path Traversal via Unvalidated `source` Parameter
**File:** `c4-send.js:58`, `c4-notify.js:37`

```javascript
const channelScript = path.join(SKILLS_DIR, source, 'send.js');
```

`source` comes from CLI args with no validation. A crafted value like `../../some/path` enables arbitrary JS file execution via `spawn('node', [channelScript])`.

**Recommendation:** Validate `source` against allowlist: `['telegram', 'lark', 'system', 'scheduler']`. Reject any value containing `/` or `..`.

### H2. Tmux Escape Sequence / Newline Injection
**File:** `c4-dispatcher.js:85-119`

Message content is pasted directly into tmux buffer. Newlines in content cause premature Enter keypresses, splitting one message into multiple Claude inputs. Control characters could manipulate the terminal.

**Recommendation:** Sanitize content before tmux paste — at minimum escape/strip newlines and control characters (0x00-0x1F).

### H3. Shutdown Race Condition — Duplicate Messages
**File:** `c4-dispatcher.js:200-208`

`process.exit(0)` in signal handler fires immediately. If SIGTERM arrives between successful tmux delivery and `markDelivered()`, the message stays `pending`. On PM2 restart, it gets delivered again.

**Recommendation:**
```javascript
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;  // Loop will exit naturally
  log('Shutting down gracefully...');
  // Don't call process.exit() — let the loop finish current iteration
}
```
Then after the loop exits, close DB and exit.

### H4. Recovery Misses Same-Second Messages
**File:** `c4-db.js:224-228`

```sql
WHERE timestamp > ?
```

SQLite `CURRENT_TIMESTAMP` has second precision. Messages created in the same second as a checkpoint are missed by recovery. Should use `>=` with deduplication, or switch to higher-precision timestamps.

**Recommendation:** Use `>=` instead of `>`, and deduplicate by message ID. Or use `strftime('%Y-%m-%d %H:%M:%f', 'now')` for millisecond precision.

### H5. No SQLite busy_timeout — Concurrent Write Failures
**File:** `c4-db.js:35-36`

No `busy_timeout` pragma set. When multiple `c4-receive.js` processes write simultaneously (e.g., Telegram and Lark messages arriving at once), one gets `SQLITE_BUSY` and exits with code 1. The message is lost — never queued.

**Recommendation:** Add `db.pragma('busy_timeout = 5000');` after WAL mode configuration.

### H6. Reply-Via Protocol — Command Injection Surface
**File:** `c4-receive.js:97-106`

```javascript
replyVia = `reply via: node ${path.join(scriptDir, 'c4-send.js')} ${source} ${endpoint}`;
```

`source` and `endpoint` are embedded unsanitized. Since Claude executes this path to respond, a crafted endpoint like `; rm -rf /` could lead to command injection when Claude interprets the instruction.

**Recommendation:** Validate inputs (see H1). Quote values in the reply-via string.

### H7. c4-notify.js Hardcodes Channel List
**File:** `c4-notify.js:77-98`

Telegram and Lark are hardcoded. Adding a new channel requires modifying source code, breaking the otherwise clean extensibility contract where channels are discovered via the filesystem.

**Recommendation:** Auto-discover channels by scanning for `config.json` files with `primary_dm` in the channel data directories, or maintain a central channel registry.

---

## Medium Severity Findings

### M1. Non-Atomic Checkpoint + Recovery Query (TOCTOU)
**File:** `c4-db.js:208-231`

Two separate queries — get last checkpoint, then get conversations after it. A new checkpoint could be created between the two queries, causing recovery to miss messages.

**Recommendation:** Wrap in a transaction or use a single query with JOIN.

### M2. No Input Validation on `source`/`endpoint` in c4-receive.js
**File:** `c4-receive.js:39-71`

Both parameters accepted without any validation and passed to DB and reply-via construction.

**Recommendation:** Add source allowlist, endpoint regex validation.

### M3. Doc-Code Path Mismatch
**Files:** `SKILL.md` vs `c4-send.js`

SKILL.md says channels provide `scripts/send.js` but c4-send.js looks for `send.js` at the channel root. Will confuse channel implementers.

**Recommendation:** Align documentation with code, or vice versa.

### M4. No Access Control
All scripts have no authentication. Anyone with filesystem access can queue messages to Claude or send to any channel.

**Recommendation:** Document this as a design assumption. Adequate for single-user but needs auth if ever network-exposed.

### M5. Database Schema Gaps
- No CHECK constraints on enum columns (`direction`, `status`, `type`)
- Foreign keys defined but `PRAGMA foreign_keys` never enabled (SQLite requires explicit opt-in)
- Conversations table serves double duty as queue and audit log

**Recommendation:** Add CHECK constraints, enable foreign_keys pragma, consider separating queue from log.

### M6. Migration Operations Lack Transactions
**File:** `c4-db.js:60-103`

Multi-step migrations (ALTER TABLE + CREATE INDEX) not wrapped in transactions. A crash mid-migration leaves DB in inconsistent state.

**Recommendation:** Wrap each migration in `BEGIN`/`COMMIT`.

### M7. No Message Size Validation
No limit on message content length. Very large messages could exceed tmux buffer limits or cause performance issues.

**Recommendation:** Add reasonable content length limit (e.g., 64KB).

### M8. Silent Queue Accumulation When Tmux Missing
When tmux session doesn't exist, dispatcher silently returns false and messages accumulate. No alerting.

**Recommendation:** After N consecutive tmux-missing checks, log a warning or send notification via alternative channel.

### M9. No Test Suite
**File:** `package.json:9`

Zero test coverage for a critical communication component.

**Recommendation:** Add tests for DB operations, queue ordering, input validation, recovery formatting, edge cases.

---

## Low Severity Findings

| # | Finding | File |
|---|---------|------|
| L1 | `c4-send.js:53-55` silently swallows all DB errors — breaks audit trail | c4-send.js |
| L2 | `package.json` main field points to `c4-db.js` not `scripts/c4-db.js` | package.json |
| L3 | Dispatcher fallback query duplicates `getNextPending()` logic (DRY violation) | c4-dispatcher.js:142 |
| L4 | Hardcoded config values scattered across files (poll interval, delays) | Multiple |
| L5 | Error logs lack stack traces | c4-dispatcher.js:192 |
| L6 | Channel interface has no formal validation or versioning | Design |
| L7 | Scattered SKILLS_DIR path definition | c4-send.js, c4-notify.js |

---

## Performance Findings

### P1. No Database Cleanup / Archival Strategy
**Severity:** HIGH | **File:** `c4-db.js`, `init-db.sql`

No mechanism to clean up old records. The `conversations` table grows indefinitely (~50-100MB/year). The recovery fallback at `c4-db.js:218` does `SELECT * FROM conversations` with no LIMIT when no checkpoint exists — returns entire history unbounded.

**Recommendation:** Add periodic cleanup of delivered messages older than 30 days. Add LIMIT to fallback query. Run periodic `VACUUM`.

### P2. 200ms Delivery Delay is Unnecessary
**Severity:** MEDIUM | **File:** `c4-dispatcher.js:18`

The `DELIVERY_DELAY = 200` between tmux paste-buffer and send-keys adds 200ms latency to every message. Since `execFileSync` blocks until tmux completes, this delay serves no purpose.

**Recommendation:** Reduce to 0-50ms. Immediate latency improvement with zero risk.

### P3. Process Spawning per Channel Send
**Severity:** MEDIUM | **File:** `c4-send.js:69`, `c4-notify.js:46`

Each channel send spawns a new Node.js process (~80-180ms startup). `c4-notify.js` sends sequentially.

**Recommendation:** Use `Promise.all()` for parallel delivery in c4-notify.js. Long-term: consider importing channel modules directly.

### P4. 500ms Polling Loop — Wasteful When Idle
**Severity:** MEDIUM | **File:** `c4-dispatcher.js:17`

~172,800 polls/day. Each poll spawns `tmux has-session` + reads status file + DB query. Most polls find nothing.

**Recommendation:** Use `fs.watch()` on DB file, or adaptive backoff (500ms active → 2-5s idle).

### P5. Multiple Synchronous tmux Spawns per Delivery
**Severity:** MEDIUM | **File:** `c4-dispatcher.js:90-109`

5 separate `execFileSync` calls per message. Could combine paste-buffer and send-keys with tmux `\;` separator.

### P6. Timestamp-Based Recovery Race Condition (Performance Aspect)
**Severity:** MEDIUM | **File:** `c4-db.js:212-228`

String comparison on datetime text is slower than integer/ID comparison. Should use `checkpoint_id` or row IDs for faster and more reliable recovery queries.

### P7. Checkpoint Queried on Every Insert
**Severity:** LOW | **File:** `c4-db.js:120-122`

Every `insertConversation()` runs `SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1`. Cost is negligible (indexed PK), but could be cached in module-level variable.

### P8. Missing Minor PRAGMA Optimizations
**Severity:** LOW | **File:** `c4-db.js:35-36`

Missing `temp_store = MEMORY` pragma. Minor performance gain for temp tables.

### Throughput Analysis
- **Current:** ~4-5 messages/second (bottlenecked by 200ms delay + sequential tmux spawns)
- **Optimized:** ~50-65 messages/second (0ms delay, combined tmux commands)
- **Assessment:** More than adequate for the use case (~1 msg/sec peak real-world)

---

## Positive Findings

- **SQL injection safe** — All queries use parameterized statements
- **Clean module separation** — Each script has a single clear responsibility
- **SQLite WAL mode** — Correct choice for concurrent read/write pattern
- **Priority queue** — Well-implemented with COALESCE fallback
- **Graceful signal handling** — Present (though needs the race condition fix)
- **ESM consistency** — All files correctly use ES modules
- **Good documentation** — SKILL.md is clear with diagrams and examples

---

## Recommended Action Plan

### Phase 1: Critical Fixes (Do First)
1. **Add dead-letter mechanism** for poison messages (C1)
2. **Add source allowlist validation** in receive, send, notify (H1, H6, M2)
3. **Add `busy_timeout` pragma** to prevent concurrent write failures (H5)
4. **Fix shutdown race condition** — don't `process.exit()` in signal handler (H3)

### Phase 2: High Priority
5. **Sanitize tmux content** — escape newlines and control chars (H2)
6. **Fix recovery timestamp precision** — use `>=` or checkpoint_id-based queries (H4, P6)
7. **Auto-discover channels** in c4-notify.js (H7)
8. **Wrap migrations in transactions** (M6)
9. **Add database cleanup/archival** — 30-day retention, LIMIT on fallback query (P1)

### Phase 3: Performance & Hardening
10. **Reduce delivery delay** to 0-50ms (P2)
11. **Parallel sends in c4-notify.js** — use `Promise.all()` (P3)
12. **Add CHECK constraints** to schema (M5)
13. **Enable foreign_keys pragma** (M5)
14. **Add message size validation** (M7)
15. **Add tmux-missing alerting** (M8)
16. **Fix package.json paths** (L2)
17. **Centralize configuration** (L4)

### Phase 4: Quality & Optimization
18. **Add test suite** (M9)
19. **Fix doc-code path mismatch** (M3)
20. **Consolidate duplicate query logic** (L3)
21. **Add stack traces to error logs** (L5)
22. **Combine tmux commands** with `\;` separator (P5)
23. **Adaptive polling** or event-driven dispatch (P4)
24. **Cache checkpoint ID** in module variable (P7)
25. **Add temp_store PRAGMA** (P8)
