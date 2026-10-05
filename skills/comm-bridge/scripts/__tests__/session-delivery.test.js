import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createTmuxSender, tmuxFailureDetails } from '../tmux-send-keys.js';
import { PeriodicEnter } from '../periodic-enter.js';

const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
function extract(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, start);
  const limit = source.indexOf(end, offset);
  assert.ok(limit > offset, end);
  return source.slice(offset, limit);
}

function harness(bracketed = false) {
  const state = { checks: [], captures: [], events: [], commands: [], verdict: 'empty', waits: 0, time: 0 };
  const context = vm.createContext({
    Buffer, process, Date, Error,
    ACTIVE_RUNTIME: 'claude', TMUX_SESSION: 'isolated',
    BRACKETED_PASTE_ENABLED: bracketed, ENTER_CAPTURE_ENABLED: true,
    deliveryTrace: {}, captureCapacityReported: false,
    readFileSync: () => { throw new Error('filesystem identity lookup is forbidden'); },
    ENTER_VERIFY_MAX_RETRIES: 3, ENTER_VERIFY_WAIT_MS: 500, isShuttingDown: false,
    PERIODIC_ENTER_ENABLED: true, PERIODIC_ENTER_INTERVAL_MS: 60000, PERIODIC_ENTER_MAX_ATTEMPTS: 3,
    PeriodicEnter: class extends PeriodicEnter { constructor(options) { super({ ...options, now: () => state.time }); } },
    execFileSync: (binary, args) => {
      assert.equal(binary, 'tmux');
      state.commands.push({ binary, args });
      state.onCommand?.(args);
      return args[0] === 'capture-pane' ? 'overlay' : '';
    },
    sanitizeMessage: value => value, getDeliveryDelay: () => 200,
    trace: (event, metadata) => state.events.push({ event, ...metadata }),
    saveEnterCapture: (capture, phase, metadata) => { state.captures.push({ capture, phase, ...metadata }); return 'saved'; },
    checkInputBox: target => { state.checks.push(target); return state.verdict; },
    isUsageOverlayCapture: () => true,
    log: () => {}, logDeliveryFailure: () => {},
    readProcState: () => ({ alive: true }), getAgentState: () => ({ state: 'idle' }),
    sleep: async () => { state.waits++; state.onWait?.(state.waits); }
  });
  context.tmuxFailureDetails = tmuxFailureDetails;
  context.sendTmuxKeys = createTmuxSender({ exec: (binary, args, options) =>
    args[0] === '-V' ? 'tmux 3.7c' : context.execFileSync(binary, args, options) }).sendKeys;
  vm.runInContext([
    extract('const periodicEnter =', 'export function notifyMessageDelivered('),
    extract('async function submitAndVerify(', 'export function isBypassState(')
  ].join('\n'), context);
  return { state, context, timer: vm.runInContext('periodicEnter', context), deliver: options => context.sendToTmux('private multiline\ninput', { itemId: 42, itemType: 'conversation', strictVerify: true, ...options }) };
}

test('normal delivery uses the session and enables bracketed paste only when configured', async () => {
  for (const enabled of [false, true]) {
    const { state, deliver } = harness(enabled);
    assert.equal(await deliver(), 'submitted');
    const writes = state.commands.filter(command => ['paste-buffer', 'send-keys'].includes(command.args[0]));
    assert.equal(writes.length, 2);
    assert.deepEqual(Array.from(writes[1].args.slice(0, 3)), ['send-keys', '-c', 'zylos-no-client']);
    for (const { args } of writes) assert.equal(args[args.indexOf('-t') + 1], 'isolated');
    assert.equal(writes[0].args.includes('-p'), enabled);
    assert.ok(state.checks.every(target => target === undefined || target === 'isolated'));
    const captures = state.commands.filter(command => ['capture-pane', 'display-message'].includes(command.args[0]));
    assert.ok(captures.length >= 2);
    assert.ok(captures.every(({ args }) => args[args.indexOf('-t') + 1] === 'isolated'));
  }
});

test('delivery and periodic supplementation require no filesystem or process identity lookup', async () => {
  const { state, context, timer, deliver } = harness();
  context.readProcState = context.getAgentState = () => { throw new Error('runtime lookup is forbidden'); };
  assert.equal(await deliver(), 'submitted');
  state.time = 60000;
  await context.maybePeriodicEnter();
  assert.equal(timer.pending.attempts, 1);
  assert.equal(state.events.some(event => event.event === 'periodic_sent'), true);
});

test('lifecycle exit retains permissive shutdown handling while other controls fail offline', async () => {
  for (const acceptShutdownAfterSubmit of [false, true]) {
    const { state, context, timer } = harness();
    state.verdict = 'indeterminate';
    context.isUsageOverlayCapture = () => false;
    context.readProcState = () => ({ alive: false });
    context.getAgentState = () => ({ state: 'stopped' });
    const result = await context.sendToTmux('/exit', {
      itemId: 44, itemType: 'control', strictVerify: false, acceptShutdownAfterSubmit
    });
    assert.equal(result, acceptShutdownAfterSubmit ? 'submitted' : 'verify_failed');
    assert.equal(timer.pending, null);
    assert.equal(state.commands.filter(command => command.args[0] === 'send-keys').length, 1);
  }
});

