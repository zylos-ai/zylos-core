import { readZylosConfigStrict } from './config.js';
import { configFunctions } from '../../skills/comm-bridge/scripts/c4-store-config.js';

/** Read-only explanation of the instance baseline that every group needs to start. */
export function readInstanceConfigurationIssue({ read = readZylosConfigStrict } = {}) {
  try {
    configFunctions({ dependencies: { readConfig: read } }).baseline();
    return null;
  } catch (error) {
    const code = 'CONFIG_UNREADABLE';
    const message = error.cause?.message ?? error.message;
    return { code, message, notice: `Instance configuration (.zylos/config.json) is unreadable [${code}]: ${message}. All groups (including Origin) cannot start. After fixing the configuration, recovery is automatic if the communication service was already running. If it started or restarted while the configuration was invalid, run zylos restart after fixing it.` };
  }
}
