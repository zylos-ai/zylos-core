import { health } from './health.js';
import { auth } from './auth.js';
import { context } from './context.js';
import { busy } from './busy.js';
import { hooks } from './hooks.js';
import { instructions } from './instructions.js';
import { GROUP_SYNC_WORKER_PROMPT, GROUP_SYNC_RESULT_INSTRUCTION } from '../shared/group-sync-prompts.js';
import { input } from './input.js';
import { sessionSwitch } from './switch.js';
import { prepare, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags } from './launch.js';
import { install, probeVersion, installNotice, agyCliEnv } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';
import { createUpgradeCli } from '../shared/upgrade-cli.js';

const id = 'agy';
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
    installNotice,
    upgradeCli: createUpgradeCli({ id, identity, timeoutMs: 300000, killSignal: 'SIGKILL', prepareEnv: agyCliEnv, timeoutIsOutcome: true }),
    latestVersion: UNSUPPORTED,
    installsToLocalBin: true,
    dailyUpgradePrompt: UNSUPPORTED,
    uninstall: UNSUPPORTED,
    postUpgradeSync: UNSUPPORTED,
  }),
  auth,
  health,
  launch: Object.freeze({ modelConfig: UNSUPPORTED, prepare, preAccept: UNSUPPORTED, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous: UNSUPPORTED }),
  instructions: Object.freeze({
    ...instructions,
    groupSyncPrompt: 'Without reading skills, call invoke_subagent once with Model: "flash". ' +
      `Send: "${GROUP_SYNC_WORKER_PROMPT}" Continue working. The result arrives automatically. ` +
      GROUP_SYNC_RESULT_INSTRUCTION,
  }),
  input,
  busy,
  context,
  usage: UNSUPPORTED,
  switch: sessionSwitch,
  hooks,
});
