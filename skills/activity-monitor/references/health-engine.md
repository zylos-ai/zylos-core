# Recovery and maintenance behavior

The HealthEngine maintenance loop runs every second by default. It does not enqueue periodic `primary` heartbeats, even after prolonged healthy operation. `heartbeatEnabled`, `heartbeatInterval`, and `lastHeartbeatAt` were removed; no replacement config flag exists.

Maintenance preserves these paths:

- Pending results are processed before runtime-running and health gates. Success clears pending state and restores `ok`; failures keep their existing recovery/rate-limit handling. Legacy pending records, including `primary` phases, are still processed.
- Pending probes older than 30 seconds can trigger API-error scanning, at most once per 15 seconds. The 600-second absolute pending ceiling remains.
- `unavailable` / legacy `recovering` retries enqueue `recovery` with exponential backoff (60, 300, 1500, then 3600 seconds, capped).
- Restart notifications schedule a `post_restart` probe (5-second default delay). A false-to-true process signal also permits an accelerated `post_restart` probe after the 30-second grace period.
- Legacy `down` state enqueues `down-check` at the 3600-second default retry interval.
- Rate-limit cooldown expiry clears the cooldown without restarting or enqueueing a periodic probe. User messages can trigger recovery checks or accelerate existing retries, subject to the existing cooldown.
- User-message delivery continues to trigger the existing rate-limit and sticky API-error checks in healthy sessions.

The dispatcher always delivers `recovery` and `post_restart` probes end-to-end. It retains the existing confirmed-active busy auto-ack rule for other heartbeat phases, including `down-check` and unknown phases, but no longer auto-acks idle primary probes.

Removing periodic primary probes also removes their former safety-net coverage of a stuck session with no pending probe or other recovery trigger. No substitute periodic detector is introduced. System health checks (PM2, disk, memory) remain a separate scheduled task.
