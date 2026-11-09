import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveCoreConfigModule } from './core-config-loader.js';

// Core owns dotenv; the scheduler skill is optional for these two services.
const { parse } = createRequire(resolveCoreConfigModule())('dotenv');

/** Apply only the instance TZ. An absent key preserves the inherited timezone. */
export function loadStartupTimezone(env = process.env) {
  const filename = path.join(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), '.env');
  let parsed;
  try { parsed = parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw Object.assign(new Error(`Failed to read ${filename}: ${error.message}`), { code: 'TZ_ENV_READ_ERROR' });
  }
  if (parsed.TZ === undefined) return;
  try {
    if (!parsed.TZ) throw new RangeError('TZ is empty');
    Intl.DateTimeFormat(undefined, { timeZone: parsed.TZ });
  } catch {
    throw Object.assign(new Error(`Invalid TZ in ${filename}. Use an IANA timezone.`), { code: 'INVALID_TZ' });
  }
  env.TZ = parsed.TZ;
}
