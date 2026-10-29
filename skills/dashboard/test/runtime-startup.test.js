import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { StateEngine } from '../src/lib/state-engine.js';
import { StatuslineCollector } from '../src/lib/collectors/statusline-collector.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';

test('Codex Dashboard startup wires the Core statusline collector into the state engine', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-runtime-'));
  const previous = process.env.ZYLOS_DIR;
  let engine;
  t.after(() => {
    engine?.store.close();
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.ZYLOS_DIR = root;
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'codex' }));
  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: false } }));
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess, execFileSync: () => '1.0.0',
  } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine {
      constructor(...args) { super(...args); engine = this; }
    },
  } });
  const { createServer } = await import('../src/index.js?runtime-startup');
  assert.equal(typeof createServer, 'function');
  assert.equal(engine._config.runtime, 'codex');
  assert.ok(engine.collectors.statusline instanceof StatuslineCollector);
  assert.equal(engine.collectors.statusline.store, engine.store);
  assert.equal(engine.collectors.conversation, undefined);
});
