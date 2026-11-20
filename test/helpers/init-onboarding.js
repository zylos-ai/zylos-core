import fs from 'node:fs';
import path from 'node:path';
import { deployTemplates } from '../../cli/commands/init.js';
import { enqueueStartupPrompt, isOnboardingPending } from '../../skills/activity-monitor/scripts/session-start-prompt.js';
import { buildChain } from '../../skills/activity-monitor/scripts/shard-registry.js';
import { runSessionStartShard } from '../../skills/activity-monitor/scripts/session-start-orchestrator.js';
import { desiredClaudeHooks } from '../../cli/lib/sync-runtime-hooks.js';
import { installCoreCodexHook, codexHooksPath } from '../../cli/lib/codex-hooks.js';
import { syncAgyConfig, agyConfigurationPaths } from '../../cli/lib/agy-setup.js';

const action = process.argv[2];
const root = process.env.ZYLOS_DIR;
if (action === 'fresh' || action === 'rerun') {
  deployTemplates({ freshInstall: action === 'fresh' });
} else if (action === 'inspect') {
  const { chain } = buildChain();
  const onboarding = chain.find(s => s.name === 'onboarding');
  const body = await onboarding.emit({ source: 'startup' });
  let scopeRead = false;
  const prompt = await enqueueStartupPrompt('startup', {
    scopeReader: () => { scopeRead = true; return { scope: '*', groupName: null }; },
    migrationPending: () => false,
    recentReader: () => true,
    execFile: async () => ({ stdout: '{"ok":true,"id":1}' }),
  });
  console.log(JSON.stringify({ pending: isOnboardingPending(), body, scopeRead, prompt,
    names: chain.map(s => s.name), position: onboarding.chainIndex + 1 }));
} else if (action === 'shard') {
  await runSessionStartShard('onboarding', { source: 'startup' });
} else if (action === 'hooks') {
  const claude = desiredClaudeHooks({ zylosDir: root });
  installCoreCodexHook({ zylosDir: root });
  syncAgyConfig({ zylosDir: root, home: process.env.HOME });
  const codex = JSON.parse(fs.readFileSync(codexHooksPath(root), 'utf8'));
  const agy = JSON.parse(fs.readFileSync(agyConfigurationPaths(process.env.HOME).hooks, 'utf8'));
  console.log(JSON.stringify({ claude: claude.SessionStart, codex: codex.hooks.SessionStart,
    agy: agy.zylos.SessionStart }));
} else if (action === 'agy') {
  const { runAgySessionStart } = await import('../../skills/activity-monitor/scripts/agy-hooks.js');
  // Other emitters do not belong to this boundary; keep real membership/order
  // and the real onboarding emitter, without invoking C4, health or control.
  await runAgySessionStart({ source: 'startup' }, {
    chainBuilder: () => ({ chain: buildChain().chain.map(s => s.name === 'onboarding' ? s : { ...s, emit: async () => '' }) }),
    foreground: async () => {}, enqueue: async () => {},
  });
} else throw Error('Unknown fixture action');
