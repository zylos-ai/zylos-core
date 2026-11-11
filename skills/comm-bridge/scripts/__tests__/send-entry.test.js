import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fixture } from './c4-v2-test-helpers.js';
import { parseSendArgs } from '../c4-send-args.js';
import { sendExternal, recordVoid, senderSessionId, readAbsorbedReply } from '../c4-send-external.js';
import { systemSendEnvironment } from '../c4-system-send-env.js';

function setup(t) {
  const { db, store, filename } = fixture(t, {}, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'demo', 'scripts', 'send.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const marker = path.join(dir, 'component-started');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`);
  const api = { ...store, getDb: () => db,
    getConversationsByRange: (a, b) => db.prepare('SELECT * FROM conversations WHERE id>=? AND id<=?').all(a, b) };
  return { db, store, filename, dir, script, marker, api };
}
const request = { channel: 'demo', endpoint: 'endpoint' };

test('system sends retain explicit notice provenance without changing ordinary reply records', async t => {
  const { api, dir } = setup(t);
  const inherited = { ...process.env, ZYLOS_RUN_ID: 'runtime-run', ZYLOS_SESSION_GROUP: 'demo:owned' };
  assert.equal(systemSendEnvironment(inherited).ZYLOS_SYSTEM_SEND, undefined, 'service environments are not notices');
  assert.equal(systemSendEnvironment({ ...inherited, ZYLOS_SYSTEM_SEND: '1' }).ZYLOS_SYSTEM_SEND, undefined,
    'a service environment cannot inherit a notice marker');
  const env = systemSendEnvironment(inherited, { notice: true });
  assert.equal(env.ZYLOS_SYSTEM_SEND, '1');
  assert.equal(env.ZYLOS_RUN_ID, undefined); assert.equal(env.ZYLOS_SESSION_GROUP, undefined);
  assert.equal(inherited.ZYLOS_RUN_ID, 'runtime-run');
  const notice = await sendExternal(request, 'notice', { api, skillsDir: dir, env });
  assert.equal(notice.delivery_action, 'system_notice');
  const ordinary = await sendExternal(request, 'reply', { api, skillsDir: dir, env: { ...process.env } });
  assert.equal(ordinary.delivery_action, null);
});

test('legacy trailing group option is discarded while preserving content', () => {
  for (const isTTY of [true, false]) {
    assert.deepEqual(parseSendArgs(['demo', 'ep', 'body', '--session-group', 'group'], { isTTY }),
      { kind: 'external', channel: 'demo', endpoint: 'ep', message: 'body', stdin: false });
    assert.deepEqual(parseSendArgs(['demo', 'ep', '--stdin', '--session-group', 'ignored'], { isTTY }),
      { kind: 'external', channel: 'demo', endpoint: 'ep', stdin: true });
  }
  assert.equal(parseSendArgs(['demo', '--stdin'], { isTTY: true }).endpoint, null);
  assert.equal(parseSendArgs(['demo', '-100|msg:2'], { isTTY: false }).endpoint, '-100|msg:2');
  assert.equal(parseSendArgs(['demo', 'a\\nb'], { isTTY: true }).message, 'a\nb');
  for (const args of [[], ['demo'], ['demo', 'ep', '--session-group'], ['demo', 'ep', '--session-group', 'g', 'body'],
    ['demo', 'ep', '--group', 'g'], ['void', 'ep', '--session-group', 'g'], ['--absorbed-reply', 'bad', '1']]) {
    assert.throws(() => parseSendArgs(args), { code: 'INVALID_ARGS' });
  }
});

test('current identity must match inherited run; legacy reads only foreground identity', t => {
  const { dir } = setup(t);
  const env = { ZYLOS_DIR: dir, ZYLOS_RUN_ID: 'run-a', ZYLOS_SESSION_GROUP: 'demo:g' };
  const runDir = path.join(dir, 'activity-monitor', 'session-groups', 'demo:g');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'current-session.json'), JSON.stringify({ runId: 'run-b', sessionId: 'other' }));
  assert.equal(senderSessionId(env), null);
  fs.writeFileSync(path.join(runDir, 'current-session.json'), JSON.stringify({ runId: 'run-a', sessionId: 'mine' }));
  assert.equal(senderSessionId(env), 'mine');
  fs.writeFileSync(path.join(dir, 'activity-monitor', 'foreground-session.json'), JSON.stringify({ session_id: 'legacy' }));
  assert.equal(senderSessionId({ ZYLOS_DIR: dir }), 'legacy');
});

