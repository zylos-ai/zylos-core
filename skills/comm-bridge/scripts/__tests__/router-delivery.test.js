import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRouterDiagnostics } from '../router/diagnostics.js';
import { createJsonlStream } from '../../../../cli/lib/jsonl-stream.js';
import assert from 'node:assert/strict';
import { createDelivery, getDeliveryDelay, checkClaudeFallbackInputBox } from '../router/delivery.js';
import { fixture } from './c4-v2-test-helpers.js';
const error = code => Object.assign(new Error(code), { code });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(t, options = {}) {
  const f = fixture(t), calls = [], sleeps = [];
  const target = { ready: true, runtime: 'codex', runId: 'r1', sessionId: '$1', paneId: '%1', serverGeneration: '1:1', runtimeSessionId: 's1' };
  let time = 100000;
  const state = { state: 'idle', idle_seconds: 4, health: 'ok', proc: { alive: true }, active_tools: 0, last_api_activity: 100 };
  const connection = { close: async () => calls.push(['close']), command: async args => { calls.push(['command', args]); return args.at(-1) === '#{cursor_x}' ? '2' : '0'; } };
  const adapter = {
    sendText: async args => { calls.push(['paste', args]); },
    sendKeys: async args => { if (args.keys.some(key => !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key))) throw new TypeError('Invalid key'); calls.push(['keys', args]); },
    captureScreen: async args => { calls.push(['capture', args]); return '❯ '; },
  };
  const controls = new Map();
  const db = { ...f.store,
    requeueControl: id => { calls.push(['requeueControl', id]); controls.get(id).status = 'pending'; },
    ackControl: id => { calls.push(['ackControl', id]); controls.get(id).status = 'done'; },
    retryOrFailControl: id => { calls.push(['retryControl', id]); controls.get(id).status = 'pending'; },
    failStaleTargetControl: id => { calls.push(['staleControl', id]); controls.get(id).status = 'timeout'; },
    markDelivered: (...args) => { calls.push(['markDelivered', ...args]); return f.store.markDelivered(...args); },
    failDelivery: (...args) => { calls.push(['failDelivery', ...args]); return f.store.failDelivery(...args); },
    requeueConversation: (...args) => { calls.push(['requeue', ...args]); return f.store.requeueConversation(...args); },
  };
  const deps = { db, getSessionMode: () => 'multi', now: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms; },
    openTmuxConnection: async () => connection,
    resolveSessionTarget: async ({ sessionGroup }) => { calls.push(['resolve', sessionGroup]); return target; },
    revalidateSessionTarget: async args => { assert.equal(args.target, target); assert.equal(args.connection, connection); calls.push(['validate']); },
    readSessionState: async (group, options) => { assert.deepEqual(options, { freshnessMs: 5000 }); return { identity: { ...target, present: true }, status: { valid: true, value: state } }; },
    readRuntimeHealth: () => ({ health: 'ok' }), readCurrentSession: async () => ({ runId: target.runId, sessionId: 's2' }),
    getSessionAdapter: runtime => { assert.equal(runtime, target.runtime); return adapter; },
    formatConversation: row => `safe:${row.content}`, notifyDelivered: data => { calls.push(['notify', data]); },
    diagnostic: (event, fields) => calls.push(['diagnostic', event, fields]),
  };
  function message(channel = 'telegram') {
    const row = f.store.insertConversation('in', channel, 'e', 'hi');
    const id = typeof row === 'number' ? row : row.id;
    assert.equal(f.store.claimConversation(id), true);
    return f.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  }
  function control(content = 'plain', extra = {}) { const row = { id: controls.size + 100, content, session_group: 'origin', status: 'running', ...extra }; controls.set(row.id, row); return row; }
  return { ...f, target, state, connection, adapter, deps, db, calls, sleeps, message, control,
    row: id => f.db.prepare('SELECT * FROM conversations WHERE id=?').get(id),
    create: override => createDelivery(deps, { periodicEnabled: false, ...options, ...override }) };
}

// actual conditional ledger with bound I/O fixture.
test('successful paste notifies immediately, reads current same-run F3 and drains before markDelivered', async t => {
  const f = setup(t), row = f.message();
  f.deps.notifyDelivered = data => { f.calls.push(['notify', data]); return new Promise(() => {}); };
  await f.create().deliverConversation(row);
  assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).session_id, 's2');
  const order = f.calls.map(c => c[0]);
  assert(order.indexOf('paste') < order.indexOf('notify')); assert(order.indexOf('notify') < order.indexOf('keys'));
  assert(order.indexOf('close') < order.indexOf('markDelivered'));
  assert.deepEqual(f.calls.find(c => c[0] === 'notify')[1], { conversationId: row.id, channel: 'telegram', sessionGroup: row.session_group, runId: 'r1', runtime: 'codex', pastedAt: 100000 });
  for (const [kind, arg] of f.calls) if (['paste', 'keys', 'capture'].includes(kind)) { assert.equal(arg.target, f.target); assert.equal(arg.connection, f.connection); }
  assert.equal(f.calls.filter(c => c[0] === 'resolve').length, 1);
});

