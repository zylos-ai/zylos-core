import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../../src/lib/store.js';
import { C4Reader } from '../../src/lib/c4-reader.js';
import { StateEngine } from '../../src/lib/state-engine.js';
import { CoreState } from '../../src/lib/core-state.js';
import { EventLoopMonitor } from '../../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../../src/lib/version-checker.js';

// The runner must isolate HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/tmux before imports.
// Only this fixture's random loopback port is opened. CLI and Core callbacks
// are replaced before index import; collectors/main are never started. Cleanup
// is registered before import and owns listener, intervals, engine and DBs.
export async function usageServer(t, configBody = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-http-'));
  const previous = process.env.ZYLOS_DIR;
  let server, store, reader, engine, core;
  const timers = [], originalInterval = globalThis.setInterval;
  t.after(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    for (const timer of timers) clearInterval(timer);
    engine?.stopSnapshotTimer(); reader?.close(); store?.close();
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = originalInterval(...args); timers.push(timer); return timer;
  });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.method(CoreState.prototype, 'refresh', async () => {});
  const noCli = async () => { assert.fail('Unexpected CLI invocation'); };
  const fakeExecFile = (_file, _args, _options, callback) => callback(new Error('Unexpected CLI invocation'));
  fakeExecFile[promisify.custom] = noCli;
  t.mock.module('node:child_process', { namedExports: { ...childProcess,
    execFileSync: () => '1.0.0', execFile: fakeExecFile } });
  t.mock.module('../../src/lib/store.js', { namedExports: {
    Store: class extends Store { constructor(...args) { super(...args); store = this; } }
  } });
  t.mock.module('../../src/lib/c4-reader.js', { namedExports: {
    C4Reader: class extends C4Reader { constructor(...args) { super(...args); reader = this; } }
  } });
  t.mock.module('../../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } }
  } });
  t.mock.module('../../src/lib/core-state.js', { namedExports: {
    CoreState: class extends CoreState { constructor(...args) { super(...args); core = this; } }
  } });
  fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.mkdirSync(path.join(dir, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: false }, ...configBody }));
  process.env.ZYLOS_DIR = dir;
  const { createServer } = await import(`../../src/index.js?usage=${Date.now()}-${Math.random()}`);
  server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  assert.equal(server.address().address, '127.0.0.1');
  assert.ok(store.db.name.startsWith(dir + path.sep));
  return { store, reader, core, config: engine._config, origin: `http://127.0.0.1:${server.address().port}` };
}
