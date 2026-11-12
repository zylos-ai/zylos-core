import { fileURLToPath } from 'node:url';

// The scheduler CLI beside this skill, as installed. Run from a session without a reply target, `add` saves the
// session's ZYLOS_SESSION_GROUP (Origin saves none and runs in Origin), so the task wakes this same group.
const SCHEDULER_CLI = fileURLToPath(new URL('../../scheduler/scripts/cli.js', import.meta.url));

// Sent before every TTL reclaim, ahead of any reclaim Sync, so that Sync records the handoff and task it leaves.
export const PRE_RECLAIM_CHECK_PROMPT = 'This session group has been idle and will be reclaimed. Before acknowledging this control, check the actual current state of your in-progress work (for example a PR and its CI, replies you are waiting for from others, pending handoffs). '
  + 'If any work is still waiting on an external event, handle each such item before writing the session handoff. '
  + `First run node "${SCHEDULER_CLI}" list --json and check this session group's tasks with status "pending" (their session_group_name is everything after the first colon of $ZYLOS_SESSION_GROUP, and is empty when it has no colon, as for Origin); if one already covers the same check, do not create another. `
  + 'If the item has already been waiting for more than a day without progress, do not schedule another wake-up for it; state this in the session handoff and tell the person responsible for it. '
  + `Otherwise create a one-time scheduled task that wakes this session group to check it: run node "${SCHEDULER_CLI}" add "<self-contained instructions for the check>" --in "<delay>" --json in this session, without any --reply option, so the task is saved to this session group, and confirm it reports ok:true. `
  + 'Then write the session handoff. If nothing is waiting on an external event, acknowledge directly.';
