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
  ...[true, false].map(cached => ({ name: `hanging workbench language request mounts ${cached ? 'with' : 'without'} cache`, width: 390, cached, blocked: [workbench], heal: true })),
  // Boundary: neither pending observer read may prevent the UI deadline advancing.
  // Groups also feeds board content: release it only AFTER proving the shell mounted.
  // Rerun for observer/groups startup changes; unrelated work can skip.
  { name: 'hanging observer status cannot prevent startup', width: 390, blocked: [observer] },
  { name: 'hanging groups cannot prevent startup', width: 390, blocked: [groups] },
  // Boundary: all pending requests outlive the six-second UI wait; mounting stays <=8s.
  // Rerun for any startup timeout/retry budget change; unrelated work can skip.
  ...[390, 1280].map(width => ({ name: `all startup requests hanging still mount within eight seconds at ${width}px`, width, cached: true, blocked: [primary, workbench, observer, groups], heal: true })),
  { name: 'all startup requests hanging without cache mount within eight seconds', width: 390, blocked: [primary, workbench, observer, groups], heal: true },
  // Boundary: slow valid language responses must complete, update UI and persist cache.
  // Rerun for pack timing/merge/cache changes; unrelated changes may skip.
  ...[390, 1280].flatMap(width => [primary, workbench].map(slow => ({
    name: `first visit accepts a slow ${slow === primary ? 'main' : 'workbench'} language response at ${width}px`,
    width, blocked: [], slow, delayMs: 1500,
  }))),
  // Boundary: startup status continues after UI mounts and renders its late response.
  // Rerun for observer startup coordination; unrelated changes may skip.
  { name: 'startup observer status updates after its UI wait expires', width: 390, blocked: [observer], lateObserver: true },
  // Boundary: real observer opening accepts a two-second status refresh and retains state.
  // Rerun for observer refresh/open timing changes; unrelated changes may skip.
  { name: 'opening observer accepts a slow status response after startup', width: 390, blocked: [], postObserver: true },
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
