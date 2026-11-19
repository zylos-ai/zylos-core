import { checkAuth } from './auth.js';
import { prepare } from './launch.js';
import { install, probeVersion, postUpgradeSync } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';

const id = 'codex';
const identity = createIdentity(id);

export default Object.freeze({
  id,
  identity,
  install: Object.freeze({
    probeVersion: options => probeVersion(identity, options),
    install,
    installNotice: UNSUPPORTED,
    installsToLocalBin: false,
    dailyUpgradePrompt: UNSUPPORTED,
    uninstall: Object.freeze({
      label: 'Codex CLI', detail: 'npm uninstall -g @openai/codex + remove ~/.codex/',
      npmPackage: '@openai/codex', dataDir: '.codex',
    }),
    postUpgradeSync,
  }),
  auth: Object.freeze({ checkAuth }),
  launch: Object.freeze({ prepare }),
  input: Object.freeze({ bracketedPaste: false }),
});
