import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectOrigin } from '../src/lib/core-state.js';
import { MetricResolver } from '../src/lib/metric-resolver.js';
import { describeOrigin } from '../../../cli/lib/origin-presence.js';
import { originSessionUnavailable } from '../public/js/state-presentation.js';
import { stateMood, buildAgentFleetView, defaultAgentFleetLabels } from '../public/js/agent-fleet.js';

const absent = () => ({ identity: { present: false, ready: false, runtime: 'unknown' }, status: { valid: false, reason: 'not_running' }, usage: { valid: false } });
const live = () => ({ identity: { present: true, ready: true, runtime: 'claude', runId: 'run-current', sessionId: 'session-current' }, status: { valid: true, reason: null, value: { state: 'busy' } }, usage: { valid: false } });
const mapping = { sleeping: 'SLEEPING', waking: 'WAKING', wake_overdue: 'WAKE_OVERDUE', auth_wait: 'AUTH_WAIT', rate_wait: 'RATE_WAIT', need_unreadable: 'UNKNOWN' };

test('Origin display states preserve identity and respect transition and fence priority', () => {
  for (const [state, expected] of Object.entries(mapping)) {
    const projected = projectOrigin('origin', absent(), undefined, {}, { state });
    assert.equal(projected.state, expected);
    assert.equal(projected.runId, null);
    assert.equal(projected.sessionId, null);
    if (state === 'need_unreadable') assert.equal(projected.reason, 'origin_need_unreadable');
  }
  assert.equal(projectOrigin('origin', absent(), undefined, { transitionOpen: true, fenced: true }, { state: 'auth_wait' }).state, 'SWITCHING');
  assert.equal(projectOrigin('origin', absent(), undefined, { fenced: true }, { state: 'rate_wait' }).state, 'RECLAIMING');
  const auth = projectOrigin('origin', live(), undefined, {}, { state: 'auth_wait' });
  assert.equal(auth.state, 'AUTH_WAIT');
  assert.equal(auth.runId, 'run-current');
  assert.equal(auth.sessionId, 'session-current');
  assert.equal(projectOrigin(null, absent()).state, 'OFFLINE');
  assert.equal(projectOrigin('origin', live(), undefined, { fenced: true }, null).state, 'BUSY');
});

test('Core state reads Origin facts only for absence or authentication and reads target account usage', async t => {
  let mode = 'multi', observation = absent(), health = { health: 'ok' }, targetRuntime = 'codex', factsReads = 0;
  let facts = { originNeed: { inbound: 0, controls: 0, oldestAt: null }, transitionOpen: false, fenced: false };
  const accountCalls = [];
  let accountAvailable = true;
  const reader = {
    readSessionState: async () => structuredClone(observation),
    readLiveIdentity: async () => ({ present: true, ready: true, runtime: 'codex', runId: 'other-run', sessionId: 'other-session' }),
    resolveTargetRuntime: async group => { assert.equal(group, 'origin'); return targetRuntime; },
    readRuntimeHealth: async runtime => { assert.equal(runtime, targetRuntime); return health; },
    readAccountUsage: async runtime => { accountCalls.push(runtime); return accountAvailable && runtime === 'codex' ? { fiveHour: { usedPercentage: 37 }, sevenDay: { usedPercentage: 61 } } : null; },
  };
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
    if (name === 'session-state-reader.js') return reader;
    if (name === 'session-group-paths.js') return { listGroupTmuxSessions: async () => [{ sessionGroup: 'other' }] };
    if (name === 'origin-presence.js') return { describeOrigin, readOriginFacts: async ({ zylosDir, nowSec }) => {
      assert.equal(zylosDir, process.env.ZYLOS_DIR); assert.equal(Number.isSafeInteger(nowSec), true); factsReads++; return facts;
    } };
    assert.fail(`Unexpected core module ${name}`);
  } } });
  const { CoreState } = await import(`../src/lib/core-state.js?origin-facts=${Date.now()}`);
  const core = new CoreState({ zylosDir: process.env.ZYLOS_DIR });
  assert.equal((await core.refresh()).state, 'SLEEPING');
  assert.deepEqual(accountCalls, ['codex']);
  assert.equal(core.accountUsage.fiveHour.usedPercentage, 37);
  assert.equal(core.accountUsage.sevenDay.usedPercentage, 61);
  const metrics = new MetricResolver({}, { statusline: { getAccountUsage: () => ({ runtime: 'codex', value: core.accountUsage }) } }, {});
  assert.equal(metrics.resolve('rate_limit').value, null);
  assert.equal(metrics.resolve('rate_limit').fallback_reason, 'Unknown metric: rate_limit');
  assert.equal(metrics.resolve('rate_limit_7d').value, 61);
  assert.equal(factsReads, 1);
  observation = live();
  assert.equal((await core.refresh()).state, 'BUSY');
  health = { health: 'rate_limited' };
  assert.equal((await core.refresh()).state, 'BUSY');
  assert.equal(factsReads, 1, 'present healthy or limited Origin does not open C4');
  health = { health: 'auth_failed' };
  facts.originNeed = { inbound: 1, controls: 0, oldestAt: Math.floor(Date.now() / 1000) };
  assert.equal((await core.refresh()).state, 'AUTH_WAIT');
  assert.equal(core.getState().runId, 'run-current');
  assert.equal(factsReads, 2);
  observation = absent(); health = { health: 'rate_limited' };
  facts.originNeed.oldestAt -= 400;
  assert.equal((await core.refresh()).state, 'RATE_WAIT');
  facts = { originNeed: { error: { code: 'READ_FAILED', message: 'unreadable' } }, transitionOpen: null, fenced: null };
  const unreadable = await core.refresh();
  assert.equal(unreadable.state, 'UNKNOWN'); assert.equal(unreadable.reason, 'origin_need_unreadable');
  facts = { originNeed: { inbound: 0, controls: 0, oldestAt: null }, transitionOpen: false, fenced: false };
  accountAvailable = false; health = { health: 'ok' };
  assert.equal((await core.refresh()).state, 'SLEEPING');
  assert.equal(core.accountUsage, null);
  assert.equal(metrics.resolve('rate_limit').value, null);
  assert.equal(metrics.resolve('rate_limit_7d').value, null);
  facts.originNeed = { inbound: 0, controls: 0, continuation: true, oldestAt: Math.floor(Date.now() / 1000) };
  assert.equal((await core.refresh()).state, 'WAKING');
  facts.originNeed.oldestAt -= 400;
  assert.equal((await core.refresh()).state, 'WAKE_OVERDUE');
  health = { health: 'auth_failed' };
  assert.equal((await core.refresh()).state, 'AUTH_WAIT');
  facts.originNeed = { inbound: 0, controls: 0, continuation: false, oldestAt: null };
  assert.equal((await core.refresh()).state, 'SLEEPING');
  const reads = factsReads;
  mode = 'single';
  assert.equal((await core.refresh()).state, 'OFFLINE');
  assert.equal(factsReads, reads);
  assert.equal(core.accountUsage, null);
});

