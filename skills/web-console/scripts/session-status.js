import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

export function createConsoleStatusReader({ readSessionMode, readSessionState, getChannelNamespace, readInstanceConfigurationIssue = () => null }) {
  return async function readStatus() {
    try {
      const configurationIssue = readInstanceConfigurationIssue();
      if (configurationIssue) return { state: 'error', message: configurationIssue.notice, configurationIssue };
      const { mode } = readSessionMode();
      let sessionGroup = null;
      if (mode === 'multi') {
        const binding = getChannelNamespace('web-console');
        if (!binding?.namespace) throw new Error('Web Console namespace is unavailable');
        sessionGroup = binding.namespace;
      }
      const { identity, status } = await readSessionState(sessionGroup, { freshnessMs: 5000 });
      if (status.valid) return { ...status.value, sessionGroup, runId: identity.runId };
      if (!identity.present) return { state: 'not_running', reason: 'not_running', sessionGroup };
      return { state: 'unknown', reason: status.reason, sessionGroup };
    } catch (error) {
      return { state: 'error', message: error.message };
    }
  };
}

export async function loadConsoleStatusReader(getChannelNamespace) {
  const configPath = resolveCoreConfigModule();
  const [{ readSessionMode }, { readSessionState }, { readInstanceConfigurationIssue }] = await Promise.all([
    import(pathToFileURL(configPath).href),
    import(pathToFileURL(path.join(path.dirname(configPath), 'session-state-reader.js')).href),
    import(pathToFileURL(path.join(path.dirname(configPath), 'instance-config-status.js')).href)
  ]);
  return createConsoleStatusReader({ readSessionMode, readSessionState, getChannelNamespace, readInstanceConfigurationIssue });
}
