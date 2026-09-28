import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { PeriodicEnter } from '../periodic-enter.js';

const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
function extract(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function harness() {
  const state = { selected: '%7', pid: 123, start: 777, alive: true, checks: [], captures: [], events: [], commands: [], verdict: 'empty', waits: 0, time: 0 };
  const context = vm.createContext({
    Buffer, process, Date, Error, path,
    ACTIVE_RUNTIME: 'claude', TMUX_SESSION: 'isolated',
    ENTER_VERIFY_MAX_RETRIES: 3, ENTER_VERIFY_WAIT_MS: 500, isShuttingDown: false,
    PERIODIC_ENTER_ENABLED: true, PERIODIC_ENTER_INTERVAL_MS: 60000, PERIODIC_ENTER_MAX_ATTEMPTS: 3,
    PeriodicEnter: class extends PeriodicEnter { constructor(options) { super({ ...options, now: () => state.time }); } },
    readActiveRuntime: () => 'claude', existsSync: () => state.alive,
    readFileSync: file => {
      if (state.readError) throw state.readError;
      if (file.includes('/123/') && file.endsWith('stat') && !state.alive) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (file.endsWith('cmdline')) return file.includes('/100/') ? '/bin/bash\0' : '/bin/claude\0';
      return `123 (runtime) S ${Array(18).fill('0').join(' ')} ${state.start} 0`;
    },
    execFileSync: (binary, args) => {
      state.commands.push({ binary, args });
      if (binary === 'pgrep') { if (state.pgrepError) throw state.pgrepError; return String(state.pid); }
      if (state.tmuxError) throw state.tmuxError;
      if (args[0] === 'list-panes') return state.paneList ?? '%7';
      if (args[0] === 'display-message') {
        if (state.displayError) throw state.displayError;
        const target = args[args.indexOf('-t') + 1];
        const pane = target === 'isolated' ? state.selected : target;
        return `${pane} 100 ${state.alive ? 0 : 1}`;
      }
      if (args[0] === 'capture-pane') return 'overlay';
      state.onCommand?.(args);
      return '';
    },
    sanitizeMessage: value => value, getDeliveryDelay: () => 200,
    trace: (event, metadata) => state.events.push({ event, ...metadata }),
    captureEnter: (phase, target, metadata) => { state.checks.push(target); state.captures.push({ phase, target, ...metadata }); },
    checkInputBox: target => { state.checks.push(target); return state.verdict; },
    isUsageOverlayCapture: () => true,
    log: () => {}, logDeliveryFailure: () => {},
    readProcState: () => ({ alive: true }), getAgentState: () => ({ state: 'idle' }),
    sleep: async () => { state.waits++; state.onWait?.(state.waits); }
  });
  vm.runInContext([
    extract('function resolveDeliveryTarget(', 'function captureEnter('),
    extract('function assertDeliveryTarget(', 'export function notifyMessageDelivered('),
    extract('async function submitAndVerify(', 'export function isBypassState(')
  ].join('\n'), context);
  return { state, context, timer: vm.runInContext('periodicEnter', context), deliver: options => context.sendToTmux('private multiline\ninput', { itemId: 42, itemType: 'conversation', strictVerify: true, ...options }) };
}

test('normal delivery pins paste, Enter and verification despite selected-pane switch', async () => {
  const { state, deliver } = harness();
  state.onCommand = args => { if (args[0] === 'paste-buffer') state.selected = '%8'; };
  assert.equal(await deliver(), 'submitted');
  const writes = state.commands.filter(command => ['paste-buffer', 'send-keys'].includes(command.args[0]));
  assert.equal(writes.length, 2);
  for (const { args } of writes) assert.equal(args[args.indexOf('-t') + 1], '%7');
  assert.ok(writes[0].args.includes('-p'));
  assert.deepEqual(state.checks, ['%7', '%7']);
});

test('replacement between paste and initial Enter stops before any key', async () => {
  const { state, deliver } = harness();
  state.onWait = () => { state.pid = 456; };
  assert.equal(await deliver(), 'verify_failed');
  assert.equal(state.commands.filter(command => command.args[0] === 'send-keys').length, 0);
});

test('same PID with a new start time cannot pass post-Enter verification', async () => {
  const { state, deliver } = harness();
  state.onWait = count => { if (count === 2) state.start++; };
  assert.equal(await deliver(), 'verify_failed');
  assert.deepEqual(state.checks, []);
});

test('identity unavailable before paste fails without writing text or keys', async () => {
  const { state, deliver } = harness();
  state.alive = false;
  assert.equal(await deliver(), 'paste_error');
  assert.equal(state.commands.some(command => ['paste-buffer', 'send-keys'].includes(command.args[0])), false);
});

test('replacement during set-buffer stops paste', async () => {
  const { state, deliver } = harness();
  state.onCommand = args => { if (args[0] === 'set-buffer') state.pid++; };
  assert.equal(await deliver(), 'paste_error');
  assert.equal(state.commands.some(command => command.args[0] === 'paste-buffer'), false);
});

test('retry Enter stays on pinned pane and revalidates immediately before key', async () => {
  const { state, deliver } = harness();
  state.verdict = 'has_content';
  state.onWait = count => { if (count === 2) state.selected = '%8'; if (count === 3) state.verdict = 'empty'; };
  assert.equal(await deliver(), 'submitted');
  const keys = state.commands.filter(command => command.args[0] === 'send-keys');
  assert.equal(keys.length, 2);
  assert.ok(keys.every(command => command.args[2] === '%7'));
});

test('overlay Escape and capture use pinned pane', async () => {
  const { state, deliver } = harness();
  state.verdict = 'indeterminate';
  state.onWait = count => { if (count === 2) state.selected = '%8'; if (count === 3) state.verdict = 'empty'; };
  assert.equal(await deliver(), 'submitted');
  const escape = state.commands.find(command => command.args.includes('Escape'));
  assert.equal(escape.args[2], '%7');
  const capture = state.commands.find(command => command.args[0] === 'capture-pane');
  assert.equal(capture.args[3], '%7');
});

test('runtime replacement detected after capture prevents Escape', async () => {
  const { state, context, deliver } = harness();
  state.verdict = 'indeterminate';
  context.isUsageOverlayCapture = () => { state.pid++; return true; };
  assert.equal(await deliver(), 'verify_failed');
  assert.equal(state.commands.some(command => command.args.includes('Escape')), false);
});

test('non-strict controls also fail on runtime replacement', async () => {
  const { state, deliver } = harness();
  state.onWait = () => { state.pid++; };
  assert.equal(await deliver({ strictVerify: false }), 'verify_failed');
});

test('lifecycle accepts disappearance after Enter but never replacement', async () => {
  const first = harness();
  first.state.onWait = count => { if (count === 2) first.state.alive = false; };
  assert.equal(await first.deliver({ acceptShutdownAfterSubmit: true }), 'submitted');
  const second = harness();
  second.state.onWait = count => { if (count === 2) second.state.pid++; };
  assert.equal(await second.deliver({ acceptShutdownAfterSubmit: true }), 'verify_failed');
});

test('lifecycle cannot turn unavailable identity into success while original PID exists', async () => {
  const { state, context, deliver } = harness();
  const read = context.readFileSync;
  context.readFileSync = file => file === '/proc/123/stat' && !state.alive ? 'present' : read(file);
  state.onWait = count => { if (count === 2) state.alive = false; };
  assert.equal(await deliver({ acceptShutdownAfterSubmit: true }), 'verify_failed');
});

test('lifecycle rejects tmux, pgrep and proc lookup failures even when original PID is gone', async () => {
  for (const failure of ['tmux', 'pgrep', 'proc']) {
    const { state, context, deliver } = harness();
    const originalRead = context.readFileSync;
    context.readFileSync = file => {
      if (state.waits >= 2 && file === '/proc/123/stat') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return originalRead(file);
    };
    state.onWait = count => {
      if (count !== 2) return;
      if (failure === 'tmux') state.tmuxError = new Error('tmux timeout');
      if (failure === 'pgrep') state.pgrepError = Object.assign(new Error('pgrep failed'), { status: 2 });
      if (failure === 'proc') state.readError = Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    assert.equal(await deliver({ acceptShutdownAfterSubmit: true }), 'verify_failed', failure);
    assert.equal(state.events.some(event => event.event === 'lifecycle_shutdown_after_enter'), false, failure);
  }
});

test('resolver distinguishes absence from malformed state and lookup errors', () => {
  const { state, context } = harness();
  assert.equal(context.resolveDeliveryTarget('%7').state, 'present');
  state.pgrepError = Object.assign(new Error('no children'), { status: 1 });
  assert.equal(context.resolveDeliveryTarget('%7').state, 'authoritative_absent');
  state.pgrepError = Object.assign(new Error('failed'), { status: 2 });
  assert.equal(context.resolveDeliveryTarget('%7').state, 'lookup_error');
  state.pgrepError = null;
  state.readError = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.equal(context.resolveDeliveryTarget('%7').state, 'authoritative_absent');
  state.readError = Object.assign(new Error('permissions'), { code: 'EACCES' });
  assert.equal(context.resolveDeliveryTarget('%7').state, 'lookup_error');
  state.readError = null;
  // A non-runtime cmdline is legitimate, but a matching runtime with bad stat is not.
  context.readFileSync = file => file.endsWith('cmdline') ? '/bin/claude\0' : 'malformed';
  assert.equal(context.resolveDeliveryTarget('%7').state, 'lookup_error');
});

test('failed pane lookup needs successful pane listing to confirm removal', () => {
  const { state, context } = harness();
  state.displayError = new Error('cannot find pane');
  assert.equal(context.resolveDeliveryTarget('%7').state, 'lookup_error');
  state.paneList = '%8';
  assert.equal(context.resolveDeliveryTarget('%7').state, 'authoritative_absent');
  state.paneList = 'invalid-output';
  assert.equal(context.resolveDeliveryTarget('%7').state, 'lookup_error');
  state.tmuxError = new Error('connection failed');
  assert.equal(context.resolveDeliveryTarget('%7').state, 'lookup_error');
});

test('verified-empty delivery retains budget, supplements target original pane after selection switch', async () => {
  const { state, context, timer, deliver } = harness();
  state.onCommand = args => { if (args[0] === 'paste-buffer') state.selected = '%8'; };
  assert.equal(await deliver(), 'submitted');
  assert.equal(timer.pending.pane, '%7');
  assert.equal(timer.pending.itemId, 42);
  context.getAgentState = context.readProcState = context.checkInputBox = () => { throw new Error('no health, idle or empty gate allowed'); };
  state.time = 60000;
  await context.maybePeriodicEnter();
  assert.equal(timer.pending.attempts, 1);
  const keys = state.commands.filter(command => command.args[0] === 'send-keys');
  assert.equal(keys.length, 2);
  assert.ok(keys.every(command => command.args[2] === '%7'));
  assert.equal(state.captures.at(-1).itemId, 42);
  assert.equal(state.captures.at(-1).itemType, 'conversation');
});

test('periodic supplementation cancels runtime replacement, including same PID new start', async () => {
  for (const field of ['pid', 'start']) {
    const { state, context, timer, deliver } = harness();
    await deliver();
    state[field]++;
    state.time = 60000;
    await context.maybePeriodicEnter();
    assert.equal(timer.pending, null);
    assert.equal(state.commands.filter(command => command.args[0] === 'send-keys').length, 1);
  }
});

test('replacement during periodic capture cancels before sending a key', async () => {
  const { state, context, timer, deliver } = harness();
  await deliver();
  context.captureEnter = () => { state.pid++; };
  state.time = 60000;
  await context.maybePeriodicEnter();
  assert.equal(timer.pending, null);
  assert.equal(state.commands.filter(command => command.args[0] === 'send-keys').length, 1);
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
  assert.ok(failures.every(event => event.itemId === 42 && event.itemType === 'conversation' && event.pane === '%7'));
  assert.equal(JSON.stringify(state.events).includes('private input'), false);
});

test('text probes arm while slash controls clear budget', async () => {
  const { context, timer, deliver } = harness();
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
