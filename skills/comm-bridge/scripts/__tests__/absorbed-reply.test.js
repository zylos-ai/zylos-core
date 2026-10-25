import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { parseSendArgs } from '../c4-send-args.js';
import { readAbsorbedReply, sendExternal } from '../c4-send-external.js';

function setup(t, endpoint = 'route') {
  const result = fixture(t, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorbed-reply-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'demo', 'scripts', 'send.js');
  const output = path.join(dir, 'argv.json');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
  const row = result.store.insertConversation('in', 'demo', endpoint, 'original', { groupName: 'room' });
  const { runId } = result.store.beginModeTransition('single', 'multi');
  result.store.setDrainFence('*');
  result.store.absorbForTransition(runId);
  const api = { ...result.store, getDb: () => result.db, validateChannel: () => {},
    getConversationsByRange: (a, b) => result.db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=? ORDER BY id').all(a, b) };
  return { ...result, dir, script, output, row, runId, api };
}

test('#6b rejects malformed run/id at parse boundary without coercing numeric input', () => {
  const runId = '01234567-89ab-cdef-0123-456789abcdef';
  for (const id of ['0', '-1', '+1', '01', '1.0', '1e3', ' 1', '1\n', '12345678901234567890']) {
    assert.throws(() => parseSendArgs(['--absorbed-reply', runId, id]), { code: 'INVALID_ARGS' });
  }
  for (const run of [runId.toUpperCase(), runId + 'x', '', 'not-a-run']) {
    assert.throws(() => parseSendArgs(['--absorbed-reply', run, '1']), { code: 'INVALID_ARGS' });
  }
  assert.equal(parseSendArgs(['--absorbed-reply', runId, '1000000000000000001']).id, '1000000000000000001');
  assert.throws(() => parseSendArgs(['--absorbed-reply', runId, '1', 'extra']), { code: 'INVALID_ARGS' });
});

test('#6b missing run, gating membership and vanished row preserve D9 and never create out audit', t => {
  const { api, db, runId, row } = setup(t);
  const original = db.prepare('SELECT absorbed_ids FROM mode_transitions WHERE run_id=?').get(runId).absorbed_ids;
  assert.throws(() => readAbsorbedReply('00000000-0000-0000-0000-000000000000', String(row.id), api), { code: 'RUN_NOT_FOUND' });
  assert.throws(() => readAbsorbedReply(runId, '999', api), { code: 'ABSORBED_NOT_IN_RUN' });
  db.prepare("UPDATE mode_transitions SET phase='gating' WHERE run_id=?").run(runId);
  assert.throws(() => readAbsorbedReply(runId, String(row.id), api), { code: 'ABSORBED_NOT_IN_RUN' });
  db.prepare("UPDATE mode_transitions SET phase='converting' WHERE run_id=?").run(runId);
  db.prepare('DELETE FROM conversations WHERE id=?').run(row.id);
  assert.throws(() => readAbsorbedReply(runId, String(row.id), api), { code: 'ABSORBED_MISMATCH' });
  assert.equal(db.prepare('SELECT absorbed_ids FROM mode_transitions WHERE run_id=?').get(runId).absorbed_ids, original);
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, 0);
});

test('#6b real component receives exact absorbed route bytes and null endpoint is omitted', async t => {
  for (const endpoint of [null, 'a\'"$`\\\nroute', 'x'.repeat(131071)]) {
    const { api, db, runId, row, dir, output } = setup(t, endpoint);
    const request = readAbsorbedReply(runId, String(row.id), api);
    await sendExternal(request, 'response', { api, skillsDir: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), endpoint === null ? ['response'] : [endpoint, 'response']);
    assert.equal(db.prepare("SELECT endpoint_id FROM conversations WHERE direction='out'").get().endpoint_id, endpoint);
    assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'switch_absorbed');
  }
});

