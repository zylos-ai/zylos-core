import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { freezeFirstFailureNotice, processFirstFailureNotices, sendNoticeWorker } from '../first-failure-notice.js';
import { reserveStatusNoticeCooldown } from '../c4-db.js';
import { reserveStatusNotice } from '../status-notice.js';
import { messageForStatus } from '../status-notice-templates.js';
import { HealthStore } from '../../../activity-monitor/scripts/health-store.js';

const hookHealth = (await getRuntime('claude')).health.hookHealth;

const identity = { runtime:'claude', session_id:'session', claude_pid:123 };
const event = { schema_version:1, source:'hook', ...identity,
  event_id:'11111111-1111-1111-1111-111111111111', prompt_id:'prompt',
  event:'stop_failure', error:'rate_limit', received_at:100000 };

test('single mode real first-failure reservation and sender preserve the grouped target scope', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'first-notice-integration-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sender=path.join(root,'.claude/skills/fake/scripts');
  fs.mkdirSync(sender,{recursive:true});
  const capture=path.join(root,'capture.json');
  fs.writeFileSync(path.join(sender,'send.js'),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),body:fs.readFileSync(0,'utf8')}));`);
  const code=`import {getDb,close} from ${JSON.stringify(new URL('../c4-db.js',import.meta.url).href)};
    import {freezeFirstFailureNotice,processFirstFailureNotices} from ${JSON.stringify(new URL('../first-failure-notice.js',import.meta.url).href)};
    import {HealthStore} from ${JSON.stringify(new URL('../../../activity-monitor/scripts/health-store.js',import.meta.url).href)};
    const database=getDb(),identity=${JSON.stringify(identity)};
    database.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','fake','room','request','delivered','fake:review')").run();
    const store=new HealthStore({zylosDir:process.env.ZYLOS_DIR,now:()=>100000,freezeNotice:options=>freezeFirstFailureNotice(database,{...options,sessionGroup:null})});
    store.consume(${JSON.stringify(event)},{hookHealth:${JSON.stringify(hookHealth)},identity});
    await processFirstFailureNotices({store,database,identity:()=>identity,zylosDir:process.env.ZYLOS_DIR});
    console.log(JSON.stringify({outcome:store.read().last_notice_outcome.status,rows:database.prepare('SELECT cooldown_key FROM status_notice_cooldowns').all()}));close();`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,ZYLOS_DIR:root},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout.trim());
  assert.equal(output.outcome,'sent');
  assert.match(output.rows[0].cooldown_key,/fake:review/);
  assert.match(output.rows[0].cooldown_key,/claude/);
  const sent=JSON.parse(fs.readFileSync(capture,'utf8'));
  assert.equal(sent.args[0],'room');
  assert.doesNotMatch(sent.args.join(' ')+sent.body,/--session-group/);
});

for (const mode of ['sent','sender-signal','worker-killed','spawn-error']) {
  test('worker diagnostic is recorded once for '+mode, async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-notice-log-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const spawnWorker=()=>{
      const child=new EventEmitter();child.pid=mode==='spawn-error'?undefined:123;
      child.stdout=new EventEmitter();child.stdin=new EventEmitter();
      child.stdin.end=()=>queueMicrotask(()=>{
        if(mode==='spawn-error') child.emit('error',Object.assign(new Error('spawn'),{code:'ENOENT'}));
        if(mode==='sent') child.stdout.emit('data',JSON.stringify({outcome:'sent',exitCode:0,signal:null}));
        if(mode==='sender-signal') child.stdout.emit('data',JSON.stringify({outcome:'uncertain',exitCode:null,signal:'SIGTERM'}));
        child.emit('close',mode==='worker-killed'?null:mode==='spawn-error'?-2:0,mode==='worker-killed'?'SIGKILL':null);
      });
      return child;
    };
    const result=await sendNoticeWorker({channel:'fake',endpoint:'group|msg:1'},'notice',
      {health:'rate_limited',reason:'rate_limit',noticeKind:'first-failure'},{zylosDir:root,spawnWorker});
    const rows=fs.readFileSync(path.join(root,'activity-monitor/status-notices.log'),'utf8').trim().split('\n');
    assert.equal(rows.length,1);
    const row=JSON.parse(rows[0]);
    assert.equal(row.outcome,result.outcome);assert.equal(row.kind,'first-failure');
    assert.equal(row.endpoint,'group');
    if(mode==='worker-killed') {assert.equal(row.outcome,'uncertain');assert.equal(row.workerSignal,'SIGKILL');assert.equal(row.signal,null);}
    if(mode==='sender-signal') {assert.equal(row.signal,'SIGTERM');assert.equal(row.workerSignal,null);assert.equal(row.workerExitCode,0);}
    if(mode==='sent') {assert.equal(row.exitCode,0);assert.equal(row.workerExitCode,0);}
    if(mode==='spawn-error') assert.equal(row.outcome,'failed');
  });
}
function fixture(t, sessionGroup = 'fake', now = 100000) {
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR,'.claude','skills','fake'),{recursive:true});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-notice-file-'));
  const db = new Database(':memory:'); guardDatabase(db,schema);
  t.after(() => { db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const store = new HealthStore({zylosDir:root,now:()=>now,
    freezeNotice: options => freezeFirstFailureNotice(db,{...options,sessionGroup})});
  return {root,db,store};
}
function inbound(db,id,{status='delivered',channel='fake',endpoint='group|thread:t|msg:'+id,sessionGroup='fake'}={}) {
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES (?,'in',?,?,'private request',?,?)")
    .run(id,channel,endpoint,status,sessionGroup);
}
function consume(store) {
  assert.equal(store.consume(event,{hookHealth, identity}).status,'processed');
  return store.read().pending_notice;
}
function options(f,{now=100100,scope=identity,sent=[],outcome='sent',quota=()=>null,...extra}={}) {
  return {store:f.store,database:f.db,identity:()=>scope,now:()=>now,quota,
    reserve(channel,endpoint,route) {
      return reserveStatusNotice(channel,endpoint,route,{reserve:input=>reserveStatusNoticeCooldown({...input,now:Math.floor(now/1000)},f.db)});
    },
    async send(claim,message,route) {sent.push({claim,message,route});return {outcome};}, ...extra};
}
test('health and latest target commit together; failed intake excluded and target frozen', async t => {
  const f=fixture(t);
  inbound(f.db,1);inbound(f.db,2);inbound(f.db,3,{status:'failed'});
  const intent=consume(f.store);
  assert.equal(intent.conversation_id,2);
  assert.equal(f.store.read().health,'rate_limited');
  assert.equal(f.store.read().last_processed.event_id,event.event_id);
  assert.doesNotMatch(fs.readFileSync(f.store.file,'utf8'),/private request/);
  inbound(f.db,4);
  const sent=[];await processFirstFailureNotices(options(f,{sent}));
  assert.equal(sent.length,1);assert.equal(sent[0].claim.endpoint,intent.endpoint);
  assert.equal(sent[0].route.noticeKind,'first-failure');
  assert.equal(sent[0].route.sessionGroup,'fake');
  assert.equal(sent[0].route.runtime,'claude');
  assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'sent');
});
test('no eligible inbound, no reply endpoint, and control channel create no target', t => {
  const f=fixture(t);
  inbound(f.db,1,{status:'failed'});inbound(f.db,2,{endpoint:null});
  inbound(f.db,3,{channel:'control'});inbound(f.db,4,{status:'pending'});
  assert.equal(consume(f.store),undefined);
});
for (const group of ['fake:review', '']) test('single mode sends latest eligible '+(group?'grouped':'legacy')+' inbound', async t => {
  const f=fixture(t,null);
  inbound(f.db,1,{sessionGroup:'fake:older'});
  inbound(f.db,2,{sessionGroup:group});
  for (const [index,channel] of ['void','system','internal','control','scheduler'].entries()) {
    inbound(f.db,3+index,{channel,sessionGroup:group});
  }
  inbound(f.db,8,{status:'failed',sessionGroup:group});
  inbound(f.db,9,{endpoint:'',sessionGroup:group});
  assert.equal(consume(f.store).conversation_id,2);
  const sent=[];await processFirstFailureNotices(options(f,{sent}));
  assert.equal(sent.length,1);
  assert.equal(sent[0].claim.endpoint,'group|thread:t|msg:2');
  assert.equal(sent[0].route.sessionGroup,group || 'origin');
  assert.equal(f.db.prepare('SELECT session_group FROM conversations WHERE id=2').get().session_group,group);
  assert.equal(f.store.read().last_notice_outcome.status,'sent');
});
test('multi origin never selects legacy or another group', t => {
  const f=fixture(t,'origin');
  inbound(f.db,1,{sessionGroup:''});inbound(f.db,2,{sessionGroup:'fake:other'});
  assert.equal(consume(f.store),undefined);
});
test('running target sends immediately without retargeting a newer message', async t => {
  const f=fixture(t);inbound(f.db,1,{status:'running'});consume(f.store);
  inbound(f.db,2);
  const sent=[];await processFirstFailureNotices(options(f,{sent}));
  assert.equal(sent.length,1);assert.match(sent[0].claim.endpoint,/msg:1$/);
});
for (const status of ['pending','failed']) test('ineligible target '+status+' cannot send', async t => {
  const f=fixture(t);inbound(f.db,1,{status:'running'});consume(f.store);
  f.db.prepare('UPDATE conversations SET status=? WHERE id=1').run(status);
  const sent=[];await processFirstFailureNotices(options(f,{sent,now:161001}));
  assert.equal(sent.length,0);assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'suppressed');
});
test('changed process identity cancels frozen notice', async t => {
  const f=fixture(t);inbound(f.db,1);consume(f.store);
  const sent=[];await processFirstFailureNotices(options(f,{sent,scope:{...identity,claude_pid:124}}));
  assert.equal(sent.length,0);assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'stale');
});
test('inbound and first-failure share per-reason cooldown', async t => {
  const f=fixture(t);inbound(f.db,1);const intent=consume(f.store);
  const sent=[];const op=options(f,{sent});
  op.reserve('fake','group|thread:t|msg:new',{health:intent.health,reason:intent.reason,sessionGroup:'fake',runtime:'claude'});
  await processFirstFailureNotices(op);
  assert.equal(sent.length,0);assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'suppressed');
  assert.equal(op.reserve('fake',intent.endpoint,{health:'auth_failed',reason:'authentication_failed',sessionGroup:'fake',runtime:'claude'}).suppressed,false);
});
test('late matching quota enriches reply inside bounded wait', async t => {
  const f=fixture(t);inbound(f.db,1);consume(f.store);
  const sent=[];
  await processFirstFailureNotices(options(f,{sent,quotaWaitMs:750}));
  assert.equal(sent.length,0);
  const quota={schema_version:1,source:'statusline',...identity,observed_at:100336,
    rate_limits:{five_hour:{used_percentage:100,resets_at:1000}}};
  await processFirstFailureNotices(options(f,{sent,now:100400,quota:()=>quota,quotaWaitMs:750}));
  assert.equal(sent.length,1);assert.equal(sent[0].route.noticeCode,'quota_exhausted_reset');
  assert.equal(sent[0].route.resetAt,1000000);
});
test('missing quota sends neutral reply after bounded wait', async t => {
  const f=fixture(t);inbound(f.db,1);consume(f.store);
  const sent=[];await processFirstFailureNotices(options(f,{sent,now:100751,quotaWaitMs:750}));
  assert.equal(sent.length,1);assert.notEqual(sent[0].route.noticeCode,'quota_exhausted_reset');
});
test('restart with sending, sent or uncertain intent never resends after cooldown', async t => {
  for (const status of ['sending','sent','uncertain']) {
    const f=fixture(t);inbound(f.db,1);consume(f.store);
    f.store.updatePending(event.event_id,{status});
    f.store=new HealthStore({zylosDir:f.root});
    const sent=[];await processFirstFailureNotices(options(f,{sent,now:10000000}));
    assert.equal(sent.length,0);
  }
});
test('sender exception retains cooldown and records uncertain result', async t => {
  const f=fixture(t);inbound(f.db,1);consume(f.store);
  await processFirstFailureNotices(options(f,{send:async()=>{throw Error('timeout');}}));
  assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'uncertain');
  assert.equal(f.db.prepare('SELECT count(*) n FROM status_notice_cooldowns').get().n,1);
});

for (const boundary of ['identity-changed','intent-changed','send-failed']) {
  test('definite first-failure cancellation clears reservation: '+boundary,async t=>{
    const f=fixture(t);inbound(f.db,1);consume(f.store);
    const sent=[];
    const op=options(f,{sent,outcome:'failed'});
    if(boundary==='identity-changed') {
      let reads=0;
      op.identity=()=>++reads===1?identity:{...identity,claude_pid:124};
    }
    if(boundary==='intent-changed') {
      const update=f.store.updatePending.bind(f.store);
      f.store.updatePending=(id,patch)=>patch.status==='sending'?false:update(id,patch);
    }
    await processFirstFailureNotices(op);
    assert.equal(sent.length,boundary==='send-failed'?1:0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM status_notice_cooldowns').get().n,0);
  });
}
test('grouped failure freezes its own message and publishes notice updates through runtime serialization',async t=>{
  const f=fixture(t);f.store.freezeNotice=input=>freezeFirstFailureNotice(f.db,input);
  inbound(f.db,1);inbound(f.db,2);f.db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run('telegram:a',1);f.db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run('telegram:b',2);
  const result=f.store.consume(event,{hookHealth, identity,sessionGroup:'telegram:a'});assert.equal(result.status,'processed');
  const intent=f.store.read('telegram:a').pending_notice;assert.equal(intent.conversation_id,1);assert.equal(intent.session_group,'telegram:a');assert.equal(f.store.read('telegram:b').pending_notice,undefined);
  let mutations=0;const sent=[];const opts=options(f,{sent});const reserve=opts.reserve;
  await processFirstFailureNotices({...opts,identity:async()=>identity,sessionGroup:'telegram:a',mutate:async fn=>{mutations++;return fn();},reserve:(channel,endpoint,route)=>{assert.equal(route.sessionGroup,'telegram:a');assert.equal(route.runtime,'claude');return reserve(channel,endpoint,route);}});
  assert.equal(sent.length,1);assert.equal(mutations,2);assert.equal(f.store.read('telegram:a').last_notice_outcome.status,'sent');
});


function internalFailure(t, { externalAge = 600, receipt = false } = {}) {
  const group = 'telegram:work';
  const original = '-100|thread:work|msg:1';
  const sender = 'telegram:sender';
  const failure = { ...event, received_at: 1800000000000 };
  const f = fixture(t, group, failure.received_at);
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR,'.claude','skills','telegram'),{recursive:true});
  const request = f.db.prepare(`
    INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group,timestamp,session_id,delivery_action)
    VALUES ('in',?,?,'request',?,?,datetime(?,'unixepoch'),?,?)
  `);
  const receive = (channel, endpoint, { status = 'delivered', sessionGroup = group, age = 0, session = null, action = null } = {}) =>
    Number(request.run(channel, endpoint, status, sessionGroup, failure.received_at / 1000 - age, session, action).lastInsertRowid);
  receive('telegram', original, { age: externalAge, session: 'earlier-session' });
  const receiveInternal = () => receive('internal', sender, {
    session: identity.session_id, action: receipt ? 'failure_receipt' : null,
  });
  const stop = internalId => {
    assert.equal(f.store.consume(failure,{hookHealth, identity,sessionGroup:group}).status,'processed');
    const pending = f.store.read(group).pending_notice;
    assert.equal(pending.conversation_id,internalId);
    assert.equal(pending.channel,'internal');
    assert.equal(pending.endpoint,sender);
  };
  const replies = () => f.db.prepare(`
    SELECT id, endpoint_id, content, status, delivery_action FROM conversations
    WHERE direction='in' AND channel='internal' AND session_group=?
  `).all(sender);
  const sent = [];
  const op = options(f,{ sent, now:failure.received_at+100, sessionGroup:group });
  return { ...f, group, original, sender, receive, receiveInternal, stop, replies, sent, op };
}

test('Internal failure queues a receipt before notifying the earlier unanswered Telegram request', async t => {
  const f = internalFailure(t);
  f.db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group)
    VALUES ('out','internal','telegram:peer','internal handoff','delivered',?)`).run(f.group);
  f.receive('telegram','-200|msg:1',{status:'failed'});
  const internalId = f.receiveInternal();
  f.receive('telegram','-100|thread:work|msg:2',{status:'pending'});
  f.stop(internalId);
  assert.deepEqual(f.replies(),[]);
  // A new delivery during the wait must not become the recipient.
  f.receive('telegram','-100|thread:work|msg:3');
  f.db.prepare(`INSERT INTO conversations(direction,channel,content,status,session_group)
    VALUES ('out','telegram','other group reply','delivered','telegram:other')`).run();
  const send = f.op.send;
  let receiptsAtSend;
  f.op.send = async (claim,message,route) => {
    receiptsAtSend = f.replies().length;
    return send(claim,message,route);
  };
  assert.equal(await processFirstFailureNotices(f.op),1);
  assert.equal(receiptsAtSend,1);
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].claim.endpoint,f.original);
  assert.deepEqual(f.replies().map(({id,...row})=>row),[{
    endpoint_id:f.group,content:f.sent[0].message,status:'pending',delivery_action:'failure_receipt',
  }]);
  assert.deepEqual(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(f.sender),{head_id:f.replies()[0].id});
  assert.equal(await processFirstFailureNotices(f.op),0);
});

