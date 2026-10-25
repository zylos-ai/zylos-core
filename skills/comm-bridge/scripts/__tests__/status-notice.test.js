import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { reserveStatusNoticeCooldown, clearStatusNoticeCooldownReservation } from '../c4-db.js';
import { normalizeStatusEndpoint, statusNoticeKey, reserveStatusNotice, sendStatusNotice } from '../status-notice.js';
import { messageForStatus } from '../status-notice-templates.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('invalid sender channel is rejected before opening any database or spawning', () => {
  for (const channel of ['../outside', '--stdin', undefined]) {
    assert.throws(() => reserveStatusNotice(channel, 'endpoint'), /Invalid/);
    assert.throws(() => sendStatusNotice({ channel, endpoint: 'endpoint' }, 'message', {}, {
      spawn() { assert.fail('must not spawn'); },
    }), /Invalid/);
  }
});

test('legacy cooldown keys cannot suppress a distinct v2 reservation', t => {
  const { db, input } = fixture(t);
  db.prepare(`INSERT INTO status_notice_cooldowns VALUES (?,?,?,?,?,?,?,?)`)
    .run('old-key', 'lark', 'group|thread:t|root:r', 'unavailable', 'unavailable', 90, 150, 90);
  assert.equal(reserveStatusNoticeCooldown(input, db).suppressed, false);
});

for (const mode of ['timeout', 'crash', 'missing', 'throw']) test(`sender ${mode} persists the correct retry boundary`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, '.claude/skills/fake/scripts');
  fs.mkdirSync(channel, { recursive: true });
  const marker = path.join(root, 'sent');
  if (mode !== 'missing') fs.writeFileSync(path.join(channel, 'send.js'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'once'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);`);
  const senderUrl = new URL('../status-notice.js', import.meta.url).href;
  const dbUrl = new URL('../c4-db.js', import.meta.url).href;
  const code = `import {spawnSync} from 'node:child_process';
    import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(senderUrl)};
    import {close} from ${JSON.stringify(dbUrl)};
    const claim=reserveStatusNotice('fake','group',{sessionGroup:'fake',runtime:'claude'});
    const result=sendStatusNotice(claim,'notice',{}, {spawn:(cmd,args,options)=>{
      ${mode === 'crash' ? "process.kill(process.pid,'SIGKILL');" : mode === 'throw' ? "throw Error('injected');" : 'return spawnSync(cmd,args,{...options,timeout:500});'}
    }});console.log(JSON.stringify(result));close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  if (mode === 'crash') assert.equal(result.signal, 'SIGKILL');
  else {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).outcome, mode === 'missing' ? 'failed' : 'uncertain');
  }
  if (mode === 'timeout') assert.equal(fs.readFileSync(marker, 'utf8'), 'once');
  if (mode !== 'crash') {
    const lines = fs.readFileSync(path.join(root, 'activity-monitor/status-notices.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const diagnostic = JSON.parse(lines[0]);
    assert.equal(diagnostic.kind, 'inbound');
    assert.equal(diagnostic.endpoint, 'group');
    assert.equal(diagnostic.outcome, mode === 'missing' ? 'failed' : 'uncertain');
    assert.ok(Object.hasOwn(diagnostic, 'exitCode'));
    assert.ok(Object.hasOwn(diagnostic, 'signal'));
  }
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM status_notice_cooldowns').get().n, mode === 'missing' ? 0 : 1);
    const row = db.prepare('SELECT * FROM status_notice_cooldowns').get();
    const input = { cooldownKey: statusNoticeKey('fake','group','unavailable','unavailable','fake','claude'),
      channel: 'fake', endpoint: 'group', statusType:'unavailable',reason:'unavailable',ttl:600, now: row ? row.expires_at - 1 : Math.floor(Date.now() / 1000) };
    const next = reserveStatusNoticeCooldown(input, db);
    assert.equal(next.suppressed, mode !== 'missing');
    if (mode !== 'missing') {
      assert.equal(reserveStatusNoticeCooldown({ ...input, now: row.expires_at }, db).suppressed, false);
    }
  } finally { db.close(); }
});

function fixture(t) {
  const db = new Database(':memory:');
  guardDatabase(db, schema);
  t.after(() => db.close());
  const endpoint = 'group|root:r|thread:t|msg:a|parent:b';
  const input = { cooldownKey: statusNoticeKey('lark', endpoint), channel: 'lark', endpoint:normalizeStatusEndpoint(endpoint),
    statusType:'unavailable',reason:'unavailable',ttl:600, now: 100 };
  return { db, input };
}

