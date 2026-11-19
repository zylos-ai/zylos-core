import fs from 'node:fs';
import path from 'node:path';
import { installGlobalPackage } from '../../runtime-setup.js';
import { probeVersion as probe } from '../shared/identity.js';

const profiles = {
  doctor: { timeout: 10000, parse: stdout => stdout.trim().split('\n')[0] },
  dashboard: { timeout: 5000, parse: stdout => stdout.trim().replace(/^codex-cli\s+/, '').replace(/\s.*$/, '') },
};

export function probeVersion(identity, options) {
  return probe(identity, profiles, options);
}

export async function install({ exec } = {}) {
  return installGlobalPackage('@openai/codex', exec);
}

export const postUpgradeSync = Object.freeze({
  inUse({ configuredRuntime, homeDir }) {
    const globalDir = path.join(homeDir, '.codex');
    return configuredRuntime === 'codex' || fs.existsSync(path.join(globalDir, 'config.toml'))
      || fs.existsSync(path.join(globalDir, 'auth.json'));
  },
  failureIsFatal({ configuredRuntime }) {
    return configuredRuntime === 'codex';
  },
});