test('single uses null target; unknown runtime, missing READY and invalid F4 do not send', async t => {
  for (const kind of ['unknown', 'ready', 'invalid']) await t.test(kind, async t => {
    const f = setup(t), row = f.message(); f.deps.getSessionMode = () => 'single';
    if (kind === 'unknown') f.target.runtime = 'unknown';
    if (kind === 'ready') f.target.ready = false;
    if (kind === 'invalid') f.deps.readSessionState = async () => ({ status: { valid: false } });
    await f.create().deliverConversation(row);
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
    assert.equal(f.calls.find(c => c[0] === 'resolve')[1], null); assert(!f.calls.some(c => c[0] === 'paste'));
  });
});

test('non-bypass runtime/session health and require_idle gates requeue without retries', async t => {
  for (const kind of ['runtime', 'session', 'idle', 'offline']) await t.test(kind, async t => {
    const f = setup(t), row = f.message();
    if (kind === 'runtime') f.deps.readRuntimeHealth = () => new Proxy({ publicHealth: 'unavailable' }, { get: (obj, key) => { assert(['health', 'publicHealth', 'missing', 'unreadable'].includes(key)); return obj[key]; } });
    if (kind === 'session') f.state.health = 'recovering';
    if (kind === 'idle') { row.require_idle = 1; f.state.idle_seconds = 2; }
    if (kind === 'offline') f.state.state = 'offline';
    await f.create().deliverConversation(row);
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0); assert(!f.calls.some(c => c[0] === 'paste'));
  });
});

test('stale and unavailable samples allow ordinary delivery with unknown activity', async t => {
  for (const reason of ['stale', 'missing', 'unparseable']) for (const type of ['conversation', 'control']) {
    await t.test(`${reason} ${type}`, async t => {
      const f = setup(t), row = type === 'conversation' ? f.message() : f.control();
      f.deps.readSessionState = async () => ({ identity: f.target,
        status: { valid: false, value: null, reason, sampledAt: 1,
          ...(reason === 'stale' ? { lastValue: { ...f.state, state: 'offline' } } : {}) } });
      const d = f.create(); t.after(() => d.stop());
      const result = await (type === 'conversation' ? d.deliverConversation(row) : d.deliverControl(row));
      assert.equal(result.state, 'unknown'); assert.equal(result.delivered, true);
      assert.equal(type === 'conversation' ? f.row(row.id).status : row.status, type === 'conversation' ? 'delivered' : 'done');
      assert.equal(f.calls.some(c => c[0] === 'diagnostic' && c[2].code === 'session_offline'), false);
      assert.equal(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'state_stale'), reason === 'stale');
    });
  }
});

test('stale samples preserve health and identity rejection gates', async t => {
  for (const kind of ['session', 'runtime', 'run', 'runtime_identity', 'ready', 'identity_changed', 'identity_mismatch', 'identity_missing']) {
    await t.test(kind, async t => {
      const f = setup(t), row = f.message(), identity = { ...f.target };
      if (kind === 'run') identity.runId = 'other';
      if (kind === 'runtime_identity') identity.runtime = 'claude';
      if (kind === 'ready') identity.ready = false;
      if (kind === 'runtime') f.deps.readRuntimeHealth = () => ({ publicHealth: 'unavailable' });
      f.deps.readSessionState = async () => ({ identity, status: { valid: false, value: null,
        reason: kind.startsWith('identity_') ? kind : 'stale', lastValue: { health: kind === 'session' ? 'unavailable' : 'ok' } } });
      const d = f.create(); t.after(() => d.stop()); await d.deliverConversation(row);
      assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
      assert.equal(f.calls.some(c => c[0] === 'paste'), false);
      const expected = kind === 'session' ? 'session_unhealthy' : kind === 'runtime' ? 'runtime_unavailable' : 'session_offline';
      assert.ok(f.calls.some(c => c[0] === 'diagnostic' && c[2].code === expected));
    });
  }
});