test('a notice without an endpoint uses the sender stdin broadcast contract', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-broadcast-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, '.claude/skills/fake/scripts');
  fs.mkdirSync(channel, { recursive: true });
  const marker = path.join(root, 'sent.json');
  fs.writeFileSync(path.join(channel, 'send.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);
  const code = `import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(new URL('../status-notice.js', import.meta.url).href)};
    import {close} from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
    const claim=reserveStatusNotice('fake',null,{sessionGroup:'fake',runtime:'claude'});
    console.log(JSON.stringify(sendStatusNotice(claim,'broadcast notice',{}, {diagnostic:false})));close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).outcome, 'sent');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['broadcast notice']);
  assert.equal(fs.existsSync(path.join(root,'activity-monitor/status-notices.log')),false);
});

test('endpoint keys ignore message IDs but preserve health, reason, channel, root and thread', () => {
  assert.equal(statusNoticeKey('lark', 'group|type:group|thread:t|root:r|msg:a'),
    statusNoticeKey('lark', 'group|parent:b|root:r|thread:t|type:group|req:2'));
  assert.notEqual(statusNoticeKey('lark', 'group|thread:t'), statusNoticeKey('lark', 'group|thread:u'));
  assert.notEqual(statusNoticeKey('lark', 'ep'), statusNoticeKey('other', 'ep'));
});

test('reservation atomically suppresses sends until its original expiry', t => {
  const { db, input } = fixture(t);
  const claim = reserveStatusNoticeCooldown(input, db);
  assert.equal(claim.suppressed, false);
  assert.equal(reserveStatusNoticeCooldown(input, db).suppressed, true);
  assert.equal(reserveStatusNoticeCooldown({ ...input, now: 699 }, db).suppressed, true);
  assert.equal(reserveStatusNoticeCooldown({ ...input, now: 700 }, db).suppressed, false);
});

test('definite failure releases reservation and stale completion cannot change replacement', t => {
  const { db, input } = fixture(t);
  const first = reserveStatusNoticeCooldown(input, db);
  clearStatusNoticeCooldownReservation(first.key,first.reservedAt,db);
  const next = reserveStatusNoticeCooldown({ ...input, now: 102 }, db);
  assert.equal(next.suppressed, false);
  clearStatusNoticeCooldownReservation(first.key,first.reservedAt,db);
  assert.equal(db.prepare('SELECT expires_at FROM status_notice_cooldowns').get().expires_at, 702);
});

test('different health and reason remain independently notifiable', t => {
  const { db, input } = fixture(t);
  reserveStatusNoticeCooldown(input, db);
  for (const [health, reason] of [['auth_failed', 'invalid_key'], ['unavailable', 'network']]) {
    assert.equal(reserveStatusNoticeCooldown({ ...input, statusType:health, reason,
      cooldownKey: statusNoticeKey(input.channel, input.endpoint, health, reason) }, db).suppressed, false);
  }
});

test('schema retains only released C4 tables', t => {
  const { db } = fixture(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const name of ['runtime_deliveries','runtime_health_state','runtime_health_events','runtime_notice_intents','status_notice_attempts'])
    assert.equal(tables.includes(name), false, name);
});

test('diagnostic log rotates at 100 KB and preserves normalized target and notice kind', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'notice-log-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'activity-monitor/status-notices.log');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,('x'.repeat(1023)+'\n').repeat(101));
  const code=`import {logStatusNotice} from ${JSON.stringify(new URL('../status-notice.js',import.meta.url).href)};
    logStatusNotice({channel:'fake',endpoint:'group|thread:t|msg:123'},
      {health:'auth_failed',reason:'authentication_failed',noticeKind:'first-failure'},'sent',{status:0});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{
    env:{...process.env,ZYLOS_DIR:root},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.ok(fs.statSync(file).size<100*1024);
  const last=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1));
  assert.equal(last.endpoint,'group|thread:t');assert.equal(last.kind,'first-failure');
  assert.equal(last.exitCode,0);assert.equal(last.signal,null);
});

test('an experimental schema2 lacking the current layout is rejected without changing its data', t => {
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('history'); PRAGMA user_version=2");
  assert.throws(()=>guardDatabase(db,schema),/missing/);
  assert.equal(db.pragma('user_version',{simple:true}),2);
  assert.equal(db.prepare('SELECT value FROM retained').get().value,'history');
});

test('templates do not promise automatic recovery or an invented reset time', () => {
  for (const health of ['rate_limited', 'auth_failed', 'unavailable']) {
    const message = messageForStatus({ health });
    assert.match(message, /未进入处理队列/);
    assert.doesNotMatch(message, /within an hour|automatically|administrator has|should be back/);
  }
});
