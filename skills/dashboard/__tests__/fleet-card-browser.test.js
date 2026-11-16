import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Real Dashboard HTML/modules/CSS; fixture APIs only. The gate precedes resource allocation.
// No Core, PM2, tmux or database starts; the sandbox proves private paths and reclaims listeners.
test('Fleet instance cards omit Origin child badges across themes and viewport sizes',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runFleetCardBrowser } = await import('./helpers/fleet-card-browser.js');
      await runFleetCardBrowser(t, sandbox);
    }, { timeoutMs: 110_000 });
    assert.equal(fs.existsSync(sandbox.root), false);
    assert.equal(sandbox.children.size, 0);
    assert.ok([...sandbox.servers].every(server => !server.listening));
    assert.deepEqual(sandbox.counts, { db: 0, http: 1, runtime: 0 });
    console.log('Fleet card cleanup:', JSON.stringify({ rootRemoved: true, listeners: 0, children: 0, counts: sandbox.counts }));
  });