test('void requires environment ownership and retains delivered record without component', t => {
  const { api, db, dir, store } = setup(t);
  assert.throws(() => recordVoid(request, 'note', { api, env: { ZYLOS_DIR: dir } }), { code: 'NO_SESSION_ENV' });
  assert.throws(() => recordVoid(request, 'note', { api, env: { ZYLOS_SESSION_GROUP: 'demo:missing' } }), { code: 'UNKNOWN_GROUP' });
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  const row = recordVoid(request, 'note', { api, env: { ZYLOS_RUN_ID: 'run-a', ZYLOS_DIR: dir } });
  assert.equal(row.channel, 'void'); assert.equal(row.status, 'delivered'); assert.equal(row.session_group, 'origin');
  store.insertConversation('in', 'demo', 'endpoint', 'group owner', { groupName: 'owned' });
  const grouped = recordVoid(request, 'group note', { api, env: { ZYLOS_SESSION_GROUP: 'demo:owned', ZYLOS_RUN_ID: 'run-a', ZYLOS_DIR: dir } });
  assert.equal(grouped.session_group, 'demo:owned');
  assert.throws(() => recordVoid(request, 'empty group', { api, env: { ZYLOS_SESSION_GROUP: '', ZYLOS_RUN_ID: 'run-a' } }), { code: 'UNKNOWN_GROUP' });
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 3);
});

test('precheck failures leave empty and never invoke component', async t => {
  const { api, db, dir, script, marker } = setup(t);
  const options = { api, skillsDir: dir };
  for (const endpoint of ['x\0y', 'x'.repeat(131072)]) {
    await assert.rejects(sendExternal({ ...request, endpoint }, 'body', options), { code: 'ENDPOINT_NOT_PASSABLE' });
  }
  fs.renameSync(script, script + '.away');
  await assert.rejects(sendExternal(request, 'body', options), { code: 'INVALID_ARGS' });
  assert.equal(fs.existsSync(marker), false);
  for (const table of ['conversations', 'channel_namespaces', 'group_heads']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});

test('audit rollback prevents component; actual exit failure preserves audit', async t => {
  const { api, db, dir, script, marker } = setup(t);
  db.exec("CREATE TRIGGER reject_send BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'reject'); END");
  await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), { code: 'DB_WRITE_FAILED' });
  assert.equal(fs.existsSync(marker), false); assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
  db.exec('DROP TRIGGER reject_send');
  fs.writeFileSync(script, 'process.exit(1)');
  await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), { code: 'SEND_FAILED', exitCode: 1 });
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n, 1);
});

test('absorbed reply reads transition and message atomically without reusing the stored group', t => {
  const { api, store, db } = setup(t);
  const endpoint = 'a\'"$`\\\nroute';
  const row = store.insertConversation('in', 'demo', endpoint, 'incoming', { groupName: 'group' });
  const { runId } = store.beginModeTransition('single', 'multi');
  store.setDrainFence('*'); store.absorbForTransition(runId);
  const original = api.getModeTransition;
  api.getModeTransition = options => { assert.equal(db.inTransaction, true); return original(options); };
  assert.deepEqual(readAbsorbedReply(runId, String(row.id), api), { kind: 'external', channel: 'demo', endpoint, id: row.id, runId });
  assert.throws(() => readAbsorbedReply(runId, '2', api), { code: 'ABSORBED_NOT_IN_RUN' });
  db.prepare("UPDATE conversations SET status='failed' WHERE id=?").run(row.id);
  assert.throws(() => readAbsorbedReply(runId, String(row.id), api), { code: 'ABSORBED_MISMATCH' });
});

