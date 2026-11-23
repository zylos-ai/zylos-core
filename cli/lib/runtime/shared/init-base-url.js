import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotEnv } from 'dotenv';

export class InitEndpointConfigurationError extends Error {}

export function savedInitBaseUrl({ key, zylosDir, nativeFile, parseNative }) {
  const message = 'Could not read saved API endpoint configuration. Provide the base URL explicitly or repair the saved configuration.';
  const read = file => {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new InitEndpointConfigurationError(message); }
  };
  const envText = read(path.join(zylosDir, '.env'));
  if (envText !== null) {
    // Select only the endpoint assignment; credentials in the same file are not promoted.
    const assignments = envText.split(/\r?\n/).filter(line => new RegExp(`^[^\\S\\r\\n]*(?:export[^\\S\\r\\n]+)?${key}[^\\S\\r\\n]*=`).test(line));
    const value = parseDotEnv(assignments.join('\n'))[key];
    if (value) return value;
  }
  const native = read(nativeFile);
  if (native === null) return null;
  try {
    const value = parseNative(native);
    if (value !== undefined && typeof value !== 'string') throw new Error(message);
    return value || null;
  } catch { throw new InitEndpointConfigurationError(message); }
}
