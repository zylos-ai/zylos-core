import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const root = fs.realpathSync(process.env.DOCTOR_TEST_ROOT);
const resolved = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => {
  const value = fs.realpathSync(process.env[key]);
  assert.ok(value.startsWith(`${root}${path.sep}`), `${key} escaped fixture`);
  return [key, value];
}));
assert.equal(os.homedir(), resolved.HOME);
assert.equal(process.env.PATH, path.join(root, 'bin'));
assert.equal(process.cwd(), root);
assert.equal(process.env.CLAUDE_BIN, path.join(root, 'bin', 'claude'));
assert.equal(process.env.DOCTOR_TEST_TMUX_SOCKET, path.join(resolved.TMPDIR, 'tmux.sock'));
assert.ok(Buffer.byteLength(process.env.DOCTOR_TEST_TMUX_SOCKET) < 100);
const allowed = new Set(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH', 'CLAUDE_BIN',
  'DOCTOR_TEST_ROOT', 'DOCTOR_TEST_STATE', 'DOCTOR_TEST_NETWORK', 'DOCTOR_TEST_TMUX_SOCKET',
  'NO_COLOR', 'ZYLOS_GH_RETRY_DELAY_MS']);
for (const key of Object.keys(process.env)) assert.ok(allowed.has(key), `Unexpected inherited variable: ${key}`);

// Replace only OS/network boundaries; import the product normally below.
const blocked = () => { throw new Error('Unexpected live network access in doctor fixture'); };
http.request = http.get = https.request = https.get = net.connect = net.createConnection = blocked;
globalThis.fetch = blocked;
dns.resolve4 = async () => {
  if (process.env.DOCTOR_TEST_NETWORK === 'down') {
    throw Object.assign(new Error('Fixture DNS unavailable'), { code: 'ENOTFOUND' });
  }
  return ['192.0.2.1'];
};

const config = await import('../../cli/lib/config.js');
assert.equal(fs.realpathSync(config.ZYLOS_DIR), resolved.ZYLOS_DIR);
assert.equal(config.CONFIG_DIR, path.join(resolved.ZYLOS_DIR, '.zylos'));
assert.equal(config.SKILLS_DIR, path.join(resolved.ZYLOS_DIR, '.claude', 'skills'));
assert.equal(config.COMPONENTS_FILE, path.join(resolved.ZYLOS_DIR, '.zylos', 'components.json'));
console.error(`doctor isolation: ${JSON.stringify({ ...resolved,
  PATH: process.env.PATH, tmuxSocket: process.env.DOCTOR_TEST_TMUX_SOCKET,
  database: 'none', args: process.argv.slice(2) })}`);
const { doctorCommand } = await import('../../cli/commands/doctor.js');
await doctorCommand(process.argv.slice(2), { type: 'direct' });
