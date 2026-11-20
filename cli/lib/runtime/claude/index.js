import { auth } from './auth.js';
import { instructions } from './instructions.js';
import { prepare, checkAutonomous, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags } from './launch.js';
import { install, probeVersion } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';
import { createUpgradeCli } from '../shared/upgrade-cli.js';

const id = 'claude';
const identity = createIdentity(id);

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
  launch: Object.freeze({ prepare, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous }),
  instructions,
  input: Object.freeze({ bracketedPaste: false }),
});
