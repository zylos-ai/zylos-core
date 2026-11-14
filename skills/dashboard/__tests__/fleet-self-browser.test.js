import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, chatResourceCounts, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: actual Dashboard HTML, modules and styles with fixture API responses, including server-generated
// fleet records and running-group summaries. Run for fleet reachability/state labels, self session-mode or
// Fleet summary contract changes; skip unrelated pages. This fixture proves rendering, not live collection.
// The opt-in gate precedes imports that allocate resources. No Core, PM2, tmux or database is started; the chat
// sandbox proves private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DB paths and owns all cleanup.
test('reachable self UNKNOWN keeps its configured mode on the real fleet page',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runFleetSelfBrowser } = await import('./helpers/fleet-self-browser.js');
      await runFleetSelfBrowser(t, sandbox);
    }, { timeoutMs: 110_000 });
    assert.equal(fs.existsSync(sandbox.root), false, 'private fixture root reclaimed');
    assert.equal(sandbox.children.size, 0, 'no fixture children remain');
    assert.ok([...sandbox.servers].every(server => !server.listening), 'fixture listeners reclaimed');
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
    console.log('Fleet browser reclaimed:', JSON.stringify({ rootRemoved: true, listeners: 0, children: 0,
      counts: sandbox.counts, resourceStarts: chatResourceCounts() }));
  });
