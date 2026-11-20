import { parse as parseDotEnv } from 'dotenv';

export function upsertEnvValue(content, key, value, comment = null) {
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = comment ? `\n\n# ${comment}\n` : '\n';
  return content.trimEnd() + `${prefix}${line}\n`;
}

export function credentialEnvValue(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  // Preserve the exact credential without adding escape bytes. Use only a
  // lossless dotenv representation and reject unrepresentable input before writing.
  for (const candidate of [value, `'${value}'`, `"${value}"`]) {
    const literal = candidate.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (literal === value && parseDotEnv(`CREDENTIAL=${candidate}\n`).CREDENTIAL === value) return candidate;
  }
  return null;
}
