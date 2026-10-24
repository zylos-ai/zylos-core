import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = path.join(process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos'), '.zylos', 'config.json');

// Keep the strict read contract aligned with Core; this module never writes F1.
export function readZylosConfigStrict() {
  let source;
  try {
    source = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'error', error };
  }
  try {
    const config = JSON.parse(source);
    if (config === null || Array.isArray(config) || typeof config !== 'object') {
      throw new TypeError('config.json root must be a JSON object');
    }
    return { state: 'ok', config };
  } catch (error) {
    return { state: 'error', error };
  }
}

export function readZylosConfigOrThrow() {
  const result = readZylosConfigStrict();
  if (result.state === 'error') {
    const error = new Error(`Zylos configuration is unreadable: ${result.error?.message || result.error}`);
    error.code = 'CONFIG_UNREADABLE';
    error.cause = result.error;
    throw error;
  }
  return result.state === 'ok' ? result.config : {};
}
