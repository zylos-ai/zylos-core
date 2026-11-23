import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { guardDatabase, planDatabaseMigration } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';

// Run for session-mode status, read-only C4, supervisor socket or PM2 probe
// changes. Skip for unrelated changes. Cases use private databases, fixture
// sockets and scoped PM2 shims under the isolated runner.
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-status-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge')); fs.mkdirSync(path.join(root, 'activity-monitor'));
  const filename = path.join(root, 'comm-bridge', 'c4.db'); const database = new Database(filename);
  guardDatabase(database, schema);
  const store = createStore(database, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  return { root, filename, database, store };
}

async function publicStatus(root, args = ['--json'], extraEnv = {}) {
  const execute = promisify(execFile);
  // Keep accidental PM2 calls inside a recording, non-daemonizing fixture.
  const pm2Root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-status-pm2-')); roots.push(pm2Root);
  const safePm2 = pm2Cli(pm2Root, 'process.exit(1);');
  try {
    const result = await execute(process.execPath, ['cli/zylos.js', 'session-mode', 'status', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'private-pm2'), PM2_RPC_PORT: '', ...safePm2, ...extraEnv },
      timeout: 10000,
    });
    return { ...result, code: 0 };
  } catch (error) { return error; }
}

// Public CLI integration covers read-only access to a historical schema. Run for
// status/schema changes; unrelated UI work may skip. The runner supplies isolated
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; publicStatus uses this private DB and a
// recording PM2 fixture. No tmux is launched; owned directories are removed.
test('public status leaves a pending schema migration byte-identical instead of upgrading the database', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-status-old-schema-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge', 'c4.db');
  const database = new Database(filename);
  database.exec(fs.readFileSync(new URL('../skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.9.0-v1.sql', import.meta.url), 'utf8'));
  const fixtureVersion = 1;
  assert.equal(database.pragma('user_version', { simple: true }), fixtureVersion);
  const expectedSteps = Array.from({ length: schema.SUPPORTED_SCHEMA_VERSION - fixtureVersion },
    (_, index) => [fixtureVersion + index, fixtureVersion + index + 1]);
  assert.deepEqual(planDatabaseMigration(database, schema, { strict: false }).steps.map(step => [step.from, step.to]), expectedSteps);
  database.close();
  const before = fs.readFileSync(filename); const filesBefore = fs.readdirSync(path.dirname(filename)).sort();
  console.log('Status migration isolation:', JSON.stringify({ HOME: root, ZYLOS_DIR: root,
    PM2_HOME: path.join(root, 'private-pm2'), TMPDIR: process.env.TMPDIR,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR, database: filename,
    amSocket: path.join(root, 'activity-monitor/am.sock'), tmux: 'not launched' }));
  const result = await publicStatus(root);
  // Assert the no-write invariant before the error contract, so an accidental
  // migration fails for its data change even if it also makes the query succeed.
  assert.equal(fs.readFileSync(filename).equals(before), true);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)).sort(), filesBefore);
  const readonly = new Database(filename, { readonly: true, fileMustExist: true });
  try { assert.equal(readonly.pragma('user_version', { simple: true }), 1); }
  finally { readonly.close(); }
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(fs.existsSync(path.join(root, 'private-pm2')), false);
});

function pm2Cli(root, body) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const executable = path.join(bin, 'pm2');
  fs.writeFileSync(executable, String.raw`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(path.join(process.env.HOME, 'pm2-calls'), JSON.stringify(process.argv.slice(2)) + '\n');
${body}
`, { mode: 0o700 });
  // The executable has no extension, so declare ESM for this isolated CLI fixture.
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

test('missing PM2 socket skips the CLI and leaves no daemon after public status exits', { timeout: 5000 }, async () => {
  const { root, database } = fixture(); database.close();
  const env = pm2Cli(root, `fs.mkdirSync(process.env.PM2_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.PM2_HOME, 'pm2.pid'), String(process.pid));
console.log('[]');`);
  const result = await publicStatus(root, ['--json'], env);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).data.supervisorPm2, { status: 'daemon_not_running', error: null });
  assert.equal(fs.existsSync(path.join(root, 'pm2-calls')), false);
  assert.equal(fs.existsSync(path.join(root, 'private-pm2')), false);
});
