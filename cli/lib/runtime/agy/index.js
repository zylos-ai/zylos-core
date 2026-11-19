import { checkAuth } from './auth.js';
import { prepare } from './launch.js';
import { install, probeVersion, installNotice } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';

const id = 'agy';
const identity = createIdentity(id);

export default Object.freeze({
  id,
  identity,
  install: Object.freeze({
    probeVersion: options => probeVersion(identity, options),
    install: options => install(identity, options),
    installNotice,
    installsToLocalBin: true,
    dailyUpgradePrompt: UNSUPPORTED,
    uninstall: UNSUPPORTED,
    postUpgradeSync: UNSUPPORTED,
  }),
  auth: Object.freeze({ checkAuth }),
  launch: Object.freeze({ prepare }),
  input: Object.freeze({ bracketedPaste: true }),
});
