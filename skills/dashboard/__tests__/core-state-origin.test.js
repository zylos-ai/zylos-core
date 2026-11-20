import { registerHooks } from 'node:module';
import { AccountUsageCache } from '../src/lib/account-usage-cache.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CoreState, projectOrigin } from '../src/lib/core-state.js';
import { describeOrigin } from '../../../cli/lib/origin-presence.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { stateMood, buildAgentFleetView, defaultAgentFleetLabels } = await import('../public/js/agent-fleet.js');

const absent = () => ({ identity: { present: false, ready: false, runtime: 'unknown' }, status: { valid: false, reason: 'not_running' }, usage: { valid: false } });
const live = () => ({ identity: { present: true, ready: true, runtime: 'claude', runId: 'run-current', sessionId: 'session-current' }, status: { valid: true, reason: null, value: { state: 'busy' } }, usage: { valid: false } });
const mapping = { sleeping: 'SLEEPING', waking: 'WAKING', wake_overdue: 'WAKE_OVERDUE', auth_wait: 'AUTH_WAIT', rate_wait: 'RATE_WAIT', need_unreadable: 'UNKNOWN' };

test('captured model override is unavailable when the sampled session identity changes', () => {
  const core = new CoreState();
  core.observation = live();
  const launch = { runtime: 'claude', mode: 'override', model: 'opus[1m]', effort: 'high' };
  core.observation.identity.launchConfig = launch;
  core.observation.status = { valid: false, reason: 'starting' };
  assert.deepEqual(core.getLaunchConfig(), launch, 'a bound override remains usable before the first usage sample');
  core.observation.status.reason = 'identity_changed';
  assert.equal(core.getLaunchConfig(), null, 'the old run cannot supply current model facts');
  assert.equal(core.getCurrentSessionId(), null);
});

