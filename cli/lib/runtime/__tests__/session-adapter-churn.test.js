import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedTmux, waitForServerExit } from '../../../../test/helpers/isolated-tmux.js';
import { SessionAdapter } from '../session-adapter.js';
import { openTmuxConnection, runTmuxCommand } from '../tmux-connection.js';
import { resolveSessionTarget, revalidateSessionTarget } from '../session-target.js';

const binary = process.env.TEST_TMUX_BIN || 'tmux';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const badControl = process.env.ZYLOS_TMUX_BAD_CONTROL === '1';

async function fixture(t) {
  const f = isolatedTmux(t, { prefix: 'adapter-churn-', timeout: 5000 });
  const executable = path.join(f.dir, 'claude');
  await fs.writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
const run = process.env.ZYLOS_RUN_ID;
if (!run || !process.stdin.isTTY) process.exit(91);
process.stdin.setRawMode(true);
const output = fs.openSync('received-' + run, 'a');
fs.closeSync(fs.openSync('ready-' + run, 'w'));
process.stdin.on('data', bytes => fs.writeSync(output, bytes));
process.stdin.resume();
`, { mode: 0o755 });
  // The recorder has no extension; select ESM independently of host defaults.
  await fs.writeFile(path.join(f.dir, 'package.json'), '{"type":"module"}\n');
  const tmuxOptions = { binary, socketPath: f.socketPath, configFile: '/dev/null', timeoutMs: 5000 };
  const start = () => f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '/bin/sleep 600');
  start();
  class Adapter extends SessionAdapter { get runtimeId() { return 'claude'; } }
  const adapter = new Adapter({ root: f.dir, tmux: tmuxOptions,
    paths: { tmuxNameForGroup: group => group.replaceAll(':', '-') },
    env: { HOME: f.dir, ZYLOS_DIR: f.dir, PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    runtimeExecutable: () => executable,
  });
  const launch = (group, runId) => adapter.launch({ sessionGroup: group, sessionMode: 'multi', runId,
    launchConfig: { runtime: 'claude', mode: 'default' } });
  async function ready(runId) {
    for (let i = 0; i < 200; i++) {
      try { await fs.access(path.join(f.dir, `ready-${runId}`)); return; } catch { await delay(10); }
    }
    throw Error(`Recorder ${runId} did not become ready`);
  }
  const read = runId => fs.readFile(path.join(f.dir, `received-${runId}`), 'utf8');
  return { ...f, adapter, launch, ready, read, start, tmuxOptions };
}

test('real adapter survives 300 launches and 150 deliveries on one socket under session churn',
  { timeout: 300000, skip: badControl }, async t => {
    const f = await fixture(t);
    await f.launch('stress:receiver', 'receiver'); await f.ready('receiver');
    await f.launch('stress:canary', 'canary'); await f.ready('canary');
    const generation = f.tmux('display-message', '-p', '#{pid}:#{start_time}');
    const connection = await openTmuxConnection(f.tmuxOptions);
    const target = await resolveSessionTarget({ tmuxName: 'stress-receiver', connection, readReady: async () => null });
    let stopping = false, churnRounds = 0;
    const churnErrors = [];
    const churn = (async () => {
      while (!stopping) {
        const name = `churn-${churnRounds}`;
        try {
          await runTmuxCommand(['new-session', '-d', '-s', name, '/bin/sleep 600'], f.tmuxOptions);
          await runTmuxCommand(['kill-session', '-t', `=${name}`], f.tmuxOptions);
          churnRounds++;
        } catch (error) { churnErrors.push({ code: error.code, message: error.message }); break; }
        await delay(5);
      }
    })();
    let launches = 0, deliveries = 0, expected = '';
    try {
      for (let i = 0; i < 300; i++) {
        const group = `stress:round-${i}`;
        const result = await f.launch(group, `launch-${i}`);
        assert.equal(result.tmuxName, group.replaceAll(':', '-'));
        f.tmux('kill-session', '-t', `=${result.tmuxName}`);
        launches++;
        if (i % 2 === 0) {
          const text = `delivery-${deliveries}: ZYLOS_OK #{pid} 'quoted'`;
          await f.adapter.sendText({ target, connection, text });
          await f.adapter.sendKeys({ target, connection, keys: ['Enter'] });
          expected += `${text}\r`; deliveries++;
        }
      }
      for (let i = 0; i < 200 && await f.read('receiver') !== expected; i++) await delay(10);
      assert.equal(await f.read('receiver'), expected, 'Every delivery arrives exactly once in its bound pane');
      assert.equal(await f.read('canary'), '', 'No delivery reaches the canary pane');
      assert.equal(f.tmux('display-message', '-p', '#{pid}:#{start_time}'), generation, 'Server did not crash or restart');
    } finally { stopping = true; await churn; connection.close(); }
    assert.deepEqual(churnErrors, []);
    assert.ok(churnRounds > 0, 'Session churn overlapped adapter work');
    assert.deepEqual({ launches, deliveries }, { launches: 300, deliveries: 150 });
    t.diagnostic(JSON.stringify({ matrixStress: true, version: f.tmux('-V'), launches, deliveries, churnRounds,
      errors: 0, serverCrashes: 0, wrongPaneLines: 0, missingLines: 0 }));
  });

