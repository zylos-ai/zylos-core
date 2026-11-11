import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: the real workbench page (overview, group detail, memory, schedule, settings) in a local browser,
// with fixed API answers and recorded dashboard actions; no Core, runtime, PM2, tmux or database is started.
// Run for changes to the workbench pages' layout, the app header (brand colour, Core version), the phone stylesheet (portrait and a phone on its side), the page actions and their confirmation,
// memory/detail navigation, the group timeline's event filtering and order, or the phone settings drawer and the page's history handling; skip for backend-only and conversation-page-only changes. Opt-in with the same
// gate as the chat browser cases before any directory, server or browser is allocated; the harness proves the
// private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket paths and closes the browser and HTTP server when the case ends.
test('workbench pages ask before acting and fit a phone screen',
  { skip: !chatEnabled(), timeout: 240_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runWorkbenchBrowser } = await import('./helpers/workbench-browser.js');
      await runWorkbenchBrowser(t, sandbox);
    }, { timeoutMs: 230_000 });
  });