test('Origin states have matching detail, Fleet and action availability presentation', () => {
  const labels = defaultAgentFleetLabels();
  for (const state of ['SLEEPING', 'WAKING', 'WAKE_OVERDUE', 'AUTH_WAIT', 'RATE_WAIT', 'RECLAIMING', 'SWITCHING']) {
    const agent = { name: 'Origin', state, pulse_rate: 1 };
    assert.equal(stateMood(agent), ['WAKE_OVERDUE', 'AUTH_WAIT'].includes(state) ? 'stuck' : 'idle');
    const tile = buildAgentFleetView({ agents: [agent] }).tiles[0];
    assert.equal(tile.offline, false); assert.equal(tile.stateLabel, labels[state.toLowerCase()]);
    assert.equal(originSessionUnavailable(agent), true);
  }
  assert.equal(originSessionUnavailable({ state: 'AUTH_WAIT', runId: 'current' }), false);
  assert.equal(originSessionUnavailable({ sessionGroup: 'origin', state: 'UNKNOWN', runId: null }), true);
  assert.equal(originSessionUnavailable({ sessionGroup: null, state: 'OFFLINE', runId: null }), false);
  for (const lang of ['en', 'zh']) {
    const dictionary = JSON.parse(fs.readFileSync(new URL(`../public/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of ['sleeping', 'waking', 'wake_overdue', 'auth_wait', 'rate_wait', 'reclaiming', 'switching']) {
      for (const prefix of ['state', 'activity', 'agent_fleet']) assert.equal(typeof dictionary[`${prefix}.${key}`], 'string');
    }
    for (const key of ['action.origin_not_running', 'result.restart_wake_requested', 'result.restart_wake_failed']) assert.equal(typeof dictionary[key], 'string');
  }
});

test('manual restart distinguishes wake requests and failed wake writes in multi mode', async t => {
  let mode = 'multi', reply = { kind: 'accepted', reply: { result: 'already_stopped' } }, submissions = 0;
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
    if (name === 'am-sock-client.js') return { submit: async () => { submissions++; return reply; }, lookupRestartRequest: async () => assert.fail('accepted result requires no lookup') };
    assert.fail(`Unexpected module ${name}`);
  } } });
  const { handleCoreAction } = await import(`../src/lib/core-actions.js?wake-result=${Date.now()}`);
  const config = { zylosDir: process.env.ZYLOS_DIR };
  assert.equal((await handleCoreAction('restart-session', {}, config)).messageKey, 'result.restart_wake_requested');
  reply = { kind: 'rejected', reply: { reason: 'wake_failed' } };
  assert.equal((await handleCoreAction('restart-session', {}, config)).messageKey, 'result.restart_wake_failed');
  mode = 'single'; reply = { kind: 'accepted', reply: { result: 'already_stopped' } };
  const single = await handleCoreAction('restart-session', {}, config);
  assert.equal(single.messageKey, 'result.restart_already_stopped'); assert.match(single.message, /already_stopped/);
  mode = 'multi';
  assert.equal((await handleCoreAction('interrupt', {}, config)).error, 'TARGET_REQUIRED');
  assert.equal((await handleCoreAction('chop-chop', {}, config)).error, 'TARGET_REQUIRED');
  assert.equal(submissions, 3, 'missing run targets never enqueue controls or request a wake');
});
