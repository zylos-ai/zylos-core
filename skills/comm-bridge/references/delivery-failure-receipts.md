# Terminal delivery notifications

Terminal delivery failures leave the original conversation `failed`; they do
not replay it. Historical failed messages are not backfilled.

## Internal receipts

An internal failure inserts a receipt for the sender group into `conversations`
in the same transaction as the original failure. The receipt's own
`delivery_action=failure_receipt` prevents recursive receipts. This uses the
existing conversations table; no new table or schema migration is required.

## External owner alerts

An external terminal failure makes one best-effort owner-alert attempt through
existing `SupervisorServerHealth` notification routing. Existing
`status_notice_cooldowns` admit at most one alert per target session group and
failure reason in 600 seconds. There is no send retry or persistent alert queue.
A crash between committing the failure and sending the alert can lose the
owner alert; this is a known limitation. The original message stays failed.

Initial authorization and unhealthy-channel rejection replies remain unchanged.
Scheduler control-queue work is outside this conversation-row failure path.

## Launch diagnostics

Tmux preflight and runtime exec share a 10-second launch budget. The separate
30-second runtime READY budget is unchanged. Router diagnostics record
`session_launch_failed` with the conversation ID, phase, cause and timings.

## Investigating an alert

1. Resolve an unclear short owner reply using
   [Short Replies to Owner Alerts](../SKILL.md#short-replies-to-owner-alerts).
   Agreement to investigate authorizes a read-only investigation.
2. Take the original conversation ID from the alert. Use existing
   [c4-db](c4-db.md) / [c4-fetch](c4-fetch.md) reads to inspect its message state
   and available failure reason. Fetch only this chat's relevant records;
   respect the documented content-projection rules for custom reads. For an
   exact ID, use:

   ```bash
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin ID --end ID
   ```

3. Find `session_launch_failed` events with that `conversation_id` in Router
   diagnostics (`$ZYLOS_DIR/comm-bridge/router-events.jsonl`, default
   `~/zylos/comm-bridge/router-events.jsonl`, including retained rotations).
   Compare the recorded phase, cause and timings. Missing retained evidence
   does not establish that delivery succeeded; report any unknown reason.
4. Explain the failure and available evidence to the owner. The original
   message remains failed even if the target is healthy now. Obtain an
   explicit decision before rerunning a task or notifying its original sender;
   never silently replay a message or change it back to pending.