test('require_idle waits for a fresh idle sample and stale activity cannot autoack heartbeat', async t => {
  const f = setup(t), d = f.create(); t.after(() => d.stop());
  const fresh = f.deps.readSessionState;
  f.deps.readSessionState = async () => ({ identity: f.target, status: { valid: false, reason: 'stale', value: null,
    lastValue: { ...f.state, active_tools: 1 } } });
  const row = f.message(); row.require_idle = 1;
  await d.deliverConversation(row); assert.equal(f.row(row.id).status, 'pending');
  assert.equal(f.calls.some(c => c[0] === 'paste'), false);
  const heartbeat = f.control('Heartbeat check [phase=normal] ---- ack via: safe', { bypass_state: 1 });
  await d.deliverControl(heartbeat);
  assert.equal(heartbeat.status, 'running'); assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
  f.deps.readSessionState = fresh; f.store.claimConversation(row.id);
  await d.deliverConversation(row); assert.equal(f.row(row.id).status, 'delivered');
});

// Real delivery/ledger with an injected clock and terminal. Run for status or
// idle pacing changes; skip unrelated UI. Official isolated env, no processes.
for (const outcome of ['fresh idle', 'deadline']) test(`idle settlement polls stale samples until ${outcome}`, { timeout: 2000 }, async t => {
  const f = setup(t), row = f.message(); row.require_idle = 1;
  const fresh = f.deps.readSessionState; let reads = 0;
  f.deps.readSessionState = async (...args) => {
    reads++;
    if (reads === 1 || (outcome === 'fresh idle' && reads === 4)) return fresh(...args);
    return { identity: f.target, status: { valid: false, reason: 'stale', value: null, lastValue: f.state } };
  };
  const d = f.create({ idleHoldMs: 7, idleWaitMs: 30, idlePollMs: 10 }); t.after(() => d.stop());
  await d.deliverConversation(row);
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(reads, outcome === 'fresh idle' ? 4 : 5);
  assert.equal(f.sleeps.filter(ms => ms === 10).length, outcome === 'fresh idle' ? 2 : 3);
});

test('binding failures do not retry business and terminate only directed control', async t => {
  for (const code of ['TARGET_GONE', 'GENERATION_CHANGED', 'RUNID_MISMATCH', 'TMUX_UNAVAILABLE']) await t.test(code, async t => {
    const f = setup(t), row = f.message(); f.deps.resolveSessionTarget = async () => { throw error(code); };
    const d = f.create(); await d.deliverConversation(row);
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
    const directed = f.control('x', { target_binding: '{}' }), ordinary = f.control();
    await d.deliverControl(directed); await d.deliverControl(ordinary);
    assert.equal(directed.status, code === 'TMUX_UNAVAILABLE' ? 'pending' : 'timeout'); assert.equal(ordinary.status, 'pending');
  });
});

