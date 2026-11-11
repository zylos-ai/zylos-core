import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';

// Real CLI/store boundary; rerun for readonly listing changes. No services run.
// Every child uses isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and synthetic data.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-ro-'));
  const home = path.join(root, 'home');
  const zylos = path.join(home, 'zylos');
  const tmp = path.join(root, 'tmp');
  const file = path.join(zylos, 'scheduler/scheduler.db');
  const env = {...process.env, HOME:home, ZYLOS_DIR:zylos, PM2_HOME:path.join(root, 'pm2'),
    TMPDIR:tmp, TMUX_TMPDIR:tmp, TZ:'UTC'};
  delete env.TMUX;
  for (const dir of [home, zylos, tmp]) fs.mkdirSync(dir, {recursive:true});
  for (const target of [home, zylos, tmp, env.PM2_HOME, file]) assert.ok(target.startsWith(root + path.sep));
  console.log(JSON.stringify({readonlyFixture:root, HOME:home, ZYLOS_DIR:zylos,
    PM2_HOME:env.PM2_HOME, TMPDIR:tmp, TMUX_TMPDIR:tmp, database:file}));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)),
    'list', '--reply-channel', 'web-console', '--json', '--readonly'], {env, encoding:'utf8', timeout:15000});
  return {root, zylos, file, run};
}

for (const valid of [true, false]) test(`readonly list ${valid ? 'reads filtered rows' : 'rejects incompatible schema'} without modifying bytes`, t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.file));
  const db = new Database(f.file);
  if (valid) {
    db.exec(`CREATE TABLE tasks (id TEXT, status TEXT, type TEXT, reply_channel TEXT, priority INTEGER, next_run_at INTEGER);
      INSERT INTO tasks VALUES ('legacy', 'pending', 'one-time', 'web-console', 1, 1);
      INSERT INTO tasks VALUES ('other', 'pending', 'one-time', 'lark', 1, 1);`);
  } else db.exec('CREATE TABLE preserved (value TEXT);');
  db.close();
  const before = fs.readFileSync(f.file);
  const files = fs.readdirSync(path.dirname(f.file)).sort();
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, valid ? 0 : 1, result.stderr);
  if (valid) assert.equal(JSON.parse(result.stdout).map(row => row.id).join(','), 'legacy');
  else assert.equal(JSON.parse(result.stdout).ok, false);
  assert.ok(fs.readFileSync(f.file).equals(before));
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(), files);
});

test('readonly list rejects a missing database without initializing its directory', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
});
