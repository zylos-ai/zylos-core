import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Integration: actual Dashboard modules and translations in a static browser,
// across numeric pool states, sizes and themes, including a narrow width sweep.
// Proves retired capacity provenance is neither read nor displayed. Run for pool observations or responsive
// layout changes; skip unrelated work. Private HOME/ZYLOS_DIR/PM2_HOME, short
// TMPDIR, socket and DB paths are proven before loopback startup. No DB, PM2 or
// tmux is opened. Browser network is loopback-only; teardown bounds every case.
test('numeric pool observations omit provenance across viewport sizes and themes',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runPoolCapacityBrowser } = await import('./helpers/pool-capacity-browser.js');
      await runPoolCapacityBrowser(sandbox);
    }, { timeoutMs: 110000 });
  });