test('newer outbound notice for another address in the group suppresses the Telegram fallback', async t => {
  const f = internalFailure(t);
  f.stop(f.receiveInternal());
  f.db.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group,delivery_action)
    VALUES ('out','telegram','-200','prior notice','delivered',?,'system_notice')`).run(f.group);
  await processFirstFailureNotices(f.op);
  assert.equal(f.replies().length,1);
  assert.deepEqual(f.sent,[]);
});

test('an Internal failure only queues a receipt when the external request is older than 30 minutes', async t => {
  const f = internalFailure(t,{ externalAge:2400 });
  f.stop(f.receiveInternal());
  await processFirstFailureNotices(f.op);
  assert.equal(f.replies().length,1);
  assert.deepEqual(f.sent,[]);
});

test('failure while processing a receipt never queues another receipt and still checks the Telegram request', async t => {
  const f = internalFailure(t,{ receipt:true });
  f.stop(f.receiveInternal());
  await processFirstFailureNotices(f.op);
  assert.deepEqual(f.replies(),[]);
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].claim.endpoint,f.original);
});

for (const suppressedChannel of ['internal','telegram']) {
  test('the ' + suppressedChannel + ' cooldown only suppresses its own route', async t => {
    const f = internalFailure(t);
    f.stop(f.receiveInternal());
    const intent = f.store.read(f.group).pending_notice;
    const route = { sessionGroup:f.group, runtime:intent.runtime, health:intent.health, reason:intent.reason };
    // Use a different reply address for the same Telegram thread to exercise endpoint normalization.
    f.op.reserve(suppressedChannel,suppressedChannel==='internal' ? f.sender : '-100|thread:work|msg:previous',route);
    await processFirstFailureNotices(f.op);
    assert.equal(f.replies().length,suppressedChannel==='internal'?0:1);
    assert.equal(f.sent.length,suppressedChannel==='telegram'?0:1);
    if (suppressedChannel==='telegram') {
      assert.equal(f.replies()[0].content,messageForStatus({ ...route, context:'failure' }));
    }
  });
}
