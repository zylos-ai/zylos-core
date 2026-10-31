// Commands and grouping produced by the pinned v0.6.9 installer. Test-only:
// the bundled service never installs or removes these legacy entries.
import { HookInstaller } from '../../src/lib/hook-installer.js';
import path from 'node:path';
export function legacyDashboardHooks(zylosDir) {
  const installer = new HookInstaller(path.join(zylosDir,'.claude/skills/dashboard'), zylosDir);
  const thirdParty = {type:'command',command:'node /third-party/dashboard-audit.js'};
  const claude = { hooks: {}, statusLine:{type:'command',command:`node ${installer.statuslineScript}`,refreshInterval:5} };
  const codex = { hooks:{} };
  for (const event of ['PreToolUse','PostToolUse','UserPromptSubmit','Stop','PermissionRequest','SubagentStart','SubagentStop']) {
    const group={hooks:[{type:'command',command:installer._command(),timeout:5,async:true},{...thirdParty}]};
    if (['PreToolUse','PostToolUse'].includes(event)) group.matcher='';
    claude.hooks[event]=[group];
  }
  for (const event of ['SessionStart','PreToolUse','PostToolUse','UserPromptSubmit','Stop','PermissionRequest']) {
    const group={hooks:[{type:'command',command:installer._codexCommand(),timeout:5},{...thirdParty}]};
    if (['PreToolUse','PostToolUse'].includes(event)) group.matcher='';
    codex.hooks[event]=[group];
  }
  return {claude,codex,thirdParty};
}
