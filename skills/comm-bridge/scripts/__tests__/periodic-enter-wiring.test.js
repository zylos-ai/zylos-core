import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { PeriodicEnter } from '../periodic-enter.js';

const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test('actual delivery uses bracketed paste before unconditional Enter; loop awaits delivery before supplement', async () => {
  const commands = [];
  const events = [];
  const ordering = [];
  const timer = new PeriodicEnter({ enabled: true });
  const context = vm.createContext({
    Buffer, process, Date, Error,
    TMUX_SESSION: 'isolated', ENTER_VERIFY_MAX_RETRIES: 3, ENTER_VERIFY_WAIT_MS: 500,
    PERIODIC_ENTER_ENABLED: true,
    periodicEnter: timer, periodicTarget: () => ({ identity: 'pane:pid' }),
    sanitizeMessage: value => value, getDeliveryDelay: () => 200,
    execFileSync: (binary, args) => { commands.push(args); },
    trace: (event, metadata) => events.push({ event, ...metadata }),
    captureEnter: () => {}, checkInputBox: () => 'empty',
    log: () => {}, logDeliveryFailure: () => {},
    sleep: async () => { ordering.push('wait'); },
    isShuttingDown: false, pollInterval: 1000, POLL_INTERVAL_BASE: 1000, POLL_INTERVAL_MAX: 3000
  });
  vm.runInContext([
    extract('function sendEnter(', 'async function maybePeriodicEnter('),
    extract('async function submitAndVerify(', 'export function isBypassState('),
    extract('async function dispatcherLoop(', 'function shutdown(')
  ].join('\n'), context);
  context.processNextMessage = async () => {
    ordering.push('delivery_start');
    assert.equal(await context.sendToTmux('private input', { itemId: 42, itemType: 'conversation', strictVerify: true }), 'submitted');
    ordering.push('delivery_end');
    return { delivered: true, state: 'idle' };
  };
  context.maybePeriodicEnter = async () => { ordering.push('periodic'); context.isShuttingDown = true; };
  await context.dispatcherLoop();
  const paste = commands.findIndex(args => args[0] === 'paste-buffer');
  const enter = commands.findIndex(args => args[0] === 'send-keys');
  assert.ok(commands[paste].includes('-p'));
  assert.ok(enter > paste);
  assert.equal(commands.filter(args => args[0] === 'send-keys').length, 1);
  assert.ok(ordering.indexOf('periodic') > ordering.indexOf('delivery_end'));
  assert.equal(timer.pending.itemId, 42);
  assert.ok(events.some(event => event.event === 'paste_sent' && event.itemId === 42));
  assert.equal(JSON.stringify(events).includes('private input'), false);
});

test('actual periodic target rejects runtime changes, missing/stale process, and replacement PID', () => {
  let runtime = 'claude';
  let proc = { alive: true, pid: 123 };
  const context = vm.createContext({
    ACTIVE_RUNTIME: 'claude', TMUX_SESSION: 'isolated',
    readActiveRuntime: () => runtime, readProcState: () => proc,
    execFileSync: () => '%7', readFileSync: () => `123 (runtime) ${Array(19).fill('0').join(' ')} 777 0`
  });
  vm.runInContext(extract('function periodicTarget(', 'function captureEnter('), context);
  const first = context.periodicTarget().identity;
  proc = { alive: true, pid: 456 };
  assert.notEqual(context.periodicTarget().identity, first);
  proc = null;
  assert.equal(context.periodicTarget(), null);
  proc = { alive: true, pid: 123 };
  runtime = 'codex';
  assert.equal(context.periodicTarget(), null);
});
