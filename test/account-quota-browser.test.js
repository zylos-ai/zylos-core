import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Boundary: real Dashboard HTML, modules, styles and host-panel lifecycle with fixture API answers.
// Run for account reset presentation, snapshot-to-host wiring, or affected responsive layout changes;
// unrelated pages may skip. Gate off by default. No live config, PM2, tmux or database is opened.
// Before browser startup the harness proves private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR,
// socket and database paths. HTTP, browser and contexts are reclaimed on failure and timeout.
test('account reset tooltips and host details update at phone and desktop widths',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runAccountQuotaBrowser } = await import('./helpers/account-quota-browser.js');
      await runAccountQuotaBrowser(sandbox);
    }, { timeoutMs: 165_000 });
    assert.equal(fs.existsSync(sandbox.root), false, 'private fixture root reclaimed');
    assert.equal(sandbox.children.size, 0, 'no fixture children remain');
    assert.ok([...sandbox.servers].every(server => !server.listening), 'fixture listeners reclaimed');
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
  });
