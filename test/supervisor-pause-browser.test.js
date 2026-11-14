import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Boundary: real Dashboard HTML/modules/styles with fixture state and Fleet APIs. Run when supervisor pause
// fields or their UI change; unrelated pages may skip. No live config, Core, PM2, tmux or DB is opened.
// The harness proves private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths and owns browser/HTTP cleanup.
test('supervisor pause appears and clears on Fleet and Dashboard at phone and desktop widths',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runSupervisorPauseBrowser } = await import('./helpers/supervisor-pause-browser.js');
      await runSupervisorPauseBrowser(sandbox);
    }, { timeoutMs: 110_000 });
    assert.equal(fs.existsSync(sandbox.root), false, 'private fixture root reclaimed');
    assert.equal(sandbox.children.size, 0, 'no fixture children remain');
    assert.ok([...sandbox.servers].every(server => !server.listening), 'fixture listeners reclaimed');
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
  });
