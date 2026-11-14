import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: actual composed renderer's whole-invalid and unknown-block literal
// fallbacks, confirmation styles and Chart.js duration display. Run for changes
// to these paths; skip unrelated backend/runtime work.
// Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB paths are proven before
// local HTTP and browser startup. No database or runtime is opened. The sandbox
// owns HTTP/browser cleanup on success, failure and timeout.
test('invalid fallback, confirmation severity and duration charts fit both themes and widths',
  { skip: !chatEnabled(), timeout: 90_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runDisplayRefinements } = await import('./helpers/display-refinements.js');
      await runDisplayRefinements(sandbox);
    }, { timeoutMs: 80_000 });
  });
