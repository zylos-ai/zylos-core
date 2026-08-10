/**
 * Runtime secret store — credentials reach the agent as environment variables,
 * never as conversation text.
 *
 * WHY: tools the agent drives in direct mode (gh, git, docker, kubectl,
 * lark-cli) authenticate themselves, so credentials must exist on the machine.
 * The goal is therefore not "no credentials on disk" — that is unachievable —
 * but "no plaintext credential in the model's context". A value that has been
 * in the context has already been sent to the model provider, and no local
 * deletion can recall it.
 *
 * HOW: the control plane drops one file per credential into
 * `<ZYLOS_DIR>/security/credentials/`, named exactly as the environment
 * variable (`GH_TOKEN`, file content = the value). At launch these become real
 * environment variables of the agent process, so the agent only ever handles the
 * *name*: it runs `gh auth login --with-token <<< "$GH_TOKEN"`, and the value is
 * substituted by the shell, never rendered into the transcript.
 *
 * The `security/` naming is deliberate: it is a soft wall. Current models'
 * safety training makes them reluctant to cat files under such a path, which
 * lowers the chance of an accidental read. It is not a hard control — the agent
 * runs as a user that can read the directory. The hard guarantees remain
 * server-side revocation and the provider-side kill switch.
 *
 * Injecting at launch rather than through PM2 is intentional: PM2 persists a
 * service's env into `~/.pm2/dump.pm2` and prints it via `pm2 env <id>`, which
 * would create extra plaintext copies in places nobody thinks to revoke.
 *
 * REVOCATION: delete the file and restart the runtime. Removing a variable from
 * a live process is not reliably possible, so the restart is the mechanism.
 */

import fs from 'node:fs';
import path from 'node:path';

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Directory (under ZYLOS_DIR) holding one file per credential. */
export const SECRETS_SUBDIR = path.join('security', 'credentials');

/**
 * Names a delivered secret may never occupy. Overwriting PATH or HOME would let
 * whatever writes into the secret directory redirect every command the agent
 * runs — a credential drop must not be a code-execution primitive.
 */
export const PROTECTED_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
  'IS_SANDBOX', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);

/**
 * Load credentials from the secret directory.
 *
 * Every rejection is reported rather than silently dropped: a credential that
 * quietly fails to load looks to the agent exactly like "this tool is not
 * configured", which is a confusing way to discover a typo in a filename.
 *
 * @param {object} opts
 * @param {string} opts.zylosDir
 * @param {object} [opts.fsApi] injected for tests
 * @returns {{secrets: Record<string,string>, warnings: string[], names: string[]}}
 */
export function loadRuntimeSecrets({ zylosDir, fsApi = fs }) {
  const dir = path.join(zylosDir, SECRETS_SUBDIR);
  const secrets = {};
  const warnings = [];

  let entries;
  try {
    entries = fsApi.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Absent directory is the normal case on a host with no delivered
    // credentials — not a warning.
    return { secrets, warnings, names: [] };
  }

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (!entry.isFile()) {
      warnings.push(`secret store: skipped non-file entry "${name}"`);
      continue;
    }
    if (!VALID_NAME.test(name)) {
      warnings.push(`secret store: skipped "${name}" — not a valid environment variable name`);
      continue;
    }
    if (PROTECTED_NAMES.has(name)) {
      warnings.push(`secret store: refused "${name}" — protected variable, cannot be set from the secret store`);
      continue;
    }

    const file = path.join(dir, name);
    let raw;
    try {
      raw = fsApi.readFileSync(file, 'utf8');
    } catch (err) {
      warnings.push(`secret store: failed to read "${name}": ${err.message}`);
      continue;
    }

    // Strip exactly one trailing newline — `echo secret > FILE` adds one and it
    // would otherwise become part of the credential.
    const value = raw.replace(/\r?\n$/, '');
    if (!value) {
      warnings.push(`secret store: skipped "${name}" — file is empty`);
      continue;
    }

    try {
      const mode = fsApi.statSync(file).mode & 0o077;
      if (mode) warnings.push(`secret store: "${name}" is readable beyond its owner (mode ${(mode).toString(8)}) — tighten to 0600`);
    } catch {
      // Permission reporting is advisory; never block a usable credential on it.
    }

    secrets[name] = value;
  }

  return { secrets, warnings, names: Object.keys(secrets).sort() };
}

/**
 * Apply secrets onto an assembled environment.
 *
 * Kept separate from loading so callers can log which names were injected
 * without ever touching the values.
 *
 * @returns {{applied: string[], skipped: string[]}}
 */
export function applySecrets(env, secrets) {
  const applied = [];
  const skipped = [];
  for (const [name, value] of Object.entries(secrets || {})) {
    if (PROTECTED_NAMES.has(name)) { skipped.push(name); continue; }
    env[name] = value;
    applied.push(name);
  }
  return { applied: applied.sort(), skipped: skipped.sort() };
}
