import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Integration: actual Dashboard modules and translations in a static browser,
// across pool records, sizes and themes. Run for pool explanation or responsive
// layout changes; skip unrelated work. Private HOME/ZYLOS_DIR/PM2_HOME, short
// TMPDIR, socket and DB paths are proven before loopback startup. No DB, PM2 or
// tmux is opened. Browser network is loopback-only; teardown bounds every case.
test('pool explanations render across records, viewport sizes and themes',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runPoolCapacityBrowser } = await import('./helpers/pool-capacity-browser.js');
      await runPoolCapacityBrowser(sandbox);
    }, { timeoutMs: 110000 });
  });
