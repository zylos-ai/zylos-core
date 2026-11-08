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

test('scoped status notice forwards a local group without changing component argv', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-group-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, '.claude/skills/fake/scripts');
  fs.mkdirSync(channel, { recursive: true });
  const marker = path.join(root, 'sent.json');
  fs.writeFileSync(path.join(channel, 'send.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)))`);
  const code = `
    import * as db from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
    import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(new URL('../status-notice.js', import.meta.url).href)};
    db.insertConversation('in','fake','room','old',{groupName:'wanted'});
    db.insertConversation('in','fake','room','new',{groupName:'other'});
    const route={sessionGroup:'fake:wanted',runtime:'claude'};
    const result=await sendStatusNotice(reserveStatusNotice('fake','room',route),'notice',route,{diagnostic:false});
    const row=db.getDb().prepare("SELECT session_group FROM conversations WHERE direction='out'").get();
    console.log(JSON.stringify({result,row}));db.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.trim());
  assert.equal(data.result.outcome, 'sent');
  assert.equal(data.row.session_group, 'fake:wanted');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), ['room', 'notice']);
});

test('invalid sender channel is rejected before opening any database or spawning', async () => {
  for (const channel of ['../outside', '--stdin', undefined]) {
    assert.throws(() => reserveStatusNotice(channel, 'endpoint'), /Invalid/);
    await assert.rejects(sendStatusNotice({ channel, endpoint: 'endpoint' }, 'message', {}, {
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

// Covers notice child outcomes and reservation ownership. Run for notice transport
// changes; unrelated routing/display changes may skip. All child paths are private.
for (const mode of ['timeout', 'killed', 'nonzero', 'spawn-missing', 'spawn-denied', 'missing', 'throw', 'crash']) {
  test(`sender ${mode} persists the correct retry boundary`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-process-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const channel = path.join(root, '.claude/skills/fake/scripts');
    fs.mkdirSync(channel, { recursive: true });
    const marker = path.join(root, 'sent');
    if (mode !== 'missing') fs.writeFileSync(path.join(channel, 'send.js'), 'process.exit(0);');
    const childCode = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'once');
      ${mode === 'killed' ? "process.kill(process.pid,'SIGKILL');" : mode === 'nonzero' ? 'process.exit(7);' : 'setInterval(() => {}, 1000);setTimeout(()=>process.exit(0),3500);'}`;
    const spawnBody = mode === 'crash' ? "process.kill(process.pid,'SIGKILL');"
      : mode === 'throw' ? "throw Error('injected');"
      : mode === 'spawn-denied' ? "throw Object.assign(Error('denied'), {code:'EACCES'});"
      : mode === 'spawn-missing' ? "return spawn('/missing-notice-executable',[],options);"
      : `return spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],options);`;
    const code = `import {spawn} from 'node:child_process';
      import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(new URL('../status-notice.js', import.meta.url).href)};
      import {close} from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
      const claim=reserveStatusNotice('fake','group',{sessionGroup:'fake',runtime:'claude'});
      let ticked=false; const timer=setTimeout(()=>{ticked=true;},10);
      const result=await sendStatusNotice(claim,'notice',{}, {timeoutMs:500,spawn:(cmd,args,options)=>{${spawnBody}}});
      clearTimeout(timer);console.log(JSON.stringify({result,ticked}));close();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
    });
    const failed = ['missing', 'spawn-missing', 'spawn-denied'].includes(mode);
    if (mode === 'crash') assert.equal(result.signal, 'SIGKILL');
    else {
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout.trim());
      assert.equal(output.result.outcome, failed ? 'failed' : 'uncertain');
      assert.equal(output.result.code, mode === 'missing' ? 'NOTICE_SEND_UNAVAILABLE' : `NOTICE_SEND_${failed ? 'FAILED' : 'UNCERTAIN'}`);
      if (mode === 'timeout' || mode === 'killed') assert.equal(output.result.signal, 'SIGKILL');
      if (mode === 'nonzero') assert.equal(output.result.exitCode, 7);
      if (mode === 'timeout') assert.equal(output.ticked, true, 'event-loop timer runs while the sender is pending');
    }
    if (mode === 'timeout') assert.equal(fs.readFileSync(marker, 'utf8'), 'once');
    if (mode !== 'crash') {
      const lines = fs.readFileSync(path.join(root, 'activity-monitor/status-notices.log'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const diagnostic = JSON.parse(lines[0]);
      assert.equal(diagnostic.kind, 'inbound');
      assert.equal(diagnostic.endpoint, 'group');
      assert.equal(diagnostic.outcome, failed ? 'failed' : 'uncertain');
      assert.ok(Object.hasOwn(diagnostic, 'exitCode'));
      assert.ok(Object.hasOwn(diagnostic, 'signal'));
    }
    const db = new Database(path.join(root, 'comm-bridge/c4.db'));
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM status_notice_cooldowns').get().n, failed ? 0 : 1);
      const row = db.prepare('SELECT * FROM status_notice_cooldowns').get();
      const input = { cooldownKey: statusNoticeKey('fake','group','unavailable','unavailable','fake','claude'),
        channel: 'fake', endpoint: 'group', statusType:'unavailable',reason:'unavailable',ttl:600,
        now: row ? row.expires_at - 1 : Math.floor(Date.now() / 1000) };
      assert.equal(reserveStatusNoticeCooldown(input, db).suppressed, !failed);
      if (!failed) assert.equal(reserveStatusNoticeCooldown({ ...input, now: row.expires_at }, db).suppressed, false);
    } finally { db.close(); }
  });
}

// Covers bounded pipe collection without changing the child outcome. This uses a
// real child but substitutes only its fixture program, never product source.
test('notice diagnostics drain both pipes and retain bounded output prefixes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, '.claude/skills/fake/scripts');
  fs.mkdirSync(channel, { recursive: true });
  fs.writeFileSync(path.join(channel, 'send.js'), 'process.exit(0);');
  const code = `import {spawn} from 'node:child_process';
    import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(new URL('../status-notice.js', import.meta.url).href)};
    import {close} from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
    const childCode="process.stdout.write('o'.repeat(100000));process.stderr.write('e'.repeat(100000));";
    const result=await sendStatusNotice(reserveStatusNotice('fake','room',{sessionGroup:'fake',runtime:'claude'}),'notice',{}, {
      spawn:(cmd,args,options)=>spawn(process.execPath,['-e',childCode],options)});
    console.log(JSON.stringify(result));close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).outcome, 'sent');
  const diagnostic = JSON.parse(fs.readFileSync(path.join(root, 'activity-monitor/status-notices.log'), 'utf8'));
  assert.equal(diagnostic.stdout, 'o'.repeat(8192));
  assert.equal(diagnostic.stderr, 'e'.repeat(8192));
});

