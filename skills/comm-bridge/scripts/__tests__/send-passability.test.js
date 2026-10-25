import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { sendExternal } from '../c4-send-external.js';

function setup(t) {
  const result = fixture(t, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-passability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'demo', 'scripts', 'send.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const marker = path.join(dir, 'component-started');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`);
  return { ...result, dir, script, marker, api: { ...result.store, validateChannel: () => {} } };
}
const request = { channel: 'demo', endpoint: 'private-route-value' };

test('IF-68 actual SQLite writer contention commits no audit, namespace or group and starts no process', async t => {
  const { db, filename, api, dir, marker } = setup(t);
  db.pragma('busy_timeout=1');
  const writer = new Database(filename);
  t.after(() => writer.close());
  writer.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), { code: 'DB_BUSY' });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(db.inTransaction, false);
    for (const table of ['conversations', 'channel_namespaces', 'group_heads']) {
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    }
  } finally { writer.exec('ROLLBACK'); }
  await sendExternal(request, 'unlocked', { api, skillsDir: dir });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started');
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 1);
});

test('IF-68 real PATH ENOENT and EACCES retain committed audit without disclosing endpoint', async t => {
  const { api, db, dir } = setup(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = bin;
    for (const errno of ['ENOENT', 'EACCES']) {
      if (errno === 'EACCES') fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), error => {
        assert.equal(error.code, 'COMPONENT_SPAWN_FAILED');
        assert.ok(error.message.includes(errno));
        assert.ok(!error.message.includes(request.endpoint));
        return true;
      });
    }
  } finally { process.env.PATH = originalPath; }
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n, 2);
});

test('IF-68 actual aggregate argv/environment E2BIG keeps audit even when each argument is passable', async t => {
  const { api, db, dir } = setup(t);
  const keys = Array.from({ length: 40 }, (_, i) => `P09_SEND_PAYLOAD_${i}`);
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'x'.repeat(65536);
    await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), error =>
      error.code === 'COMPONENT_SPAWN_FAILED' && error.message.includes('E2BIG'));
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n, 1);
});

test('IF-68 started syntax failure and signal termination are uncertain send failures with retained audits', async t => {
  const { api, db, dir, script } = setup(t);
  for (const source of ['this is not valid JavaScript !!!', "process.kill(process.pid, 'SIGTERM')"]) {
    fs.writeFileSync(script, source);
    await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), error => {
      assert.equal(error.code, 'SEND_FAILED');
      assert.ok(error.message.includes('delivery unconfirmed'));
      return true;
    });
  }
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n, 2);
});
