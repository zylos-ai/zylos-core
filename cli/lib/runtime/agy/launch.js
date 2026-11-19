import { buildInstructionFile } from '../instruction-builder.js';
import { adapterError, launchEnvironment } from '../session-command.js';
import { ZYLOS_DIR } from '../../config.js';
import { syncAgyConfig } from '../../agy-setup.js';

export async function prepare(options = {}) {
  const root = options.root || ZYLOS_DIR;
  const env = launchEnvironment(root, options.env || process.env, { runtime: 'agy' });
  if (!env.GEMINI_API_KEY) throw adapterError('LAUNCH_FAILED', 'Antigravity requires GEMINI_API_KEY; account login is not supported');
  syncAgyConfig({ zylosDir: root, home: env.HOME });
  buildInstructionFile('agy', { zylosDir: root });
}