// Covers a sender that closes stdin before reading the notice. The host must not
// crash on the write error, and the unread notice stays uncertain as before.
test('notice sender closing stdin early is uncertain without crashing the host', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-stdin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, '.claude/skills/fake/scripts');
  fs.mkdirSync(channel, { recursive: true });
  fs.writeFileSync(path.join(channel, 'send.js'), 'process.exit(0);');
  const code = `import {spawn} from 'node:child_process';
    import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(new URL('../status-notice.js', import.meta.url).href)};
    import {close} from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
    const childCode="process.stdin.destroy();setTimeout(()=>process.exit(0),300);";
    const result=await sendStatusNotice(reserveStatusNotice('fake','room',{sessionGroup:'fake',runtime:'claude'}),'x'.repeat(1<<20),{}, {
      timeoutMs:3000,spawn:(cmd,args,options)=>spawn(process.execPath,['-e',childCode],options)});
    console.log(JSON.stringify(result));close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.outcome, 'uncertain');
  assert.equal(output.exitCode, 0);
});

// Covers timeout settlement when a descendant retains inherited pipe writers.
// The test owns and kills that descendant; the product kills only its direct child.
for (const directExit of ['running', 'zero']) test(`notice timeout settles with a ${directExit} sender and inherited output pipes`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-pipes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, '.claude/skills/fake/scripts');
  fs.mkdirSync(channel, { recursive: true });
  fs.writeFileSync(path.join(channel, 'send.js'), 'process.exit(0);');
  const pidFile = path.join(root, 'descendant.pid');
  const descendantCode = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),3500);`;
  const parentCode = `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(descendantCode)}],{stdio:'inherit'});
    ${directExit === 'zero' ? 'child.unref();process.exit(0);' : 'setInterval(()=>{},1000);setTimeout(()=>process.exit(0),3500);'}`;
  const code = `import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';
    import {reserveStatusNotice,sendStatusNotice} from ${JSON.stringify(new URL('../status-notice.js', import.meta.url).href)};
    import {close} from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
    let pending; const start=performance.now();
    try {
      pending=sendStatusNotice(reserveStatusNotice('fake','room',{sessionGroup:'fake',runtime:'claude'}),'notice',{}, {
        timeoutMs:500,spawn:(cmd,args,options)=>spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(parentCode)}],options)});
      const result=await pending;
      assert.equal(result.outcome,'uncertain');
      assert.equal(result.signal,${directExit === 'zero' ? 'null' : "'SIGKILL'"});
      assert.equal(result.exitCode,${directExit === 'zero' ? '0' : 'null'});
      assert.ok(performance.now()-start<2000,'does not wait for descendant pipe closure');
      const pid=Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8'));
      process.kill(pid,0);console.log(JSON.stringify(result));
    } finally {
      if(fs.existsSync(${JSON.stringify(pidFile)})) {try{process.kill(Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8')),'SIGKILL');}catch{}}
      await pending;close();
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  // Also reclaim on a failure before the inner finally can execute.
  if (fs.existsSync(pidFile)) {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'uncertain');
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
    console.log(JSON.stringify(await sendStatusNotice(claim,'broadcast notice',{}, {diagnostic:false})));close();`;
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
