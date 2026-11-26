import { dream } from './dream.js';
import { health } from './health.js';
import { auth } from './auth.js';
import { context } from './context.js';
import { usage } from './usage.js';
import { busy } from './busy.js';
import { hooks } from './hooks.js';
import { instructions } from './instructions.js';
import { GROUP_SYNC_RESULT_INSTRUCTION } from '../shared/group-sync-prompts.js';
import { input } from './input.js';
import { sessionSwitch } from './switch.js';
import { modelConfig, prepare, preAccept, checkAutonomous, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags } from './launch.js';
import { install, probeVersion } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';
import { createUpgradeCli } from '../shared/upgrade-cli.js';

const id = 'claude';
const identity = Object.freeze({
  ...createIdentity(id),
  launcherWrapsNative: false,
});

export default Object.freeze({
  id,
  identity,
  install: Object.freeze({
    probeVersion: options => probeVersion(identity, options),
    install: options => install(identity, options),
    installNotice: UNSUPPORTED,
    upgradeCli: createUpgradeCli({ id, identity, timeoutMs: 60000 }),
    latestVersion: Object.freeze({ source: 'github', repo: 'anthropics/claude-code' }),
    installsToLocalBin: true,
    dailyUpgradePrompt: 'Daily upgrade. Use the upgrade-claude skill to upgrade Claude Code to the latest version.',
    uninstall: Object.freeze({
      label: 'Claude CLI', detail: 'npm uninstall -g + remove ~/.claude/',
      npmPackage: '@anthropic-ai/claude-code', dataDir: '.claude',
    }),
    postUpgradeSync: UNSUPPORTED,
  }),
  auth,
  dream,
  health,
  launch: Object.freeze({ modelConfig, prepare, preAccept, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous }),
  instructions: Object.freeze({
    ...instructions,
    groupSyncPrompt: 'Immediately call Agent once with subagent_type: "zylos-group-sync", run_in_background: true, and prompt: "group Sync". ' +
      'Start without reading skills or adding to the prompt. Continue working. ' +
      GROUP_SYNC_RESULT_INSTRUCTION,
  }),
  input,
  busy,
  context,
  usage,
  switch: sessionSwitch,
  hooks,
});