test('#6b uninstalled component and unpassable original routes reject without new audit or source mutation', async t => {
  for (const endpoint of ['x\0y', 'x'.repeat(131072), 'route']) {
    const { api, db, runId, row, dir, script } = setup(t, endpoint);
    if (endpoint === 'route') fs.renameSync(script, script + '.removed');
    const before = db.prepare('SELECT * FROM conversations').all();
    const runBefore = db.prepare('SELECT * FROM mode_transitions').all();
    await assert.rejects(sendExternal(readAbsorbedReply(runId, String(row.id), api), 'body', { api, skillsDir: dir }),
      { code: endpoint === 'route' ? 'INVALID_ARGS' : 'ENDPOINT_NOT_PASSABLE' });
    assert.deepEqual(db.prepare('SELECT * FROM conversations').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM mode_transitions').all(), runBefore);
  }
});

test('#6b D9 and D1 reads share an actual WAL snapshot during a concurrent committed state change', t => {
  const { api, db, filename, runId, row } = setup(t);
  const writer = new Database(filename);
  t.after(() => writer.close());
  const readRun = api.getModeTransition;
  api.getModeTransition = options => {
    assert.equal(db.inTransaction, true);
    const run = readRun(options);
    writer.transaction(() => {
      writer.prepare("UPDATE conversations SET status='failed',endpoint_id='changed' WHERE id=?").run(row.id);
      writer.prepare("UPDATE mode_transitions SET absorbed_ids='[]' WHERE run_id=?").run(runId);
    })();
    return run;
  };
  assert.equal(readAbsorbedReply(runId, String(row.id), api).endpoint, 'route');
  assert.equal(db.inTransaction, false);
  assert.equal(db.prepare('SELECT endpoint_id FROM conversations WHERE id=?').get(row.id).endpoint_id, 'changed');
  api.getModeTransition = readRun;
  assert.throws(() => readAbsorbedReply(runId, String(row.id), api), { code: 'ABSORBED_NOT_IN_RUN' });
});

test('#6b snapshot negative control detects reads outside the shared transaction', t => {
  const { api, db, filename, runId, row } = setup(t);
  const writer = new Database(filename);
  t.after(() => writer.close());
  const readRun = api.getModeTransition;
  api.getModeTransition = options => {
    const run = readRun(options);
    writer.prepare("UPDATE conversations SET status='failed' WHERE id=?").run(row.id);
    return run;
  };
  const brokenApi = { ...api, getDb: () => ({ transaction: operation => operation }) };
  assert.throws(() => readAbsorbedReply(runId, String(row.id), brokenApi), { code: 'ABSORBED_MISMATCH' });
  assert.equal(db.inTransaction, false);
});

test('#6b absorbed internal route is retained in full for the internal handler', t => {
  const { api, db, runId, row } = setup(t);
  const endpoint = 'peer:room-with-\'"$`\\\nbytes';
  db.prepare("UPDATE conversations SET channel='internal',endpoint_id=?,session_group='origin' WHERE id=?").run(endpoint, row.id);
  assert.deepEqual(readAbsorbedReply(runId, String(row.id), api),
    { kind: 'external', channel: 'internal', endpoint, groupName: undefined });
});

test('#6b unsafe numeric D9 id is refused rather than replying to a rounded neighboring id', t => {
  const { api, db, row, runId } = setup(t);
  const exact = '1000000000000000001';
  db.prepare('UPDATE conversations SET id=? WHERE id=?').run(BigInt(exact), row.id);
  db.prepare('UPDATE mode_transitions SET absorbed_ids=? WHERE run_id=?').run(`[${exact}]`, runId);
  const decoded = api.getModeTransition({ runId }).absorbed_ids[0];
  assert.equal(Number.isSafeInteger(decoded), false);
  assert.notEqual(String(decoded), exact);
  assert.throws(() => readAbsorbedReply(runId, exact, api), { code: 'ABSORBED_NOT_IN_RUN' });
  assert.throws(() => readAbsorbedReply(runId, String(decoded), api), { code: 'ABSORBED_NOT_IN_RUN' });
  // String storage cannot make a Number-based C4 driver safe for this id.
  db.prepare('UPDATE mode_transitions SET absorbed_ids=? WHERE run_id=?').run(JSON.stringify([exact]), runId);
  assert.throws(() => readAbsorbedReply(runId, exact, api), { code: 'ABSORBED_NOT_IN_RUN' });
});
