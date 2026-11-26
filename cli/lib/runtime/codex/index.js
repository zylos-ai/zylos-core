import { dream } from './dream.js';
import { health } from './health.js';
import { auth } from './auth.js';
import { context } from './context.js';
import { usage } from './usage.js';
import { busy } from './busy.js';
import { hooks } from './hooks.js';
import { instructions } from './instructions.js';
import { GROUP_SYNC_WORKER_PROMPT, GROUP_SYNC_RESULT_INSTRUCTION } from '../shared/group-sync-prompts.js';
import { input } from './input.js';
import { sessionSwitch } from './switch.js';
import { modelConfig, prepare, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags } from './launch.js';
import { install, probeVersion, postUpgradeSync } from './install.js';
import { UNSUPPORTED } from '../contract.js';
import { createIdentity } from '../shared/identity.js';
import { createUpgradeCli } from '../shared/upgrade-cli.js';

const id = 'codex';
const identity = Object.freeze({
  ...createIdentity(id),
  launcherWrapsNative: true,
});

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
  dream,
  health,
  launch: Object.freeze({ modelConfig, prepare, preAccept: UNSUPPORTED, buildArgs, env, helpProbe, promptPlacement, efforts, overrideHelpFlags, checkAutonomous: UNSUPPORTED }),
  instructions: Object.freeze({
    ...instructions,
    groupSyncPrompt: 'Call spawn_agent once without reading skills. Set fork_turns: "none". ' +
      'Use the exact listed Terra ID as model. If none, omit model and tell the worker why. Omit reasoning_effort. ' +
      `Prompt: "${GROUP_SYNC_WORKER_PROMPT}" Await the final result before ending this turn. ` +
      GROUP_SYNC_RESULT_INSTRUCTION,
  }),
  input,
  busy,
  context,
  usage,
  switch: sessionSwitch,
  hooks,
});
