import { fileURLToPath } from 'node:url';

// The scheduler CLI beside this skill, as installed. Run from a session without a reply target, `add` saves the
// session's ZYLOS_SESSION_GROUP (Origin saves none and runs in Origin), so the task wakes this same group.
const SCHEDULER_CLI = fileURLToPath(new URL('../../scheduler/scripts/cli.js', import.meta.url));

// Sent before every TTL reclaim, ahead of any reclaim Sync, so that Sync records the handoff and task it leaves.
export const PRE_RECLAIM_CHECK_PROMPT = 'This session group has been idle and will be reclaimed. Before acknowledging this control, check the actual current state of your in-progress work (for example a PR and its CI, replies you are waiting for from others, pending handoffs). '
  + `If any work is still waiting on an external event, first create a one-time scheduled task that wakes this session group to check it: run node "${SCHEDULER_CLI}" add "<self-contained instructions for the check>" --in "<delay>" --json in this session, without any --reply option, so the task is saved to this session group, and confirm it reports ok:true; then write the session handoff. `
  + 'If nothing is waiting on an external event, acknowledge directly.';
