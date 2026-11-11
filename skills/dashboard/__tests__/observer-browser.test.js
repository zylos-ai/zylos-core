import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Real observer app/navigation/request/retry handlers in a private browser; bounded API,
// iframe and WebSocket transport fixtures. No Core, tmux, PM2 or database is started.
// Run for observer selection, lease validation/cleanup, retry or status-count changes;
// skip for unrelated pages and backend-only edits. The opt-in gate runs before resource
// allocation. Every server/context/wait is tied to the isolated sandbox lifecycle.
test('observer navigation preserves target binding and recovers from superseded requests',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async ({ signal }) => {
      const { runObserverBrowser } = await import('./helpers/observer-browser.js');
      await runObserverBrowser(t, sandbox, signal);
    }, { timeoutMs: 170_000 });
  });
