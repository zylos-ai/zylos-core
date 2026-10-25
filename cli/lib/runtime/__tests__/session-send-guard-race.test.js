import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTmuxConnection } from '../tmux-connection.js';
import { resolveSessionTarget, revalidateSessionTarget } from '../session-target.js';
import { SessionAdapter } from '../session-adapter.js';

const binary = process.env.TEST_TMUX_BIN || 'tmux';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function waitFor(read, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for isolated tmux input recorder');
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p02-send-race-'));
  const socketPath = path.join(dir, 'socket');
  const input = path.join(dir, 'input');
  const ready = path.join(dir, 'ready');
  const tmux = (...args) => execFileSync(binary, ['-u', '-S', socketPath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
  }).trim();
  let connection;
  t.after(async () => {
    connection?.close();
    try { tmux('kill-server'); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });
  const start = async () => {
    // kill-server can exit before its socket is released. Wait for a successful
    // new server; this never connects to the host's default socket.
    await waitFor(async () => {
      try { tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', 'sleep 120'); return true; }
      catch { return false; }
    }, Boolean);
    tmux('new-session', '-d', '-s', 'fixture', '-e', 'ZYLOS_RUN_ID=old-run',
      '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude"}', 'sleep 120');
  };
  await start();
  connection = await openTmuxConnection({ socketPath, binary });
  const target = await resolveSessionTarget({ connection, tmuxName: 'fixture', readReady: async () => null });
  let replacements = 0;
  const adapter = new SessionAdapter({ dependencies: {
    revalidateSessionTarget: async options => {
      // Complete the real Node-side checks, then replace the server before the
      // adapter can issue its paste/send-keys. Only the server guard can stop it.
      await revalidateSessionTarget(options);
      tmux('kill-server');
      await start();
      assert.equal(tmux('display-message', '-p', '-t', '=fixture:', '#{pane_id}'), target.paneId);
      assert.notEqual(tmux('display-message', '-p', '#{pid}:#{start_time}'), target.serverGeneration);
      tmux('respawn-pane', '-k', '-t', target.paneId,
        `stty -echo -icanon min 1 time 0; : > ${quote(input)}; : > ${quote(ready)}; exec cat > ${quote(input)}`);
      await waitFor(async () => fs.stat(ready).then(() => true, () => false), Boolean);
      replacements++;
      return true;
    },
  } });
  return { adapter, connection, target, tmux, input, replacements: () => replacements };
}

for (const method of ['sendText', 'sendKeys']) {
  test(`${method} rejects same-socket replacement after revalidation and before guarded action`, async t => {
    const f = await fixture(t);
    let error;
    try { await f.adapter[method]({ connection: f.connection, target: f.target, text: 'old-message', keys: ['X'] }); }
    catch (caught) { error = caught; }
    assert.equal(f.replacements(), 1, 'The real revalidation completed before replacement');
    await delay(100);
    const received = await fs.readFile(f.input, 'utf8');
    // Keep both observations in one assertion: a constant-true guard reports
    // success AND actual old input here, rather than failing on an earlier read.
    assert.deepEqual({ code: error?.code ?? null, received }, { code: 'GENERATION_CHANGED', received: '' });

    // Positive recorder control: the reused pane ID accepts literal input.
    f.tmux('send-keys', '-l', '-t', f.target.paneId, 'recorder-control');
    assert.equal(await waitFor(() => fs.readFile(f.input, 'utf8'), value => value !== ''), 'recorder-control');
  });
}
