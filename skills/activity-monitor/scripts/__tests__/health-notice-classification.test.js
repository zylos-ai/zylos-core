import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../comm-bridge/node_modules/better-sqlite3/lib/index.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { freezeFirstFailureNotice } from '../../../comm-bridge/scripts/first-failure-notice.js';
import { classifyHealthNotice } from '../health-notice-classification.js';
import { matchHealthNoticeText } from '../health-notice-match.js';
import { HealthStore } from '../health-store.js';
import { MessageRouter } from '../message-router.js';
import { buildStatusPayload } from '../status-writer.js';
import { messageForStatus } from '../../../comm-bridge/scripts/status-notice-templates.js';

const now = Date.now();
const identity = { runtime:'claude', session_id:'session', claude_pid:123 };
const base = { ...identity, schema_version:1, source:'hook', event_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  event:'stop_failure', prompt_id:'prompt', error:'rate_limit', received_at:now };
const snapshot = windows => ({ ...identity, schema_version:1, source:'statusline', observed_at:now-1000, rate_limits:windows });
const reset1 = Math.floor(now/1000)+3600;
const reset2 = reset1+3600;
function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'notice-classification-'));
  const db=new Database(':memory:');guardDatabase(db,schema);
  t.after(()=>{db.close();fs.rmSync(zylosDir,{recursive:true,force:true});});
  db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','group','test','delivered')").run();
  return new HealthStore({zylosDir,now:()=>now,freezeNotice:input=>freezeFirstFailureNotice(db,{...input,sessionGroup:null})});
}

test('verified exhausted windows outrank model prose, and both full windows use later reset', () => {
  const event = { ...base, notice_match:{sourceId:1,kind:'model_quota'}, quota:snapshot({
    five_hour:{used_percentage:100,resets_at:reset1}, seven_day:{used_percentage:100,resets_at:reset2},
  }) };
  const result = classifyHealthNotice(event,now);
  assert.equal(result.noticeCode,'quota_exhausted_reset');
  assert.equal(result.resetAt,reset2*1000);
  event.quota.rate_limits.seven_day = {used_percentage:100};
  assert.equal(classifyHealthNotice(event,now).noticeCode,'quota_exhausted');
});

test('expired, foreign and stale quota cannot invent exhaustion or reset time', () => {
  for (const override of [{observed_at:now-60001},{session_id:'foreign'},{claude_pid:999},{observed_at:now+1}]) {
    const result = classifyHealthNotice({...base,quota:{...snapshot({five_hour:{used_percentage:100,resets_at:reset1}}),...override}},now);
    assert.equal(result.noticeCode,'rate_limited'); assert.equal(result.resetAt,null);
  }
  const result=classifyHealthNotice({...base,quota:snapshot({five_hour:{used_percentage:100,resets_at:reset1}})},reset1*1000+1);
  assert.equal(result.noticeCode,'rate_limited');
});

test('legacy process-start differences do not override matching PID and session quota',()=>{
  const result=classifyHealthNotice({...base,process_start:'new-ignored',quota:{
    ...snapshot({five_hour:{used_percentage:100,resets_at:reset1}}),process_start:'old-ignored'}},now);
  assert.equal(result.noticeCode,'quota_exhausted_reset');assert.equal(result.resetAt,reset1*1000);
});

test('trusted full windows precede negative text; without proof terminal failures remain neutral', () => {
  for (const text of ['API Error: Server is temporarily limiting requests (not your usage limit)', 'API Error: 429 Rate limit exceeded', "You've used 90% of your weekly limit", 'API Error: Repeated 529 Overloaded errors.', 'Invalid API key']) {
    const notice_match=matchHealthNoticeText({error_details:text});
    assert.ok(notice_match,text);
    const result=classifyHealthNotice({...base,notice_match,quota:snapshot({five_hour:{used_percentage:100}})},now);
    assert.equal(result.eligible,true); assert.equal(result.noticeCode,'quota_exhausted');
    const neutral=classifyHealthNotice({...base,notice_match},now);
    assert.equal(neutral.eligible,true);assert.equal(neutral.noticeCode,'rate_limited');assert.equal(neutral.resetAt,null);
  }
});

test('billing requires positive quota evidence; other error categories cannot activate quota copy', () => {
  assert.equal(classifyHealthNotice({...base,error:'billing_error'},now).noticeCode,'billing_error');
  const notice_match={sourceId:4,kind:'credits_required'};
  assert.equal(classifyHealthNotice({...base,error:'billing_error',notice_match},now).noticeCode,'usage_credits_required');
  assert.equal(classifyHealthNotice({...base,error:'server_error',notice_match},now).noticeCode,'service_error');
  assert.equal(classifyHealthNotice({...base,quota:snapshot({five_hour:{used_percentage:20},seven_day:{used_percentage:30}})},now).noticeCode,'rate_limited');
});

test('factual first failure notices are independent of persistent health transitions', t => {
  for (const [error,noticeCode,health] of [
    ['authentication_failed','auth_failed','auth_failed'],
    ['model_not_found','model_unavailable','ok'],
    ['billing_error','billing_error','ok'],
    ['overloaded','service_error','ok'],
    ['server_error','service_error','ok'],
    ['unknown','unavailable','ok'],
  ]) {
      const store=fixture(t);
      const evidence=error==='billing_error'?{}:{notice_match:{sourceId:1,kind:'model_quota'},quota:snapshot({five_hour:{used_percentage:100}})};
      const result=store.consume({...base,error,...evidence}, {identity});
      // Billing is tested without supporting quota; the other classes must
      // never adopt quota wording even when unrelated quota evidence exists.
      assert.equal(result.notice.noticeCode,noticeCode);assert.equal(result.notice.eligible,true);
      const intent=store.read().pending_notice;
      assert.equal(intent.notice.noticeCode,noticeCode);
      assert.equal(store.read().health,health);
  }
});

test('IB-02 matched notice evidence remains durable while rate-limited inbound stays pending', async t => {
  const store=fixture(t);
  const result=store.consume({...base,quota:snapshot({five_hour:{used_percentage:100,resets_at:reset1}}),error_details:'PRIVATE'}, {identity});
  const intent=store.read().pending_notice;
  assert.equal(intent.notice.noticeCode,'quota_exhausted_reset');
  assert.doesNotMatch(fs.readFileSync(store.file,'utf8'),/PRIVATE/);
  const engine={health:'rate_limited',healthReason:result.state.reason,evidence:{store,refresh(){}},
    runRecoveryProbe:async()=>({recovered:false})};
  const router=new MessageRouter({healthCoordinator:{store:()=>store,notifyUserMessage:()=>false},
    resolveTargetRuntime:()=> 'claude',requestProbe:async()=>{},cacheDirectory:path.join(path.dirname(store.file),'probe-cache'),now:()=>now});
  const route=await router.route({version:1,type:'route',requestId:'test',noReply:false,receivedAt:now});
  const status=buildStatusPayload({statusObj:{},healthEngine:engine});
  assert.equal(route.decision,'pending');assert.equal(route.userMessage,undefined);
  assert.match(messageForStatus({health:status.health,...status.health_notice}),/\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:UTC|[A-Za-z_]+\/[A-Za-z_]+)/);
  const revision=store.read().revision;
  store.transition('ok','',{identity,kind:'recovery',expectedRevision:revision});
  assert.equal(store.read().notice,undefined);
});
