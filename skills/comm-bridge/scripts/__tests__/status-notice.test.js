import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { claimStatusNotice, startStatusNotice, finishStatusNotice } from '../c4-db.js';
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

test('legacy cooldown metadata order preserves only the existing suppression window', t => {
  const { db, input } = fixture(t);
  db.prepare(`INSERT INTO status_notice_cooldowns VALUES (?,?,?,?,?,?,?,?)`)
    .run('old-key', 'lark', 'group|thread:t|root:r', 'rate_limited', 'rate', 90, 150, 90);
  assert.equal(claimStatusNotice(input, db).reason, 'cooldown');
  assert.equal(claimStatusNotice({ ...input, now: 150 }, db).suppressed, false);
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
    const claim=reserveStatusNotice('fake','group',{healthEpisode:'episode'});
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
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM status_notice_cooldowns').get().n, 0);
    const row = db.prepare('SELECT * FROM status_notice_attempts').get();
    const input = { key: statusNoticeKey('fake','group'), episode: 'episode', attemptId: 'replacement',
      channel: 'fake', endpoint: 'group', normalizedEndpoint: 'group', now: row.lease_until + 1 };
    const next = claimStatusNotice(input, db);
    assert.equal(next.suppressed, mode !== 'missing');
    if (mode !== 'missing') assert.equal(next.reason, 'uncertain');
  } finally { db.close(); }
});

function fixture(t) {
  const db = new Database(':memory:');
  guardDatabase(db, schema);
  t.after(() => db.close());
  const endpoint = 'group|root:r|thread:t|msg:a|parent:b';
  const input = { key: statusNoticeKey('lark', endpoint), attemptId: 'a', channel: 'lark', endpoint,
    normalizedEndpoint: normalizeStatusEndpoint(endpoint), now: 100, leaseSeconds: 60 };
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
    const claim=reserveStatusNotice('fake',null,{healthEpisode:'episode'});
    console.log(JSON.stringify(sendStatusNotice(claim,'broadcast notice')));close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).outcome, 'sent');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['broadcast notice']);
});

test('endpoint keys share reasons and message IDs but preserve channel, root and thread', () => {
  assert.equal(statusNoticeKey('lark', 'group|type:group|thread:t|root:r|msg:a'),
    statusNoticeKey('lark', 'group|parent:b|root:r|thread:t|type:group|req:2'));
  assert.notEqual(statusNoticeKey('lark', 'group|thread:t'), statusNoticeKey('lark', 'group|thread:u'));
  assert.notEqual(statusNoticeKey('lark', 'ep'), statusNoticeKey('other', 'ep'));
});

test('claim is atomic suppression, success cooldown starts at confirmed completion', t => {
  const { db, input } = fixture(t);
  const claim = claimStatusNotice(input, db);
  assert.equal(claim.suppressed, false);
  assert.equal(claimStatusNotice({ ...input, attemptId: 'b' }, db).reason, 'claimed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM status_notice_cooldowns').get().n, 0);
  assert.equal(startStatusNotice(claim, 101, db), true);
  assert.equal(finishStatusNotice(claim, 'sent', { now: 120, health: 'rate_limited', reason: 'rate' }, db), true);
  assert.equal(db.prepare('SELECT expires_at FROM status_notice_cooldowns').get().expires_at, 720);
  assert.equal(claimStatusNotice({ ...input, attemptId: 'b', now: 719 }, db).reason, 'cooldown');
  assert.equal(claimStatusNotice({ ...input, attemptId: 'c', now: 720 }, db).suppressed, false);
});

test('definite failure releases claim; old completion cannot corrupt its replacement', t => {
  const { db, input } = fixture(t);
  const first = claimStatusNotice(input, db);
  finishStatusNotice(first, 'failed', { now: 101 }, db);
  const next = claimStatusNotice({ ...input, attemptId: 'b', now: 102 }, db);
  assert.equal(next.suppressed, false);
  assert.equal(finishStatusNotice(first, 'sent', { now: 103 }, db), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM status_notice_cooldowns').get().n, 0);
});

test('pre-send crash can recover but sending crash stays uncertain without blind retry', t => {
  const { db, input } = fixture(t);
  const first = claimStatusNotice(input, db);
  const next = claimStatusNotice({ ...input, attemptId: 'b', now: 161 }, db);
  assert.equal(next.suppressed, false);
  assert.equal(startStatusNotice(first, 162, db), false);
  assert.equal(startStatusNotice(next, 162, db), true);
  assert.equal(claimStatusNotice({ ...input, attemptId: 'c', now: 222 }, db).reason, 'uncertain');
  assert.equal(claimStatusNotice({ ...input, attemptId: 'd', now: 10000 }, db).reason, 'uncertain');
  assert.equal(claimStatusNotice({ ...input, attemptId: 'e', episode: 'verified-new-episode', now: 10001 }, db).suppressed, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM status_notice_cooldowns').get().n, 0);
});

test('explicit uncertain completion never starts success cooldown or auto-retries', t => {
  const { db, input } = fixture(t);
  const claim = claimStatusNotice(input, db);
  startStatusNotice(claim, 101, db);
  finishStatusNotice(claim, 'uncertain', { now: 102 }, db);
  assert.equal(claimStatusNotice({ ...input, now: 1000 }, db).reason, 'uncertain');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM status_notice_cooldowns').get().n, 0);
});

test('templates do not promise automatic recovery or an invented reset time', () => {
  for (const health of ['rate_limited', 'auth_failed', 'unavailable']) {
    const message = messageForStatus({ health });
    assert.match(message, /未进入处理队列/);
    assert.doesNotMatch(message, /within an hour|automatically|administrator has|should be back/);
  }
});
