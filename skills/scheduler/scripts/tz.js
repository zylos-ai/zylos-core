import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'dotenv';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const ENV_PATH = path.join(ZYLOS_DIR, '.env');

function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export class TimezoneConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TimezoneConfigError';
    this.code = code;
  }
}

function invalidTzError(source, timezone) {
  return new TimezoneConfigError(
    'INVALID_TZ',
    `Invalid TZ value "${timezone}" in ${source}. Use an IANA timezone like "Asia/Shanghai" or "America/New_York".`
  );
}

export function loadTimezone() {
  try {
    const envText = fs.readFileSync(ENV_PATH, 'utf8');
    const env = parse(envText);
    const value = env.TZ;

    if (value !== undefined) {
      if (!value) {
        throw new TimezoneConfigError('INVALID_TZ', `Invalid TZ in ${ENV_PATH}: TZ is empty`);
      }
      if (!isValidTimezone(value)) {
        throw invalidTzError(ENV_PATH, value);
      }
      return value;
    }
  } catch (error) {
    if (error instanceof TimezoneConfigError) {
      throw error;
    }
    if (error.code !== 'ENOENT') {
      throw new TimezoneConfigError(
        'TZ_ENV_READ_ERROR',
        `Failed to read ${ENV_PATH}: ${error.message}`
      );
    }
  }

  const externalTimezone = process.env.TZ;
  if (externalTimezone) {
    if (!isValidTimezone(externalTimezone)) {
      throw invalidTzError('process.env', externalTimezone);
    }
    return externalTimezone;
  }

  return 'UTC';
}
