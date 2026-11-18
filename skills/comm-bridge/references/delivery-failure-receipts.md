# Terminal delivery notifications

Terminal delivery failures leave the original conversation `failed`; they do
not replay it. Historical failed messages are not backfilled.

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
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin ID --end ID --json
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
