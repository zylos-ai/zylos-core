import { fileURLToPath } from 'node:url';

// These installed sibling CLIs inherit this session's group and run identity.
const SCHEDULER_CLI = fileURLToPath(new URL('../../scheduler/scripts/cli.js', import.meta.url));
const SUPERVISOR_REQUEST_CLI = fileURLToPath(new URL('./supervisor-request.js', import.meta.url));

const DEFER_RUNNING_WORK = 'Only one thing can hold the reclaim: work this session itself started that is still running and whose result it is waiting for — a background command, a Monitor watcher, a background subagent or workflow. '
  + `If there is such work, run \`node "${SUPERVISOR_REQUEST_CLI}" defer-reclaim --minutes <N> --reason "<what is still running>"\`, confirm it reports ok:true, then acknowledge this control.`;
const INTERRUPTED_RUNNING_WORK = 'If work this session itself started is still running (a background command, a Monitor watcher, a background subagent or workflow), '
  + 'it will be interrupted by this restart: name it in the session handoff so the next session can rerun or check it.';
const HANDOFF_CHECK = 'Otherwise write the session handoff: list open business items as they stand now, checking each against its current record and leaving out any that have finished. '
  + 'Replies, reviews or decisions you are waiting for from people or other sessions need nothing more: an incoming reply wakes this group again.';
const WAKE_UP_CHECK = 'Create a wake-up only for a step of your own ongoing task that waits on an external system whose result will not arrive as a message to this group '
  + '(for example CI on a PR you opened, or a deployment rolling out). '
  + `First run \`node "${SCHEDULER_CLI}" list --json\`; if a pending task of this group already covers it, do not create another. `
  + `Otherwise run \`node "${SCHEDULER_CLI}" add "<self-contained check>" --in "<delay>" --json\` in this session without any --reply option, and confirm it reports ok:true. `
  + 'Do not create scheduled tasks for anything else.';

const checkControlPrompt = (reason, { restart = false, closing = 'Then acknowledge.' } = {}) =>
  `${reason} During this check, do not send messages to anyone.\n\n`
  + `1. ${restart ? INTERRUPTED_RUNNING_WORK : DEFER_RUNNING_WORK}\n`
  + `2. ${HANDOFF_CHECK}\n`
  + `3. ${WAKE_UP_CHECK}\n\n${closing}`;

// TTL reclaim and capacity/memory-pressure eviction share the approved check.
export const PRE_RECLAIM_CHECK_PROMPT = checkControlPrompt('This session group has been idle and will be reclaimed.');
export const UPGRADE_RESTART_CHECK_PROMPT = checkControlPrompt('This session group will be restarted for an upgrade.', { restart: true });
export const SINGLE_UPGRADE_RESTART_CHECK_PROMPT = checkControlPrompt('This session will be restarted for an upgrade. '
  + 'In single-session mode it is the only session group and $ZYLOS_SESSION_GROUP is unset.', { restart: true });
export const CONFIG_RECLAIM_PROMPT = checkControlPrompt('The launch configuration changed and this session group will be restarted with it.', {
  restart: true,
  closing: 'Then submit ready_for_config_reclaim through the supervisor. After acceptance, finish this control and the current turn.',
});