test('real component receives maximum endpoint and preserves shell metacharacters', async t => {
  const { api, dir, script, db, filename } = setup(t);
  const output = path.join(dir, 'argv.json');
  const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
  fs.writeFileSync(script, `const fs = require('node:fs'); const Database = require(${JSON.stringify(sqlite)});
    const db = new Database(${JSON.stringify(filename)}, {readonly:true});
    const rows = db.prepare('SELECT count(*) n FROM conversations').get().n;
    db.close(); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), rows}));`);
  for (const [index, endpoint] of ['x'.repeat(131071), 'a\'"$`\\\nroute'].entries()) {
    await sendExternal({ ...request, endpoint }, 'body', { api, skillsDir: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(output)), { args: [endpoint, 'body'], rows: index + 1 });
  }
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 2);
});

test('actual E2BIG and a component disappearing before delivery preserve delivered rows', { timeout: 15000 }, async t => {
  const { api, dir, script, marker, db } = setup(t);
  const argMax = Number(execFileSync('getconf', ['ARG_MAX'], { encoding: 'utf8', timeout: 5000 }).trim());
  assert.ok(Number.isSafeInteger(argMax) && argMax > 0, 'getconf must report a positive argument limit');
  // Exceed the platform's entire argv budget, not Linux's per-argument limit.
  await assert.rejects(sendExternal(request, 'x'.repeat(argMax + 1), { api, skillsDir: dir }),
    error => error.code === 'COMPONENT_SPAWN_FAILED' && error.message.includes('E2BIG'));
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n, 1);
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(dir, 'demo', 'SKILL.md'), `---
c4:
  before_send:
    hook_id: disappear
    entry: scripts/before-send.js
    timeout_ms: 1000
---
`);
  fs.writeFileSync(path.join(dir, 'demo', 'scripts', 'before-send.js'), `
    require('node:fs').renameSync(${JSON.stringify(script)}, ${JSON.stringify(script + '.removed')});
    process.stdout.write(JSON.stringify({version:1, decision:'continue'}));
  `);
  await assert.rejects(sendExternal(request, 'body', { api, skillsDir: dir }), { code: 'SEND_FAILED' });
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE status='delivered'").get().n, 2);
  assert.equal(fs.existsSync(script + '.removed'), true);
  assert.equal(fs.existsSync(marker), false);
});

test('component query owns outbound routing despite history and legacy request groups', async t => {
  const { api, store, db, dir } = setup(t);
  store.registerChannelNamespace('demo', 'namespace');
  store.insertConversation('in', 'demo', 'endpoint', 'old', {groupName:'old'});
  store.insertConversation('in', 'demo', 'other', 'unrelated', {groupName:'other'});
  store.insertConversation('in', 'demo', 'endpoint', 'new', {groupName:'new'});
  fs.writeFileSync(path.join(dir, 'demo', 'scripts', 'session-group.js'), `process.stdout.write(${JSON.stringify('queried\n')})`);
  const options = { api, skillsDir: dir, env: { ...process.env } };
  for (const legacy of [{}, { groupName: 'old' }, { groupName: 'bad name' }, { wholeGroup: true }]) {
    const row = await sendExternal({ ...request, ...legacy }, 'query route', options);
    assert.equal(row.session_group, 'namespace:queried');
    assert.equal(row.status, 'delivered');
    assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=?').get(row.id).session_group, 'namespace:queried');
  }
  assert.equal(db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, 4);
});

test('matching and stale run identities persist exact session_id or NULL in committed audit', async t => {
  const { api, db, dir, store } = setup(t);
  store.insertConversation('in', 'demo', request.endpoint, 'owner', { groupName: 'room' });
  fs.writeFileSync(path.join(dir, 'demo', 'scripts', 'session-group.js'), `process.stdout.write(${JSON.stringify('room\n')})`);
  const runDir = path.join(dir,'activity-monitor/session-groups/demo:room');
  fs.mkdirSync(runDir,{recursive:true});
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = {PATH:bin,ZYLOS_DIR:dir,ZYLOS_RUN_ID:'own-run',ZYLOS_SESSION_GROUP:'demo:room'};
  for (const [runId, expected] of [['other-run',null],['own-run','own-session']]) {
    fs.writeFileSync(path.join(runDir,'current-session.json'),JSON.stringify({runId,sessionId:'own-session'}));
    const row = await sendExternal(request,'body',{api,env,skillsDir:dir});
    assert.equal(row.session_id,expected);
    assert.equal(db.prepare('SELECT session_id FROM conversations WHERE id=?').get(row.id).session_id,expected);
  }
});
