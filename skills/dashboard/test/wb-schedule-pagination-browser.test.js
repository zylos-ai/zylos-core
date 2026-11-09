import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Integration boundary: the real schedule page and real read model/routes over
// a private SQLite fixture; unrelated workbench APIs return fixed answers.
// Run for schedule list paging, summary/detail loading, search and page layout;
// skip for unrelated dashboard pages and scheduler dispatch-only changes.
// The opt-in sandbox proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket
// and database paths before opening SQLite, HTTP or Chrome, and owns cleanup.
test('schedule pages load completed tasks and full content on demand',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runSchedulePaginationBrowser } = await import('./helpers/schedule-pagination-browser.js');
      await runSchedulePaginationBrowser(t, sandbox);
    }, { timeoutMs: 170_000 });
  });
