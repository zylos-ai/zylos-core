import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { freezeFirstFailureNotice, processFirstFailureNotices, sendNoticeWorker } from '../first-failure-notice.js';
import { claimStatusNotice } from '../c4-db.js';
import { statusNoticeKey, normalizeStatusEndpoint } from '../status-notice.js';
import { HealthStore } from '../../../activity-monitor/scripts/health-store.js';

const identity = { runtime:'claude', session_id:'session', claude_pid:123 };
const event = { schema_version:1, source:'hook', ...identity,
  event_id:'11111111-1111-1111-1111-111111111111', prompt_id:'prompt',
  event:'stop_failure', error:'rate_limit', received_at:100000 };

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
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-notice-file-'));
  const db = new Database(':memory:'); guardDatabase(db,schema);
  t.after(() => { db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const store = new HealthStore({zylosDir:root,now:()=>100000,
    freezeNotice: options => freezeFirstFailureNotice(db,{...options,sessionGroup:null})});
  return {root,db,store};
}
function inbound(db,id,{status='delivered',channel='fake',endpoint='group|thread:t|msg:'+id}={}) {
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (?,'in',?,?,'private request',?)")
    .run(id,channel,endpoint,status);
}
function consume(store) {
  assert.equal(store.consume(event,{identity}).status,'processed');
  return store.read().pending_notice;
}
function options(f,{now=100100,scope=identity,sent=[],outcome='sent',quota=()=>null,...extra}={}) {
  return {store:f.store,database:f.db,identity:()=>scope,now:()=>now,quota,
    reserve(channel,endpoint,route) {
      return claimStatusNotice({key:statusNoticeKey(channel,endpoint,route.health,route.reason),
        health:route.health,reason:route.reason,channel,endpoint,normalizedEndpoint:normalizeStatusEndpoint(endpoint),now:Math.floor(now/1000)},f.db);
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
  assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'sent');
});
test('no eligible inbound, no reply endpoint, and control channel create no target', t => {
  const f=fixture(t);
  inbound(f.db,1,{status:'failed'});inbound(f.db,2,{endpoint:null});
  inbound(f.db,3,{channel:'control'});inbound(f.db,4,{status:'pending'});
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
  op.reserve('fake','group|thread:t|msg:new',{health:intent.health,reason:intent.reason});
  await processFirstFailureNotices(op);
  assert.equal(sent.length,0);assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'suppressed');
  assert.equal(op.reserve('fake',intent.endpoint,{health:'auth_failed',reason:'authentication_failed'}).suppressed,false);
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

test('T02 grouped failure freezes its own message and publishes notice updates through runtime serialization',async t=>{
  const f=fixture(t);f.store.freezeNotice=input=>freezeFirstFailureNotice(f.db,input);
  inbound(f.db,1);inbound(f.db,2);f.db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run('telegram:a',1);f.db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run('telegram:b',2);
  const result=f.store.consume(event,{identity,sessionGroup:'telegram:a'});assert.equal(result.status,'processed');
  const intent=f.store.read('telegram:a').pending_notice;assert.equal(intent.conversation_id,1);assert.equal(intent.session_group,'telegram:a');assert.equal(f.store.read('telegram:b').pending_notice,undefined);
  let mutations=0;const sent=[];const opts=options(f,{sent});const reserve=opts.reserve;
  await processFirstFailureNotices({...opts,identity:async()=>identity,sessionGroup:'telegram:a',mutate:async fn=>{mutations++;return fn();},reserve:(channel,endpoint,route)=>{assert.equal(route.sessionGroup,'telegram:a');assert.equal(route.runtime,'claude');return reserve(channel,endpoint,route);}});
  assert.equal(sent.length,1);assert.equal(mutations,2);assert.equal(f.store.read('telegram:a').last_notice_outcome.status,'sent');
});
