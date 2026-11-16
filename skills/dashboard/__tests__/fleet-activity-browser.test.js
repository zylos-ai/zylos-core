import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Actual page/modules/styles with fixture API responses. The opt-in gate precedes resource allocation;
// private HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR and test DB paths are checked before loopback startup.
test('single and multi session cards retain status without action rows',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runFleetActivityBrowser } = await import('./helpers/fleet-activity-browser.js');
      await runFleetActivityBrowser(t, sandbox);
    }, { timeoutMs: 110000 });
    assert.equal(fs.existsSync(sandbox.root), false);
    assert.equal(sandbox.children.size, 0);
    assert.ok([...sandbox.servers].every(server => !server.listening));
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
  });
