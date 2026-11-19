// Commands and grouping produced by the pinned v0.6.9 installer. Test-only:
// the bundled service never installs or removes these legacy entries.
import path from 'node:path';
export function legacyDashboardHooks(zylosDir) {
  const root = path.join(zylosDir, '.claude/skills/dashboard');
  const hookCommand = `node ${root}/src/lib/hook-ingest.cjs`;
  const codexCommand = `ZYLOS_RUNTIME=codex ZYLOS_DIR=${zylosDir} ${hookCommand}`;
  const statuslineCommand = `node ${root}/src/lib/statusline-ingest.cjs`;
  const thirdParty = {type:'command',command:'node /third-party/dashboard-audit.js'};
  const claude = { hooks: {}, statusLine:{type:'command',command:statuslineCommand,refreshInterval:5} };
  const codex = { hooks:{} };
  for (const event of ['PreToolUse','PostToolUse','UserPromptSubmit','Stop','PermissionRequest','SubagentStart','SubagentStop']) {
    const group={hooks:[{type:'command',command:hookCommand,timeout:5,async:true},{...thirdParty}]};
    if (['PreToolUse','PostToolUse'].includes(event)) group.matcher='';
    claude.hooks[event]=[group];
  }
  for (const event of ['SessionStart','PreToolUse','PostToolUse','UserPromptSubmit','Stop','PermissionRequest']) {
    const group={hooks:[{type:'command',command:codexCommand,timeout:5},{...thirdParty}]};
    if (['PreToolUse','PostToolUse'].includes(event)) group.matcher='';
    codex.hooks[event]=[group];
  }
  return {claude,codex,thirdParty};
}
