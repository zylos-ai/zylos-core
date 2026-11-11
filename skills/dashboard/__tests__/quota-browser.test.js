import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: actual quota renderers and CSS with synthetic snapshots on a loopback
// static server; no backend, auth, polling, DB, PM2 or tmux is started. Run when
// quota layout, labels or colors change; skip backend-only changes. The opt-in
// harness proves private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB paths
// before allocation and reclaims the server, browser and profile on every exit.
test('quota values stay on one line across locales, themes and screen widths',
  { skip: !chatEnabled(), timeout: 90_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runQuotaBrowser } = await import('./helpers/quota-browser.js');
      await runQuotaBrowser(sandbox);
    }, { timeoutMs: 80_000 });
  });
