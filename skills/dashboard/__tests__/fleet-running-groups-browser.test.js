import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, chatResourceCounts, createChatSandbox } from './helpers/chat-integration-harness.js';

// Actual Dashboard HTML/ESM/CSS; only API responses are fixtures. The opt-in gate runs before importing
// browser code or allocating resources. No Core, PM2, tmux, live config, DB or remote service is started.
test('fleet running-group cards: Scheme A on phone and desktop, light and dark',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runFleetRunningGroupsBrowser } = await import('./helpers/fleet-running-groups-browser.js');
      await runFleetRunningGroupsBrowser(t, sandbox);
    }, { timeoutMs: 170_000 });
    assert.equal(fs.existsSync(sandbox.root), false, 'private fixture root reclaimed');
    assert.equal(sandbox.children.size, 0, 'no fixture children remain');
    assert.ok([...sandbox.servers].every(server => !server.listening), 'fixture listeners reclaimed');
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
    console.log('Running groups browser reclaimed:', JSON.stringify({ rootRemoved: true, listeners: 0, children: 0,
      counts: sandbox.counts, resourceStarts: chatResourceCounts() }));
  });