test('same fixture rejects stale generation; constant-true guard positive control must fail',
  { timeout: 20000 }, async t => {
    const f = await fixture(t);
    await f.launch('stress:receiver', 'old'); await f.ready('old');
    let open = openTmuxConnection;
    if (badControl) {
      const protocolUrl = new URL('../../../../skills/comm-bridge/scripts/tmux-protocol.js', import.meta.url);
      const original = await fs.readFile(protocolUrl, 'utf8');
      const mutant = original.replace(/(export function tmuxGuardCondition\(binding, kind\) \{)[\s\S]*?\n\}/,
        "$1\n  return '1';\n}");
      assert.notEqual(mutant, original, 'Positive control must alter the production guard');
      const protocolFile = path.join(f.dir, 'tmux-protocol.mjs');
      await fs.writeFile(protocolFile, mutant);
      const source = await fs.readFile(new URL('../tmux-connection.js', import.meta.url), 'utf8');
      const connectionFile = path.join(f.dir, 'constant-true.mjs');
      await fs.writeFile(connectionFile, source.replace(/(['"])(\.\/[^'"]+)\1/g, (_match, _quote, relative) =>
        JSON.stringify(relative === './tmux-protocol.js' ? pathToFileURL(protocolFile).href : new URL(relative, new URL('../tmux-connection.js', import.meta.url)).href)));
      ({ openTmuxConnection: open } = await import(pathToFileURL(connectionFile).href));
    }
    const connection = await open(f.tmuxOptions); t.after(() => connection.close());
    const target = await resolveSessionTarget({ tmuxName: 'stress-receiver', connection, readReady: async () => null });
    const adapter = new SessionAdapter({ dependencies: {
      revalidateSessionTarget: async options => {
        await revalidateSessionTarget(options);
        f.tmux('kill-server'); await waitForServerExit(f); f.start();
        await f.launch('stress:receiver', 'replacement'); await f.ready('replacement');
        assert.equal(f.tmux('display-message', '-p', '-t', '=stress-receiver:', '#{pane_id}'), target.paneId);
        assert.notEqual(f.tmux('display-message', '-p', '#{pid}:#{start_time}'), target.serverGeneration);
      },
    } });
    let code = null;
    try { await adapter.sendText({ target, connection, text: 'stale-message' }); }
    catch (error) { code = error.code; }
    for (let i = 0; badControl && i < 100 && await f.read('replacement') === ''; i++) await delay(10);
    assert.deepEqual({ code, received: await f.read('replacement') }, { code: 'GENERATION_CHANGED', received: '' });
    f.tmux('send-keys', '-l', '-t', target.paneId, 'recorder-control');
    for (let i = 0; i < 100 && await f.read('replacement') === ''; i++) await delay(10);
    assert.equal(await f.read('replacement'), 'recorder-control', 'Replacement recorder detects wrong-pane input');
  });
