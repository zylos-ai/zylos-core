import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Boundary: the complete product page, modules, styles and real Chart.js, with read-only API fixtures.
// Run for Fleet clock readiness, runtime effort visibility, Observer clocks, memory units or cache curves.
// The gate precedes resources; the normal Node runner supplies the private parent HOME and TMPDIR.
test('Dashboard display facts survive cold loads, refresh and desktop/mobile themes and languages',
  { skip: !chatEnabled(), timeout: 240_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runDashboardDisplayBrowser } = await import('./helpers/dashboard-display-browser.js');
      await runDashboardDisplayBrowser(t, sandbox);
    }, { timeoutMs: 230_000 });
    assert.equal(fs.existsSync(sandbox.root), false, 'private fixture root reclaimed');
    assert.equal(sandbox.children.size, 0, 'no browser children remain');
    assert.ok([...sandbox.servers].every(server => !server.listening), 'HTTP listeners reclaimed');
  });
