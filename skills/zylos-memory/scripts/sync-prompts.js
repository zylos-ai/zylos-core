// Stable text is also the control-queue deduplication key.
// Controls are typed into the runtime whole, and Claude Code treats input over 800 characters
// as pasted material, so these stay short pointers: the result-handling rules live only in
// the skill's "Parent result handling" section.
export const GROUP_SYNC_PROMPT = 'Read the zylos-memory skill and start a background Sync as it specifies, then keep working and handle its result per its Parent result handling section.';
export const ORIGIN_SYNC_PROMPT = 'Read the zylos-memory skill and start a background Origin Sync as it specifies, then keep working and handle its result per its Parent result handling section.';
export const PRE_RECLAIM_SYNC_PROMPT = 'Read the zylos-memory skill and start a background group Sync subagent in this running session’s runtime. Wait for it to finish before acknowledging this control. Report any failure; do not acknowledge while the Sync is still running.';
export const PRE_RECLAIM_ORIGIN_SYNC_PROMPT = 'Read the zylos-memory skill and start a background Origin Sync subagent in this running session’s runtime. Wait for it to finish before acknowledging this control. Report any failure; do not acknowledge while the Sync is still running.';
export const IDENTITY_ROTATION_PROMPT = 'Identity has been updated. Follow the new-session procedure: merge and deduplicate unfinished items in the existing handoff with new unfinished work, write the current scope’s handoff.md via a temporary file and atomic replacement, then enqueue /clear for this Claude session or /exit for this Codex session. Do not rotate before the handoff is saved.';
export const SYNC_BACKLOG_ALERT = (kind, backlog, lag, scope = kind === 'global' ? '*' : 'origin', type = 'backlog', details = {}) => {
  const issue = { backlog: `${backlog} messages remain unsynced (lag ${lag}s)`,
    state_uncommitted: 'checkpoint exists but state is not committed',
    no_checkpoint: 'repeated Sync requests produced no new checkpoint',
    repair_failed: 'Memory Sync repair failed' }[type] ?? type;
  const reason = details.reason ?? ({ backlog: 'backlog persists after Sync attempts',
    state_uncommitted: 'state still trails the checkpoint', no_checkpoint: 'no checkpoint progress after repeated attempts' }[type] ?? 'durable Sync completion was not verified');
  const attempt = { pre_reclaim_retry: 'pre-reclaim Sync plus one retry', maintenance: 'one dedicated maintenance Sync attempt' }[details.repairAttempt]
    ?? (type === 'no_checkpoint' ? 'repeated ordinary Sync requests' : 'automatic Sync repair');
  const proof = kind === 'origin' ? 'cursor progress and a released Sync lock' : 'a covering checkpoint and committed state';
  const action = reason === 'activation_timeout' ? 'Check runtime availability and login, then ask the agent to rerun Sync for this scope.'
    : reason === 'INPUT_CHANGED' ? 'Ask the agent to rerun Sync for this scope once current messages settle.'
    : `Ask the agent to rerun Sync for this scope and verify ${proof}.`;
  const repair = kind === 'origin' && type === 'backlog'
    ? 'ordinary Origin Sync; backlog remains above the limit'
    : `${attempt}; failed because ${reason}`;
  return `Memory Sync alert: type=${type}; kind=${kind}; scope=${scope}. Tell the owner: Issue: ${issue}. Automated repair: ${repair}. Action: ${action} Do not automatically change Sync parameters.`;
};

export const REFERENCE_REORG_PROMPT = 'Memory reorganization: the old memory/reference/projects.md or decisions.md still exists at its original path. Read the zylos-memory skill references/reference-reorg.md and follow it now. Start one background worker on a cheaper model: it rebuilds pages only for in-progress work listed in state files, then archives both old files unchanged into memory/reference/legacy/. If a reorganization worker you started is still running, do nothing. Do not wait for it.';
