import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';

function fixture(t, { legacy = false, invalidVersion = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/dcli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), `${key} is private`);
  }
  assert.ok(!root.startsWith(fs.realpathSync(os.userInfo().homedir) + path.sep));
  env.ZYLOS_DATA_DIR = path.join(env.ZYLOS_DIR, 'components/dashboard');
  fs.mkdirSync(env.ZYLOS_DATA_DIR, { recursive: true });
  const file = path.join(env.ZYLOS_DATA_DIR, 'dashboard.db');
  assert.ok(file.startsWith(root + path.sep));
  console.log('Dashboard CLI isolation:', JSON.stringify({ root, file,
    ...Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, env[key]])),
    privateSocket: path.join(env.TMUX_TMPDIR, 'reserved.sock'), tmux: 'not started' }));
  if (legacy) {
    const db = new Database(file);
    try {
      db.exec(fs.readFileSync(new URL('./fixtures/dashboard-schema22.sql', import.meta.url), 'utf8'));
      if (invalidVersion) db.exec('DELETE FROM schema_migrations; INSERT INTO schema_migrations(version) VALUES(-1)');
    }
    finally { db.close(); }
  } else {
    const store = new Store(file);
    store.close();
  }
  const invoke = (script, args) => spawnSync(process.execPath,
    [new URL(`../scripts/${script}.js`, import.meta.url).pathname, ...args],
    { env, cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  return { file, invoke };
}

// CLI/schema integration: actual commands against old or invalid-version databases.
// Run for CLI storage admission/schema changes; UI-only changes may skip.
// All five paths and DB are private and logged before open. Synchronous children
// have timeout/output bounds; no runtime, tmux, PM2, network or background loop.
for (const [script, args] of [['api-key', ['list']], ['group-name', ['get', 'telegram:team', '--json']]]) {
  for (const invalidVersion of [false, true]) {
    test(`${script} refuses ${invalidVersion ? 'an invalid-version' : 'an old'} Dashboard database without changing bytes or mtime`, t => {
      const f = fixture(t, { legacy: true, invalidVersion });
      const bytes = fs.readFileSync(f.file), mtime = fs.statSync(f.file).mtimeMs;
      const result = f.invoke(script, args);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Dashboard requires an upgrade/);
      assert.ok(fs.readFileSync(f.file).equals(bytes), 'database bytes remain unchanged');
      assert.equal(fs.statSync(f.file).mtimeMs, mtime, 'database mtime remains unchanged');
      assert.equal(fs.existsSync(f.file + '-wal'), false);
      assert.equal(fs.existsSync(f.file + '-shm'), false);
    });
  }
}

// Current-schema compatibility: real CLI writes and reads the private database.
// Run for admission changes; UI-only changes may skip. Same isolated/bounded
// fixture as above; no real Core adapter or service is launched.
test('API key CLI still writes and lists keys on the current Dashboard schema', t => {
  const f = fixture(t);
  let result = f.invoke('api-key', ['generate', 'fixture-key', 'read']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API key created: fixture-key/);
  result = f.invoke('api-key', ['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture-key.*scope=read.*status=active/);
});

// Current-schema compatibility: name persistence through two actual CLI runs.
// Run for admission changes; UI-only changes may skip. Same isolated/bounded
// fixture; set/get stay local and do not collect groups from Core.
test('group name CLI still writes and reads names on the current Dashboard schema', t => {
  const f = fixture(t);
  let result = f.invoke('group-name', ['set', 'telegram:team', 'Team', '--json']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.displayName, 'Team');
  result = f.invoke('group-name', ['get', 'telegram:team', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.displayName, 'Team');
});