test('verification retries and overlay Escape use the session', async () => {
  for (const verdict of ['has_content', 'indeterminate']) {
    const { state, deliver } = harness();
    state.verdict = verdict;
    state.onWait = count => { if (count === 3) state.verdict = 'empty'; };
    assert.equal(await deliver(), 'submitted');
    const keys = state.commands.filter(command => command.args[0] === 'send-keys');
    assert.equal(keys.length, 2);
    assert.ok(keys.every(command => command.args[command.args.indexOf('-t') + 1] === 'isolated'));
    assert.equal(keys[1].args.at(-1), verdict === 'has_content' ? 'Enter' : 'Escape');
  }
});

test('verified-empty delivery retains three blind attempts without consulting runtime state', async () => {
  const { state, context, timer, deliver } = harness();
  assert.equal(await deliver(), 'submitted');
  assert.equal(timer.pending.itemId, 42);
  context.getAgentState = context.readProcState = context.checkInputBox = () => { throw new Error('no health, idle or empty gate allowed'); };
  for (let i = 0; i < 5; i++) {
    state.time += 60000;
    await context.maybePeriodicEnter();
    await context.maybePeriodicEnter();
  }
  assert.equal(timer.pending.attempts, 3);
  const keys = state.commands.filter(command => command.args[0] === 'send-keys');
  assert.equal(keys.length, 4);
  assert.ok(keys.every(command => command.args[command.args.indexOf('-t') + 1] === 'isolated'));
  assert.equal(state.captures.at(-1).itemId, 42);
});

test('temporary session loss consumes an attempt without cancelling the remaining budget', async () => {
  const { state, context, timer, deliver } = harness();
  await deliver();
  state.onCommand = args => { if (args[0] === 'send-keys') throw new Error('session unavailable'); };
  state.time = 60000;
  await context.maybePeriodicEnter();
  assert.equal(timer.pending.attempts, 1);
  state.onCommand = undefined;
  for (let i = 0; i < 4; i++) { state.time += 60000; await context.maybePeriodicEnter(); }
  assert.equal(timer.pending.attempts, 3);
  assert.equal(state.events.filter(event => event.event === 'periodic_failed').length, 1);
  assert.equal(state.events.filter(event => event.event === 'periodic_sent').length, 2);
});

test('periodic send failure is bounded and preserves original item diagnostics', async () => {
  const { state, context, timer, deliver } = harness();
  await deliver();
  state.onCommand = args => { if (args[0] === 'send-keys') throw new Error('private input'); };
  for (let i = 0; i < 5; i++) {
    state.time += 60000;
    await context.maybePeriodicEnter();
    await context.maybePeriodicEnter();
  }
  assert.equal(timer.pending.attempts, 3);
  const failures = state.events.filter(event => event.event === 'enter_failed');
  assert.equal(failures.length, 3);
  assert.ok(failures.every(event => event.itemId === 42 && event.itemType === 'conversation'));
  assert.equal(JSON.stringify(state.events).includes('private input'), false);
});

test('text probes arm while slash and keystroke controls clear budget', async () => {
  const { timer, deliver } = harness();
  await deliver({ itemType: 'control', periodicTextControl: true, itemId: 43 });
  assert.equal(timer.pending.itemId, 43);
  assert.equal(timer.pending.itemType, 'control');
  await deliver({ itemType: 'control', periodicTextControl: false, itemId: 44 });
  assert.equal(timer.pending, null);
  const keyBranch = extract('if (isKeystrokeControl(item))', "log(`Delivering ${item.type}");
  assert.ok(keyBranch.includes("periodicEnter.reset('keystroke_control')"));
});

test('actual loop awaits complete delivery before periodic supplementation', async () => {
  const { state, context } = harness();
  const order = [];
  Object.assign(context, {
    pollInterval: 1000, POLL_INTERVAL_BASE: 1000, POLL_INTERVAL_MAX: 3000,
    processNextMessage: async () => {
      order.push('delivery-start');
      await context.sendToTmux('message', { itemType: 'conversation', itemId: 4 });
      order.push('delivery-end');
      return { delivered: true, state: 'busy' };
    },
    maybePeriodicEnter: async () => { order.push('timer'); context.isShuttingDown = true; }
  });
  vm.runInContext(extract('async function dispatcherLoop(', 'function shutdown('), context);
  await context.dispatcherLoop();
  assert.deepEqual(order, ['delivery-start', 'delivery-end', 'timer']);
  assert.ok(state.commands.some(command => command.args[0] === 'paste-buffer'));
});
