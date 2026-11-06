import { readZylosConfigStrict } from './config.js';
import { SUPPORTED_RUNTIMES } from './runtime/index.js';

/** Read-only explanation of the instance baseline that every group needs to start. */
export function readInstanceConfigurationIssue({ read = readZylosConfigStrict } = {}) {
  try {
    const result = read();
    if (result.state === 'error') throw result.error;
    const config = result.state === 'missing' ? {} : result.config;
    const runtime = config.runtime ?? 'claude';
    if (!SUPPORTED_RUNTIMES.includes(runtime)) throw new Error(`Unsupported runtime: ${runtime}`);
    if (config.session_mode !== undefined && !['single', 'multi'].includes(config.session_mode)) {
      throw new Error('session_mode must be "single" or "multi"');
    }
    return null;
  } catch (error) {
    const code = 'CONFIG_UNREADABLE';
    const message = error?.message ?? String(error);
    return { code, message, notice: `Instance configuration (.zylos/config.json) is unreadable [${code}]: ${message}. All groups (including Origin) cannot start. Startup resumes automatically after the configuration is fixed.` };
  }
}
