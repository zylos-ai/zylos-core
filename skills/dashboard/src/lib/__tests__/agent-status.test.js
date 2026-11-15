import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentStatus } from '../agent-status.js';
import { agentReadiness } from '../agent-readiness.js';

const observation = { identity: { present: true, ready: true, sessionId: 'current' }, status: { valid: true, value: { state: 'busy' } } };
const row = (name, input, ready, reason, stage) => test(`Origin ${name}`, () => {
  assert.deepEqual(agentReadiness(input, { sessionMode: 'multi' }), { ready, reason, stage, observable: ['ready', 'session_ready'].includes(stage) });
});
row('busy is ready', { observation }, true, 'ready', 'ready');
row('idle is ready', { observation: { ...observation, status: { valid: true, value: { state: 'idle' } } } }, true, 'ready', 'ready');
for (const state of ['sleeping', 'waking']) row(state, { observation: null, view: { state } }, true, state, 'ready');
row('authentication wait', { view: { state: 'auth_wait' } }, false, 'auth_wait', 'runtime_down');
row('authentication failure outranks live identity', { observation, runtimeHealth: { health: 'auth_failed' } }, false, 'health_auth_failed', 'runtime_down');
row('wake timeout', { view: { state: 'wake_overdue' } }, false, 'wake_overdue', 'runtime_up');
row('rate limit wait', { view: { state: 'rate_wait' } }, false, 'rate_wait', 'session_ready');
row('unreadable wake demand', { view: { state: 'need_unreadable' } }, false, 'origin_need_unreadable', 'runtime_down');
row('unreadable observation', {}, false, 'status_missing', 'runtime_down');
row('not running', { observation: { identity: { present: false }, status: { valid: false, reason: 'not_running' } } }, false, 'no_session', 'runtime_up');
row('starting', { observation: { identity: { present: true, ready: false }, status: { valid: false, reason: 'starting' } } }, false, 'no_session', 'runtime_up');
row('not yet ready', { observation: { ...observation, identity: { present: true, ready: false } } }, false, 'no_session', 'runtime_up');
row('no running identity', { observation: { ...observation, identity: { present: false } } }, false, 'no_session', 'runtime_up');
row('changed identity', { observation: { ...observation, status: { valid: false, reason: 'identity_changed' } } }, false, 'session_predates_launch', 'runtime_up');
row('unreadable status', { observation: { ...observation, status: { valid: false } } }, false, 'status_missing', 'runtime_down');
row('stale status', { observation: { ...observation, status: { valid: false, reason: 'stale' } } }, false, 'stale', 'runtime_down');

const state = { session_mode: 'single', state: 'BUSY', context_pct: 40, session_cost: 1, daily_cost: 2, weekly_cost: 3,
  runtime_info: { runtime: 'codex', model: 'model', model_id: 'model-id', effort: 'high' }, rate_limit_7d_pct: 55,
  system_metrics: { scope: 'container', cpu_pct: 20, mem_pct: 30, mem_used_bytes: 300, mem_total_bytes: 1000, disk_pct: 10, disk_free_bytes: 5000 } };
test('single session contract retains per-session metrics and projects public fields', () => {
  const value = buildAgentStatus({ state, readiness: { ready: true }, sampledAt: 'fixture' });
  assert.equal(value.schema_version, 1);
  assert.equal(value.sampled_at, 'fixture');
  assert.equal(value.state, 'BUSY');
  assert.equal(value.groups, null);
  assert.equal(value.context_pct, 40);
  assert.deepEqual(value.cost, { session: 1, daily: 2, weekly: 3 });
  assert.deepEqual(value.runtime, state.runtime_info);
  assert.equal(value.rate_limit_7d_pct, 55);
  assert.deepEqual(value.resources, state.system_metrics);
});
for (const [name, summary, expected] of [
  ['busy group', { counts: { busy: 1, idle: 1 }, running: 2, listKnown: true }, 'BUSY'],
  ['idle fleet', { counts: { idle: 2 }, running: 2, listKnown: true }, 'IDLE'],
  ['unknown group in readable list', { counts: { unknown: 1 }, running: 1, listKnown: true }, 'IDLE'],
  ['unreadable list', { counts: {}, running: 0, listKnown: false }, 'UNKNOWN'],
  ['unavailable summary', null, 'UNKNOWN'],
]) test(`multi-session contract: ${name}`, () => {
  const value = buildAgentStatus({ state: { ...state, session_mode: 'multi', group_summary: summary }, readiness: {} });
  assert.equal(value.state, expected);
  assert.equal(value.context_pct, null);
  assert.equal(value.cost.session, null);
  assert.equal(value.cost.daily, 2);
  assert.equal(value.cost.weekly, 3);
  assert.equal(value.groups.running, summary?.running ?? 0);
  assert.equal(value.groups.busy, summary?.counts.busy ?? 0);
  assert.equal(value.groups.unknown, summary?.counts.unknown ?? 0);
});
test('projection with null session mode selects the single response structure', () => {
  assert.equal(buildAgentStatus({ state: { ...state, session_mode: null }, readiness: {} }).session_mode, 'single');
});
for (const [name, input, expected] of [
  ['idle', { observation: { ...observation, status: { valid: true, value: { state: 'idle' } } } }, { ready: true, observable: true, reason: 'ready', stage: 'ready' }],
  ['busy', { observation }, { ready: false, observable: true, reason: 'busy', stage: 'session_ready' }],
  ['starting', { observation: { identity: { present: true, ready: false }, status: { valid: false, reason: 'starting' } } }, { ready: false, observable: false, reason: 'no_session', stage: 'runtime_up' }],
  ['no session', { observation: { identity: { present: false }, status: { valid: false, reason: 'not_running' } } }, { ready: false, observable: false, reason: 'no_session', stage: 'runtime_up' }],
  ['unreadable', {}, { ready: false, observable: false, reason: 'status_missing', stage: 'runtime_down' }],
  ['authentication failed', { observation, runtimeHealth: { health: 'auth_failed' } }, { ready: false, observable: false, reason: 'health_auth_failed', stage: 'runtime_down' }],
]) test(`single-session readiness: ${name}`, () => {
  assert.deepEqual(agentReadiness(input, { sessionMode: 'single' }), expected);
});
test('readiness mapper with null mode uses the single-session busy rule', () => {
  assert.equal(agentReadiness({ observation }, { sessionMode: null }).ready, false);
  assert.equal(agentReadiness({ observation }, { sessionMode: null }).stage, 'session_ready');
});