test('directed control compares every bound field and optional F3 session id', async t => {
  for (const key of ['expectedRunId', 'serverGeneration', 'sessionId', 'paneId', 'expectedSessionId']) await t.test(key, async t => {
    const f = setup(t); const binding = { expectedRunId: 'r1', tmuxTarget: { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' }, expectedSessionId: 's1' };
    (['expectedRunId', 'expectedSessionId'].includes(key) ? binding : binding.tmuxTarget)[key] = 'different';
    const row = f.control('x', { bypass_state: 1, target_binding: JSON.stringify(binding) });
    await f.create().deliverControl(row); assert.equal(row.status, 'timeout'); assert(!f.calls.some(c => c[0] === 'paste'));
  });
});

test('paste failure uses atomic failDelivery: second failure is terminal and false has no backoff', async t => {
  const f = setup(t), row = f.message(); f.adapter.sendText = async () => { throw error('PASTE_FAILED'); };
  const d = f.create(); await d.deliverConversation(row);
  assert.equal(f.row(row.id).retry_count, 1); assert.equal(f.row(row.id).status, 'pending'); assert(f.sleeps.includes(500));
  f.store.claimConversation(row.id); f.sleeps.length = 0; await d.deliverConversation(row);
  assert.equal(f.row(row.id).retry_count, 2); assert.equal(f.row(row.id).status, 'failed'); assert.deepEqual(f.sleeps, []);
  await d.deliverConversation(row); assert.equal(f.row(row.id).retry_count, 2); assert.deepEqual(f.sleeps, []);
});

test('lost markDelivered stays final without a second paste', async t => {
  const f = setup(t), row = f.message(); f.adapter.sendText = async args => { f.calls.push(['paste', args]); f.db.markDelivered(row.id, { sessionId: 'other' }); };
  await f.create().deliverConversation(row); assert.equal(f.row(row.id).session_id, 'other'); assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
  assert(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'mark_delivered_stale'));
});

test('Enter failure increments retry, invalid keystroke rejected; valid keystroke always acks', async t => {
  const f = setup(t), row = f.message(); const d = f.create(); const original = f.adapter.sendKeys;
  f.adapter.sendKeys = async () => { throw error('ENTER_UNVERIFIED'); }; await d.deliverConversation(row); assert.equal(f.row(row.id).retry_count, 1);
  f.adapter.sendKeys = original;
  const bad = f.control('[KEYSTROKE]-R'), good = f.control('[KEYSTROKE]Enter');
  await d.deliverControl(bad); await d.deliverControl(good);
  assert.equal(bad.status, 'pending'); assert.equal(good.status, 'done');
});

test('normal active heartbeat autoacks, recovery and post_restart reach runtime', async t => {
  for (const phase of ['normal', 'recovery', 'post_restart']) await t.test(phase, async t => {
    const f = setup(t); f.state.active_tools = 1; const row = f.control(`Heartbeat check [phase=${phase}] ---- ack via: safe`, { bypass_state: 1 });
    await f.create().deliverControl(row);
    assert.equal(row.status, phase === 'normal' ? 'done' : 'running'); assert.equal(f.calls.some(c => c[0] === 'paste'), phase !== 'normal');
  });
});

test('a control typed in as a message records its delivery like a conversation message; keys, slash commands and auto-acknowledged heartbeats do not', async t => {
  const f = setup(t), d = f.create();
  const delivered = () => f.calls.filter(c => c[0] === 'diagnostic' && c[1] === 'deliver').map(c => c[2]);
  const plain = f.control('Name the new conversation'), submitted = f.control('Run Memory Sync ---- ack via: safe');
  await d.deliverControl(plain); await d.deliverControl(submitted);
  assert.equal(plain.status, 'done'); assert.equal(submitted.status, 'running');
  assert.deepEqual(delivered().map(fields => [fields.control_id, fields.sessionId, fields.conversation_id]),
    [[plain.id, 's2', undefined], [submitted.id, 's2', undefined]]);
  f.state.active_tools = 1;
  for (const row of [f.control('[KEYSTROKE]Enter'), f.control('/compact'), f.control('Heartbeat check [phase=normal] ---- ack via: safe', { bypass_state: 1 })]) {
    await d.deliverControl(row);
    assert.equal(row.status, 'done', row.content);
  }
  assert.equal(delivered().length, 2, 'only the two typed messages record a delivery');
});

test('bypass skips health but cannot bypass idle or READY', async t => {
  const f = setup(t); f.state.health = 'unavailable'; f.deps.readRuntimeHealth = () => ({ health: 'down', publicHealth: 'unavailable' });
  const d = f.create(), row = f.control('repair', { bypass_state: 1 }); await d.deliverControl(row); assert.equal(row.status, 'done');
  const idle = f.control('repair', { bypass_state: 1, require_idle: 1 }); f.state.idle_seconds = 0; await d.deliverControl(idle); assert.equal(idle.status, 'pending');
  const unready = f.control('repair', { bypass_state: 1 }); f.target.ready = false; await d.deliverControl(unready); assert.equal(unready.status, 'pending');
});

test('Codex exact /exit permits target disappearance only after successful Enter', async t => {
  for (const variant of ['exit', 'paste', 'enter', 'generation', 'other', 'claude']) await t.test(variant, async t => {
    const f = setup(t); if (variant === 'claude') f.target.runtime = 'claude';
    const row = f.control(variant === 'other' ? '/exit now' : '/exit');
    if (variant === 'paste') f.adapter.sendText = async () => { throw error('PASTE_FAILED'); };
    if (variant === 'enter') f.adapter.sendKeys = async () => { throw error('TARGET_GONE'); };
    else f.connection.command = async () => { throw error(variant === 'generation' ? 'GENERATION_CHANGED' : 'TARGET_GONE'); };
    await f.create().deliverControl(row); assert.equal(row.status, variant === 'exit' ? 'done' : 'pending');
  });
});

test('unverified conversation fails; live control accepted, dead control retried', async t => {
  for (const type of ['conversation', 'live', 'dead']) await t.test(type, async t => {
    const f = setup(t); f.connection.command = async () => '5';
    if (type === 'dead') f.adapter.sendText = async () => { f.state.proc.alive = false; };
    const row = type === 'conversation' ? f.message() : f.control();
    const d = f.create(); await (type === 'conversation' ? d.deliverConversation(row) : d.deliverControl(row));
    assert.equal(type === 'conversation' ? f.row(row.id).status : row.status, type === 'live' ? 'done' : 'pending');
  });
});

test('stop before delivery requeues the claimed row without tmux I/O', async t => {
  for (const type of ['conversation', 'control']) await t.test(type, async t => {
    const f = setup(t), row = type === 'conversation' ? f.message() : f.control();
    f.deps.openTmuxConnection = async () => { f.calls.push(['open']); return f.connection; };
    const delivery = f.create();
    await delivery.stop();
    const result = await (type === 'conversation'
      ? delivery.deliverConversation(row)
      : delivery.deliverControl(row));
    assert.equal(result.delivered, false);
    assert.equal(result.blocked, true);
    assert.equal(type === 'conversation' ? f.row(row.id).status : row.status, 'pending');
    assert.equal(f.calls.some(call => ['open', 'resolve', 'paste', 'keys', 'capture', 'command'].includes(call[0])), false);
    assert.ok(f.calls.some(call => call[0] === 'diagnostic' && call[1] === 'delivery_deferred' && call[2].code === 'delivery_stopped'));
  });
});

test('stop after delivery crosses its entry waits for settlement instead of requeueing', async t => {
  const f = setup(t), row = f.message(), opened = deferred(), releaseOpen = deferred();
  f.deps.openTmuxConnection = async () => { opened.resolve(); await releaseOpen.promise; return f.connection; };
  const delivery = f.create();
  const pending = delivery.deliverConversation(row);
  await opened.promise;
  let stopped = false;
  const stopping = delivery.stop().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  assert.equal(f.row(row.id).status, 'running');
  releaseOpen.resolve();
  await Promise.all([pending, stopping]);
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'requeue'), false);
});

