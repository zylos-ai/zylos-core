import { renderCodexProjectConfig, renderCodexGlobalConfig } from '../../../../cli/lib/runtime/codex/hooks.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { projectDir, project = '', global = '', bypassPermissions = true } = JSON.parse(input);
process.stdout.write(JSON.stringify({
  project: renderCodexProjectConfig(project, { bypassPermissions }),
  global: renderCodexGlobalConfig(projectDir, global),
}));
