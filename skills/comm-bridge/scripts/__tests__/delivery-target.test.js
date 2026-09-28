import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
function extract(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function harness() {
  const state = { selected: '%7', pid: 123, start: 777, alive: true, checks: [], commands: [], verdict: 'empty', waits: 0 };
  const context = vm.createContext({
    Buffer, process, Date, Error, path,
    ACTIVE_RUNTIME: 'claude', TMUX_SESSION: 'isolated',
    ENTER_VERIFY_MAX_RETRIES: 3, ENTER_VERIFY_WAIT_MS: 500, isShuttingDown: false,
    readActiveRuntime: () => 'claude', existsSync: () => state.alive,
    readFileSync: file => {
      if (file.endsWith('cmdline')) return file.includes('/100/') ? '/bin/bash\0' : '/bin/claude\0';
      return `123 (runtime) ${Array(19).fill('0').join(' ')} ${state.start} 0`;
    },
    execFileSync: (binary, args) => {
      state.commands.push({ binary, args });
      if (binary === 'pgrep') return String(state.pid);
      if (args[0] === 'display-message') {
        const target = args[args.indexOf('-t') + 1];
        const pane = target === 'isolated' ? state.selected : target;
        return `${pane} 100 ${state.alive ? 0 : 1}`;
      }
      if (args[0] === 'capture-pane') return 'overlay';
      state.onCommand?.(args);
      return '';
    },
    sanitizeMessage: value => value, getDeliveryDelay: () => 200,
    trace: () => {}, captureEnter: (phase, target) => state.checks.push(target),
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
  return { state, context, deliver: options => context.sendToTmux('private multiline\ninput', { itemId: 42, strictVerify: true, ...options }) };
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
  context.existsSync = () => true;
  state.onWait = count => { if (count === 2) state.alive = false; };
  assert.equal(await deliver({ acceptShutdownAfterSubmit: true }), 'verify_failed');
});

test('shipped dispatcher has no autonomous periodic Enter path', () => {
  assert.equal(source.includes('maybePeriodicEnter'), false);
  assert.equal(source.includes('PeriodicEnter'), false);
});