test('a stalled paste does not block another lane', async t => {
  const f = setup(t), a = f.message(), b = f.message('other'); const gate = deferred();
  const original = f.adapter.sendText; let count = 0;
  f.adapter.sendText = async args => { if (++count === 1) await gate.promise; await original(args); };
  const d = f.create(), pending = d.deliverConversation(a); await new Promise(setImmediate);
  await d.deliverConversation(b); assert.equal(f.row(b.id).status, 'delivered'); assert.equal(f.row(a.id).status, 'running');
  gate.resolve(); await pending; assert.equal(f.row(a.id).status, 'delivered');
});

test('byte delay and Claude fallback preserve baseline boundaries', () => {
  assert.equal(getDeliveryDelay(1023), 200); assert.equal(getDeliveryDelay(1024), 300); assert.equal(getDeliveryDelay(100000), 1000);
  assert.equal(checkClaudeFallbackInputBox('not a box'), 'indeterminate');
  assert.equal(checkClaudeFallbackInputBox('──────────\n❯           art\n──────────'), 'empty');
  assert.equal(checkClaudeFallbackInputBox('──────────\n❯ text\n──────────'), 'has_content');
});

// Real delivery and private ledger; run for timer phase/drain changes, skip
// unrelated UI. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR;
// no real tmux or model; teardown releases every held wait and stops delivery.
test('periodic Enter callback during idle settlement drains before ledger', { timeout: 2000 }, async t => {
  const f = setup(t), row = f.message(), periodicStarted = deferred(), hold = deferred(), callback = deferred();
  row.require_idle = 1;
  f.deps.now = Date.now;
  let periodic = false;
  f.deps.diagnostic = (event, fields) => {
    f.calls.push(['diagnostic', event, fields]);
    if (event === 'enter_attempt' && fields.kind === 'periodic') periodic = true;
  };
  f.deps.sleep = async ms => {
    if (ms === 31) await hold.promise;
    else if (ms === 1 && periodic) await callback.promise;
  };
  const send = f.adapter.sendKeys;
  f.adapter.sendKeys = async args => { await send(args); if (periodic) periodicStarted.resolve(); };
  const d = f.create({ periodicEnabled: true, periodicIntervalMs: 5, periodicMaxAttempts: 1, verifyWaitMs: 1, idleHoldMs: 31 });
  t.after(async () => { hold.resolve(); callback.resolve(); await d.stop(); });
  const pending = d.deliverConversation(row);
  await periodicStarted.promise; hold.resolve(); await new Promise(setImmediate);
  assert.equal(f.row(row.id).status, 'running'); assert(!f.calls.some(c => c[0] === 'close'));
  callback.resolve(); await pending; assert.equal(f.row(row.id).status, 'delivered');
  const count = f.calls.filter(c => c[0] === 'keys').length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.calls.filter(c => c[0] === 'keys').length, count);
  assert(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'periodic_sent'));
});

