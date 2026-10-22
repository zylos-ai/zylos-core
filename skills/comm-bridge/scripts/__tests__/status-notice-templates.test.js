import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageForStatus } from '../status-notice-templates.js';
import { messageForRoute } from '../../../activity-monitor/scripts/message-router.js';
import { NOTICE_TEMPLATES, SOURCE_NOTICE_CASES } from '../status-notice-catalog.js';

test('AM and C4 fallback use the same bilingual Zylos defaults', () => {
  for (const health of ['rate_limited', 'auth_failed', 'unavailable']) {
    const input = { health, reason: 'PRIVATE_ERROR_TEXT' };
    assert.equal(messageForRoute(input), messageForStatus(input));
    assert.match(messageForStatus(input), /^\[Zylos\]/);
    assert.match(messageForStatus(input), /未进入处理队列/);
    assert.match(messageForStatus(input), /not added to the processing queue/);
    assert.doesNotMatch(messageForStatus(input), /PRIVATE_ERROR_TEXT|automatically/);
  }
});

test('first failure wording does not claim an already delivered request was never queued', () => {
  const message = messageForStatus({ health: 'rate_limited', context: 'failure' });
  assert.match(message, /本次请求未能完成/);
  assert.match(message, /could not be completed/);
  assert.doesNotMatch(message, /未进入处理队列|not added to the processing queue/);
});

test('operators override brand and each failure context; messages stay bilingual', () => {
  const config = { language: 'en', brand: 'Product', templates: {
    failure: { rate_limited: { en: 'Please retry this request later.' } },
  } };
  assert.match(messageForStatus({ health: 'rate_limited', context: 'failure' }, config), /^\[Product\].*\n\[Product\] Please retry this request later\.$/);
  assert.match(messageForStatus({ health: 'rate_limited' }, config), /not added to the processing queue/);
  assert.match(messageForStatus({ health: 'rate_limited' }, config), /当前/);
  assert.match(messageForStatus({ health: 'auth_failed' }, { language: 'zh' }), /当前认证不可用/);
  assert.match(messageForStatus({ health: 'auth_failed' }, { language: 'zh' }), /Authentication/);
});

test('catalog covers all 33 diagnostic cases without enabling out-of-scope cases', () => {
  assert.deepEqual(SOURCE_NOTICE_CASES.map(row=>row.id),Array.from({length:33},(_,i)=>i+1));
  for(const id of [3,12,14,15,...Array.from({length:18},(_,i)=>i+16)]) {
    const row=SOURCE_NOTICE_CASES.find(row=>row.id===id);
    assert.equal(row.eligibility,'diagnostic');assert.equal(row.noticeCode,null);
  }
  assert.equal(Object.keys(NOTICE_TEMPLATES).length,9);
});

test('all active IDs render Chinese then English with correct context and no platform claims', () => {
  for(const noticeCode of Object.keys(NOTICE_TEMPLATES))for(const context of ['inbound','failure']) {
    const text=messageForStatus({health:'rate_limited',noticeCode,resetAt:Date.now()+3600000,context},{});
    assert.equal(text.split('\n').length,2);
    assert.match(text.split('\n')[0],/[\u4e00-\u9fff]/);
    assert.doesNotMatch(text.split('\n')[1],/[\u4e00-\u9fff]/);
    assert.doesNotMatch(text,/OpenMax|Dashboard|已通知|管理员已|automatically|has been informed|\{resetAt\}/);
    assert.match(text,context==='inbound'?/未进入处理队列/:/本次请求未能完成/);
  }
});

