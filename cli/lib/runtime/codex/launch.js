import fs from 'node:fs';
import { ZYLOS_DIR } from '../../config.js';
import { ensureLaunchHooksTrusted } from '../codex-launch-trust.js';
import { adapterError, launchEnvironment, runtimeExecutable } from '../session-command.js';

export async function prepare(options = {}) {
  const env = options.env || process.env;
  const root = await fs.promises.realpath(options.root || ZYLOS_DIR);
  const codexBin = (options.runtimeExecutable || runtimeExecutable)('codex', env);
  // Trust must succeed before launch can create a tmux session.
  try {
    await ensureLaunchHooksTrusted({ zylosDir: root, projectDir: root,
      codexBin, env: launchEnvironment(root, env) });
  } catch (cause) {
    // Trust failing stops the launch, so Codex is not running: say so, with the trust step's own report.
    let reason = cause;
    while (reason?.cause instanceof Error) reason = reason.cause;
    const report = (reason?.message || 'hook trust failed').replace(/\.+$/, '');
    const message = `Codex did not start: ${report}. ` +
      'Hook trust must succeed before Codex starts and is tried again at the next launch; ' +
      'run `zylos init` to retry it now and see the result.';
    process.stderr.write(`${message}\n`);
    throw adapterError('LAUNCH_FAILED', message, cause);
  }
}
