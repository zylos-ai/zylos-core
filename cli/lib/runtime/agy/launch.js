import { buildInstructionFile } from '../instruction-builder.js';
import { adapterError, launchEnvironment } from '../session-command.js';
import { ZYLOS_DIR } from '../../config.js';
import { syncAgyConfig } from '../../agy-setup.js';
import { buildKickPrompt } from '../kick-prompt.js';
import { UNSUPPORTED } from '../contract.js';

export const env = Object.freeze({
  fromDotenv: Object.freeze([]),
  fromDotenvOrProcess: Object.freeze(['GEMINI_API_KEY', 'HTTPS_PROXY']),
  fixed: Object.freeze({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }),
});
export const helpProbe = 'override';
export const promptPlacement = 'kick';
export const efforts = UNSUPPORTED;
export const overrideHelpFlags = UNSUPPORTED;

export function buildArgs(_config, { root, bypassPermissions = true }) {
  const args = [];
  if (bypassPermissions) args.push('--dangerously-skip-permissions');
  args.push('--settings', JSON.stringify({ modelProvider: 'gemini', trustedWorkspaces: [root] }), '-i', buildKickPrompt());
  return args;
}

export async function prepare(options = {}) {
  const root = options.root || ZYLOS_DIR;
  const sessionEnv = launchEnvironment(root, options.env || process.env, { runtimeEnv: env });
  if (!sessionEnv.GEMINI_API_KEY) throw adapterError('LAUNCH_FAILED', 'Antigravity requires GEMINI_API_KEY; account login is not supported');
  syncAgyConfig({ zylosDir: root, home: sessionEnv.HOME });
  buildInstructionFile('agy', { zylosDir: root });
}
