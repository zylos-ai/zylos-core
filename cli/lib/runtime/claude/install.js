import { execSync } from 'node:child_process';
import { probeVersion as probe } from '../shared/identity.js';

const profiles = {
  doctor: { timeout: 30000, parse: stdout => stdout.trim() },
  dashboard: { timeout: 5000, parse: stdout => stdout.trim().replace(/\s.*$/, '') },
};

export function probeVersion(identity, options) {
  return probe(identity, profiles, options);
}

export async function install(identity, { exec = { execSync } } = {}) {
  try {
    exec.execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      stdio: 'pipe',
      timeout: 300000, // 5 min — downloads ~213MB native binary
    });
    return identity.findExecutable() !== null;
  } catch {
    return false;
  }
}