test('reset uses bounded future epoch milliseconds and deterministic explicit UTC', () => {
  const resetAt=Date.now()+3600000;
  const input={health:'rate_limited',noticeCode:'quota_exhausted_reset',context:'failure'};
  const expected=new Date(resetAt).toISOString().slice(0,16).replace('T',' ')+' UTC';
  assert.ok(messageForStatus({...input,resetAt},{timeZone:'UTC'}).includes(expected));
  for(const value of [undefined,NaN,Infinity,Date.now()-1,Date.now()+9*86400000,Math.floor(resetAt/1000),String(resetAt)]) {
    const text=messageForStatus({...input,resetAt:value},{});
    assert.doesNotMatch(text,/UTC|预计于|expected to reset|\{resetAt\}/);
    assert.equal(text,messageForStatus({...input,noticeCode:'quota_exhausted'},{}));
  }
});

test('known code overrides never fall back to a different category', () => {
  const resetAt=Date.now()+3600000;
  const config={timeZone:'UTC',templates:{failure:{rate_limited:{zh:'错误类别覆盖',en:'Wrong category override'}}}};
  const text=messageForStatus({health:'rate_limited',noticeCode:'quota_exhausted_reset',resetAt,context:'failure'},config);
  assert.match(text,/UTC/);assert.doesNotMatch(text,/错误类别覆盖|Wrong category override/);
});

test('reset time uses configured zone or host zone with explicit label and invalid-zone UTC fallback', () => {
  const input={noticeCode:'quota_exhausted_reset',resetAt:Date.now()+3600000,context:'failure'};
  assert.match(messageForStatus(input,{timeZone:'Asia/Singapore'}),/Asia\/Singapore/);
  assert.ok(messageForStatus(input,{}).includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.equal(messageForStatus(input,{timeZone:'Not/AZone'}),messageForStatus(input,{timeZone:'UTC'}));
});

test('structured nonquota errors render factual notices without guessing account cause', () => {
  for(const noticeCode of ['model_unavailable','billing_error','service_error','auth_failed','unavailable']) {
    const text=messageForStatus({health:'ok',noticeCode,context:'failure'},{});
    assert.match(text,/本次请求未能完成/);
    assert.doesNotMatch(text,/已用完|余额不足|撤销|exhausted|balance|revoked|informed|automatically/);
  }
  assert.match(messageForStatus({noticeCode:'auth_failed',context:'failure'},{}),/authentication error/);
  assert.match(messageForStatus({noticeCode:'billing_error',context:'failure'},{}),/billing error/);
  assert.match(messageForStatus({noticeCode:'model_unavailable',context:'failure'},{}),/model is unavailable/);
});

test('stable IDs support per-locale overrides and fallback without leaking reason text', () => {
  const config={templates:{failure:{model_quota_exhausted:{zh:'平台模型额度提示。',en:'Platform model quota notice.'},rate_limited:{en:'Legacy category.'}}}};
  const input={health:'rate_limited',noticeCode:'model_quota_exhausted',context:'failure'};
  assert.equal(messageForStatus(input,config),'[Zylos] 平台模型额度提示。\n[Zylos] Platform model quota notice.');
  const unknown=messageForStatus({...input,noticeCode:'PRIVATE_UNKNOWN',reason:'PRIVATE_REASON'},{});
  assert.doesNotMatch(unknown,/PRIVATE_UNKNOWN|PRIVATE_REASON/);
  assert.equal(unknown,messageForStatus({health:'rate_limited',context:'failure'},{}));
});

test('paid-credit requirement and disabled allocation do not assert exhausted quota', () => {
  for(const noticeCode of ['usage_credits_required','quota_allocation_unavailable']) {
    assert.doesNotMatch(messageForStatus({noticeCode,context:'failure'},{}),/已用完|已用尽|exhausted|expected to reset/);
  }
});

test('invalid operator configuration falls back without exposing runtime text', () => {
  const input = { health: 'unknown', reason: 'PRIVATE', context: 'failure' };
  const config = { language: 'invalid', brand: 'bad\nbrand', templates: { failure: { unavailable: { zh: '\0', en: 'x'.repeat(2001) } } } };
  assert.equal(messageForStatus(input, config), messageForStatus(input, {}));
  assert.doesNotThrow(() => messageForStatus(input, null));
});
