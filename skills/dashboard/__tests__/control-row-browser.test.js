import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: real dashboard HTML/modules/CSS with fixed API answers in private
// loopback Chrome; overview, usage, schedule and conversation outer control rows
// at 1280/390 and light/dark. Run for control sizing/alignment or responsive CSS;
// backend-only changes may skip. Optional survey captures all workbench sections.
// Official runner + sandbox prove private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and
// socket/database paths before allocation. No database/runtime/channel starts;
// browser, contexts, SSE and HTTP close on failure or timeout.
test('same-row dashboard controls have equal heights and aligned centers',
  { skip: !chatEnabled(), timeout: 240000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runControlRows } = await import('./helpers/control-row-browser.js');
      await runControlRows(t, sandbox);
    }, { timeoutMs: 230000 });
  });
