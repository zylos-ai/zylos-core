import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ATTACHMENTS_DIR } from '../c4-config.js';
import { createDelivery } from '../router/delivery.js';
import { formatConversation } from '../router/format.js';
import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import { fixture } from './c4-v2-test-helpers.js';
const error = code => Object.assign(new Error(code), { code });
function setup(t, options = {}) {
  const f = fixture(t), calls = [], sleeps = [];
  const target = { ready: true, runtime: 'codex', runId: 'r1', sessionId: '$1', paneId: '%1', serverGeneration: '1:1', runtimeSessionId: 's1' };
  let time = 100000;
  const state = { state: 'idle', idle_seconds: 4, health: 'ok', proc: { alive: true }, active_tools: 0, last_api_activity: 100 };
  const connection = { close: async () => calls.push(['close']), command: async args => { calls.push(['command', args]); return args.at(-1) === '#{cursor_x}' ? '2' : '0'; } };
  const adapter = {
    sendText: async args => { assert.equal(args.runtime, target.runtime); calls.push(['paste', args]); },
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
    session: adapter,
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

test('real-time delivery spills only above the target runtime paste threshold', async t => {
  const f = setup(t);
  const runtime = await getRuntime('claude');
  f.target.runtime = runtime.id;
  f.deps.findRuntime = async id => {
    assert.equal(id, runtime.id);
    return { ...runtime, input: { ...runtime.input, pasteCharThreshold: 5 } };
  };
  f.deps.formatConversation = formatConversation;
  const delivery = f.create();
  t.after(() => delivery.stop());

  const atLimit = { ...f.message(), content: 'abcde', endpoint_id: null };
  const aboveLimit = { ...f.message(), content: 'abcdef', endpoint_id: null };
  const atLimitDir = path.join(ATTACHMENTS_DIR, 'conv-' + atLimit.id);
  const aboveLimitDir = path.join(ATTACHMENTS_DIR, 'conv-' + aboveLimit.id);
  t.after(() => Promise.all([atLimitDir, aboveLimitDir].map(dir => fs.rm(dir, { recursive: true, force: true }))));

  assert.equal((await delivery.deliverConversation(atLimit)).delivered, true);
  assert.equal((await delivery.deliverConversation(aboveLimit)).delivered, true);
  const [first, second] = f.calls.filter(([kind]) => kind === 'paste').map(([, args]) => args.text);
  assert.equal(first, 'abcde');
  await assert.rejects(fs.stat(atLimitDir), { code: 'ENOENT' });
  assert.ok(second.includes('[C4] ⚠️ TRUNCATED'));
  assert.equal(await fs.readFile(path.join(aboveLimitDir, 'message.txt'), 'utf8'), 'abcdef');
});

test('single targets Origin and withholds delivery on unknown runtime, missing READY or invalid status', async t => {
  for (const kind of ['unknown', 'ready', 'invalid']) await t.test(kind, async t => {
    const f = setup(t), row = f.message(); f.deps.getSessionMode = () => 'single';
    if (kind === 'unknown') f.target.runtime = 'unknown';
    if (kind === 'ready') f.target.ready = false;
    if (kind === 'invalid') f.deps.readSessionState = async () => ({ status: { valid: false } });
    await f.create().deliverConversation(row);
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
    assert.equal(f.calls.find(c => c[0] === 'resolve')[1], 'origin'); assert(!f.calls.some(c => c[0] === 'paste'));
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

test('normal active heartbeat autoacks, recovery and post_restart reach runtime', async t => {
  for (const phase of ['normal', 'recovery', 'post_restart']) await t.test(phase, async t => {
    const f = setup(t); f.state.active_tools = 1; const row = f.control(`Heartbeat check [phase=${phase}] ---- ack via: safe`, { bypass_state: 1 });
    await f.create().deliverControl(row);
    assert.equal(row.status, phase === 'normal' ? 'done' : 'running'); assert.equal(f.calls.some(c => c[0] === 'paste'), phase !== 'normal');
  });
});

test('exact lifecycle /exit permits target disappearance only after successful Enter on the bound run', async t => {
  for (const runtime of ['claude', 'codex']) for (const scope of ['single', 'origin', 'group']) {
    for (const variant of ['exit', 'paste', 'before_enter', 'enter', 'generation', 'run', 'other']) {
      await t.test(`${runtime} ${scope} ${variant}`, async t => {
        const f = setup(t); f.target.runtime = runtime;
        f.deps.getSessionMode = () => scope === 'single' ? 'single' : 'multi';
        const group = scope === 'group' ? 'telegram-test' : 'origin';
        const row = f.control(variant === 'other' ? '/exit now' : '/exit', { session_group: group });
        if (variant === 'paste' || variant === 'before_enter') {
          f.adapter.sendText = async () => { throw error(variant === 'paste' ? 'PASTE_FAILED' : 'TARGET_GONE'); };
        }
        if (variant === 'enter') f.adapter.sendKeys = async () => { throw error('TARGET_GONE'); };
        else f.connection.command = async () => {
          throw error(variant === 'generation' ? 'GENERATION_CHANGED' : variant === 'run' ? 'RUNID_MISMATCH' : 'TARGET_GONE');
        };
        await f.create().deliverControl(row);
        assert.equal(row.status, variant === 'exit' ? 'done' : 'pending');
        assert.equal(f.calls.find(c => c[0] === 'resolve')[1], group);
        const entered = f.calls.some(c => c[0] === 'keys' && c[1].keys.includes('Enter'));
        assert.equal(entered, !['paste', 'before_enter', 'enter'].includes(variant));
        for (const [kind, args] of f.calls) if (['paste', 'keys'].includes(kind)) {
          assert.equal(args.target, f.target); assert.equal(args.target.runId, 'r1');
          assert.equal(args.connection, f.connection);
        }
      });
    }
  }
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

test('only a committed terminal Enter failure notifies the supervisor with the pasted run identity', async t => {
  const f = setup(t), row = f.message(), notifications = [];
  f.adapter.sendKeys = async () => { throw error('ENTER_UNVERIFIED'); };
  f.deps.notifyDeliveryFailed = fact => {
    notifications.push({ fact, status: f.row(row.id).status, lastCall: f.calls.at(-1)[0] });
    return Promise.reject(new Error('supervisor unavailable'));
  };
  const delivery = f.create();
  await delivery.deliverConversation(row);
  assert.deepEqual(notifications, [], 'a retryable failure cannot trigger a restart');
  assert.equal(f.store.claimConversation(row.id), true);
  await delivery.deliverConversation(row);
  assert.deepEqual(notifications, [{ status: 'failed', lastCall: 'failDelivery', fact: {
    conversationId: row.id, sessionGroup: row.session_group, runId: 'r1', sessionId: 's1',
    runtime: 'codex', pastedAt: f.calls.filter(c => c[0] === 'notify').at(-1)[1].pastedAt } }]);
  await delivery.deliverConversation(row);
  assert.equal(notifications.length, 1, 'a lost conditional transition cannot repeat the notification');
  assert.equal(f.row(row.id).retry_count, 2);
});
