# Bounded periodic Enter fallback

No hook integration or configuration changes are included. Normal paste uses
`tmux paste-buffer -p`: tmux wraps the paste when the application enables
bracketed paste. A separate Enter still submits. Isolated Claude 2.1.280 and
Codex idle tests validated this; busy/modal behavior is not proven.

Dispatcher environment settings (no live settings changed):

| Setting | Default | Meaning |
| --- | --- | --- |
| `C4_PERIODIC_ENTER_ENABLED` | off | Set `1` to enable |
| `C4_PERIODIC_ENTER_INTERVAL_MS` | 60000 | Minimum 1000; monotonic elapsed time |
| `C4_PERIODIC_ENTER_MAX_ATTEMPTS` | 3 | Positive integer, capped at 10 |
| `C4_ENTER_CAPTURE_ENABLED` | off | Set `1` for sensitive local pane captures |

A successful conversation paste arms a fresh attempt budget. Startup has no
armed state and cannot recover a draft left before dispatcher restart. Initial
and verification Enter success reset the timer. Each periodic attempt consumes
budget, including failed sends; successful sends reset the interval but never
reset that budget. Exhaustion logs once, then stops until another actual
conversation paste. Controls disarm; auto-acked heartbeats do not arm or reset.

The awaited dispatcher loop serializes paste, verification, and periodic Enter.
No second timer writes keys. Polling and long delivery waits can delay a due
attempt. New messages can postpone it indefinitely. Only fresh healthy idle
status and a fresh live nonfrozen process allow a supplement. Busy waits until
idle. Runtime configuration, pane ID, process PID and Linux process start time
pin the target; missing/changed identity disarms rather than targeting a new
session. Configuration/runtime switching should restart the dispatcher as usual.

The fallback does not inspect draft content, repaste, requeue, or change any
delivered state. A successful tmux command is evidence of key injection, not
application submission. Existing normal delivery verification remains unchanged.
This is for agent-only terminals: idle does not prove absence of a dialog or a
human draft. A supplement can submit either, or create an empty turn. Enable
only after checking the intended runtime's idle, busy, and modal behavior.

Structured standard logs contain timestamps, paste byte count, item ID/type,
Enter kind/result, cursor/fallback verdict, arm/reset and bounded-attempt events.
No message text, pane text, or paste-command error string is logged. The trace
can establish commands and detector branches, but cannot prove real submission.
Opt-in snapshots capture only the visible pane before/after a periodic attempt
and before each normal verification check, including cursor/pane geometry.
They can contain secrets and are local only: `activity-monitor/enter-captures/`
is mode 0700 with at most 100 mode-0600 JSON files, at most 8192 capture characters
each. Capacity stops new snapshots and logs once; nothing is deleted or
overwritten. No scrollback is captured or uploaded. Captures add at most two
500ms command timeouts per observation; capture is off by default.

Verification: `node --test skills/comm-bridge/scripts/__tests__/periodic-enter.test.js`
and existing dispatcher tests. No production enablement, deployment, or hook
changes are part of this patch.