// Real createDelivery, two same-group pastes, inherited deadline. Run when arm,
// schedule or initial verification order changes; skip unrelated paths. Private
// DB/env via official runner, injected terminal, bounded timer and stop cleanup.
test('carried periodic deadline cannot send Enter between paste and initial Enter', { timeout: 2000 }, async t => {
  const f = setup(t), first = f.message(); let clock = 0, secondPaste = false;
  f.deps.now = () => clock;
  f.deps.sleep = async ms => {
    if (ms === 200 && secondPaste) { clock = 5000; await new Promise(resolve => setTimeout(resolve, 80)); }
  };
  const d = f.create({ periodicEnabled: true, periodicIntervalMs: 5000, verifyWaitMs: 1 });
  t.after(() => d.stop());
  await d.deliverConversation(first);
  clock = 4950; const second = f.message(); const start = f.calls.length;
  secondPaste = true; await d.deliverConversation(second);
  assert.equal(f.row(first.id).status, 'delivered'); assert.equal(f.row(second.id).status, 'delivered');
  const events = f.calls.slice(start);
  assert.equal(events.filter(c => c[0] === 'paste').length, 1);
  assert.deepEqual(events.filter(c => c[0] === 'diagnostic' && c[1] === 'enter_attempt').map(c => c[2].kind), ['initial']);
  // The inherited deadline still applies after settlement, rather than being reset.
  await d.maybePeriodicEnter(second.session_group);
  assert.equal(f.calls.filter(c => c[0] === 'diagnostic' && c[1] === 'enter_attempt' && c[2].kind === 'initial').length, 2);
  assert.equal(f.calls.filter(c => c[0] === 'diagnostic' && c[1] === 'periodic_sent').length, 1);
});

// Real group-shared delivery budget and actual control path; run for either
// control reset/periodic changes, skip unrelated UI. Official runner isolates
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, private DB, injected terminal, stop cleanup.
for (const [content, reason] of [['/clear', 'slash_control'], ['[KEYSTROKE]Down', 'keystroke']]) {
  test(`${reason} clears the prior message periodic Enter budget`, async t => {
    const f = setup(t), row = f.message(); let clock = 0;
    f.deps.now = () => clock; f.deps.sleep = async () => {};
    const d = f.create({ periodicEnabled: true, periodicIntervalMs: 5000, verifyWaitMs: 1 });
    t.after(() => d.stop());
    await d.deliverConversation(row);
    assert.ok(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'periodic_armed'));
    const control = f.control(content, { session_group: row.session_group });
    clock = 4950; await d.deliverControl(control); assert.equal(control.status, 'done');
    assert.ok(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'periodic_disarmed' && c[2].reason === reason));
    const keys = f.calls.filter(c => c[0] === 'keys').length;
    clock = 10000; await d.maybePeriodicEnter(row.session_group);
    assert.equal(f.calls.filter(c => c[0] === 'keys').length, keys);
    assert.equal(f.calls.filter(c => c[0] === 'diagnostic' && c[1] === 'periodic_sent').length, 0);
  });
}

test('require_idle retains running row during hold while a second lane settles', async t => {
  const f = setup(t), a = f.message(), b = f.message('other'), hold = deferred(), holding = deferred(); a.require_idle = 1;
  f.deps.sleep = async ms => { if (ms === 5000) { holding.resolve(); await hold.promise; } };
  const d = f.create(), pending = d.deliverConversation(a); await holding.promise;
  await d.deliverConversation(b); assert.equal(f.row(a.id).status, 'running'); assert.equal(f.row(b.id).status, 'delivered');
  hold.resolve(); await pending; assert.equal(f.row(a.id).status, 'delivered');
});

// I2 R6: a successful body must settle even when final F3 cannot identify it.
for (const reason of ['missing', 'run_mismatch', 'read_failed']) {
  test(`final F3 ${reason} settles delivered with NULL identity and no replay`, async t => {
    const f = setup(t), row = f.message();
    f.deps.readCurrentSession = async () => {
      if (reason === 'read_failed') throw error('EIO');
      return reason === 'missing' ? null : { runId: 'other', sessionId: 'other' };
    };
    await f.create().deliverConversation(row);
    assert.equal(f.row(row.id).status, 'delivered');
    assert.equal(f.row(row.id).session_id, null);
    assert.equal(f.row(row.id).retry_count, 0);
    assert.equal(f.store.getNextPending(), null);
    assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
    assert.equal(f.calls.some(c => ['failDelivery', 'requeue'].includes(c[0])), false);
    assert.ok(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'delivery_identity_lost' && c[2].reason === reason));
  });
}

