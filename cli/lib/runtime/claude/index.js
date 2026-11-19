import { checkAuth } from './auth.js';
import { prepare } from './launch.js';
import { install, probeVersion } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';

const id = 'claude';
const identity = createIdentity(id);

export default Object.freeze({
  id,
  identity,
  install: Object.freeze({
    probeVersion: options => probeVersion(identity, options),
    install: options => install(identity, options),
    installNotice: UNSUPPORTED,
    installsToLocalBin: true,
    dailyUpgradePrompt: 'Daily upgrade. Use the upgrade-claude skill to upgrade Claude Code to the latest version.',
    uninstall: Object.freeze({
      label: 'Claude CLI', detail: 'npm uninstall -g + remove ~/.claude/',
      npmPackage: '@anthropic-ai/claude-code', dataDir: '.claude',
    }),
    postUpgradeSync: UNSUPPORTED,
  }),
  auth: Object.freeze({ checkAuth }),
  launch: Object.freeze({ prepare }),
  input: Object.freeze({ bracketedPaste: false }),
});
