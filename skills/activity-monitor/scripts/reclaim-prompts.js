// Controls are typed into the runtime whole, and Claude Code treats input over 800 characters
// as pasted material, so each check control states its reason and points to the skill
// reference that holds the check's rules.
const checkControlPrompt = (reason, check) =>
  `${reason} Read references/session-checks.md in the activity-monitor skill and run its ${check} now.`;

// TTL reclaim and capacity/memory-pressure eviction share the approved check.
export const PRE_RECLAIM_CHECK_PROMPT = checkControlPrompt('This session group has been idle and will be reclaimed.', 'idle reclaim check');
export const UPGRADE_RESTART_CHECK_PROMPT = checkControlPrompt('This session group will be restarted for an upgrade.', 'upgrade restart check');
export const SINGLE_UPGRADE_RESTART_CHECK_PROMPT = checkControlPrompt('This session will be restarted for an upgrade.', 'single-session upgrade restart check');
export const CONFIG_RECLAIM_PROMPT = checkControlPrompt('The launch configuration changed and this session group will be restarted with it.', 'configuration restart check');
export const ROTATION_PROMPT = 'Context usage has reached the session threshold. Complete required handoff and use the new-session skill to continue in a fresh session.';