test('F4 reader failure is offline, while valid READY bypass control can recover', async t => {
  const f = setup(t), row = f.message();
  f.deps.readSessionState = async () => { throw error('TMUX_UNAVAILABLE'); };
  const d = f.create(); await d.deliverConversation(row);
  assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
  const control = f.control('[KEYSTROKE]Enter', { bypass_state: 1 }); await d.deliverControl(control); assert.equal(control.status, 'done');
});

// actual delivery decisions through the real diagnostic writer and JSONL file.
test('JSONL records successful settlement, stale settlement and distinct gate releases', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-jsonl-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'router-events.jsonl');
  const diagnostics = createRouterDiagnostics({ stream: createJsonlStream(file),
    receiveStream: createJsonlStream(path.join(directory, 'receive-events.jsonl')) });
  const f = setup(t); f.deps.diagnostic = diagnostics.diagnostic;
  const delivery = f.create(), success = f.message();
  await delivery.deliverConversation(success);
  const stale = f.message();
  const paste = f.adapter.sendText;
  f.adapter.sendText = async args => { await paste(args); f.db.markDelivered(stale.id, { sessionId: 'other' }); };
  await delivery.deliverConversation(stale);
  f.adapter.sendText = paste;
  const gated = f.message();
  for (const kind of ['session', 'runtime', 'idle']) {
    f.state.health = kind === 'session' ? 'recovering' : 'ok';
    f.deps.readRuntimeHealth = () => ({ publicHealth: kind === 'runtime' ? 'unavailable' : 'ok' });
    gated.require_idle = kind === 'idle' ? 1 : 0; f.state.idle_seconds = 0;
    await delivery.deliverConversation(gated);
    assert.equal(f.row(gated.id).status, 'pending');
    assert.equal(f.row(gated.id).retry_count, 0);
    if (kind !== 'idle') assert(f.store.claimConversation(gated.id));
  }
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  const delivered = rows.filter(row => row.event === 'deliver');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].conversation_id, success.id);
  assert.equal(delivered[0].decision, 'deliver'); assert.equal(delivered[0].session_id, 's2');
  const lost = rows.filter(row => row.event === 'mark_delivered_stale');
  assert.equal(lost.length, 1); assert.equal(lost[0].conversation_id, stale.id);
  assert.equal(f.row(stale.id).session_id, 'other');
  const waits = rows.filter(row => ['delivery_deferred', 'delivery_wait_changed'].includes(row.event));
  assert.deepEqual(waits.map(row => row.code), ['session_unhealthy', 'runtime_unavailable', 'require_idle']);
  assert.deepEqual(waits.map(row => row.reason), ['session_recovering', 'runtime_unavailable', 'require_idle']);
  for (const row of waits) {
    assert.equal(row.decision, row.event); assert.ok(row.attempts >= 1); assert.ok(row.durationMs >= 0);
    assert.equal(row.conversation_id, gated.id); assert.equal(row.session_group, gated.session_group);
  }
});

// I2 R7: a delayed Enter failure must not replay an already verified body.
test('periodic Enter failure after verified delivery drains without requeue or duplicate paste', {timeout:15000}, async t => {
  const f = setup(t), row = f.message(), holding = deferred(), releaseHold = deferred(), periodicStarted = deferred(), releasePeriodic = deferred();
  row.require_idle = 1;
  f.deps.now = Date.now;
  f.deps.sleep = async ms => { if (ms === 5000) { holding.resolve(); await releaseHold.promise; } };
  let keys = 0;
  f.adapter.sendKeys = async args => {
    f.calls.push(['keys', args]);
    if (++keys === 2) { periodicStarted.resolve(); await releasePeriodic.promise; throw error('ENTER_UNVERIFIED'); }
  };
  const d = f.create({periodicEnabled:true, periodicIntervalMs:5, periodicMaxAttempts:1});
  const pending = d.deliverConversation(row);
  await holding.promise; await periodicStarted.promise;
  releaseHold.resolve(); await new Promise(setImmediate);
  assert.equal(f.row(row.id).status, 'running');
  assert.equal(f.calls.some(c=>c[0]==='close'), false);
  releasePeriodic.resolve(); await pending;
  const firstStatus=f.row(row.id).status, next=f.store.getNextPending();
  if (next && f.store.claimConversation(next.id)) await d.deliverConversation(next);
  t.diagnostic(JSON.stringify({firstStatus, retryCount:f.row(row.id).retry_count, pasteCount:f.calls.filter(c=>c[0]==='paste').length}));
  assert.equal(firstStatus, 'delivered');
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(f.row(row.id).retry_count, 0);
  assert.equal(f.calls.some(c=>c[0]==='failDelivery'), false);
  assert.equal(f.store.getNextPending(), null);
  assert.equal(f.calls.filter(c=>c[0]==='paste').length, 1);
  assert.ok(f.calls.some(c=>c[0]==='diagnostic' && c[1]==='periodic_failed'));
  const count=keys; await new Promise(resolve=>setTimeout(resolve,15)); assert.equal(keys,count);
});

