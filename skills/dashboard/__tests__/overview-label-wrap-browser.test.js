import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Integration boundary: the real overview page (board head counts, instance strip, legend) in headless Chrome at
// 1280 and 390 px, zh and en, plain and technical view, with the group drawer closed and open: no short label breaks
// inside, icon and value on screen with the details on hover (the item's name first in its title), the run mode
// first, and each icon's spoken name; the auto-name button in a box narrower than its label; the strip's pool item
// with numeric capacity and queue only at 3840, 1280 and390 px; the host panel has numeric slots without source,
// bucket or algorithm explanations, and follows group-count polls; absent outside multi mode. Refits on a window
// resize with the drawer open (to a width where the full form fits in any font and to one where it fits in none), on
// whole strip items after content grows on a poll without any compact measurement, and on coming back to the
// overview from another page without a window error. Product wording is read from the Dashboard's translation
// files, never copied into the test. It uses the workbench fixture API answers; no Core, runtime,
// PM2, tmux or database is started. Run for changes to the overview's head, instance strip (pool item included),
// legend, the host panel's pool section, their labels or label-fit.js; skip for other pages. Opt-in with the same
// gate as the other browser cases before any directory, server or browser is allocated; the harness proves the
// private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket paths and closes the browser and HTTP server when the case ends.
test('overview short labels stay whole: compact first, then whole labels wrap',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runOverviewLabelWrapBrowser } = await import('./helpers/overview-label-wrap-browser.js');
      await runOverviewLabelWrapBrowser(t, sandbox);
    }, { timeoutMs: 170_000 });
  });
