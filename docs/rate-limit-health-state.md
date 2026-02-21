# Proposal: Rate-Limit Health State for Activity Monitor

**Status:** Draft
**Branch:** feat/rate-limit-health-state
**Target version:** v0.2.1
**Authors:** Zylos100

## Problem

When Claude Code hits an API rate limit, it displays an interactive menu:

```
You've hit your limit · resets 4am (Asia/Singapore)

❯ /rate-limit-options
───────────────────────────────────────────────────
 What do you want to do?

 ❯ 1. Stop and wait for limit to reset
   2. Request more

 Enter to confirm · Esc to cancel
```

This interactive prompt blocks the input pipeline. The C4 dispatcher cannot deliver messages (including heartbeat probes), because the tmux input box is replaced by the menu.

### What happens today

1. Claude hits rate limit → interactive menu appears
2. No activity for 300 seconds → stuck detection triggers
3. Heartbeat probe enqueued → dispatcher tries to deliver
4. Dispatcher pastes message into the menu → `submitAndVerify()` fails (no input box separator found)
5. Heartbeat times out → `HeartbeatEngine` transitions `ok → recovering`
6. Recovery kills tmux session and restarts Claude
7. New session starts but hits the same rate limit → restart fails
8. After 3 failed restarts → health becomes `down`
9. Periodic 30-minute probes in `down` state until rate limit eventually clears

**Result:** ~2 hours of downtime. Users receive a generic "I'm currently offline" message with no indication of when service will resume. The kill-restart cycle is wasteful since Claude's process is healthy — only the API quota is exhausted.

### Incident timeline (2026-02-20)

| Time | Event |
|------|-------|
| 18:37 | Claude enters idle state |
| 18:42 | Stuck detection triggers (300s no activity) |
| 18:42 | Heartbeat probe enqueued; tmux capture shows rate-limit menu |
| 18:44 | Heartbeat timeout → `ok → recovering`, tmux killed, restart attempt 1/3 |
| 18:50 | Restart attempt 2/3 (same rate-limit menu) |
| 18:57 | Restart attempt 3/3 → `recovering → down` |
| 19:27–20:02 | 30-minute probes fail (rate limit still active) |
| 20:27 | Rate limit clears, heartbeat succeeds → `down → ok` |

## Solution: `rate_limited` Health State

