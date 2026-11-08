import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { mutateConfig } from './config-mutation.js';

// The caller owns the one-time display. Only the hash reaches configuration.
export async function provisionDashboardAuth(zylosDir, { reset = false } = {}) {
  const dataDir = path.join(zylosDir, 'components', 'dashboard');
  const configPath = path.join(dataDir, 'config.json');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const fresh = !fs.existsSync(configPath);
  let password = null;
  if (reset || fresh || !JSON.parse(fs.readFileSync(configPath, 'utf8')).auth?.password) {
    await mutateConfig(configPath, config => {
      if (fresh) {
        for (const [key, value] of Object.entries({ port: 3470, host: '127.0.0.1', observer: { enabled: false } })) {
          if (config[key] === undefined) config[key] = value;
        }
      }
      if (reset || !config.auth?.password) {
        password = crypto.randomBytes(16).toString('hex');
        config.auth = { enabled: true, ...config.auth, ...(reset ? { enabled: true } : {}), password: hashPassword(password) };
      }
    });
  }
  return { password };
}
