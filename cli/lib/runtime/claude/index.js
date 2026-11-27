import { dream } from './dream.js';
import { health } from './health.js';
import { auth } from './auth.js';
import { context } from './context.js';
import { usage } from './usage.js';
import { busy } from './busy.js';
import { hooks } from './hooks.js';
import { instructions } from './instructions.js';
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
    retiredProjectFiles: Object.freeze({
      source: Object.freeze(['.claude', 'agents']),
      archive: Object.freeze(['.zylos', 'retired-claude-agents']),
      names: Object.freeze(['zylos-global-sync.md', 'zylos-group-sync.md', 'zylos-origin-sync.md']),
    }),
  }),
  auth,
  dream,
  health,
  launch: Object.freeze({ modelConfig, prepare, preAccept, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous }),
  instructions,
  input,
  busy,
  context,
  usage,
  switch: sessionSwitch,
  hooks,
});
