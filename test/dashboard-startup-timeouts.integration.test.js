import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

const primary = '/_assets/i18n/zh.json';
const workbench = '/_assets/i18n/wb.zh.json';
const observer = '/api/observer/status';
const groups = '/api/workbench/groups';
const cases = [
  // Boundary: reload with real cached Chinese packs, hung main fetch, visible rows,
  // then background healing. Rerun for primary i18n/startup changes; other work can skip.
  ...[390, 1280].map(width => ({ name: `cached Chinese survives a hanging language request at ${width}px`, width, cached: true, blocked: [primary], heal: true })),
  // Boundary: first visit has no cache, mounts raw-key fallback, then heals without reload.
  // Rerun for primary i18n fallback/healing changes; unrelated work can skip.
  { name: 'first visit mounts and heals after a hanging language request', width: 390, blocked: [primary], heal: true },
  // Boundary: workbench's separate loader cannot stall startup, with or without cache.
  // Rerun for workbench i18n/startup changes; unrelated work can skip.
  ...[true, false].map(cached => ({ name: `hanging workbench language request mounts ${cached ? 'with' : 'without'} cache`, width: 390, cached, blocked: [workbench] })),
  // Boundary: each member of the observer Promise.all independently times out.
  // Groups also feeds board content: release it only AFTER proving the shell mounted.
  // Rerun for observer/groups startup changes; unrelated work can skip.
  { name: 'hanging observer status cannot prevent startup', width: 390, blocked: [observer] },
  { name: 'hanging groups cannot prevent startup', width: 390, blocked: [groups] },
  // Boundary: cumulative main + workbench retries + observer/group wait stays <=8s.
  // Rerun for any startup timeout/retry budget change; unrelated work can skip.
  ...[390, 1280].map(width => ({ name: `all startup requests hanging still mount within eight seconds at ${width}px`, width, cached: true, blocked: [primary, workbench, observer, groups] })),
  { name: 'all startup requests hanging without cache mount within eight seconds', width: 390, blocked: [primary, workbench, observer, groups] },
];

let failed = false;
for (const scenario of cases) {
  // All cases require the explicit gate and official runner. Sandbox proves isolated
  // HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR, private tmux socket and database paths
  // before HTTP/browser startup. No tmux/PM2/database is opened. Cleanup owns browser,
  // pending routes, streams and HTTP on failure, success and the case deadline.
  test(scenario.name, { skip: !chatEnabled(), timeout: 65000 }, async t => {
    if (failed) { t.skip('a prior startup case already provided a counterexample'); return; }
    const sandbox = createChatSandbox(t);
    try {
      await sandbox.runCase(async () => {
        const { runStartupTimeoutBrowser } = await import('./helpers/dashboard-startup-timeouts-browser.js');
        await runStartupTimeoutBrowser(sandbox, scenario);
      }, { timeoutMs: 55000 });
    } catch (error) { failed = true; throw error; }
  });
}
