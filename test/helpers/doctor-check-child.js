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
  'NO_COLOR', 'ZYLOS_GH_RETRY_DELAY_MS', 'DOCTOR_TEST_MODE', 'DOCTOR_TEST_ORIGIN', 'DOCTOR_TEST_RUNTIME', 'ZYLOS_SESSION_GROUP']);
// The repository test runner adds only its child-process guard preload.
const guardPreload = `--import=${JSON.stringify(new URL('../../scripts/test-child-preload.js', import.meta.url).href)}`;
if (process.env.NODE_OPTIONS !== undefined) assert.equal(process.env.NODE_OPTIONS, guardPreload);
for (const key of Object.keys(process.env)) {
  // macOS may add this locale marker even to an explicitly constructed env.
  const systemLocale = process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING';
  assert.ok(allowed.has(key) || key === 'NODE_OPTIONS' || systemLocale, `Unexpected inherited variable: ${key}`);
}

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
  database: process.env.DOCTOR_TEST_MODE === 'multi' ? path.join(resolved.ZYLOS_DIR, 'comm-bridge', 'c4.db') : 'none', args: process.argv.slice(2) })}`);
if (process.env.DOCTOR_TEST_MODE === 'multi' && process.env.DOCTOR_TEST_ORIGIN !== 'missing_db') {
  const [{ default: Database }, owner, { guardDatabase }] = await Promise.all([
    import('../../skills/comm-bridge/scripts/sqlite-driver.js'), import('../../skills/comm-bridge/scripts/c4-schema.js'),
    import('../../skills/comm-bridge/scripts/sqlite-schema.js'),
  ]);
  const dir = path.join(resolved.ZYLOS_DIR, 'comm-bridge');
  fs.mkdirSync(dir);
  const dbPath = path.join(dir, 'c4.db');
  assert.ok(dbPath.startsWith(`${resolved.ZYLOS_DIR}${path.sep}`));
  const db = new Database(dbPath);
  guardDatabase(db, owner);
  const state = process.env.DOCTOR_TEST_ORIGIN;
  if (state !== 'sleeping') {
    const age = state === 'waking' ? 0 : 400;
    db.prepare(`INSERT INTO conversations(timestamp,direction,channel,content,status,session_group)
      VALUES(?, 'in', 'system', 'fixture work', 'pending', 'origin')`).run(
        new Date(Date.now() - age * 1000).toISOString().replace('T', ' ').slice(0, 19));
  }
  db.close();
  if (state === 'auth_wait' || state === 'rate_wait') {
    const runtime = process.env.DOCTOR_TEST_RUNTIME;
    const dir = path.join(resolved.ZYLOS_DIR, 'activity-monitor', 'runtime-health');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${runtime}.json`), JSON.stringify({
      v: 1, runtime, health: state === 'auth_wait' ? 'auth_failed' : 'rate_limited',
      reason: 'fixture health', updatedAt: Math.floor(Date.now() / 1000), hook: {},
      unavailableSince: 0, cooldownUntil: 0, recoveringStartedAt: 0,
      lastUserMessageRecoveryAt: 0, restartFailureCount: 0, lastRecoveryAt: 0,
      lastDownCheckAt: 0, rateLimitResetTime: '',
    }));
  }
  console.error(`doctor fixture database: ${dbPath}`);
}
const { doctorCommand } = await import('../../cli/commands/doctor.js');
await doctorCommand(process.argv.slice(2), { type: 'direct' });
