import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: real frontend entry/modules/styles and fixed existing API shapes in
// a private loopback browser fixture. Run for mobile shell, focus/menu/composer
// or chat layout changes; unrelated runtime/backend work may skip this opt-in.
// The official runner/sandbox proves private HOME/ZYLOS_DIR/PM2_HOME, short
// TMPDIR/socket/database paths before allocation. No DB/runtime/channel starts.
// Browser, contexts, SSE and HTTP are lifecycle-bound, including failed cases.
test('mobile conversation navigation keeps focus and existing actions',
  { skip: !chatEnabled(), timeout: 150000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runMobileConversationBrowser } = await import('./helpers/mobile-conversation-browser.js');
      await runMobileConversationBrowser(t, sandbox);
    }, { timeoutMs: 140000 });
  });
