import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Integration boundary: the real settings and memory pages over the real key list read (private SQLite) and the
// real backlog reader, order and paging (in-memory snapshot and group answers); other workbench APIs return fixed
// answers. Run for key list or memory backlog paging, search and layout; skip for unrelated dashboard pages.
// The opt-in sandbox proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket and database paths before
// opening SQLite, HTTP or Chrome, and owns cleanup.
test('the key list and the memory backlog page through the server, search it and survive a restart',
  { skip: !chatEnabled(), timeout: 400_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runKeysBacklogPaginationBrowser } = await import('./helpers/keys-backlog-pagination-browser.js');
      await runKeysBacklogPaginationBrowser(t, sandbox);
    }, { timeoutMs: 390_000 });
  });
