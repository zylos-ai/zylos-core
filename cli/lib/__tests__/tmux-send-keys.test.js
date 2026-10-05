import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createTmuxSender, parseTmuxVersion, describeTmuxSendKeys, tmuxFailureDetails } from '../../../skills/comm-bridge/scripts/tmux-send-keys.js';

for (const [version, enabled] of [['3.2a', false], ['3.3a', false], ['3.4', true], ['3.6a', true], ['3.7c', true], ['3.10', true], ['4.0', true], ['next-3.8', true], ['next-3.9', true]]) {
  test(`tmux ${version} version gate and cached execution`, () => {
    const calls = [];
    const sender = createTmuxSender({ binary: '/test/tmux', exec: (bin, args, opts) => {
      calls.push({ bin, args, opts }); return `tmux ${version}`;
    } });
    assert.equal(calls.length, 0);
    assert.equal(parseTmuxVersion(`tmux ${version}`).version, version);
    const options = { timeout: 5000, stdio: 'pipe' };
    sender.sendKeys('agent', ['Enter'], options);
    sender.sendKeys('agent', ['Escape'], options);
    assert.equal(calls.filter(c => c.args[0] === '-V').length, 1);
    assert.ok(calls.every(c => c.bin === '/test/tmux'));
    for (let i = 1; i <= 2; i++) {
      assert.deepEqual(calls[i].args, ['send-keys', ...(enabled ? ['-c', 'zylos-no-client'] : []), '-t', 'agent', i === 1 ? 'Enter' : 'Escape']);
      assert.equal(calls[i].opts, options);
    }
    assert.match(describeTmuxSendKeys(sender.getCapability()), enabled ? /-c enabled/ : /-c disabled/);
  });
}
for (const failure of ['unparseable', 'error', 'openbsd-7.6']) {
  test(`unknown ${failure} warns once and preserves legacy argv`, () => {
    let probes = 0; const warnings = []; const sends = [];
    const sender = createTmuxSender({ warn: s => warnings.push(s), exec: (bin, args) => {
      if (args[0] === '-V') { probes++; if (failure === 'error') throw Object.assign(new Error('private'), { code: 'ENOENT' }); return failure === 'openbsd-7.6' ? 'tmux openbsd-7.6' : 'unexpected'; }
      sends.push(args);
    } });
    sender.sendKeys('s', ['Enter']); sender.sendKeys('s', ['Escape']);
    assert.equal(probes, 1); assert.equal(warnings.length, 1);
    assert.equal(sender.getCapability().version, 'unknown');
    assert.ok(sender.getCapability().reason);
    assert.match(describeTmuxSendKeys(sender.getCapability()), /unknown .*legacy argv/);
    assert.deepEqual(sends[0], ['send-keys', '-t', 's', 'Enter']);
    assert.ok(!warnings[0].includes('private'));
  });
}
test('failure diagnostics contain stderr/status without command or user input', () => {
  const details = tmuxFailureDetails(Object.assign(new Error('send-keys PRIVATE_INPUT'), { status: 1, stderr: Buffer.from('client is read-only\n') }));
  assert.deepEqual(details, { status: 1, code: null, signal: null, stderr: 'client is read-only' });
});
test('runtime paste and trust-prompt key paths use the version-gated sender and preserve timeout', () => {
  const source = fs.readFileSync(new URL('../runtime/tmux-helpers.js', import.meta.url), 'utf8');
  for (const version of ['3.3a', '3.7c']) {
    const calls = [];
    const exec = (bin, args, options) => { if (args[0] === '-V') return `tmux ${version}`; calls.push({ args, options }); };
    const context = vm.createContext({ execFileSync: exec, sendTmuxKeys: createTmuxSender({ exec }).sendKeys });
    vm.runInContext(source.replace(/^import .*;$/gm, '').replaceAll('export ', ''), context);
    context.tmuxPasteBuffer('agent', '/tmp/input', 'buffer');
    context.tmuxSendKeys('agent', '1', 'Enter');
    const sends = calls.filter(c => c.args[0] === 'send-keys');
    assert.equal(sends.length, 2);
    for (const call of sends) {
      assert.equal(call.args.includes('-c'), version === '3.7c');
      assert.equal(call.options.timeout, 3000);
    }
    assert.deepEqual(Array.from(sends[1].args.slice(-2)), ['1', 'Enter']);
  }
});
test('read-only rejection negative control discriminates legacy and protected argv', () => {
  const exec = (bin, args) => {
    if (args[0] === '-V') return 'tmux 3.7c';
    if (!args.includes('-c')) throw new Error('client is read-only');
    return 'delivered';
  };
  assert.throws(() => exec('tmux', ['send-keys', '-t', 'agent', 'Enter']), /read-only/);
  assert.equal(createTmuxSender({ exec }).sendKeys('agent', ['Enter']), 'delivered');
});
test('send failure propagates the original child-process error', () => {
  const error = Object.assign(new Error('failure'), { status: 1, stderr: Buffer.from('client is read-only') });
  const sender = createTmuxSender({ exec: (bin, args) => { if (args[0] === '-V') return 'tmux 3.7'; throw error; } });
  assert.throws(() => sender.sendKeys('agent', ['Enter']), caught => caught === error);
});
test('doctor text and JSON report enabled, legacy and unknown with reason', () => {
  const source = fs.readFileSync(new URL('../../commands/doctor.js', import.meta.url), 'utf8');
  let output;
  const context = vm.createContext({ ACTIVE_RUNTIME: 'codex', API_HOST: 'example.test',
    describeTmuxSendKeys, dim: s => s, red: s => s, logToFile: () => {},
    displayCheckGroup: (name, status, checks) => { output = checks; } });
  vm.runInContext(source.slice(source.indexOf('function buildDiagnosticJson('), source.indexOf('function displayAiGroup(')), context);
  for (const version of ['tmux 3.3a', 'tmux 3.7c', 'unrecognized']) {
    const capability = parseTmuxVersion(version);
    const diag = { system: { tmux: { installed: true, ...capability }, pm2: { installed: false }, network: { reachable: true } },
      ai: { cli: { installed: true }, auth: true, autonomous: true }, services: { running: false, procs: [] } };
    const json = context.buildDiagnosticJson(diag, { success: false });
    const tmux = json.groups.system.checks.tmux;
    assert.equal(tmux.version, capability.version);
    assert.equal(tmux.sendKeysClientFlag, capability.useClientFlag);
    assert.equal(tmux.versionReason, capability.reason);
    context.displaySystemGroup(diag, json.groups.system);
    assert.equal(output[0], describeTmuxSendKeys(capability));
  }
});
test('dispatcher keystroke control executes shared gate and logs failure metadata', async () => {
  const source = fs.readFileSync(new URL('../../../skills/comm-bridge/scripts/c4-dispatcher.js', import.meta.url), 'utf8');
  const start = source.indexOf('  const rawContent = item.content', source.indexOf('// Keystroke delivery:'));
  const end = source.indexOf('\n  log(`Delivering ${item.type}', start);
  let argv; let ack = false; const logs = [];
  const context = vm.createContext({ item: { id: 1, priority: 1, content: '[KEYSTROKE] Enter' },
    TMUX_SESSION: 'agent', agentState: { state: 'idle' }, periodicEnter: { reset() {} },
    isKeystrokeControl: () => true, parseKeystrokeKey: () => 'Enter', log: s => logs.push(s),
    ackControl: () => { ack = true; }, tmuxFailureDetails,
    handleControlDeliveryFailure: async () => {} });
  context.sendTmuxKeys = createTmuxSender({ exec: (bin, args) => { if (args[0] === '-V') return 'tmux 3.7c'; argv = args; } }).sendKeys;
  const execute = () => vm.runInContext(`(async () => {${source.slice(start, end)}})()`, context);
  assert.equal((await execute()).delivered, true);
  assert.equal(ack, true);
  assert.deepEqual(argv, ['send-keys', '-c', 'zylos-no-client', '-t', 'agent', 'Enter']);
  context.sendTmuxKeys = () => { throw Object.assign(new Error('PRIVATE_INPUT'), { status: 1, stderr: 'client is read-only' }); };
  assert.equal((await execute()).delivered, false);
  assert.ok(logs.some(s => s.includes('client is read-only')));
  assert.ok(logs.every(s => !s.includes('PRIVATE_INPUT')));
});
