import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from '../../../comm-bridge/node_modules/better-sqlite3/lib/index.js';
import { migrateHealthNotices } from '../../../comm-bridge/scripts/c4-health-migration.js';
import { classifyHealthNotice } from '../health-notice-classification.js';
import { matchHealthNoticeText } from '../health-notice-match.js';
import { HealthStore } from '../health-store.js';
import { MessageRouter } from '../message-router.js';
import { buildStatusPayload } from '../status-writer.js';
import { messageForStatus } from '../../../comm-bridge/scripts/status-notice-templates.js';

const now = Date.now();
const generation = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const identity = { runtime:'claude', runtime_generation:generation, session_id:'session', claude_pid:123, process_start:`${generation}:123` };
const base = { ...identity, schema_version:1, source:'hook', event_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  event:'stop_failure', prompt_id:'prompt', error:'rate_limit', received_at:now };
const snapshot = windows => ({ ...identity, schema_version:1, source:'statusline', observed_at:now-1000, rate_limits:windows });
const reset1 = Math.floor(now/1000)+3600;
const reset2 = reset1+3600;

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
  for (const override of [{observed_at:now-60001},{session_id:'foreign'},{process_start:`${generation}:999`},{observed_at:now+1}]) {
    const result = classifyHealthNotice({...base,quota:{...snapshot({five_hour:{used_percentage:100,resets_at:reset1}}),...override}},now);
    assert.equal(result.noticeCode,'rate_limited'); assert.equal(result.resetAt,null);
  }
  const result=classifyHealthNotice({...base,quota:snapshot({five_hour:{used_percentage:100,resets_at:reset1}})},reset1*1000+1);
  assert.equal(result.noticeCode,'rate_limited');
});

test('negative diagnostics cannot turn a rate limit or full snapshot into quota wording', () => {
  for (const text of ['API Error: Server is temporarily limiting requests (not your usage limit)', "You've used 90% of your weekly limit", 'API Error: Repeated 529 Overloaded errors.']) {
    const notice_match=matchHealthNoticeText({error_details:text});
    assert.ok(notice_match,text);
    const result=classifyHealthNotice({...base,notice_match,quota:snapshot({five_hour:{used_percentage:100}})},now);
    assert.equal(result.eligible,false); assert.equal(result.noticeCode,'rate_limited');
  }
});

test('billing requires positive quota evidence; other error categories cannot activate quota copy', () => {
  assert.equal(classifyHealthNotice({...base,error:'billing_error'},now).eligible,false);
  const notice_match={sourceId:4,kind:'credits_required'};
  assert.equal(classifyHealthNotice({...base,error:'billing_error',notice_match},now).noticeCode,'usage_credits_required');
  assert.equal(classifyHealthNotice({...base,error:'server_error',notice_match},now).eligible,false);
  assert.equal(classifyHealthNotice({...base,quota:snapshot({five_hour:{used_percentage:20},seven_day:{used_percentage:30}})},now).noticeCode,'rate_limited');
});

test('matched evidence flows transactionally to first reply and identical inbound/fallback messages', async t => {
  const db=new Database(':memory:'); migrateHealthNotices(db); t.after(()=>db.close());
  db.prepare(`INSERT INTO runtime_deliveries(conversation_id,runtime_id,runtime_generation,session_id,process_start,channel,endpoint,status,started_at,submitted_at)
    VALUES(1,'claude',?,?,?,'fake','group','delivered',?,?)`).run(generation,'session',identity.process_start,now-2000,now-1500);
  const store=new HealthStore(db,{now:()=>now});
  const result=store.consume({...base,quota:snapshot({five_hour:{used_percentage:100,resets_at:reset1}}),error_details:'PRIVATE'}, {identity});
  const intent=db.prepare('SELECT * FROM runtime_notice_intents').get();
  assert.equal(JSON.parse(intent.notice_json).noticeCode,'quota_exhausted_reset');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM runtime_health_events').all()),/PRIVATE/);
  const engine={health:'rate_limited',healthReason:result.state.reason,evidence:{store,refresh(){}},
    runRecoveryProbe:async()=>({recovered:false})};
  const router=new MessageRouter({healthEngine:engine,now:()=>now});
  const route=await router.route({version:1,type:'route',requestId:'test'});
  const status=buildStatusPayload({statusObj:{},healthEngine:engine});
  assert.equal(route.userMessage,messageForStatus({health:status.health,...status.health_notice}));
  assert.match(route.userMessage,/UTC/);
  const revision=store.read().revision;
  store.transition('ok','',{identity,kind:'recovery',expectedRevision:revision});
  assert.equal(store.read().notice,undefined);
});