Add `rate_limited` as a new health state that the system can distinguish from `recovering` and `down`. Instead of killing and restarting Claude (which doesn't help), the system:

1. Dismisses the rate-limit menu (Escape key)
2. Transitions to `rate_limited` health
3. Gives users an instant, specific reply with the expected reset time
4. Probes every 5 minutes until the limit clears
5. Automatically recovers and notifies waiting users

## State Machine Changes

### Current states

```
ok ──[heartbeat fail]──→ recovering ──[3 failures]──→ down
 ↑                                                      │
 └──────────────[heartbeat success]─────────────────────┘
```

### New states

```
ok ──[heartbeat fail]──→ recovering ──[3 failures]──→ down
 │                            │                         │
 │   [rate limit detected]    │  [rate limit detected]  │
 │           │                │         │               │
 ↓           ↓                ↓         ↓               │
 └──→ rate_limited ←──────────┘         │               │
         │                              │               │
         │ [heartbeat success]          │               │
         ↓                              │               │
        ok ←────────────────────────────┘───────────────┘
```

Key differences from `recovering`/`down`:

| Behavior | recovering / down | rate_limited |
|----------|-------------------|--------------|
| Kill tmux session | Yes | **No** |
| Restart Claude | Yes | **No** |
| Probe interval | 60–300s (recovering) / 30min (down) | **300s (5 min)** |
| User message | "temporarily unavailable" / "offline" | **"rate-limited, resets at X"** |
| Pre-probe action | None | **Send Escape to dismiss menu** |
| Stuck detection | Active | **Suppressed** |

### Transitions

| From | To | Trigger |
|------|-----|---------|
| `ok` | `rate_limited` | Dispatcher detects rate-limit in tmux capture |
| `recovering` | `rate_limited` | Dispatcher detects rate-limit during recovery probe |
| `rate_limited` | `ok` | Heartbeat probe succeeds (rate limit cleared) |
| `rate_limited` | `rate_limited` | Heartbeat probe fails (still rate-limited) — no escalation |

Note: `rate_limited` never transitions to `recovering` or `down`. It stays in `rate_limited` until the limit clears.

## Detection Layer (c4-dispatcher.js)

### When detection happens

The dispatcher already captures the tmux pane content in `submitAndVerify()` when input-box separator detection fails (state = `indeterminate`). Rate-limit detection hooks into this existing code path.

### Detection logic

When `checkInputBox()` returns `indeterminate`, inspect the captured pane content for:

```javascript
const RATE_LIMIT_PATTERN = /You've hit your limit/i;
const RESET_TIME_PATTERN = /resets\s+(\d{1,2}(?:am|pm)\s*\([^)]+\))/i;
```

### Actions on detection

1. **Parse reset time** from the capture (e.g., "4am (Asia/Singapore)")
2. **Send Escape** to dismiss the interactive menu: `tmux send-keys -t claude-main Escape`
3. **Write signal file** at `~/zylos/activity-monitor/rate-limit-signal.json`:

```json
{
  "detected_at": 1740000000,
  "reset_hint": "4am (Asia/Singapore)",
  "source": "dispatcher",
  "capture_snippet": "You've hit your limit · resets 4am (Asia/Singapore)"
}
```

4. **Return `'rate_limited'`** from `sendToTmux()` (new return value alongside existing `'submitted'` and `'paste_error'`)

### Dispatcher handling of rate_limited return

In `processNextMessage()`, when `sendToTmux()` returns `'rate_limited'`:

- For **control items** (heartbeats): mark as failed with reason `'RATE_LIMITED'`
- For **conversation items** (user messages): requeue for later delivery
- Do **not** retry — the rate limit won't resolve by retrying

## State Transition Layer (activity-monitor.js)

### Signal file polling

Add to `monitorLoop()`: check for `rate-limit-signal.json` on every tick (1 second). When found:

1. Read signal file, extract `reset_hint`
2. Call `engine.setRateLimited(resetHint)` to transition health state
3. Write `rate_limit_reset` field into `claude-status.json` (for c4-receive.js to read)
4. Delete signal file
5. Log the transition with reset time
6. Notify owner via configured channel (Telegram DM):
   "API rate limit triggered. Expected reset: {reset_hint}. I'll recover automatically."

### Stuck detection suppression

When `engine.health === 'rate_limited'`, skip the stuck detection block in `monitorLoop()`. We already know why there's no activity — triggering stuck probes would be redundant.

## Heartbeat Engine Changes (heartbeat-engine.js)

### New method: `setRateLimited(resetHint)`

```javascript
setRateLimited(resetHint) {
  if (this.healthState === 'rate_limited') return;
  this.setHealth('rate_limited', `api_rate_limit (resets ${resetHint})`);
  this.resetHint = resetHint;
  this.restartFailureCount = 0;       // Clear recovery counter
  this.lastRateLimitCheckAt = 0;      // Allow immediate first probe
  this.deps.clearHeartbeatPending();   // Clear any in-flight heartbeat
}
```

### processHeartbeat() — rate_limited branch

```javascript
if (this.healthState === 'rate_limited') {
  if ((currentTime - this.lastRateLimitCheckAt) < this.rateLimitRetryInterval) {
    return;
  }
  // Dismiss any lingering menu before probing
  this.deps.dismissRateLimitMenu();
  const ok = this.enqueueHeartbeat('rate-limit-check');
  if (ok) {
    this.lastRateLimitCheckAt = currentTime;
  }
  return;
}
```

Configuration: `rateLimitRetryInterval = 300` (5 minutes).

### onHeartbeatSuccess() — no changes needed

The existing logic already handles any non-`ok` → `ok` transition:

```javascript
if (this.healthState !== 'ok') {
  this.setHealth('ok', `heartbeat_ack phase=${phase}`);
  this.deps.notifyPendingChannels();
}
```

This covers `rate_limited → ok` automatically.

### onHeartbeatFailure() — rate_limited branch

```javascript
if (this.healthState === 'rate_limited') {
  this.deps.log(`Still rate-limited (${status}); next check in ${this.rateLimitRetryInterval}s`);
  this.deps.clearHeartbeatPending();
  return;
}
```

No escalation — stays in `rate_limited`. No tmux kill, no restart.

### New dependency: `dismissRateLimitMenu`

Injected via `deps` object. Implementation in activity-monitor.js:

```javascript
function dismissRateLimitMenu() {
  try {
    execSync(`tmux send-keys -t "${SESSION}" Escape 2>/dev/null`);
  } catch {
    // Best-effort
  }
}
```

## User Response Layer (c4-receive.js)

### New health check branch

```javascript
const health = readHealthStatus();
if (health !== 'ok') {
  recordPendingChannel(channel, endpoint);

  if (health === 'rate_limited') {
    const resetHint = readRateLimitReset();
    const msg = resetHint
      ? `I've hit my API rate limit and expect to be back around ${resetHint}. I'll reach out as soon as I'm available!`
      : "I've hit my API rate limit. I'll reach out as soon as it resets!";
    emitError(json, 'HEALTH_RATE_LIMITED', msg);
  }

  if (health === 'down') {
    emitError(json, 'HEALTH_DOWN', "I'm currently offline...");
  }
  emitError(json, 'HEALTH_RECOVERING', "I'm temporarily unavailable...");
}
```

### readRateLimitReset()

Read `rate_limit_reset` from `claude-status.json`:

```javascript
function readRateLimitReset() {
  try {
    const status = JSON.parse(fs.readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
    return status.rate_limit_reset || null;
  } catch {
    return null;
  }
}
```

## Status File Schema Update (claude-status.json)

When `health = 'rate_limited'`, activity-monitor.js writes an additional field:

```json
{
  "state": "idle",
  "health": "rate_limited",
  "rate_limit_reset": "4am (Asia/Singapore)",
  "last_check": 1740000000,
  "last_check_human": "2026-02-21 02:30:00"
}
```

The `rate_limit_reset` field is removed when health transitions back to `ok`.

## Cooldown and Probe Timing

| Phase | Interval | Action |
|-------|----------|--------|
| Detection | Immediate | Write signal file, send Escape |
| First probe | 0–300s after detection | Heartbeat check |
| Subsequent probes | Every 300s (5 min) | Send Escape + heartbeat check |
| Recovery | Immediate on heartbeat success | Health → ok, notify pending channels |

Why 300s (5 min):
- Short enough to recover promptly after rate limit clears
- Long enough to avoid unnecessary probes during a known wait
- Significantly shorter than `down` state's 30-minute interval, since rate limits always self-resolve

## Edge Cases

### 1. Rate limit detected during `recovering` state

If the system is already in `recovering` (restart cycle in progress) and the dispatcher detects a rate-limit screen during delivery:

- Signal file is written as usual
- Activity monitor reads signal → calls `engine.setRateLimited()`
- `setRateLimited()` transitions `recovering → rate_limited`, clearing the restart counter
- The restart cycle stops — no more kill/restart attempts

This is the key fix for the 2026-02-20 incident: the system would have stopped after the first restart attempt instead of cycling through all 3.

### 2. Rate limit clears between probes

Worst case: 5-minute delay between the limit clearing and the heartbeat probe detecting it. This is acceptable — far better than the current 30-minute delay in `down` state.

### 3. Non-rate-limit interactive prompts

The detection pattern is specific to rate-limit text. Other interactive prompts (e.g., permission requests, confirmation dialogs) are not affected by this change and follow the existing recovery flow.

Future work may generalize interactive-prompt detection, but this proposal focuses solely on rate limits as the observed failure mode.

### 4. Signal file race condition

The dispatcher writes the signal file; the activity monitor reads and deletes it. Since the monitor polls every 1 second and the dispatcher writes atomically, the race window is negligible. Even if the file is read between write and completion, the next tick will pick it up.

### 5. Persistence across restarts

If the activity monitor is restarted (PM2 restart), it reads `health` from `claude-status.json` on startup via `loadInitialHealth()`. If health is `rate_limited`, the engine starts in that state and continues probing. The `rate_limit_reset` field in the status file provides context.

## Changes Summary

| File | Change |
|------|--------|
| `skills/comm-bridge/scripts/c4-dispatcher.js` | Add rate-limit detection in `submitAndVerify()`, write signal file, return `'rate_limited'` status, handle in `processNextMessage()` |
| `skills/activity-monitor/scripts/heartbeat-engine.js` | Add `rate_limited` health state, `setRateLimited()` method, probe logic (300s interval), suppress escalation on failure |
| `skills/activity-monitor/scripts/activity-monitor.js` | Poll signal file in `monitorLoop()`, call `setRateLimited()`, skip stuck detection when rate-limited, add `dismissRateLimitMenu` dependency, notify owner |
| `skills/comm-bridge/scripts/c4-receive.js` | Add `rate_limited` health branch with specific user-facing message including reset time |

No new files or dependencies.

## Testing Plan

### Unit Tests

1. **HeartbeatEngine** — `rate_limited` state transitions:
   - `ok → rate_limited` via `setRateLimited()`
   - `recovering → rate_limited` via `setRateLimited()`
   - `rate_limited → ok` on heartbeat success
   - `rate_limited` stays on heartbeat failure (no escalation)
   - Probe interval respected (300s)
   - `dismissRateLimitMenu` called before each probe

2. **c4-dispatcher** — Rate-limit detection:
   - Capture containing rate-limit text → returns `'rate_limited'`
   - Capture without rate-limit text → existing behavior unchanged
   - Reset time parsing (various formats)
   - Signal file written with correct schema

3. **c4-receive** — User response:
   - `health = 'rate_limited'` with reset hint → message includes time
   - `health = 'rate_limited'` without reset hint → generic message
   - Pending channel recorded for recovery notification

### Integration Tests

1. Simulate rate-limit screen in tmux → verify full flow:
   detection → signal file → state transition → user response → probe → recovery
2. Verify owner notification sent on rate-limit detection
3. Verify pending channel notifications sent on recovery

## References

- [Incident: 2026-02-20 rate-limit downtime](#problem) (this document)
- [Hook-Based Activity Tracking](./hook-activity-tracking.md) — related proposal for activity detection
- `skills/activity-monitor/scripts/heartbeat-engine.js` — current heartbeat state machine
- `skills/comm-bridge/scripts/c4-dispatcher.js` — current message delivery pipeline
