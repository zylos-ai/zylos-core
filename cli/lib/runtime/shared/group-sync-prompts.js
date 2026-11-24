export const GROUP_SYNC_WORKER_PROMPT =
  "You are this session's already-launched Memory Sync subagent; do not read the zylos-memory SKILL.md or launch another subagent. " +
  'For group Sync, read and follow .claude/skills/zylos-memory/agents/zylos-group-sync.md under $ZYLOS_DIR (default ~/zylos), skipping front matter.';

export const GROUP_SYNC_RESULT_INSTRUCTION =
  'On final Sync success or SYNC_BUSY, do nothing. Otherwise, read and follow only "Parent result handling" in zylos-memory SKILL.md.';