test('single-session history ignores a multi-session sample until a fresh single-session observation arrives', async t => {
  let mode = 'multi', identityChanged = false;
  const core = new CoreState({ accountUsageCache: { read: async () => null },
    sessionObservations: { get: async () => {
      const group = mode === 'multi' ? 'origin' : null;
      const observation = live();
      observation.identity.sessionId = group === null ? 'single-session' : 'multi-session';
      if (identityChanged) observation.status = { valid: false, reason: 'identity_changed' };
      return { mode, group, observations: new Map([[group, observation]]),
        reader: { readRuntimeHealth: async () => ({ health: 'ok' }) } };
    } } });
  assert.equal(core.getSingleSessionId(), null, 'no sample cannot mark a history session current');
  await core.refresh();
  assert.equal(core.getCurrentSessionId(), 'multi-session');
  mode = 'single';
  assert.equal(core.getSingleSessionId(), null, 'the previous multi-session sample cannot mark single-session history current');
  await core.refresh();
  assert.equal(core.getSingleSessionId(), 'single-session', 'a fresh single-session observation supplies the current history session');
  identityChanged = true;
  await core.refresh();
  assert.equal(core.getSingleSessionId(), null, 'an invalidated identity cannot mark a history session current');
});

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
  let accountAvailable = true, accountLive = true, changes = 0;
  const reader = {
    readSessionStates: async groups => new Map(groups.map(group => [group, structuredClone(observation)])),
    readLiveIdentity: async () => ({ present: true, ready: true, runtime: 'codex', runId: 'other-run', sessionId: 'other-session' }),
    resolveTargetRuntime: async group => { assert.equal(group, mode === 'multi' ? 'origin' : null); return targetRuntime; },
    readRuntimeHealth: async runtime => { assert.equal(runtime, observation.identity.present ? observation.identity.runtime : targetRuntime); return health; },
    readAccountUsageSnapshot: async runtime => { accountCalls.push(runtime); return { recorded: accountAvailable && runtime === 'codex'
      ? { value: { fiveHour: { usedPercentage: 37 }, sevenDay: { usedPercentage: 61 } }, live: accountLive, recordedAt: 1000 } : null }; },
  };
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'runtime/descriptors.js') return import('../../../cli/lib/runtime/descriptors.js');
    if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
    if (name === 'session-group-paths.js') return { listGroupTmuxSessions: async () => [{ sessionGroup: 'other' }] };
    if (name === 'origin-presence.js') return { describeOrigin, readOriginFacts: async ({ zylosDir, nowSec }) => {
      assert.equal(zylosDir, process.env.ZYLOS_DIR); assert.equal(Number.isSafeInteger(nowSec), true); factsReads++; return facts;
    } };
    assert.fail(`Unexpected core module ${name}`);
  } } });
  const { CoreState } = await import(`../src/lib/core-state.js?origin-facts=${Date.now()}`);
  const core = new CoreState({ accountUsageCache: new AccountUsageCache({ ttlMs: 0 }), zylosDir: process.env.ZYLOS_DIR, onChange: () => { changes++; },
    sessionObservations: { get: async () => ({ mode, group: mode === 'multi' ? 'origin' : null, reader,
      observations: new Map([[mode === 'multi' ? 'origin' : null, structuredClone(observation)]]) }),
      resolveOfflineRuntime: async () => targetRuntime } });
  assert.equal((await core.refresh()).state, 'SLEEPING');
  assert.deepEqual(accountCalls, ['codex']);
  assert.equal(core.accountUsage.fiveHour.usedPercentage, 37);
  assert.equal(core.accountUsage.sevenDay.usedPercentage, 61);
  const before = changes;
  await core.refresh(); assert.equal(changes, before);
  accountLive = false;
  await core.refresh(); assert.equal(changes, before + 1);
  assert.equal(factsReads, 3);
  observation = live();
  assert.equal((await core.refresh()).state, 'BUSY');
  health = { health: 'rate_limited' };
  assert.equal((await core.refresh()).state, 'BUSY');
  assert.equal(factsReads, 3, 'present healthy or limited Origin does not open C4');
  health = { health: 'auth_failed' };
  facts.originNeed = { inbound: 1, controls: 0, oldestAt: Math.floor(Date.now() / 1000) };
  assert.equal((await core.refresh()).state, 'AUTH_WAIT');
  assert.equal(core.getState().runId, 'run-current');
  assert.equal(factsReads, 4);
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
  accountAvailable = true;
  assert.equal((await core.refresh()).state, 'OFFLINE');
  assert.equal(core.accountUsage.sevenDay.usedPercentage, 61);
});

test('Core state ignores live sample timestamps and notifies recorded provenance changes', async t => {
  let record = { value: { seven_day: { used_percentage: 21 } }, live: true, recordedAt: 1000 };
  let changes = 0;
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'runtime/descriptors.js') return import('../../../cli/lib/runtime/descriptors.js');
    if (name === 'config.js') return { readSessionMode: () => ({ mode: 'single' }) };
    if (name === 'session-group-paths.js') return {};
    assert.fail(`Unexpected core module ${name}`);
  } } });
  const { CoreState } = await import(`../src/lib/core-state.js?quota-notifications=${Date.now()}`);
  const core = new CoreState({ accountUsageCache: new AccountUsageCache({ ttlMs: 0 }), zylosDir: process.env.ZYLOS_DIR, onChange: () => { changes++; },
    sessionObservations: { get: async () => ({ mode: 'single', group: null,
      observations: new Map([[null, live()]]), reader: { readAccountUsageSnapshot: async () => ({ recorded: structuredClone(record) }) } }) } });
  await core.refresh();
  assert.equal(changes, 1);
  record.recordedAt = 2000;
  await core.refresh();
  assert.equal(changes, 1, 'same live percentage with a new sample time does not broadcast');
  record.live = false;
  await core.refresh();
  assert.equal(changes, 2, 'same percentage switching to recorded evidence broadcasts');
  record.recordedAt = 3000;
  await core.refresh();
  assert.equal(changes, 3, 'recorded label time changes broadcast');
  await core.refresh();
  assert.equal(changes, 3, 'unchanged recorded evidence does not broadcast');
  record.live = true;
  await core.refresh();
  assert.equal(changes, 4, 'switching back to live evidence broadcasts');
  record.value.seven_day.used_percentage = 22;
  await core.refresh();
  assert.equal(changes, 5, 'live percentage changes still broadcast');
});

