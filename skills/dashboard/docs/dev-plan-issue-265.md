# Dev Plan: Fleet poller — silent death of SSE reconnect + fallback polling (#265)

## Summary

After a failed first connection (observed during the 06:02 simultaneous deploy restart of both boxes), a fleet member's SSE reconnect chain and fallback polling chain can both die silently, leaving the member frozen at `unreachable` forever with zero log output. This plan hardens the poller so its recovery loops cannot die silently: every async path settles, a watchdog invariant revives dead loops, and loop lifecycle transitions are logged. It also fixes the related observability-noise finding from the same incident: secret-guard broadcast skips are indistinguishable from real staleness to fleet subscribers.

Production evidence is in #265 (frozen `updated_at`, zero TCP connections, healthy link verified at the same moment, instant recovery on process restart).

## Scope

**In scope**

1. **SSE connect timeout** — `_fetchStream()` currently uses raw `this.fetch` with no deadline; a fetch stuck awaiting response headers never settles and is covered by no watchdog. Add a headers-received deadline so `_runSse` always settles.
2. **`connecting` flag hardening** — `_connectSse()` early-returns while `connecting === true`; if `_runSse` never settles, every future reconnect no-ops forever. Fix via (1) plus a watchdog-side wedge detector (defense in depth).
3. **Self-healing watchdog invariant** — periodic check per configured member: if the record is frozen AND no recovery activity is pending, force-restart the loops and log. This is the backstop against any future race, not just the ones we can name today.
4. **Loop lifecycle logging** — SSE connect failure (with reason + next retry delay), fallback polling start/stop, watchdog revival. The production incident produced zero log lines; that must be impossible going forward.
5. **Guard-skip redacted placeholder** — when `assertFleetPayloadSafe` rejects a broadcast, redact secret values from string fields and re-assert instead of silently skipping. Subscribers keep receiving fresh, honest data with `[redacted]` placeholders; fail-closed is preserved (still skip + log if redaction doesn't pass the re-assert).

**Out of scope**

- UI/frontend changes — none of the above is user-visible markup; no `style.css?v=N` bump expected.
- `/api/fleet` payload schema changes — `link` payload from #263 is untouched.
- Root-causing the exact production race post-mortem — the watchdog invariant makes the class of bug self-healing; we add regression tests for the mechanisms we can reproduce deterministically.
- Fleet proxy (`fleet-proxy.js`) secret handling — its `secret_leak_blocked` responses are request/response scoped, not broadcast loops.

## Design Decisions

### D1: SSE connect timeout

`_fetchStream` gets a headers deadline using the existing `fleet.timeout_ms` (default 2500ms) — same budget as `_fetchState`/`_ensureToken`, no new config knob. Implementation: a timer that aborts a dedicated "connect phase" signal, cleared as soon as the response (headers) arrives. **Body streaming is explicitly NOT subject to this deadline** — long-lived quiet streams are legitimate and remain covered by the existing idle watchdog (#180), which arms only after the body starts. The two watchdogs are complementary, not overlapping: connect-phase vs streaming-phase.

Constraint: the connect-phase abort must compose with the existing `stream.controller` signal (caller-initiated abort must still work during connect). Use `AbortSignal.any([controllerSignal, connectDeadlineSignal])` (Node 20.3+, we require Node 20+).

### D2: `connecting` flag cannot wedge

Primary fix is D1 (every `_runSse` settles, `finally` clears `connecting`). Defense in depth: record `stream.connectingSince = now()` when setting the flag. The watchdog (D3) treats `connecting === true && now - connectingSince > 2 × timeout_ms + reconnectMaxMs` as wedged: abort `stream.controller`, clear `connecting`, restart loops, log. We deliberately do NOT change the early-return semantics of `_connectSse` — it correctly prevents concurrent connect attempts; we only bound how long it can hold.

### D3: Self-healing watchdog invariant

A single poller-level interval timer (started in `start()`, stopped in `stop()`, unref'd), period = `pollIntervalMs`. Each tick, for every configured agent, classify:

- **Healthy-active**: SSE body currently being read (`stream.reading === true`, new explicit flag set after a 2xx stream response, cleared in the read `finally`). Skip — a quiet stream with old data is legitimate (#180 covers byte-silence).
- **Recovering**: `stream.pollTimer` or `stream.reconnectTimer` pending, or `connecting` within its bound. Skip — recovery machinery is alive.
- **Wedged-connecting**: per D2 — abort, clear, revive, log.
- **Dead**: none of the above AND record `updated_at` older than `2 × pollIntervalMs`. Revive: `_startFallbackPolling(agent)` + `_scheduleReconnect(agent)` (both already idempotent), log at warn level with the frozen duration.

The `updated_at` age condition keeps the watchdog from racing normal in-flight operations (a poll in flight has no pending timer for one interval at most, and a completed poll always bumps `updated_at` via `_setSuccess`/`_setFailure` — verified property, see Assumptions).

Generation safety: all watchdog actions go through the existing `_agentGeneration`/`_isCurrentAgent` checks so config reloads mid-tick are safe.

### D4: Lifecycle logging

Prefix `[fleet]`, plain `console.log`/`console.warn` like the rest of the codebase (pm2 adds timestamps). Events:

- SSE connect failure: agent, classified reason, next retry delay (`[fleet] sse connect failed agent=X reason=conn_refused retry_in_ms=4000`)
- Fallback polling start/stop: agent + trigger (sse-failure / compatibility-timer / watchdog / sse-takeover)
- Watchdog revival: agent, classification (dead / wedged-connecting), frozen duration
- Guard-skip redaction: pattern category hit, whether redaction passed re-assert (never log the matched value itself)

Volume control: connect-failure logs are naturally rate-limited by exponential backoff (cap `reconnectMaxMs`), worst case ~1–2 lines/min per dead member. No additional dedup logic — outage visibility is the point.

### D5: Guard-skip redaction (fail-closed preserved)

New `redactFleetPayload(payload)` in `fleet-payload.js`:

1. Deep-walk the payload; transform **string leaf values only** (never keys, never non-strings).
2. Replace token-shaped matches `zylos_(ak|st)_[A-Za-z0-9_-]+` → `[redacted]` (charset deliberately wider than today's hex to be future-proof), and literal field-name leaks `read_api_key` / `read_session_token` inside text → `[redacted]`.
3. Re-run `assertFleetPayloadSafe` on the result. Pass → broadcast the redacted payload. Still failing (e.g. pattern appears as an object **key**, which would indicate a code regression, not chatty activity text) → keep today's behavior: skip the broadcast, log `[fleet] SSE broadcast skipped: fleet_secret_leak_guard (redaction insufficient)`.

This honors all three review criteria zylos0t pre-stated: no secret can leak (re-assert is the same fail-closed gate), data semantics stay real (it is the current payload with fresh real timestamps, only secret substrings masked — never a replayed stale payload), and genuine SSE/fallback freezes are not masked (redaction only runs on guard hits; a frozen poller still freezes and is now visible via D3/D4).

Broadcast call site: wherever `buildFleetPayload`'s guard error is currently caught and skipped (the `[fleet] SSE broadcast skipped: fleet_secret_leak_guard` log seen on zylos0t's box) — wire redaction in there, single site.

## Development Checklist

- [ ] `_fetchStream`: headers deadline via `AbortSignal.any` composing caller signal + connect timer; timer cleared on response; classified error (`timeout`) on deadline
- [ ] `stream.connectingSince` recorded alongside `connecting = true`; cleared with the flag
- [ ] `stream.reading` flag: set after 2xx stream response accepted, cleared in the body-read `finally`
- [ ] Watchdog: interval timer in `start()`/`stop()`, per-agent classification (healthy-active / recovering / wedged-connecting / dead), revival actions, generation-safe
- [ ] Lifecycle logging per D4 (including the previously-silent paths: `_connectSse` catch, `_startFallbackPolling`, `_stopFallbackPolling`)
- [ ] `redactFleetPayload` in `fleet-payload.js` + wiring at the broadcast guard-catch site
- [ ] No changes to `/api/fleet` schema, `link` derivation, or frontend

## Test Checklist

Unit tests (extend `test/fleet-poller.test.js` fake-timer/fake-fetch infra; new `fleet-payload` cases in its existing test home):

- [ ] SSE fetch that never resolves: settles at `timeout_ms`, `connecting` clears, fallback polling starts, reconnect scheduled — loops alive
- [ ] Connect deadline does NOT fire after headers arrive: long-lived quiet stream survives past `timeout_ms` (idle watchdog #180 still owns byte-silence — existing tests must stay green)
- [ ] Caller abort during connect phase still works (signal composition)
- [ ] Watchdog revives "dead" state: frozen `updated_at`, no timers, not connecting → fallback + reconnect restarted, warn logged
- [ ] Watchdog revives wedged-connecting: `connectingSince` beyond bound → abort + clear + revive
- [ ] Watchdog no-ops on: healthy-active (reading=true, old updated_at), recovering (pending timers), fresh records
- [ ] Watchdog stops with `stop()`; no timer leaks (assert via fake-timer registry like existing probe lifecycle tests)
- [ ] Redaction: token in activity text → broadcast proceeds, value replaced, re-assert passes
- [ ] Redaction fail-closed: pattern as object key → broadcast skipped + logged
- [ ] Redaction leaves non-string leaves and clean payloads byte-identical (no false rewrites)
- [ ] Regression: full existing suite (419 + new) green

Manual verification: see Acceptance.

## Assumptions

- [ ] `_setSuccess`/`_setFailure` always bump `updated_at` — **verified in code and confirmed by today's production evidence** (frozen `updated_at` ⇔ zero completed attempts). The watchdog's "dead" classification depends on this.
- [ ] `AbortSignal.any` is available — guaranteed: project requires Node 20+, `AbortSignal.any` landed in 20.3. State explicitly in PR; no polyfill.
- [ ] Existing `_startFallbackPolling`/`_scheduleReconnect` are idempotent (early-return on pending timer) — verified in code; watchdog relies on this to be safe to call concurrently with normal operation.
- [ ] Secret token charset: current keys are hex, redaction regex covers `[A-Za-z0-9_-]+` superset — needs no system guarantee, wider is safe.
- [ ] Quiet-but-healthy SSE streams are legitimate and must not be revived/aborted by the new watchdog — guaranteed by design of #180 (keepalive comments every 15s keep the connection non-silent; data events may still be sparse). The `reading` flag honors this.

## Acceptance Checklist

- [ ] **Dead member recovery visibility**: sandbox (pattern from #263: `ZYLOS_DIR=/tmp/accept-265`, real fleet members + one dead member on a high closed port) — logs show classified connect failures with retry delays; member shows `down/conn_refused`; no silent gaps
- [ ] **Recovery without restart**: kill a live member's dashboard, wait through several reconnect cycles, bring it back → member returns to `ok` with no sandbox restart; log trail shows the full failure → recovery arc
- [ ] **Restart-race regression**: start the sandbox while a member is unreachable, let it fail its first connection, then make the member reachable → record un-freezes (this is the production scenario; pass = `updated_at` advances and member goes green)
- [ ] **Watchdog backstop**: covered by unit tests (deterministic wedge states are not reproducible from outside the process; this mirrors how `degraded` was accepted in #263)
- [ ] **Guard redaction live**: configure the sandbox's own activity to contain a `zylos_ak_…`-shaped string → subscriber sees `[redacted]` in activity, data stays fresh (no stale flicker), nothing secret-shaped in the wire payload
- [ ] No regressions: full `npm test`, `npm run check`, `git diff --check`
- [ ] No frontend diff (assert: no changes under `public/`)

## Review trail

- Production incident evidence: #265 issue body (2026-06-12)
- Guard-skip noise finding + review criteria: HXA thread with zylos0t (2026-06-12 ~15:10–15:30), criteria incorporated into D5
- Plan review: Jinglever (pending)
