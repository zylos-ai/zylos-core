import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Boundary: actual status-file reader -> status view -> classification -> mounted Dashboard.
// Run when stale status propagation/presentation changes; unrelated runtime changes can skip.
// Official runner + gated sandbox prove private HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR,
// tmux socket and database targets before startup. No tmux, PM2 or database is opened.
// File has no writer after setup; real elapsed time crosses the display cutoff.
// Sandbox owns HTTP/browser lifecycle on success, failure and timeout.
test('stopped status updates age from retained state to unknown on desktop and phone',
  { skip: !chatEnabled(), timeout: 180000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runStaleStatusBrowser } = await import('./helpers/dashboard-stale-status-browser.js');
      await runStaleStatusBrowser(t, sandbox);
    }, { timeoutMs: 170000 });
  });
