import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { SessionAdapter } from '../../../../cli/lib/runtime/session-adapter.js';
import { createSessionReader } from '../../../../cli/lib/session-state-reader-async.js';
import { resolveSessionTarget } from '../../../../cli/lib/runtime/session-target.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Adapter extends SessionAdapter { get runtimeId() { return 'claude'; } }
// Required AGENTS tmux matrix real-path stress. Opt-in keeps ordinary unit runs short.
// Ported from the validated P02 stress scenario to the shared fixture + official runner.
test('matrix real launch/delivery under same-socket create/kill churn', {
  skip: process.env.P05_TMUX_STRESS !== '1', timeout: 600000,
}, async t => {
  const launchRounds = Number(process.env.P05_LAUNCH_ROUNDS || 300);
  const deliveryRounds = Number(process.env.P05_DELIVERY_ROUNDS || 150);
  const f = isolatedTmux(t, { prefix: 'p05-stress-', socketName: 'tmux.sock', timeout: 6000 });
  const env = { ...process.env, HOME: f.dir, ZYLOS_DIR: f.dir, LANG: 'C.UTF-8', TERM: 'xterm-256color' };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = async (...args) => (await exec(f.binary, ['-u', '-S', f.socketPath, '-N', ...args], { env, timeout: 6000 })).stdout.trim();
  f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', 'sleep', '600');
  const server = await tmux('display-message', '-p', '-t', '=keeper:', '#{pid}:#{start_time}');
  const runtime = path.join(f.dir, 'runtime-fixture');
  await fs.writeFile(runtime, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');\nconst file=path.join(process.env.ZYLOS_DIR,'received-'+process.env.ZYLOS_SESSION_GROUP+'.jsonl');\nreadline.createInterface({input:process.stdin}).on('line',line=>fs.appendFileSync(file,JSON.stringify(line)+'\\n'));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const options = { socketPath: f.socketPath, binary: f.binary };
  const adapter = new Adapter({ root: f.dir, env: { ...env, CLAUDE_BIN: runtime }, tmux: options });
  const reader = createSessionReader({ env, connectionOptions: options });
  const stats = { version: (await exec(f.binary, ['-V'])).stdout.trim(), launchRounds: 0, launches: 0, deliveryRounds: 0,
    sends: 0, reads: 0, churnCycles: 0, errors: [], serverLost: false, foreignLines: 0, missingLines: 0, duplicates: 0 };
  const live = async () => { const current = await tmux('display-message', '-p', '-t', '=keeper:', '#{pid}:#{start_time}'); assert.equal(current, server); };
  const launch = async group => { await adapter.launch({ sessionGroup: group, runId: `run-${group}`, sessionMode: 'multi', launchConfig: { runtime: 'claude', mode: 'default' } }); stats.launches++; };
  const read = async group => { const s = await reader.readSessionState(group, { freshnessMs: 1000 }); assert.equal(s.identity.present, true); assert.equal(s.identity.runId, `run-${group}`); stats.reads++; };
  let stopping = false;
  const churn = (async () => {
    while (!stopping) {
      const name = `noise-${stats.churnCycles}`;
      try { await tmux('new-session', '-d', '-s', name, 'sleep', '30'); await tmux('kill-session', '-t', `=${name}`); stats.churnCycles++; }
      catch (error) { if (!stopping) stats.errors.push({ phase: 'churn', code: error.code, message: error.message }); break; }
    }
  })();
  try {
    for (let round = 1; round <= launchRounds; round++) {
      const groups = [`stress:r${round}a`, `stress:r${round}b`];
      await Promise.all(groups.map(async group => { await launch(group); await read(group); }));
      await live();
      await Promise.all(groups.map(group => adapter.stop({ tmuxName: tmuxNameForGroup(group), expectedRunId: `run-${group}` })));
      stats.launchRounds = round;
    }
    for (let lane = 1; lane <= 4; lane++) await launch(`stress:lane${lane}`);
    await Promise.all([1, 2, 3, 4].map(async lane => {
      const group = `stress:lane${lane}`;
      for (let round = 1; round <= deliveryRounds; round++) {
        const connection = await adapter.connection();
        try {
          const target = await resolveSessionTarget({ sessionGroup: group, connection });
          const text = `lane=${lane};seq=${round};literal='double" \\ $HOME #{pid} ;`;
          await adapter.sendText({ target, connection, text });
          await adapter.sendKeys({ target, connection, keys: ['Enter'] }); stats.sends++;
          await read(group);
        } finally { connection.close(); }
      }
    }));
    await live(); await delay(300);
    for (let lane = 1; lane <= 4; lane++) {
      const lines = (await fs.readFile(path.join(f.dir, `received-stress:lane${lane}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const expected = Array.from({ length: deliveryRounds }, (_, i) => `lane=${lane};seq=${i + 1};literal='double" \\ $HOME #{pid} ;`);
      stats.foreignLines += lines.filter(line => !expected.includes(line)).length;
      stats.missingLines += expected.filter(line => !lines.includes(line)).length;
      stats.duplicates += lines.length - new Set(lines).size;
    }
    stats.deliveryRounds = stats.sends / 4;
  } catch (error) { stats.errors.push({ phase: 'main', code: error.code, message: error.message }); }
  finally {
    stopping = true; await churn;
    try { await live(); } catch { stats.serverLost = true; }
    t.diagnostic(JSON.stringify(stats));
    if (process.env.P05_STRESS_RESULT) await fs.writeFile(process.env.P05_STRESS_RESULT, JSON.stringify(stats, null, 2));
  }
  assert.deepEqual(stats.errors, []); assert.equal(stats.serverLost, false);
  assert.equal(stats.launchRounds, launchRounds); assert.equal(stats.deliveryRounds, deliveryRounds);
  assert.equal(stats.foreignLines, 0); assert.equal(stats.missingLines, 0); assert.equal(stats.duplicates, 0);
  assert.ok(stats.churnCycles > 0);
});
