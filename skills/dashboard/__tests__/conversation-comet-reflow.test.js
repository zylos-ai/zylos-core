import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: real conversation entry/modules/CSS, loopback fixture SSE/API, reply
// insertion/activity folding/scroll/working transitions at 390px. Run for busy
// capsule or message/header layout changes; skip unrelated backend changes.
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket/test DB paths are proven
// before launch. No DB/runtime/model/channel/PM2/tmux starts. All producers,
// browsers and directories are owned and reclaimed by the opt-in sandbox.
for (const engine of ['chromium', 'webkit']) test(`${engine} conversation reply reflow keeps the border light on its capsule`,
  { skip: !chatEnabled(), timeout: 180000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runCometReflowBrowser } = await import('./helpers/conversation-comet-reflow-browser.js');
      await runCometReflowBrowser(t, sandbox, engine);
    }, { timeoutMs: 170000 });
  });
