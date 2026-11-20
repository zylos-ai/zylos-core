import { auth } from './auth.js';
import { prepare, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags } from './launch.js';
import { install, probeVersion, postUpgradeSync } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';
import { createUpgradeCli } from '../shared/upgrade-cli.js';

const id = 'codex';
const identity = createIdentity(id);

export default Object.freeze({
  id,
  identity,
  install: Object.freeze({
    probeVersion: options => probeVersion(identity, options),
    install,
    installNotice: UNSUPPORTED,
    upgradeCli: createUpgradeCli({ id, identity, timeoutMs: 60000 }),
    latestVersion: Object.freeze({ source: 'npm', package: '@openai/codex' }),
    installsToLocalBin: false,
    dailyUpgradePrompt: UNSUPPORTED,
    uninstall: Object.freeze({
      label: 'Codex CLI', detail: 'npm uninstall -g @openai/codex + remove ~/.codex/',
      npmPackage: '@openai/codex', dataDir: '.codex',
    }),
    postUpgradeSync,
  }),
  auth,
  launch: Object.freeze({ prepare, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous: UNSUPPORTED }),
  input: Object.freeze({ bracketedPaste: false }),
});
