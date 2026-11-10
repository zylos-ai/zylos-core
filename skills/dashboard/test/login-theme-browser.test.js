import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Integration boundary: the real login route (AuthGate) in headless Chrome at 390 and 1280 px, with the
// Dashboard's saved theme and the system colour scheme varied. Run for changes to the login page, the theme
// files or how the Dashboard saves its theme; skip for other pages. The opt-in sandbox proves
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket before opening HTTP or Chrome, blocks every request
// outside the local server, and owns cleanup. No database is opened.
test('the login page follows the Dashboard theme, else the system, from the first paint',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runLoginThemeBrowser } = await import('./helpers/login-theme-browser.js');
      await runLoginThemeBrowser(t, sandbox);
    }, { timeoutMs: 110_000 });
  });