for (const stopAt of ['idle hold', 'before idle hold', 'idle poll']) {
  test(`stop during ${stopAt} cancels queue pacing but drains verification and ledger`, { timeout: 3000 }, async t => {
    const f = setup(t), row = f.message(), entered = deferred(), releaseVerify = deferred();
    row.require_idle = 1;
    const timers = new Set(); let idleWaits = 0, abortedWaits = 0, verified = false;
    f.deps.now = Date.now;
    f.deps.sleep = (ms, signal) => {
      if (!signal) {
        if (ms === 500 && !verified) { entered.resolve(); return releaseVerify.promise.then(() => { verified = true; }); }
        return Promise.resolve();
      }
      idleWaits++;
      if (stopAt === 'idle poll' && idleWaits === 1) { f.state.state = 'running'; return Promise.resolve(); }
      entered.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.add(timer);
        signal.addEventListener('abort', () => {
          clearTimeout(timer); timers.delete(timer); abortedWaits++;
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true });
      });
    };
    const delivery = f.create({ idleHoldMs: 60000, idlePollMs: 60000 });
    const pending = delivery.deliverConversation(row);
    t.after(async () => { releaseVerify.resolve(); for (const timer of timers) clearTimeout(timer); await delivery.stop(); });
    await entered.promise;
    if (stopAt !== 'before idle hold') {
      releaseVerify.resolve();
      for (let i = 0; timers.size === 0 && i < 30; i++) await new Promise(setImmediate);
      assert.equal(timers.size, 1, 'queue pacing timer must actually be active');
    }
    assert.equal(f.row(row.id).status, 'running');
    const stopping = delivery.stop();
    if (stopAt === 'before idle hold') {
      await new Promise(setImmediate);
      assert.equal(f.row(row.id).status, 'running', 'stop cannot skip in-flight verification');
      assert.equal(f.calls.some(call => call[0] === 'close'), false);
      releaseVerify.resolve();
    }
    await Promise.all([pending, stopping]);
    assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).retry_count, 0);
    assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
    assert.equal(timers.size, 0, 'stop must clear the underlying idle timer');
    assert.equal(abortedWaits, stopAt === 'before idle hold' ? 0 : 1);
    assert.equal(idleWaits, stopAt === 'before idle hold' ? 0 : stopAt === 'idle poll' ? 2 : 1);
    assert.equal(verified, true);
    const order = f.calls.map(call => call[0]);
    assert.ok(order.indexOf('close') < order.indexOf('markDelivered'));
  });
}


test('actual control text paste reports bound control identity immediately without waiting for notification', async t => {
  const f = setup(t), row = f.control('ordinary control ---- ack via: safe');
  f.deps.notifyDelivered = data => { f.calls.push(['notify', data]); return new Promise(() => {}); };
  await f.create().deliverControl(row);
  assert.equal(row.status, 'running');
  const order = f.calls.map(call => call[0]);
  assert.ok(order.indexOf('paste') < order.indexOf('notify'));
  assert.ok(order.indexOf('notify') < order.indexOf('keys'));
  assert.deepEqual(f.calls.find(call => call[0] === 'notify')[1], {
    controlId: row.id, sessionGroup: 'origin', runId: 'r1', runtime: 'codex', pastedAt: 100000,
  });
});

test('no-paste controls and failed text paste never emit a delivery notification', async t => {
  for (const variant of ['autoack', 'keystroke', 'paste_failed']) await t.test(variant, async t => {
    const f = setup(t);
    let row;
    if (variant === 'autoack') {
      f.state.active_tools = 1;
      row = f.control('Heartbeat check [phase=normal] ---- ack via: safe', { bypass_state: 1 });
    } else if (variant === 'keystroke') row = f.control('[KEYSTROKE]Enter');
    else {
      row = f.control('ordinary control');
      f.adapter.sendText = async () => { throw error('TARGET_GONE'); };
    }
    await f.create().deliverControl(row);
    assert.equal(f.calls.some(call => call[0] === 'notify'), false);
  });
});