test('Origin states retain Fleet labels and reachability', () => {
  const labels = defaultAgentFleetLabels();
  for (const state of ['SLEEPING', 'WAKING', 'WAKE_OVERDUE', 'AUTH_WAIT', 'RATE_WAIT', 'RECLAIMING', 'SWITCHING']) {
    const agent = { name: 'Origin', state, pulse_rate: 1 };
    assert.equal(stateMood(agent), ['WAKE_OVERDUE', 'AUTH_WAIT'].includes(state) ? 'stuck' : 'idle');
    const tile = buildAgentFleetView({ agents: [agent] }).tiles[0];
    assert.equal(tile.offline, false); assert.equal(tile.stateLabel, labels[state.toLowerCase()]);
  }
  for (const lang of ['en', 'zh']) {
    const dictionary = JSON.parse(fs.readFileSync(new URL(`../public/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of ['sleeping', 'waking', 'wake_overdue', 'auth_wait', 'rate_wait', 'reclaiming', 'switching']) {
      assert.equal(typeof dictionary[`agent_fleet.${key}`], 'string');
    }
    for (const key of ['action.origin_not_running', 'result.restart_wake_requested', 'result.restart_wake_failed']) assert.equal(typeof dictionary[key], 'string');
  }
});

test('manual restart distinguishes wake requests and failed wake writes in configured modes', async t => {
  let mode = 'multi', reply = { kind: 'accepted', reply: { result: 'already_stopped' } }, submissions = 0;
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'runtime/descriptors.js') return import('../../../cli/lib/runtime/descriptors.js');
    if (name === 'config.js') return { readSessionMode: () => ({ mode, keyPresent: mode !== null }) };
    if (name === 'am-sock-client.js') return { submit: async () => { submissions++; return reply; }, lookupRestartRequest: async () => assert.fail('accepted result requires no lookup') };
    assert.fail(`Unexpected module ${name}`);
  } } });
  const { handleCoreAction } = await import(`../src/lib/core-actions.js?wake-result=${Date.now()}`);
  const config = { zylosDir: process.env.ZYLOS_DIR };
  for (mode of ['multi', 'single']) {
    reply = { kind: 'accepted', reply: { result: 'already_stopped' } };
    assert.equal((await handleCoreAction('restart-session', {}, config)).messageKey, 'result.restart_wake_requested');
    reply = { kind: 'rejected', reply: { reason: 'wake_failed' } };
    assert.equal((await handleCoreAction('restart-session', {}, config)).messageKey, 'result.restart_wake_failed');
  }
  mode = null; reply = { kind: 'accepted', reply: { result: 'already_stopped' } };
  const single = await handleCoreAction('restart-session', {}, config);
  assert.equal(single.messageKey, 'result.restart_already_stopped'); assert.match(single.message, /already_stopped/);
  mode = 'multi';
  assert.equal((await handleCoreAction('interrupt', {}, config)).error, 'TARGET_REQUIRED');
  assert.equal((await handleCoreAction('chop-chop', {}, config)).error, 'TARGET_REQUIRED');
  assert.equal(submissions, 5, 'missing run targets never enqueue controls or request a wake');
});

// Covers the shared CLI status interpretation and Dashboard projection without
// tmux, services or network. Run for native single Origin status changes.
test('native single Origin sleeps and reports wake demand consistently with CLI status', async t => {
  const { collectStatus } = await import('../../../cli/lib/status-view.js');
  const { showStatus } = await import('../../../cli/commands/service.js');
  const { buildDiagnosticJson } = await import('../../../cli/commands/doctor.js');
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let need = { inbound: 0, controls: 0, continuation: false, oldestAt: null };
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'runtime/descriptors.js') return import('../../../cli/lib/runtime/descriptors.js');
    if (name === 'origin-presence.js') return { describeOrigin, readOriginFacts: async ({ sessionMode }) => { assert.equal(sessionMode, 'single'); return { originNeed: need, transitionOpen: false, fenced: false }; } };
    assert.fail(`Unexpected core module ${name}`);
  } } });
  const { CoreState } = await import(`../src/lib/core-state.js?native-single=${now}`);
  const core = new CoreState({ accountUsageCache: { read: async () => null }, sessionObservations: {
    get: async () => ({ mode: 'single', sessionMode: 'single', group: null, observations: new Map([[null, absent()]]), reader: { readRuntimeHealth: async () => ({ health: 'ok' }) } }),
    resolveOfflineRuntime: async group => { assert.equal(group, 'origin'); return 'codex'; },
  } });
  for (const [inbound, oldestAt, state] of [[0, null, 'sleeping'], [1, 701, 'waking'], [1, 700, 'wake_overdue']]) {
    need = { ...need, inbound, oldestAt };
    const status = await collectStatus({ mode: () => ({ mode: 'single', keyPresent: true }), now: () => now,
      session: async group => { assert.equal(group, 'origin'); return absent(); },
      health: async () => ({ missing: true }), facts: async ({ sessionMode }) => { assert.equal(sessionMode, 'single'); return { originNeed: need }; },
      configIssue: () => null, resolveRoot() {}, requests: async () => [] });
    assert.equal(status.origin.sessionGroup, null);
    assert.equal(describeOrigin({ ...status, targetRuntime: 'codex', nowSec: now / 1000 }).state, state);
    assert.equal((await core.refresh()).state, state.toUpperCase());
    const diagnostic = buildDiagnosticJson({ runtime: 'claude', display: 'Claude', apiHost: 'fixture.invalid',
      system: { tmux: { installed: true }, pm2: { installed: true }, network: { reachable: true } },
      ai: { cli: { installed: true }, auth: true, authStatus: 'success', autonomous: true },
      services: { running: true, total: 1, procs: [{ name: 'activity-monitor', pm2_env: { status: 'online' } }], session: false },
      origin: describeOrigin({ ...status, targetRuntime: 'codex', nowSec: now / 1000 }), targetRuntime: 'codex',
    }, { success: true, version: 'fixture' });
    assert.equal(diagnostic.groups.services.session.origin, state);
    assert.equal(diagnostic.passed, state !== 'wake_overdue');
    assert.equal(diagnostic.issues.some(issue => /offline|not_running/.test(issue.label)), false);

    const lines = [], log = console.log;
    console.log = line => lines.push(line);
    try {
      await showStatus([], { collect: () => status, resolveRuntime: async () => 'codex',
        host: () => ({ services: [], disk: null }), alertNotice: () => ({ kind: 'ready' }) });
    } finally { console.log = log; }
    assert.ok(lines.some(line => line.includes(({ sleeping: 'Origin is asleep', waking: 'Origin is waking up', wake_overdue: 'Origin has pending work' })[state])));
    assert.equal(lines.some(line => /not_running|offline/i.test(line)), false);
  }
  const lines = [], log = console.log;
  console.log = line => lines.push(line);
  try {
    await showStatus([], { collect: () => ({ view: 'single', sessionMode: 'single',
      origin: { presence: 'not_running', status: { valid: false } }, groups: [], originNeed: { inbound: 1, controls: 0, continuation: false, oldestAt: 700 },
      runtimeHealth: { codex: { health: 'auth_failed' } }, readAt: now }),
      resolveRuntime: async group => { assert.equal(group, 'origin'); return 'codex'; },
      host: () => ({ services: [], disk: null }), alertNotice: () => ({ kind: 'ready' }) });
  } finally { console.log = log; }
  assert.match(lines.join('\n'), /Origin is waiting for codex authentication/);
  assert.equal(lines.some(line => /not_running|offline/i.test(line)), false);
  assert.equal(describeOrigin({ view: 'single', sessionMode: null, origin: { presence: 'not_running' }, originNeed: need }).state, 'not_running');
});
