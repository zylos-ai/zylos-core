import { fileURLToPath } from 'node:url';

// The scheduler CLI beside this skill, as installed. Run from a session without a reply target, `add` saves the
// session's ZYLOS_SESSION_GROUP (Origin saves none and runs in Origin), so the task wakes this same group.
const SCHEDULER_CLI = fileURLToPath(new URL('../../scheduler/scripts/cli.js', import.meta.url));

// The check of work waiting on external events, shared by every pre-restart prompt. Only the opening reason and
// the closing step differ by scenario.
const WAITING_WORK_CHECK = 'check the actual current state of your in-progress work (for example a PR and its CI, replies you are waiting for from others, pending handoffs). '
  + 'If any work is still waiting on an external event, handle each such item before writing the session handoff. '
  + `First run node "${SCHEDULER_CLI}" list --json and check this session group's tasks with status "pending" (their session_group_name is everything after the first colon of $ZYLOS_SESSION_GROUP, and is empty when it has no colon, as for Origin); if one already covers the same check, do not create another. `
  + 'If the item has already been waiting for more than a day without progress, do not schedule another wake-up for it; state this in the session handoff and tell the person responsible for it. '
  + `Otherwise create a one-time scheduled task that wakes this session group to check it: run node "${SCHEDULER_CLI}" add "<self-contained instructions for the check>" --in "<delay>" --json in this session, without any --reply option, so the task is saved to this session group, and confirm it reports ok:true. `;

const checkControlPrompt = reason => `${reason} Before acknowledging this control, ${WAITING_WORK_CHECK}`
  + 'Then write the session handoff. If nothing is waiting on an external event, acknowledge directly.';

// Sent before every TTL reclaim and capacity or memory-pressure eviction, ahead of any reclaim Sync, so that Sync
// records the handoff and task it leaves.
export const PRE_RECLAIM_CHECK_PROMPT = checkControlPrompt('This session group has been idle and will be reclaimed.');

// Sent before each session group restarts for an upgrade.
export const UPGRADE_RESTART_CHECK_PROMPT = checkControlPrompt('This session group will be restarted for an upgrade.');

// Sent before the single session exits for an upgrade. That session has no ZYLOS_SESSION_GROUP; a scheduler task it
// saves has no session group and wakes this same session, which the check's Origin wording covers.
export const SINGLE_UPGRADE_RESTART_CHECK_PROMPT = checkControlPrompt('This session will be restarted for an upgrade. '
  + 'In single-session mode it is the only session group and $ZYLOS_SESSION_GROUP is unset.');

// The single control sent when a group's launch configuration changed; it carries the same check before the handoff.
export const CONFIG_RECLAIM_PROMPT = 'The launch configuration changed and this session group will be restarted with it. '
  + `Before submitting ready_for_config_reclaim, ${WAITING_WORK_CHECK}`
  + 'Then complete required background work and the session handoff, then submit ready_for_config_reclaim through the supervisor. After acceptance, finish this control and the current turn.';
