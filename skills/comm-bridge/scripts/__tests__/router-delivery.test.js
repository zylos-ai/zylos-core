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

// T04 / IB-11, IB-12, IB-13: actual conditional ledger with bound I/O fixture.
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

// T04 delayed callback drain: independently held callback cannot outlive ledger.
test('periodic Enter callback is drained before ledger; no delayed send survives settlement', async t => {
  const f = setup(t), row = f.message(), pasteWait = deferred(), periodicStarted = deferred(), callbackWait = deferred();
  f.deps.now = Date.now;
  let firstDelay = true, firstVerify = true;
  f.deps.sleep = async ms => {
    if (ms === 200 && firstDelay) { firstDelay = false; await pasteWait.promise; }
    else if (ms === 1 && firstVerify) { firstVerify = false; await callbackWait.promise; }
  };
  const send = f.adapter.sendKeys;
  f.adapter.sendKeys = async args => { await send(args); periodicStarted.resolve(); };
  const d = f.create({ periodicEnabled: true, periodicIntervalMs: 5, periodicMaxAttempts: 1, verifyWaitMs: 1 });
  const pending = d.deliverConversation(row);
  await periodicStarted.promise; pasteWait.resolve(); await new Promise(setImmediate);
  assert.equal(f.row(row.id).status, 'running'); assert(!f.calls.some(c => c[0] === 'close'));
  callbackWait.resolve(); await pending; assert.equal(f.row(row.id).status, 'delivered');
  const count = f.calls.filter(c => c[0] === 'keys').length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.calls.filter(c => c[0] === 'keys').length, count);
  assert(f.calls.some(c => c[0] === 'diagnostic' && c[1] === 'periodic_sent'));
});

test('require_idle retains running row during hold while a second lane settles', async t => {
  const f = setup(t), a = f.message(), b = f.message('other'), hold = deferred(), holding = deferred(); a.require_idle = 1;
  f.deps.sleep = async ms => { if (ms === 5000) { holding.resolve(); await hold.promise; } };
  const d = f.create(), pending = d.deliverConversation(a); await holding.promise;
  await d.deliverConversation(b); assert.equal(f.row(a.id).status, 'running'); assert.equal(f.row(b.id).status, 'delivered');
  hold.resolve(); await pending; assert.equal(f.row(a.id).status, 'delivered');
});

test('explicit no server on opening is absent target and makes directed control stale', async t => {
  const f = setup(t), row = f.control('x', { target_binding: '{}' });
  f.deps.openTmuxConnection = async () => { throw error('TMUX_NO_SERVER'); };
  await f.create().deliverControl(row); assert.equal(row.status, 'timeout');
});

test('missing or other-run final F3 retains running ledger and never invents a session id', async t => {
  for (const ready of [null, { runId: 'other', sessionId: 'other' }]) {
    const f = setup(t), row = f.message(); f.deps.readCurrentSession = async () => ready;
    await assert.rejects(f.create().deliverConversation(row), { code: 'READY_IDENTITY_LOST' });
    assert.equal(f.row(row.id).status, 'running'); assert.equal(f.row(row.id).session_id, null);
    assert.equal(f.calls.filter(c => c[0] === 'paste').length, 1);
  }
});

test('F4 reader failure is offline, while valid READY bypass control can recover', async t => {
  const f = setup(t), row = f.message();
  f.deps.readSessionState = async () => { throw error('TMUX_UNAVAILABLE'); };
  const d = f.create(); await d.deliverConversation(row);
  assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
  const control = f.control('[KEYSTROKE]Enter', { bypass_state: 1 }); await d.deliverControl(control); assert.equal(control.status, 'done');
});

// T07: actual delivery decisions through the real diagnostic writer and JSONL file.
test('T07 JSONL records successful settlement, stale settlement and distinct gate releases', async t => {
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
  await diagnostics.flush();
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  const delivered = rows.filter(row => row.event === 'deliver');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].conversation_id, success.id);
  assert.equal(delivered[0].decision, 'deliver'); assert.equal(delivered[0].session_id, 's2');
  const lost = rows.filter(row => row.event === 'mark_delivered_stale');
  assert.equal(lost.length, 1); assert.equal(lost[0].conversation_id, stale.id);
  assert.equal(f.row(stale.id).session_id, 'other');
  const releases = rows.filter(row => row.event === 'release');
  assert.deepEqual(releases.map(row => row.code), ['session_unhealthy', 'runtime_unavailable', 'require_idle']);
  for (const row of releases) {
    assert.equal(row.decision, 'release'); assert.equal(row.reason, row.code);
    assert.equal(row.conversation_id, gated.id); assert.equal(row.session_group, gated.session_group);
  }
});
