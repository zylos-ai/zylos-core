import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { freezeFirstFailureNotice, processFirstFailureNotices } from '../first-failure-notice.js';
import { reserveStatusNoticeCooldown } from '../c4-db.js';
import { reserveStatusNotice } from '../status-notice.js';
import { HealthStore } from '../../../activity-monitor/scripts/health-store.js';

const hookHealth = (await getRuntime('claude')).health.hookHealth;

const identity = { runtime:'claude', session_id:'session', claude_pid:123 };
const event = { schema_version:1, source:'hook', ...identity,
  event_id:'11111111-1111-1111-1111-111111111111', prompt_id:'prompt',
  event:'stop_failure', error:'rate_limit', received_at:100000 };

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
test('multi origin never selects legacy or another group', t => {
  const f=fixture(t,'origin');
  inbound(f.db,1,{sessionGroup:''});inbound(f.db,2,{sessionGroup:'fake:other'});
  assert.equal(consume(f.store),undefined);
});
