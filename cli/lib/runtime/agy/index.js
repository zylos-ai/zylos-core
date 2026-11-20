import { auth } from './auth.js';
import { instructions } from './instructions.js';
import { prepare, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags } from './launch.js';
import { install, probeVersion, installNotice, agyCliEnv } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';
import { createUpgradeCli } from '../shared/upgrade-cli.js';

const id = 'agy';
const identity = createIdentity(id);

export default Object.freeze({
  id,
  identity,
  install: Object.freeze({
    probeVersion: options => probeVersion(identity, options),
    install: options => install(identity, options),
    installNotice,
    upgradeCli: createUpgradeCli({ id, identity, timeoutMs: 300000, killSignal: 'SIGKILL', prepareEnv: agyCliEnv, timeoutIsOutcome: true }),
    latestVersion: UNSUPPORTED,
    installsToLocalBin: true,
    dailyUpgradePrompt: UNSUPPORTED,
    uninstall: UNSUPPORTED,
    postUpgradeSync: UNSUPPORTED,
  }),
  auth,
  launch: Object.freeze({ prepare, preAccept: UNSUPPORTED, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous: UNSUPPORTED }),
  instructions,
  input: Object.freeze({ bracketedPaste: true }),
});
