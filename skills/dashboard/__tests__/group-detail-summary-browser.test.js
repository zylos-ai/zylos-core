import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: real Dashboard entry, group detail controller and conversation sidebar in a browser.
// Run for overview/conversation group-detail entry, responsive layout or native evidence-fold changes.
// Content, locale and detail-level combinations run in conversation-group-side.test.js without a browser.
// Unrelated backend/runtime work can skip. The official runner and opt-in sandbox prove isolated HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR, private socket and both DB paths before opening loopback HTTP.
// No database, model, PM2, tmux or external channel starts; HTTP/browser/context cleanup also owns timeout/failure.
test('group details open from overview and conversation and fit desktop and phone screens',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runGroupDetailSummaryBrowser } = await import('./helpers/group-detail-summary-browser.js');
      await runGroupDetailSummaryBrowser(t, sandbox);
    }, { timeoutMs: 170_000 });
  });
