import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { StateEngine } from '../src/lib/state-engine.js';
import { StatuslineCollector } from '../src/lib/collectors/statusline-collector.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';

// Entry-module integration; run for runtime selection or collector wiring changes,
// and skip UI-only changes. The isolated runner owns HOME/ZYLOS_DIR/PM2_HOME,
// short TMPDIR and a private tmux socket. No listener or runtime child starts;
// every import-created interval and temporary file is cleaned by this case.
test('Codex Dashboard startup wires both usage collectors and Core statusline into the state engine', { timeout: 15000 }, async t => {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    const value = process.env[key];
    assert.ok(value && path.isAbsolute(value), `${key} must be set by the isolated runner`);
    const relative = path.relative(realHome, value);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`), `${key} must be outside the live home`);
  }
  assert.equal(process.env.TMUX, undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-runtime-'));
  const previous = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  const intervals = new Set();
  const realSetInterval = globalThis.setInterval;
  let engine;
  t.after(() => {
    for (const timer of intervals) clearInterval(timer);
    engine?.store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.env.ZYLOS_DIR = root;
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'codex' }));
  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: false } }));
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = realSetInterval(...args); intervals.add(timer); return timer;
  });
  const childCalls = [];
  t.mock.module('node:child_process', { namedExports: {
    ...childProcess,
    execFileSync: (command, args) => { childCalls.push([command, args]); return '1.0.0'; },
    execFile: () => { assert.fail('startup wiring must not start a Core or PM2 child'); },
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
  assert.ok(engine.collectors.conversation instanceof ConversationCollector);
  assert.ok(engine.collectors.codexRollout instanceof CodexRolloutCollector);
  assert.equal(engine.collectors.conversation.store, engine.store);
  assert.equal(engine.collectors.codexRollout.store, engine.store);
  assert.equal(engine.store.db.name, path.join(root, 'components/dashboard/dashboard.db'));
  assert.equal(childCalls.every(([, args]) => args.length === 1 && args[0] === '--version'), true);
});
