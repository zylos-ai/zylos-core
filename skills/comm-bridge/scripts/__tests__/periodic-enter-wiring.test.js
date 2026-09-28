import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
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
  await context.sendToTmux('Meanwhile, health-check', { itemId: 43, itemType: 'control', periodicTextControl: true });
  assert.equal(timer.pending.itemId, 43);
  await context.sendToTmux('/exit', { itemId: 44, itemType: 'control', periodicTextControl: false });
  assert.equal(timer.pending, null);
});

test('actual periodic target uses live pane/process identity despite stale monitor, rejects replacements and dead panes', () => {
  let runtime = 'claude';
  let pid = 123;
  let dead = '0';
  let command = 'claude';
  const context = vm.createContext({
    path, ACTIVE_RUNTIME: 'claude', TMUX_SESSION: 'isolated',
    readActiveRuntime: () => runtime, readProcState: () => { throw new Error('monitor must not be consulted'); },
    execFileSync: binary => binary === 'tmux' ? `%7 100 ${dead}` : String(pid),
    readFileSync: file => file.endsWith('cmdline') ? (file.includes('/100/') ? '/bin/bash\0' : `/bin/${command}\0`) : `123 (runtime) ${Array(19).fill('0').join(' ')} 777 0`
  });
  vm.runInContext(extract('function periodicTarget(', 'function captureEnter('), context);
  const first = context.periodicTarget().identity;
  pid = 456;
  assert.notEqual(context.periodicTarget().identity, first);
  dead = '1';
  assert.equal(context.periodicTarget(), null);
  dead = '0';
  command = 'bash';
  assert.equal(context.periodicTarget(), null);
  command = 'claude';
  runtime = 'codex';
  assert.equal(context.periodicTarget(), null);
});

test('periodic Enter ignores busy, unhealthy and frozen/stale monitor state but cancels changed target', async () => {
  let time = 0;
  let identity = 'claude:%7:123:777';
  let sent = 0;
  const timer = new PeriodicEnter({ enabled: true, now: () => time });
  const context = vm.createContext({
    PERIODIC_ENTER_ENABLED: true, PERIODIC_ENTER_MAX_ATTEMPTS: 3, ENTER_VERIFY_WAIT_MS: 500,
    periodicEnter: timer, isShuttingDown: false,
    periodicTarget: () => ({ pane: '%7', identity }),
    getAgentState: () => { throw new Error('busy/unhealthy monitor must not gate'); },
    readProcState: () => { throw new Error('frozen/stale monitor must not gate'); },
    captureEnter: () => {}, sleep: async () => {}, sendEnter: () => { sent++; }
  });
  vm.runInContext(extract('async function maybePeriodicEnter(', 'export function notifyMessageDelivered('), context);
  timer.arm(identity, 42);
  time = 60000;
  await context.maybePeriodicEnter();
  assert.equal(sent, 1);
  identity = 'claude:%7:456:888';
  time += 60000;
  await context.maybePeriodicEnter();
  assert.equal(sent, 1);
  assert.equal(timer.pending, null);
});
