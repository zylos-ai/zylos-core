import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { SessionAdapter } from '../session-adapter.js';
import { openTmuxConnection, runTmuxCommand } from '../tmux-connection.js';
import { resolveSessionTarget, revalidateSessionTarget } from '../session-target.js';

const binary = process.env.TEST_TMUX_BIN || 'tmux';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const badControl = process.env.ZYLOS_TMUX_BAD_CONTROL === '1';

async function fixture(t) {
  const f = isolatedTmux(t, { prefix: 'adapter-churn-', socketName: 'socket', timeout: 5000 });
  const source = path.join(f.dir, 'recorder.c'), executable = path.join(f.dir, 'claude');
  await fs.writeFile(source, `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <termios.h>
int main(void) {
  char name[256], bytes[4096]; ssize_t count; struct termios state;
  const char *run = getenv("ZYLOS_RUN_ID"); if (!run) return 91;
  if (tcgetattr(0, &state)) return 92;
  state.c_lflag &= ~(ECHO | ICANON); state.c_cc[VMIN] = 1; state.c_cc[VTIME] = 0;
  if (tcsetattr(0, TCSANOW, &state)) return 93;
  snprintf(name, sizeof name, "received-%s", run);
  FILE *output = fopen(name, "ab"); if (!output) return 94; setbuf(output, NULL);
  snprintf(name, sizeof name, "ready-%s", run);
  FILE *ready = fopen(name, "w"); if (!ready) return 95; fclose(ready);
  while ((count = read(0, bytes, sizeof bytes)) > 0) {
    if (fwrite(bytes, 1, (size_t)count, output) != (size_t)count) return 96;
  }
  return fclose(output);
}
`);
  execFileSync('cc', [source, '-o', executable], { timeout: 20000, stdio: 'pipe' });
  const tmuxOptions = { binary, socketPath: f.socketPath, configFile: '/dev/null', timeoutMs: 5000 };
  const start = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '/bin/sleep 600'); return; }
      catch { await delay(10); }
    }
    throw Error('Isolated server did not start');
  };
  await start();
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
  return { ...f, adapter, launch, ready, read, start, tmuxOptions, executable };
}

// Required real adapter compatibility evidence: one socket, 300 launches,
// 150 complete deliveries and concurrent creation/removal of other sessions.
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
          expected += `${text}\n`; deliveries++;
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
    t.diagnostic(JSON.stringify({ version: f.tmux('-V'), launches, deliveries, churnRounds,
      errors: 0, serverCrashes: 0, wrongPaneLines: 0, missingLines: 0 }));
  });

test('same churn fixture rejects stale generation; constant-true guard positive control must fail',
  { timeout: 20000 }, async t => {
    const f = await fixture(t);
    await f.launch('stress:receiver', 'old'); await f.ready('old');
    let open = openTmuxConnection;
    if (badControl) {
      const original = await fs.readFile(new URL('../tmux-connection.js', import.meta.url), 'utf8');
      const mutant = original.replace(/const condition = [^\n]+;/, "const condition = '1';")
        .replace("'./tmux-client-args.js'", JSON.stringify(new URL('../tmux-client-args.js', import.meta.url).href));
      assert.notEqual(mutant, original, 'Positive control must alter the production guard');
      const filename = path.join(f.dir, 'constant-true.mjs'); await fs.writeFile(filename, mutant);
      ({ openTmuxConnection: open } = await import(pathToFileURL(filename).href));
    }
    const connection = await open(f.tmuxOptions); t.after(() => connection.close());
    const target = await resolveSessionTarget({ tmuxName: 'stress-receiver', connection, readReady: async () => null });
    const adapter = new SessionAdapter({ dependencies: {
      revalidateSessionTarget: async options => {
        await revalidateSessionTarget(options);
        f.tmux('kill-server'); await f.start();
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
    assert.equal(await f.read('replacement'), 'recorder-control', 'The replacement recorder can detect wrong-pane input');
  });
