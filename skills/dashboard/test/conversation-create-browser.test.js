import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Real full entry, page/controller, styles and SSE with a bounded fixture API.
// Covers one-click draft creation and name propagation across two open pages;
// not the server's first-reply decision, control queue or model execution.
// Run for creation UI or conversation-name refresh changes; skip backend-only changes.
// Opt-in before allocation. The sandbox proves private HOME/ZYLOS_DIR/PM2_HOME,
// short TMPDIR, socket and DB paths; no PM2/tmux/DB/model is started.
// Browser contexts, HTTP connections and sandbox resources are reclaimed on failure too.
test('conversation creation needs no name and open pages receive the resulting name',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationCreateBrowser } = await import('./helpers/conversation-create-browser.js');
      await runConversationCreateBrowser(t, sandbox);
    }, { timeoutMs: 110000 });
  });
