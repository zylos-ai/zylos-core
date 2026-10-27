import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildAgentFleetView, liveStateMood, renderAgentFleetHtml } from '../public/js/agent-fleet.js';
import { validAgentSize, validObserverSize } from '../public/js/observer-size.js';
import { agentColor } from '../src/lib/agent-color.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, reject, resolve };
}

function observerUiHarness(app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8')) {
  const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
  const source = [
    slice('function setObserverNotice(', 'function activeTabName('),
    slice('function activeTabName(', '// ─── Fleet view switch'),
    slice('function showFleetView(', 'function clearFleetFallback('),
    slice('function hasFleetWall(', '// Clear all per-agent data'),
    slice('function initFleetMode(', 'function initLocaleToggle('),
    slice('function initTabs(', 'function initObserverControls('),
    slice('function resetAgentData(', 'function initFleetMode('),
    slice('function observerStatusLabel(', 'function addPriceRow(')
  ].join('\n');
  let autoFrameReady = true;
  const elements = {
    '#observer-notice': { dataset: {} },
    '#observer-frame': { style: {}, contentWindow: { postMessage(_message, _origin, ports) { if (autoFrameReady) queueMicrotask(() => ports[0].peer.onmessage?.({ data: { type: 'ready' } })); } }, parentElement: { dataset: {} } },
    '#observer-target': {},
    '#observer-tab': { hidden: false },
    '#observer-size-form': { hidden: false, dataset: {} },
    '#observer-size-cols': { value: '120' },
    '#observer-size-rows': { value: '50' },
    '#observer-size-apply': { disabled: false },
    '#observer-size-status': { textContent: '', dataset: {} }
  };
  Object.defineProperty(elements['#observer-frame'], 'srcdoc', { set(value) { this.document = value; queueMicrotask(() => this.onload?.()); }, get() { return this.document; } });
  const settings = Object.fromEntries(['status', 'state', 'platform', 'recovery', 'install', 'enable', 'disable', 'uninstall'].map((name) => [
    name === 'status' || name === 'state' || name === 'platform' || name === 'recovery' ? `#observer-settings-${name}` : `#observer-${name}`, { hidden: true, textContent: '', disabled: false }
  ]));
  const buttons = ['install', 'enable', 'disable', 'uninstall'].map((name) => settings[`#observer-${name}`]);
  const calls = [];
  const sockets = [];
  const history = [];
  const intervals = [];
  const timeouts = [];
  const listeners = {};
  const tabs = ['overview', 'trends', 'memory', 'observer'].map((name) => ({
    dataset: { tab: name },
    classList: { toggle(_className, active) { this.active = active; } },
    addEventListener(event, handler) { this[event] = handler; }
  }));
  const panels = tabs.map(({ dataset }) => ({
    id: `tab-${dataset.tab}`,
    hidden: true,
    classList: { toggle() {} }
  }));
  let fetchImpl = async () => { throw new Error('unexpected fetch'); };
  let readOnly = false;
  const context = {
    state: {
      remoteAgent: null,
      navigationGeneration: 0,
      multiAgent: true,
      observer: { generation: 0, statusGeneration: 0, statusRequest: null }
    },
    settingsModal: { querySelector: (selector) => settings[selector], querySelectorAll: () => buttons },
    $: (selector) => elements[selector],
    document: {
      querySelectorAll: (selector) => selector === '.tab' ? tabs : selector === '.tab-panel' ? panels : [],
      querySelector: (selector) => selector === '.tab.active' ? tabs.find((tab) => tab.classList.active) || null : null,
      addEventListener() {},
      visibilityState: 'visible'
    },
    t: (key) => key,
    clearTimeout(id) { if (timeouts[id - 1]) timeouts[id - 1].cancelled = true; },
    clearInterval() {},
    setInterval: (handler) => { intervals.push(handler); return intervals.length; },
    setTimeout: (handler, delay) => { handler.delay = delay; timeouts.push(handler); return timeouts.length; },
    URL,
    AbortController,
    validObserverSize,
    validAgentSize,
    ArrayBuffer,
    window: {
      location: { href: 'http://fixture.local/dashboard/', pathname: '/' },
      history: { pushState: (...args) => { history.push(args); context.window.location.pathname = args[2]; } },
      addEventListener: (name, handler) => { listeners[name] = handler; }
    },
    encodeURIComponent,
    REMOTE_AGENT: null,
    MessageChannel: class {
      constructor() {
        this.port1 = { messages: [], postMessage(message) { this.messages.push(message); }, start() {}, close() {} };
        this.port2 = { peer: this.port1 };
      }
    },
    WebSocket: class {
      constructor(url) { this.url = String(url); sockets.push(this); }
      close() { this.closed = true; }
    },
    fetch: (...args) => {
      calls.push({ url: String(args[0]), options: args[1] });
      return fetchImpl(...args);
    },
    observerEndpoint: (suffix) => `${context.state.remoteAgent ? `/fleet/${context.state.remoteAgent}` : ''}${suffix}`,
    viewedAgentName: () => context.state.remoteAgent || 'self',
    remoteIsReadOnly: () => readOnly,
    connectSse() {},
    transitionView() {},
    refreshFleet: async () => {},
    scheduleFleetFallback() {},
    clearFleetFallback() {},
    syncFleetSubscription() {},
    prefersReducedMotion: () => false,
    refreshAll: async () => {},
    refreshCharts() {},
    loadMemoryTree: async () => {},
    syncMemoryPinned() {},
    resetMemoryState() {},
    prevSubagentIds: new Set(),
    closeActionsModal() {},
    closeSettingsModal() {},
    renderAll() {},
    remotePrefix: () => context.state.remoteAgent ? `/fleet/${context.state.remoteAgent}` : '',
    api: (value) => value
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    calls,
    context,
    elements,
    history,
    intervals,
    timeouts,
    listeners,
    sockets,
    setAutoFrameReady(value) { autoFrameReady = value; },
    setReadOnly(value) { readOnly = value; },
    settings,
    buttons,
    tabs,
    setFetch(implementation) { fetchImpl = implementation; }
  };
}

function observerResponse(data, { ok = true, status = ok ? 200 : 503 } = {}) {
  return { ok, status, json: async () => data, text: async () => '<html>renderer</html>' };
}

test('prompt source transient display is capped at 5 seconds', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /const PROMPT_TRANSIENT_SECONDS = 5;/);
  assert.match(app, /promptAge < PROMPT_TRANSIENT_SECONDS/);
  assert.doesNotMatch(app, /promptAge < 30/);
});

test('single-agent mascot uses the octopus PNGs shared with Agent Fleet and tinted by agent hue', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url).pathname, 'utf8');
  // Reuses the Agent Fleet mood logic + mascot file map (single source of truth).
  assert.match(app, /import \{ renderAgentFleet, liveStateMood, MASCOT_BY_MOOD \} from '\.\/agent-fleet\.js'/);
  // Renders an <img> from the shared mascot set, not the legacy inline SVG.
  assert.match(app, /img class="mascot-img" src="\$\{ASSET_ROOT\}\/img\/mascot\//);
  assert.match(app, /hue-rotate\(\$\{hue\}deg\)/);
  // Legacy pixel-art SVG mascot generator is gone.
  assert.doesNotMatch(app, /function mascotSvg\(/);
  // /api/state exposes the agent's identity color/hue for the tint.
  assert.match(index, /stateData\.agent = \{ \.\.\.config\.agent, \.\.\.agentColor\(config\.agent\?\.name\) \}/);
});

test('SSE state updates preserve the agent identity color so the mascot stays tinted', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // The SSE state_change payload omits the agent color (added only by
  // /api/state). The client must carry it over, the same way it already does
  // for runtime_info, so the single-agent mascot doesn't flicker back to the
  // untinted base art on every live update.
  assert.match(app, /const prevAgent = state\.dashboardState\?\.agent;/);
  assert.match(app, /if \(!data\.agent && prevAgent\) state\.dashboardState\.agent = prevAgent;/);
});

test('runtime info upgrade badges use semver-aware comparison', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url).pathname, 'utf8');
  const runtimeInfo = fs.readFileSync(new URL('../src/lib/runtime-info.js', import.meta.url).pathname, 'utf8');
  assert.match(runtimeInfo, /isNewerVersion\(latest\.cc, ccEffectiveVersion\)/);
  assert.match(runtimeInfo, /isNewerVersion\(latest\.zylos, zylosVersion\)/);
  assert.match(runtimeInfo, /isNewerVersion\(latest\.codex, codexInstalledVersion\)/);
  assert.match(index, /applyVersionUpdateFields\(info, latest,/);
  assert.doesNotMatch(index, /latest\.cc !== ccEffective/);
  assert.doesNotMatch(index, /latest\.zylos !== zylosVersion/);
});

test('Codex runtime renders CLI update badge in info bar and actions modal', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /const codexVersion = ri\.codex_running \|\| ri\.codex_version \|\| ri\.codex_installed;/);
  assert.match(app, /if \(ri\.codex_restart\) cv \+=/);
  assert.match(app, /else if \(ri\.codex_update\) cv \+=/);
  assert.match(app, /const cliUpdate = meta\.runtime_cli === 'codex' \? ri\?\.codex_restart \|\| ri\?\.codex_update : ri\?\.cc_update;/);
  assert.match(app, /ccVer\.classList\.toggle\('action-ver-dot', !!cliUpdate\)/);
});

test('zylos-core upgrade is left to the agent: no Actions button, info bar shows a non-action hint', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8'));
  assert.doesNotMatch(app, /data-action="upgrade-zylos"/);
  assert.doesNotMatch(app, /action-zylos-ver/);
  assert.match(app, /data-action="upgrade-cc"/);
  assert.match(app, /if \(ri\.zylos_update\) zv \+= ` <span class="info-bar-hint" id="zylos-update-hint"/);
  assert.doesNotMatch(app, /ri\.zylos_update[^\n]*info-bar-update/);
  assert.match(app, /e\.target\.closest\('#actions-btn, \.info-bar-update'\)/);
  assert.match(en['info.zylos_update_hint'], /ask your agent: "Please upgrade your zylos-core to the latest version\."/);
  assert.match(zh['info.zylos_update_hint'], /请升级你的 zylos-core 到最新版本/);
});

test('Codex runtime info exposes running, installed, effective, and restart fields', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url).pathname, 'utf8');
  assert.match(index, /const codexRunning = activeRuntime === 'codex' \? codexRuntimeInfo\?\.cli_version \|\| null : null;/);
  assert.match(index, /codex_version: codexRunning \|\| codexInstalledVersion \|\| null,/);
  assert.match(index, /codex_running: codexRunning,/);
  assert.match(index, /codex_installed: codexInstalledVersion \|\| null,/);
  assert.match(index, /info\.codex_restart = codexInstalledVersion;/);
  assert.match(index, /pending_restart: !!needsRestart,/);
});

test('upgrade-zylos writes a restart marker and uses double-fork spawning', () => {
  const actions = fs.readFileSync(new URL('../src/lib/actions.js', import.meta.url).pathname, 'utf8');
  assert.match(actions, /upgrade-zylos-pending\.json/);
  assert.match(actions, /spawn\(process\.execPath, \['-e', script\]/);
  assert.match(actions, /spawn\('zylos', \['upgrade', '--self', '-y'\]/);
});

function fleetFixture() {
  const now = '2026-06-07T15:20:00.000Z';
  return {
    updated_at: now,
    agents: [
      {
        name: 'zylos02',
        color: agentColor('zylos02').color,
        hue: agentColor('zylos02').hue,
        state: 'IDLE',
        activity: null,
        context_pct: 0.18,
        session_cost: 0.006,
        daily_cost: 0.04,
        weekly_cost: 0.2,
        model: 'Opus 4.6',
        effort: 'high',
        new_session_threshold: 70,
        cpu_pct: 12,
        mem_pct: 34,
        disk_pct: 56,
        has_upgrade: false,
        has_subagent: false,
        cost: 0.006,
        last_seen: now,
        pulse_rate: 1,
        health_reason: 'idle',
        sparkline: [0.001, 0.003, 0.006]
      },
      {
        name: 'zylos01',
        color: agentColor('zylos01').color,
        hue: agentColor('zylos01').hue,
        state: 'BUSY',
        activity: 'exec_command npm test',
        context_pct: 72,
        session_cost: 0.12,
        daily_cost: 0.4,
        weekly_cost: 1.8,
        model: 'GPT-5',
        effort: 'medium',
        new_session_threshold: 70,
        cpu_pct: 21,
        mem_pct: 43,
        disk_pct: 65,
        has_upgrade: true,
        has_subagent: true,
        cost: 0.12,
        last_seen: '2026-06-07T15:19:45.000Z',
        pulse_rate: 0.8,
        health_reason: 'ok',
        sparkline: [0.02, 0.08, 0.12]
      },
      {
        name: 'zylos0t',
        color: agentColor('zylos0t').color,
        hue: agentColor('zylos0t').hue,
        state: 'POSSIBLY_STUCK',
        activity: 'no progress',
        context_pct: 0.91,
        session_cost: 0.03,
        daily_cost: 0.09,
        weekly_cost: 0.7,
        model: 'Sonnet',
        effort: 'low',
        new_session_threshold: 80,
        cpu_pct: 82,
        mem_pct: 71,
        disk_pct: 44,
        has_upgrade: false,
        has_subagent: false,
        cost: 0.03,
        last_seen: '2026-06-07T15:18:00.000Z',
        pulse_rate: 1.5,
        health_reason: 'stuck'
      },
      {
        name: 'eva',
        color: agentColor('eva').color,
        hue: agentColor('eva').hue,
        state: 'OFFLINE',
        activity: 'last message',
        context_pct: null,
        session_cost: 0,
        daily_cost: null,
        weekly_cost: null,
        model: null,
        effort: null,
        new_session_threshold: null,
        cpu_pct: null,
        mem_pct: null,
        disk_pct: null,
        has_upgrade: false,
        has_subagent: false,
        cost: 0,
        last_seen: '2026-06-07T14:20:00.000Z',
        pulse_rate: 0,
        health_reason: 'unreachable'
      }
    ]
  };
}

test('Agent Fleet fixture renders operational fields and removes deprecated Pulse Wall elements', () => {
  const view = buildAgentFleetView(fleetFixture(), {
    basePath: '/dash',
    mascotRoot: '/dash/_assets/img/mascot'
  });
  const html = renderAgentFleetHtml(fleetFixture(), {
    basePath: '/dash',
    mascotRoot: '/dash/_assets/img/mascot'
  });

  assert.equal(view.tiles.length, 4);
  assert.equal(view.counts.busy, 1);
  assert.equal(view.counts.idle, 1);
  assert.equal(view.counts.stuck, 1);
  assert.equal(view.counts.offline, 1);
  assert.match(html, /class="agent-tile agent-tile-busy/);
  assert.match(html, /class="agent-tile agent-tile-stuck/);
  assert.match(html, /class="agent-tile agent-tile-offline is-offline/);
  assert.match(html, /Unreachable/);
  assert.match(html, /agent-state mood-idle/);
  assert.match(html, /agent-state mood-busy/);
  assert.match(html, /agent-state mood-stuck/);
  assert.match(html, /agent-state mood-offline/);
  assert.match(html, /ring-warning/);
  assert.doesNotMatch(html, /ring-critical/);
  assert.equal((html.match(/class="agent-fleet-reason"/g) || []).length, 2);
  assert.match(html, /href="\/dash\/fleet\/zylos01\/"/);
  assert.match(html, /src="\/dash\/_assets\/img\/mascot\/busy\.png"/);
  assert.match(html, new RegExp(`data-agent="zylos01"[^>]+--agent-hue:${agentColor('zylos01').hue}deg;`));
  assert.match(html, /GPT-5 \/ medium/);
  assert.doesNotMatch(html, /agent-upgrade-badge/);
  assert.doesNotMatch(html, /Upgrade available/);
  assert.match(html, /Session/);
  assert.match(html, /Today/);
  assert.match(html, /7 days/);
  assert.match(html, /CPU/);
  assert.match(html, /Memory/);
  assert.match(html, /Disk/);
  assert.match(html, /subagent-light is-on/);
  assert.doesNotMatch(html, /pulse-sparkline/);
  assert.doesNotMatch(html, /last seen/);
  assert.doesNotMatch(html, /--pulse-rate/);
  assert.doesNotMatch(html, /pulse-self-badge/);
});

test('Agent Fleet tile shows subagent count badge only when subagents are active (#279)', () => {
  const fixture = fleetFixture();
  fixture.agents[0].has_subagent = true;
  fixture.agents[0].subagent_count = 37;
  const html = renderAgentFleetHtml(fixture, { basePath: '/dash' });
  assert.match(html, /class="fleet-subagent-badge"[^>]*>⚡37</);
  assert.equal((html.match(/fleet-subagent-badge/g) || []).length, 1);

  // Payloads without the field (older remotes) and zero-count agents render no badge.
  const bareHtml = renderAgentFleetHtml(fleetFixture(), { basePath: '/dash' });
  assert.doesNotMatch(bareHtml, /fleet-subagent-badge/);
});

test('Agent Fleet preserves self first and stable name color mapping when response order changes', () => {
  const fixture = fleetFixture();
  fixture.agents[1].self = true;
  const original = buildAgentFleetView(fixture);
  const shuffledFixture = fleetFixture();
  shuffledFixture.agents[1].self = true;
  shuffledFixture.agents = [...shuffledFixture.agents].reverse();
  const shuffled = buildAgentFleetView(shuffledFixture);

  const originalColors = Object.fromEntries(original.tiles.map((tile) => [tile.name, tile.color]));
  const shuffledColors = Object.fromEntries(shuffled.tiles.map((tile) => [tile.name, tile.color]));
  const originalHues = Object.fromEntries(original.tiles.map((tile) => [tile.name, tile.hue]));
  const shuffledHues = Object.fromEntries(shuffled.tiles.map((tile) => [tile.name, tile.hue]));
  assert.deepEqual(shuffledColors, originalColors);
  assert.deepEqual(shuffledHues, originalHues);
  assert.ok(Object.values(originalHues).some((hue) => hue !== 0));
  assert.equal(shuffled.tiles[0].name, 'zylos01');
  assert.equal(shuffled.tiles[0].isSelf, true);
});

test('Agent Fleet uses SSE fleet events with one-shot fetch fallback', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /function clearFleetFallback\(\)/);
  assert.match(app, /function shouldReceiveFleetEvents\(\)/);
  assert.match(app, /function isSseOpen\(\)/);
  assert.match(app, /!!window\.EventSource && state\.eventSource\?\.readyState === window\.EventSource\.OPEN/);
  assert.match(app, /state\.fleetViewActive && document\.visibilityState !== 'hidden'/);
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{/);
  // #247: returning to the foreground refetches immediately instead of
  // waiting out the 10s fleet fallback / 30s poll timers.
  assert.match(app, /if \(document\.visibilityState === 'visible'\) refreshAll\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(app, /source\.addEventListener\(ev,/);
  assert.match(app, /'fleet'/);
  assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?refreshFleet\(\)\.catch\(\(\) => \{\}\);[\s\S]*?\}, 10_000\)/);
  assert.match(app, /refreshFleet\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(app, /state\.fleetTimer = setInterval\(refreshFleet, 3_000\)/);
  assert.doesNotMatch(app, /setInterval\(\(\) => \{\s*refreshFleet/);
  assert.doesNotMatch(app, /[^.]EventSource\.OPEN/);
});

test('multi-agent vs single mode landing view is gated on fleet size', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // multiAgent is true when the fleet (self + at least one external) has >= 2
  // agents — but never in remote-proxy context, where the remote's own fleet
  // config must not hijack the landing view.
  assert.match(app, /function hasFleetWall\(fleet\)/);
  assert.match(app, /return !REMOTE_AGENT && \(fleet\?\.agents\?\.length \|\| 0\) >= 2;/);
  assert.match(app, /function syncLiveFleetMode\(fleet\)/);
  assert.match(app, /const modeChanged = state\.fleetModeInitialized \? syncLiveFleetMode\(payload\) : false;/);
  // Remote context is derived from the proxy-injected base path.
  assert.match(app, /BASE_PATH\.match\(/);
  // Multi-agent mode lands on Agent Fleet; single mode shows the agent dashboard,
  // including live 0<->1 remote transitions after boot.
  assert.match(app, /if \(!state\.multiAgent\)/);
  assert.match(app, /showFleetView\(\{ animate: !prefersReducedMotion\(\) \}\)/);
  assert.match(app, /showAgentDetail\(\{ animate: !prefersReducedMotion\(\) \}\)/);
  // Early fetch drives the landing-view decision.
  assert.match(app, /applyFleetMode\(fleet\)/);
});

test('fleet ↔ agent view transition is wired with a graceful fallback', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  // Both top-level views live in a shared grid stack and carry the app-view class.
  assert.match(index, /id="view-stack"/);
  assert.match(index, /id="fleet-view"[^>]*class="[^"]*app-view|class="[^"]*app-view[^"]*"[^>]*id="fleet-view"/);
  assert.match(index, /id="agent-detail"[^>]*class="[^"]*app-view|class="[^"]*app-view[^"]*"[^>]*id="agent-detail"/);
  // The animated transition helper exists and is used by both directions.
  assert.match(app, /function transitionView\(target/);
  assert.match(app, /transitionView\('fleet'/);
  assert.match(app, /transitionView\('agent'/);
  // Graceful fallback: reduced motion / missing stack / already-active → instant swap.
  assert.match(app, /prefersReducedMotion\(\)/);
  // First-load deliberately dwells on the single-agent page, then zooms to the wall.
  assert.match(app, /setTimeout\(\(\) => showFleetView\(\{ animate: true \}\), \d+\)/);
  // CSS defines the stack and the zoom enter/leave states.
  assert.match(css, /\.view-stack\s*\{\s*display:\s*grid/);
  assert.match(css, /\.app-view\.v-enter/);
  assert.match(css, /\.app-view\.v-leave-to-fleet/);
  assert.match(css, /\.app-view\.v-leave-to-agent/);
});

test('self tile drills to local root and external tiles drill to /fleet/<name>/', () => {
  const selfFleet = {
    updated_at: '2026-06-07T15:20:00.000Z',
    agents: [
      { name: 'local', color: agentColor('local').color, hue: agentColor('local').hue, state: 'IDLE', context_pct: 0.2, cost: 0.01, last_seen: '2026-06-07T15:20:00.000Z', pulse_rate: 1, health_reason: 'idle', self: true },
      { name: 'remote', color: agentColor('remote').color, hue: agentColor('remote').hue, state: 'BUSY', activity: 'work', context_pct: 0.5, cost: 0.02, last_seen: '2026-06-07T15:20:00.000Z', pulse_rate: 1, health_reason: 'ok', self: false }
    ]
  };
  const view = buildAgentFleetView(selfFleet, {
    basePath: '/dash'
  });
  const byName = Object.fromEntries(view.tiles.map((tile) => [tile.name, tile]));
  assert.equal(byName.local.isSelf, true);
  assert.equal(byName.local.href, '/dash/');
  assert.equal(byName.remote.isSelf, false);
  assert.equal(byName.remote.href, '/dash/fleet/remote/');

  const html = renderAgentFleetHtml(selfFleet, {
    basePath: '/dash'
  });
  assert.match(html, /class="agent-tile agent-tile-idle is-self context-ok"/);
  assert.match(html, /data-self="true"/);
  assert.match(html, /href="\/dash\/"/);
  assert.match(html, /href="\/dash\/fleet\/remote\/"/);
});

test('back-to-fleet control is hidden via [hidden] in single-agent mode (no CSS specificity leak)', () => {
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // The class sets display:inline-flex, so a [hidden] guard is required or the
  // UA hidden rule is overridden and the button leaks into single-agent mode.
  assert.match(css, /\.back-to-fleet\[hidden\]\s*\{\s*display:\s*none/);
  // And single mode must actually set the hidden attribute — except in remote
  // context, where the back control survives to return to the parent wall.
  assert.match(app, /if \(!state\.multiAgent\)[\s\S]*?backBtn\.hidden = !REMOTE_AGENT/);
  // The remote-context back control leaves the page for the parent dashboard.
  assert.match(app, /if \(REMOTE_AGENT\)[\s\S]*?window\.location\.href = PARENT_DASHBOARD_PATH/);
});

test('Agent Fleet is the top-level fleet view and pulse is gone from UI', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  assert.doesNotMatch(html, /data-tab="pulse"/);
  assert.doesNotMatch(html, /id="tab-pulse"/);
  assert.doesNotMatch(html, /Pulse Wall/);
  assert.match(html, /data-tab="overview"/);
  assert.match(html, /data-tab="memory"/);
  assert.match(html, /data-tab="trends"/);
  assert.match(html, /id="fleet-view"/);
  assert.match(html, /id="back-to-fleet"/);
  assert.match(html, /id="agent-fleet-root"/);
});

// --- Fleet tile iteration 2 rendering ---

test('fleet tile renders mini ring with centered value and label below', () => {
  const html = renderAgentFleetHtml({ agents: [{ name: 'a', state: 'IDLE', cpu_pct: 8 }] });
  assert.match(html, /class="fleet-mini-ring-dial"><span>8%<\/span><\/span>\s*<small>CPU<\/small>/);
});

test('fleet tile renders link quality chips and granular failure reasons', () => {
  const html = renderAgentFleetHtml({
    agents: [
      {
        name: 'slow',
        state: 'IDLE',
        link: { quality: 'slow', latency_ms: 1840, latency_p95_ms: 1900, sampled_at: '2026-06-12T00:00:00.000Z', reason: null }
      },
      {
        name: 'degraded',
        state: 'IDLE',
        link: { quality: 'degraded', latency_ms: null, latency_p95_ms: null, sampled_at: null, reason: 'timeout' }
      },
      {
        name: 'bad',
        state: 'OFFLINE',
        pulse_rate: 0,
        health_reason: 'bad_payload',
        link: { quality: 'down', latency_ms: null, latency_p95_ms: null, sampled_at: null, reason: 'bad_payload' }
      }
    ]
  });

  assert.match(html, /agent-link-chip link-slow[^>]*>1\.8s</);
  assert.match(html, /agent-link-chip link-degraded[^>]*>Link warning</);
  assert.match(html, /title="Link latency · Degraded: Timeout"/);
  assert.match(html, /class="agent-fleet-reason">Bad payload<\/span>/);
  assert.doesNotMatch(html, /agent-link-chip link-ok/);
});

test('fleet tile always renders 5h/7d rate rows, with -- when unreported', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', rate_limit_pct: 13, rate_limit_7d_pct: null }]
  });
  assert.match(html, /class="fleet-rate-row rate-ok" aria-label="5h 13%"/);
  assert.match(html, /aria-label="7d --"/);
  assert.match(html, /width:13\.0%/);
});

test('fleet tile activity feed mirrors running tools with single-line rows', () => {
  const html = renderAgentFleetHtml({
    agents: [{
      name: 'a',
      state: 'BUSY',
      activity_feed: [
        { kind: 'tool', label: 'Bash: npm test', started_at: new Date(Date.now() - 5000).toISOString() },
        { kind: 'tool', label: 'Read: foo.js', started_at: null }
      ]
    }]
  });
  assert.match(html, /class="fleet-feed"/);
  assert.match(html, /Bash: npm test/);
  assert.match(html, /class="fleet-feed-age">\d+s</);
});

test('legacy activity line-clamp does not break the last feed row flex layout (#233)', () => {
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  // The clamp rule must target only the legacy direct-child activity span.
  // The descendant form also matched the last .fleet-feed-row and replaced
  // its display:flex with -webkit-box, un-aligning the elapsed-time label.
  assert.match(css, /\.agent-activity > span:last-child \{/);
  assert.doesNotMatch(css, /\.agent-activity span:last-child \{/);
});

test('fleet tile activity feed falls back to legacy single-line activity', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', activity: 'Prompt from lark', activity_feed: [] }]
  });
  assert.doesNotMatch(html, /class="fleet-feed"/);
  assert.match(html, /Prompt from lark/);
});

test('fleet tile renders thinking feed entry from kind, not label', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'BUSY', activity_feed: [{ kind: 'thinking', label: null, started_at: null }] }]
  });
  assert.match(html, /fleet-feed-row is-thinking/);
  assert.match(html, /Thinking…/);
});

test('fleet tile shows thinking mascot when feed has a thinking entry, counted as working', () => {
  const fleet = {
    agents: [{
      name: 'a', state: 'BUSY',
      activity: 'Prompt from lark',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  };
  const view = buildAgentFleetView(fleet);
  assert.equal(view.tiles[0].mood, 'thinking');
  const html = renderAgentFleetHtml(fleet);
  assert.match(html, /data-state="thinking"/);
  assert.match(html, /thinking\.png/);
  assert.match(html, /1 Working/);
});

test('fleet tile visible state badge follows the feed-upgraded mood', () => {
  const view = buildAgentFleetView({
    agents: [{
      name: 'a', state: 'BUSY',
      activity: 'Prompt from lark',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  });
  assert.equal(view.tiles[0].stateLabel, 'Thinking');
  const html = renderAgentFleetHtml({
    agents: [{
      name: 'a', state: 'BUSY',
      activity: 'Prompt from lark',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  });
  assert.match(html, /<span class="agent-state mood-thinking">Thinking<\/span>/);
});

test('fleet tile thinking feed never overrides stuck/offline moods', () => {
  const view = buildAgentFleetView({
    agents: [{
      name: 'a', state: 'POSSIBLY_STUCK',
      activity_feed: [{ kind: 'thinking', label: null, started_at: null }]
    }]
  });
  assert.equal(view.tiles[0].mood, 'stuck');
});

test('fleet tile context level mirrors the single-agent bar thresholds, not new_session_threshold', () => {
  const tile = (pct) => renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: pct, new_session_threshold: 30 }]
  });
  assert.match(tile(42), / context-ok"/);
  assert.match(tile(50), / context-warning"/);
  assert.match(tile(75), / context-warning"/);
  assert.match(tile(76), / context-danger"/);
  assert.match(tile(null), / context-ok"/);
  // Threshold no longer drives the ring color (it stays a tick marker only):
  // 42% over a threshold of 30 must NOT mark the tile.
  assert.doesNotMatch(tile(42), /is-over-threshold/);

  const view = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 60 }]
  });
  assert.equal(view.tiles[0].contextLevel, 'warning');

  // #251: values are 0-100 percentages — never fraction-inferred. A genuine
  // 1% weekly usage must render 1%, not a full red bar.
  const tiny = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 0.6, rate_limit_7d_pct: 1 }]
  });
  assert.equal(tiny.tiles[0].contextLevel, 'ok');
  assert.equal(tiny.tiles[0].rate7dPct, 1);

  // Static guard: the fraction heuristic must not creep back into any
  // percent-typed frontend file (cache_rate ratio sites scale via an
  // explicit unconditional * 100 instead).
  for (const f of ['public/js/app.js', 'public/js/agent-fleet.js', 'public/js/gauge-utils.js']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8');
    assert.doesNotMatch(src, /<=? ?1 \? [\w.]+ \* 100/, `${f} reintroduced the fraction heuristic`);
  }
});

test('liveStateMood upgrades busy-with-no-tools to thinking (detail page parity with #186)', () => {
  assert.equal(liveStateMood({ state: 'BUSY', activity: 'Prompt from lark', running_tools: [] }), 'thinking');
  assert.equal(liveStateMood({ state: 'BUSY', running_tools: [{ tool_name: 'Bash' }] }), 'busy');
  assert.equal(liveStateMood({ state: 'IDLE', running_tools: [] }), 'idle');
  assert.equal(liveStateMood({ state: 'POSSIBLY_STUCK', running_tools: [] }), 'stuck');
  assert.equal(liveStateMood(null), 'idle');
});

test('fleet tile renders context chip with usage and threshold, no tick line', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 42, new_session_threshold: 70 }]
  });
  assert.match(html, /<span class="context-chip"[^>]*>42% <small>\/ 70%<\/small><\/span>/);
  assert.doesNotMatch(html, /context-threshold/);

  const over = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: 79, new_session_threshold: 70 }]
  });
  assert.match(over, /context-chip is-over/);

  const empty = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', context_pct: null, new_session_threshold: null }]
  });
  assert.match(empty, /-- <small>\/ --<\/small>/);
  assert.doesNotMatch(empty, /is-over/);
});

test('fleet wall pauses re-render on hover so native tooltips can appear', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // Fleet payload applications still go through the hover gate after the sound
  // tracker and live view-mode reconciliation; a 0<->1 remote transition is
  // allowed to pierce hover pause so the page changes mode immediately.
  assert.match(app, /function setFleet\(payload\) \{\n(.*\n)*?  fleetSounds\?\.handleFleet\(payload\);\n  state\.fleet = payload;\n  const modeChanged = state\.fleetModeInitialized \? syncLiveFleetMode\(payload\) : false;\n  if \(state\.fleetHoverPaused && !modeChanged\) \{/);
  assert.doesNotMatch(app, /state\.fleet = data;\n\s*renderFleet\(\)/);
  // ...armed by pointer enter/leave on the grid root, flushing pending data on leave.
  assert.match(app, /addEventListener\('mouseenter', \(\) => \{ state\.fleetHoverPaused = true; \}\)/);
  assert.match(app, /addEventListener\('mouseleave'/);
  assert.match(app, /if \(pending\) setFleet\(pending\)/);
});

test('fleet tile mascots animate per mood with a phase-locked delay across rebuilds', () => {
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  assert.match(css, /\.agent-tile-busy \.agent-mascot \{ animation: mascot-bob 0\.8s/);
  assert.match(css, /\.agent-tile-thinking \.agent-mascot \{ animation: mascot-tilt 3s/);
  assert.match(css, /\.agent-tile-idle \.agent-mascot \{ animation: mascot-breathe 3s/);
  assert.match(css, /\.agent-tile-stuck \.agent-mascot \{ animation: mascot-pulse 2s/);

  const html = renderAgentFleetHtml({ agents: [{ name: 'a', state: 'BUSY' }] });
  // Negative wall-clock-derived delay so a rebuilt tile resumes mid-cycle.
  assert.match(html, /class="agent-mascot"[^>]*style="animation-delay:-\d+ms"/);
});

test('fleet rate rows mirror the single-agent bar thresholds, not the system ring levels', () => {
  const row = (pct) => renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', rate_limit_pct: pct, rate_limit_7d_pct: null }]
  });
  assert.match(row(42), /fleet-rate-row rate-ok/);
  assert.match(row(50), /fleet-rate-row rate-warning/);
  assert.match(row(75), /fleet-rate-row rate-warning/);
  assert.match(row(76), /fleet-rate-row rate-danger/);
  // 70 was 'warning' under the old ringLevel thresholds — still warning here,
  // but 60 must now be warning too (was ok under ringLevel):
  assert.match(row(60), /fleet-rate-row rate-warning/);
  assert.match(row(null), /fleet-rate-row rate-ok/);
});

test('fleet summary shows state dots with dimmed zeros and aggregated cost tiers', () => {
  const html = renderAgentFleetHtml({
    agents: [
      { name: 'a', state: 'BUSY', session_cost: 111.62, daily_cost: 63.03, weekly_cost: 1299.31 },
      { name: 'b', state: 'IDLE', session_cost: 1.71, daily_cost: 142.55, weekly_cost: 687.24 }
    ]
  });
  assert.match(html, /<span class="sum-seg"><i class="sum-dot dot-busy"><\/i>1 Working<\/span>/);
  assert.match(html, /<span class="sum-seg"><i class="sum-dot dot-idle"><\/i>1 Idle<\/span>/);
  assert.match(html, /<span class="sum-seg is-zero"><i class="sum-dot dot-stuck"><\/i>0 Possible Stuck<\/span>/);
  assert.match(html, /<small>Session<\/small><strong>\$113\.33<\/strong>/);
  assert.match(html, /<small>Today<\/small><strong>\$205\.58<\/strong>/);
  assert.match(html, /<small>7 days<\/small><strong>\$1986\.55<\/strong>/);
});

test('fleet summary cost totals render -- when no agent reports a tier', () => {
  const view = buildAgentFleetView({ agents: [{ name: 'a', state: 'IDLE' }] });
  assert.deepEqual(view.costTotals, { session: '--', daily: '--', weekly: '--' });
  // Partial fleet: one agent reporting still produces a total, not '--'.
  const partial = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', session_cost: 2 }, { name: 'b', state: 'IDLE' }]
  });
  assert.equal(partial.costTotals.session, '$2.00');
});

test('fleet summary cost totals treat explicit null as unreported, but 0 as a real report', () => {
  // Production payloads send explicit nulls (getCostTiers without data,
  // offline default fleet records) — these must not sum as 0.
  const nulls = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', session_cost: null, daily_cost: null, weekly_cost: null }]
  });
  assert.deepEqual(nulls.costTotals, { session: '--', daily: '--', weekly: '--' });

  const zero = buildAgentFleetView({
    agents: [{ name: 'a', state: 'IDLE', session_cost: 0, daily_cost: null, weekly_cost: null }]
  });
  assert.equal(zero.costTotals.session, '$0.0000');
  assert.equal(zero.costTotals.daily, '--');
});

test('in-page remote viewing rewrites agent data paths through the fleet proxy', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // Single choke point: every JSON fetch goes through agentPath().
  assert.match(app, /const r = await fetch\(api\(agentPath\(path\)\), \{ cache: 'no-store' \}\);/);
  // Only /api/* paths are re-rooted; /api/fleet (our own wall) and non-API
  // paths like /login always stay on the local dashboard root.
  assert.match(app, /if \(!path\.startsWith\('\/api\/'\) \|\| path === '\/api\/fleet'\) return path;/);
  assert.match(app, /return `\$\{remotePrefix\(\)\}\$\{path\}`;/);
  // Remote prefix URL-encodes the agent name.
  assert.match(app, /`\/fleet\/\$\{encodeURIComponent\(state\.remoteAgent\)\}`/);
});

test('SSE stream follows the viewed agent and remote fleet events never clobber the local wall', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /new EventSource\(api\(agentPath\('\/api\/stream'\)\)\)/);
  // Reconnect probe targets the same agent the stream does.
  assert.match(app, /await fetch\(api\(agentPath\('\/api\/state'\)\), \{ cache: 'no-store' \}\);/);
  // A remote agent's stream describes its own fleet — drop those events.
  assert.match(app, /if \(name === 'fleet' && state\.remoteAgent\) return;/);
});

test('entering and exiting a remote agent resets per-agent state and resubscribes SSE', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const enter = app.slice(app.indexOf('function enterRemoteAgent('), app.indexOf('function exitRemoteAgent('));
  const exit = app.slice(app.indexOf('function exitRemoteAgent('), app.indexOf('function initFleetMode('));
  for (const fn of [enter, exit]) {
    assert.match(fn, /resetAgentData\(\);/);
    assert.match(fn, /connectSse\(\);/);
    assert.match(fn, /return Promise\.allSettled\(\[refreshAll\(\), refreshObserverStatus/);
  }
  assert.match(enter, /showAgentDetail\(\{ navigation: false \}\);/);
  assert.match(exit, /showFleetView\(\{ navigation: false \}\);/);
  // resetAgentData clears incremental DOM, not just state, so panels from two
  // agents never mix.
  const reset = app.slice(app.indexOf('function resetAgentData('), app.indexOf('function enterRemoteAgent('));
  assert.match(reset, /prevSubagentIds\.clear\(\);/);
  assert.match(reset, /#tool-feed/);
  assert.match(reset, /#subagent-list/);
  assert.match(reset, /renderAll\(\);/);
});

test('single-agent dashboards never activate in-page remote viewing', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const enter = app.slice(app.indexOf('function enterRemoteAgent('), app.indexOf('function exitRemoteAgent('));
  // Guard sits at the function entry so both the tile-click path and a stale
  // popstate /fleet/<name> match are bypassed when there is no fleet wall.
  assert.match(enter, /if \(!state\.multiAgent\) return;/);
  assert.ok(enter.indexOf('if (!state.multiAgent) return;') < enter.indexOf('state.remoteAgent = name;'));
});

test('back button resolves in-page remote first, standalone remote second, fleet wall last', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // Anchor inside initFleetMode — applyFleetMode also references #back-to-fleet.
  const fleetMode = app.indexOf('function initFleetMode(');
  const start = app.indexOf("const backBtn = $('#back-to-fleet');", fleetMode);
  const handler = app.slice(start, app.indexOf('initLocaleToggle', start));
  const inPage = handler.indexOf('if (state.remoteAgent) {');
  const standalone = handler.indexOf('if (REMOTE_AGENT) {');
  const wall = handler.indexOf('showFleetView();');
  assert.ok(inPage > -1 && standalone > inPage && wall > standalone);
  assert.match(handler, /exitRemoteAgent\(\);/);
  assert.match(handler, /window\.location\.href = PARENT_DASHBOARD_PATH;/);
});

test('popstate routes /fleet/<name> paths into remote view only on the parent document', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // The standalone remote document (REMOTE_AGENT) keeps plain tab routing.
  assert.match(app, /if \(!REMOTE_AGENT\) \{\s*\n\s*const m = path\.match\(\/\\\/fleet\\\/\(\[\^\/\]\+\)\\\/\?\(\?::?trends\|memory\|observer\)\?\$\/\);?/);
  assert.match(app, /await enterRemoteAgent\(decodeURIComponent\(m\[1\]\), \{ push: false \}\);/);
  assert.match(app, /else if \(state\.remoteAgent\) \{\s*\n\s*await exitRemoteAgent\(\{ push: false \}\);/);
  // Tab pushState carries the remote prefix so deep links stay consistent.
  assert.match(app, /const path = name === 'overview' \? `\$\{prefix\}\/` : `\$\{prefix\}\/\$\{name\}`;/);
});

test('fleet wall tiles enter remote agents in-page instead of full navigation', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const fleetMode = app.indexOf('function initFleetMode(');
  const block = app.slice(fleetMode, app.indexOf("const backBtn = $('#back-to-fleet');", fleetMode));
  assert.match(block, /if \(tile\.dataset\.agent\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*enterRemoteAgent\(tile\.dataset\.agent\);/);
});

test('remote Actions/Settings are gated by access and routed through the viewed agent', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /function remoteAccess\(\)/);
  assert.match(app, /agent\?\.access === 'admin' \? 'admin' : 'read'/);
  assert.match(app, /const REMOTE_ACCESS = document\.documentElement\.dataset\.remoteAccess === 'admin' \? 'admin' : 'read';/);
  assert.match(app, /id="actions-btn"[^`]+disabled/);
  assert.match(app, /remote\.actions_read_only_tooltip/);
  assert.match(app, /remote\.settings_read_only_tooltip/);

  // Settings stays viewable under read access, but writes and action modals are gated.
  const handler = app.slice(app.indexOf('function initInfoBarButtons('), app.indexOf('function startTimers('));
  assert.match(handler, /closest\('#settings-btn'\)[\s\S]+openSettingsModal\(\)/);
  assert.match(handler, /if \(!remoteIsReadOnly\(\)\) openActionsModal\(\);/);

  assert.match(app, /const resp = await fetch\(api\(agentPath\('\/api\/settings'\)\)\);/);
  assert.match(app, /const resp = await fetch\(api\(agentPath\('\/api\/settings'\)\), \{/);
  assert.match(app, /const actionPath = agentPath\(`\/api\/actions\/\$\{action\}`\);/);
  assert.match(app, /const healthPath = agentPath\('\/api\/health'\);/);
  assert.match(app, /startCountdownAndReload\(15, statusEl, healthPath\);/);

  // An already-open modal cannot survive entering/exiting a remote view
  // (browser-back with the Actions modal open).
  const reset = app.slice(app.indexOf('function resetAgentData('), app.indexOf('function enterRemoteAgent('));
  assert.match(reset, /closeActionsModal\(\);/);
  assert.match(reset, /closeSettingsModal\(\);/);
});

test('Observer UI is optional, read-only, agent-routed, and releases leases on exit', () => {
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8'));
  assert.match(index, /id="observer-tab"[^>]+hidden/);
  assert.match(index, /id="tab-observer"/);
  assert.match(index, /sandbox="allow-scripts"/);
  assert.match(app, /new MessageChannel\(\)/);
  assert.match(app, /new WebSocket\(streamUrl, \['zylos-observer-v1', `lease\.\$\{lease\.id\}`, \.\.\.\(ticket \? \[`ticket\.\$\{ticket\}`\] : \[\]\)\]\)/);
  assert.match(app, /const ticket = observer\.lease\?\.ticket;/);
  assert.match(app, /X-Observer-Lease/);
  assert.match(app, /observer\.channel\?\.postMessage\(\{ type: 'render', bytes: event\.data \}, \[event\.data\]\)/);
  assert.match(app, /if \(activeTabName\(\) === 'observer' && name !== 'observer'\) closeObserver/);
  assert.match(app, /window\.addEventListener\('pagehide',[\s\S]+closeObserver/);
  assert.match(app, /state\.remoteAgent \? api\(`\$\{remotePrefix\(\)\}\$\{path\}`\) : api\(path\)/);
  assert.match(app, /const refreshed = await refreshObserverStatus\(\{ quiet: true \}\);/);
  assert.ok(app.indexOf('await refreshObserverStatus({ quiet: true });\ninitTabs();') > -1);
  assert.match(css, /\.observer-frame-shell/);
  for (const pack of [en, zh]) {
    assert.equal(typeof pack['tab.observer'], 'string');
    assert.equal(typeof pack['observer.live_read_only'], 'string');
    assert.equal(typeof pack['observer.state_unvalidated'], 'string');
  }
});

test('Observer close fences late lease acquisition and releases it against the original target', async () => {
  const harness = observerUiHarness();
  const lease = deferred();
  harness.setFetch((url) => {
    const path = String(url);
    if (path.endsWith('/status')) {
      return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    }
    if (path.endsWith('/leases')) return lease.promise;
    return Promise.resolve(observerResponse({ ok: true }));
  });

  const opening = harness.context.openObserver();
  await new Promise((resolve) => setImmediate(resolve));
  await harness.context.closeObserver();
  lease.resolve(observerResponse({ id: 'old-lease' }));
  await opening;

  assert.equal(harness.context.state.observer.lease, null);
  assert.equal(harness.context.state.observer.endpointPrefix, null);
  assert.equal(harness.context.state.observer.opening, false);
  assert.equal(harness.sockets.length, 0);
  assert.ok(harness.calls.some(({ url }) => url === '/api/observer/leases/old-lease/release'));
});

test('Observer open follows a superseded same-target status response into a lease and socket', async () => {
  const harness = observerUiHarness();
  const openingStatus = deferred();
  let statusRequests = 0;
  harness.setFetch((url) => {
    if (String(url).endsWith('/status')) {
      statusRequests += 1;
      if (statusRequests === 1) return openingStatus.promise;
      return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    }
    if (String(url).endsWith('/leases')) return Promise.resolve(observerResponse({ id: 'live-lease' }));
    return Promise.resolve(observerResponse({}));
  });

  const opening = harness.context.openObserver();
  await new Promise((resolve) => setImmediate(resolve));
  await harness.context.refreshObserverStatus({ quiet: true });
  openingStatus.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  await opening;

  assert.equal(harness.context.state.observer.lease.id, 'live-lease');
  assert.equal(harness.context.state.observer.opening, false);
  assert.equal(harness.sockets.length, 1);
  harness.context.state.observer.channel.onmessage({ data: { type: 'ready' } });
  assert.equal(harness.elements['#observer-notice'].dataset.state, 'live');
  assert.notEqual(harness.elements['#observer-notice'].dataset.state, 'error');
});

test('Observer stale renew responses cannot mutate a newer session', async () => {
  const harness = observerUiHarness();
  const oldLease = { id: 'old-lease' };
  const oldEndpoints = { api: '/old/api/observer' };
  const oldTarget = harness.context.observerTargetKey();

  harness.context.state.observer = {
    generation: 1,
    statusGeneration: 0,
    lease: oldLease,
    endpointPrefix: oldEndpoints
  };
  const renew = deferred();
  harness.setFetch(() => renew.promise);
  const pendingRenew = harness.context.renewObserverLease(1, oldTarget, oldLease, oldEndpoints);
  await harness.context.closeObserver({ release: false });
  harness.context.state.observer.lease = { id: 'new-lease' };
  harness.context.state.observer.endpointPrefix = { api: '/new/api/observer' };
  renew.resolve(observerResponse({ id: 'old-lease' }));
  await pendingRenew;
  assert.equal(harness.context.state.observer.lease.id, 'new-lease');


});

test('Observer stale open, frame, and renew errors cannot damage a closed or newer session', async (t) => {
  await t.test('stale open error', async () => {
    const harness = observerUiHarness();
    const firstLease = deferred();
    let leaseRequests = 0;
    harness.setFetch((url) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
      }
      if (path.endsWith('/leases')) {
        leaseRequests += 1;
        return leaseRequests === 1
          ? firstLease.promise
          : Promise.resolve(observerResponse({ id: 'new-lease' }));
      }
      return Promise.resolve(observerResponse({}));
    });
    const stale = harness.context.openObserver();
    await new Promise((resolve) => setImmediate(resolve));
    await harness.context.closeObserver();
    await harness.context.openObserver();
    assert.equal(harness.context.state.observer.lease.id, 'new-lease');
    firstLease.reject(new Error('old target failed'));
    await stale;
    assert.equal(harness.context.state.observer.lease.id, 'new-lease');
    assert.equal(harness.sockets[0].closed, undefined);
    assert.notEqual(harness.elements['#observer-notice'].dataset.state, 'error');
  });

  await t.test('stale frame response', async () => {
    const harness = observerUiHarness();
    const frame = deferred();
    harness.setFetch((url) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
      }
      if (path.endsWith('/leases')) return Promise.resolve(observerResponse({ id: 'old-lease' }));
      if (path.endsWith('/observer/frame')) return frame.promise;
      return Promise.resolve(observerResponse({}));
    });
    const stale = harness.context.openObserver();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.context.state.observer.lease.id, 'old-lease');
    await harness.context.closeObserver();
    frame.resolve(observerResponse({}));
    await stale;
    assert.equal(harness.context.state.observer.lease, null);
    assert.equal(harness.context.state.observer.iframe, null);
    assert.equal(harness.sockets.length, 0);
  });

  await t.test('stale renew error', async () => {
    const harness = observerUiHarness();
    const oldRenew = deferred();
    let leaseRequests = 0;
    harness.setFetch((url) => {
      const path = String(url);
      if (path.endsWith('/status')) {
        return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
      }
      if (path.endsWith('/leases')) {
        leaseRequests += 1;
        return Promise.resolve(observerResponse({
          id: leaseRequests === 1 ? 'old-lease' : 'new-lease'
        }));
      }
      if (path.includes('/leases/old-lease/renew')) return oldRenew.promise;
      return Promise.resolve(observerResponse({}));
    });
    await harness.context.openObserver();
    harness.intervals[0]();
    await new Promise((resolve) => setImmediate(resolve));
    await harness.context.closeObserver();
    await harness.context.openObserver();
    oldRenew.reject(new Error('old lease failed'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.context.state.observer.lease.id, 'new-lease');
    assert.equal(harness.sockets[1].closed, undefined);
    assert.notEqual(harness.elements['#observer-notice'].dataset.state, 'error');
  });
});

test('Observer navigation fetches target status, waits for it, and discards delayed old-target responses', async () => {
  const harness = observerUiHarness();
  const firstStatus = deferred();
  harness.setFetch((url) => {
    const path = String(url);
    if (path === '/fleet/alpha/api/observer/status') return firstStatus.promise;
    if (path === '/fleet/bravo/api/observer/status') {
      return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    }
    return Promise.resolve(observerResponse({}));
  });

  let alphaSettled = false;
  const alpha = harness.context.enterRemoteAgent('alpha', { push: false }).then(() => { alphaSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alphaSettled, false);

  await harness.context.enterRemoteAgent('bravo', { push: false });
  assert.equal(harness.context.state.observer.status.state, 'installed');
  assert.equal(harness.elements['#observer-tab'].hidden, false);

  firstStatus.resolve(observerResponse({ state: 'not_installed' }));
  await alpha;
  assert.equal(harness.context.state.remoteAgent, 'bravo');
  assert.equal(harness.context.state.observer.status.state, 'installed');
  assert.equal(harness.elements['#observer-tab'].hidden, false);
  assert.deepEqual(harness.calls.filter(({ url }) => url.endsWith('/api/observer/status')).map(({ url }) => url), [
    '/fleet/alpha/api/observer/status',
    '/fleet/bravo/api/observer/status'
  ]);
});

test('Observer navigation discards a delayed old-target status error', async () => {
  const harness = observerUiHarness();
  const oldStatus = deferred();
  harness.setFetch((url) => {
    const path = String(url);
    if (path === '/fleet/alpha/api/observer/status') return oldStatus.promise;
    if (path === '/fleet/bravo/api/observer/status') {
      return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    }
    return Promise.resolve(observerResponse({}));
  });
  const alpha = harness.context.enterRemoteAgent('alpha', { push: false });
  await new Promise((resolve) => setImmediate(resolve));
  await harness.context.enterRemoteAgent('bravo', { push: false });
  oldStatus.reject(new Error('alpha unavailable'));
  await alpha;

  assert.equal(harness.context.state.remoteAgent, 'bravo');
  assert.equal(harness.context.state.observer.status.state, 'installed');
  assert.equal(harness.elements['#observer-tab'].hidden, false);
});

test('Observer reset uses the real resetAgentData path to clear target status before navigation fetches', async () => {
  const harness = observerUiHarness();
  harness.context.state.observer.statusGeneration = 4;
  harness.context.state.observer.status = { state: 'installed', desired: { enabled: true } };
  harness.elements['#observer-tab'].hidden = false;

  harness.context.resetAgentData();

  assert.equal(harness.context.state.observer.statusGeneration, 5);
  assert.equal(harness.context.state.observer.status, null);
  assert.equal(harness.elements['#observer-tab'].hidden, true);
});

test('Observer popstate navigation generation prevents a delayed remote route from reopening locally', async () => {
  const harness = observerUiHarness();
  const remoteRefresh = deferred();
  harness.context.refreshAll = () => harness.context.state.remoteAgent === 'alpha'
    ? remoteRefresh.promise
    : Promise.resolve();
  harness.setFetch((url) => {
    const path = String(url);
    if (path.endsWith('/status')) {
      return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    }
    if (path.endsWith('/leases')) return Promise.resolve(observerResponse({ id: 'stray' }));
    return Promise.resolve(observerResponse({}));
  });
  harness.context.initTabs();
  const popstate = harness.listeners.popstate;
  assert.ok(popstate);

  harness.context.window.location.pathname = '/fleet/alpha/observer';
  const remoteNavigation = popstate();
  await new Promise((resolve) => setImmediate(resolve));
  harness.context.window.location.pathname = '/';
  await popstate();
  remoteRefresh.resolve();
  await remoteNavigation;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.context.state.remoteAgent, null);
  assert.equal(harness.context.window.location.pathname, '/');
  assert.equal(harness.context.activeTabName(), 'overview');
  assert.equal(harness.context.state.observer.lease, null);
  assert.equal(harness.sockets.length, 0);
});

test('Observer lifecycle success and error responses cannot mutate a different target', async (t) => {
  for (const outcome of ['success', 'error-response', 'network-error']) {
    await t.test(outcome, async () => {
      const harness = observerUiHarness();
      harness.context.state.remoteAgent = 'alpha';
      const action = deferred();
      harness.setFetch((url) => {
        const path = String(url);
        if (path === '/fleet/alpha/api/observer/enable') return action.promise;
        if (path === '/api/observer/status') {
          return Promise.resolve(observerResponse({ state: 'not_installed' }));
        }
        return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: false } }));
      });

      const running = harness.context.runObserverLifecycle('enable');
      await new Promise((resolve) => setImmediate(resolve));
      await harness.context.exitRemoteAgent({ push: false });
      if (outcome === 'success') {
        action.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
      } else if (outcome === 'error-response') {
        action.resolve(observerResponse({ error: 'old target failed' }, { ok: false }));
      } else {
        action.reject(new Error('old target unavailable'));
      }
      await running;

      assert.equal(harness.context.state.remoteAgent, null);
      assert.equal(harness.context.state.observer.status.state, 'not_installed');
      assert.equal(harness.elements['#observer-tab'].hidden, true);
      assert.equal(harness.calls.filter(({ url }) => url === '/fleet/alpha/api/observer/status').length, 0);
      assert.equal(harness.calls.filter(({ url }) => url === '/api/observer/status').length, 1);
    });
  }
});

test('Observer open waits for a still-pending superseding status and reports its failure', async (t) => {
  for (const outcome of ['enabled', 'disabled', 'error']) await t.test(outcome, async () => {
    const h = observerUiHarness();
    const old = deferred();
    const latest = deferred();
    let count = 0;
    h.setFetch((url) => {
      if (String(url).endsWith('/status')) return ++count === 1 ? old.promise : latest.promise;
      if (String(url).endsWith('/leases')) return Promise.resolve(observerResponse({ id: 'current' }));
      return Promise.resolve(observerResponse({}));
    });
    const opening = h.context.openObserver();
    const refreshing = h.context.refreshObserverStatus({ quiet: true });
    old.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.sockets.length, 0);
    if (outcome === 'error') latest.reject(new Error('latest unavailable'));
    else latest.resolve(observerResponse({ state: 'installed', desired: { enabled: outcome === 'enabled' } }));
    await Promise.all([opening, refreshing]);
    assert.equal(h.sockets.length, outcome === 'enabled' ? 1 : 0);
    if (outcome !== 'enabled') assert.equal(h.elements['#observer-notice'].dataset.state, outcome === 'error' ? 'connecting' : 'error');
  });
});

test('Observer click navigation supersedes pending popstate for tabs and fleet targets', async (t) => {
  for (const choice of ['tab', 'enter', 'exit']) await t.test(choice, async () => {
    const h = observerUiHarness();
    const pending = deferred();
    h.context.refreshAll = () => h.context.state.remoteAgent === 'alpha' ? pending.promise : Promise.resolve();
    h.setFetch((url) => Promise.resolve(observerResponse(String(url).endsWith('/leases')
      ? { id: 'stray' } : { state: 'installed', desired: { enabled: true } })));
    h.context.initTabs();
    h.context.window.location.pathname = '/fleet/alpha/observer';
    const navigation = h.listeners.popstate();
    await new Promise((resolve) => setImmediate(resolve));
    if (choice === 'tab') h.tabs[0].click();
    if (choice === 'enter') await h.context.enterRemoteAgent('bravo');
    if (choice === 'exit') await h.context.exitRemoteAgent();
    pending.resolve();
    await navigation;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.context.activeTabName(), 'overview');
    assert.equal(h.sockets.length, 0);
    assert.equal(h.context.state.observer.lease, null);
    assert.equal(h.context.window.location.pathname, choice === 'tab' ? '/fleet/alpha/' : choice === 'enter' ? '/fleet/bravo/' : '/');
  });
});

test('Observer lifecycle ABA and superseded actions cannot overwrite fresh status or settings feedback', async (t) => {
  for (const transition of ['ABA', 'new-action']) await t.test(transition, async () => {
    const h = observerUiHarness();
    h.context.state.remoteAgent = 'alpha';
    const pending = deferred();
    let actionCount = 0;
    h.setFetch((url) => {
      if (String(url).endsWith('/enable') && ++actionCount === 1) return pending.promise;
      return Promise.resolve(observerResponse({ state: 'not_installed' }));
    });
    const action = h.context.runObserverLifecycle('enable');
    assert.equal(h.settings['#observer-settings-status'].textContent, 'observer.working');
    if (transition === 'ABA') {
      await h.context.exitRemoteAgent({ push: false });
      await h.context.enterRemoteAgent('alpha', { push: false });
      assert.equal(h.settings['#observer-settings-status'].hidden, true);
      assert.equal(h.settings['#observer-settings-status'].textContent, '');
    } else await h.context.runObserverLifecycle('enable');
    const text = h.settings['#observer-settings-status'].textContent;
    pending.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    await action;
    assert.equal(h.context.state.observer.status.state, 'not_installed');
    assert.equal(h.elements['#observer-tab'].hidden, true);
    assert.equal(h.settings['#observer-settings-status'].textContent, text);
    assert.equal(h.buttons.every((button) => !button.disabled), true);
  });
});

test('Observer lifecycle post-refresh fence prevents old-target fallback and feedback (U6)', async () => {
  const h = observerUiHarness();
  h.context.state.remoteAgent = 'alpha';
  const refresh = deferred();
  h.setFetch((url) => {
    if (String(url) === '/fleet/alpha/api/observer/status') return refresh.promise;
    return Promise.resolve(observerResponse(String(url).endsWith('/enable')
      ? { state: 'installed', desired: { enabled: true } } : { state: 'not_installed' }));
  });
  const action = h.context.runObserverLifecycle('enable');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.calls.some(({ url }) => url === '/fleet/alpha/api/observer/status'));
  await h.context.exitRemoteAgent({ push: false });
  refresh.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  await action;
  assert.equal(h.context.state.observer.status.state, 'not_installed');
  assert.equal(h.elements['#observer-tab'].hidden, true);
  assert.equal(h.settings['#observer-settings-status'].hidden, true);
  assert.equal(h.settings['#observer-settings-status'].textContent, '');
});

test('Observer close clears measured frame geometry', async () => {
  const h = observerUiHarness();
  const iframe = h.elements['#observer-frame'];
  h.context.state.observer.iframe = iframe;
  h.context.syncObserverMetrics(iframe, { width: 1200.1, height: 800.1 });
  assert.equal(iframe.style.width, 'max(100%, 1201px)');
  assert.equal(iframe.style.height, 'max(100%, 801px)');
  await h.context.closeObserver();
  assert.equal(iframe.style.width, '');
  assert.equal(iframe.style.height, '');
});

test('Observer lifecycle status refresh cannot replace a newer same-target status', async () => {
  const h = observerUiHarness();
  const old = deferred();
  let statuses = 0;
  h.setFetch((url) => {
    if (String(url).endsWith('/status')) return ++statuses === 1 ? old.promise
      : Promise.resolve(observerResponse({ state: 'not_installed' }));
    return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  });
  const action = h.context.runObserverLifecycle('enable');
  await new Promise((resolve) => setImmediate(resolve));
  await h.context.refreshObserverStatus();
  old.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  await action;
  assert.equal(h.context.state.observer.status.state, 'not_installed');
  assert.equal(h.elements['#observer-tab'].hidden, true);
});

test('Observer popstate reports route failures without an unhandled rejection or stray stream', async () => {
  const h = observerUiHarness();
  const states = [];
  h.context.renderConnection = (state) => states.push(state);
  h.context.renderAll = () => { throw new Error('render failed'); };
  h.context.initTabs();
  h.context.window.location.pathname = '/fleet/alpha/observer';
  await assert.doesNotReject(h.listeners.popstate());
  assert.deepEqual(states, ['degraded']);
  assert.equal(h.sockets.length, 0);
});

test('Observer view transitions invalidate pending popstate across fleet entry paths', async (t) => {
  for (const route of ['fleet', 'detail', 'self-tile', 'back-local', 'live-mode', 'apply-delayed', 'apply-reduced']) {
    await t.test(route, async () => {
      const h = observerUiHarness();
      const refresh = deferred();
      h.context.refreshAll = () => refresh.promise;
      h.setFetch((url) => Promise.resolve(observerResponse(String(url).endsWith('/leases')
        ? { id: 'hidden' } : { state: 'installed', desired: { enabled: true } })));
      h.elements['#back-to-fleet'] = { addEventListener(_event, handler) { this.click = handler; } };
      h.elements['#agent-fleet-root'] = { addEventListener(_event, handler) { this.click = handler; } };
      h.context.initTabs();
      h.context.initFleetMode();
      if (route === 'back-local') h.context.state.remoteAgent = 'alpha';
      h.context.window.location.pathname = route === 'back-local' ? '/observer' : '/fleet/alpha/observer';
      const navigation = h.listeners.popstate();
      await new Promise((resolve) => setImmediate(resolve));
      const before = h.context.state.navigationGeneration;
      if (route === 'fleet') h.context.showFleetView();
      if (route === 'detail') h.context.showAgentDetail();
      if (route === 'self-tile') h.elements['#agent-fleet-root'].click({
        target: { closest: () => ({ dataset: { self: 'true' } }) }, preventDefault() {}
      });
      if (route === 'back-local') h.elements['#back-to-fleet'].click();
      const fleet = { agents: [{ name: 'self' }, { name: 'alpha' }] };
      if (route === 'live-mode') {
        h.context.state.multiAgent = false;
        h.context.syncLiveFleetMode(fleet);
      }
      if (route.startsWith('apply-')) {
        h.context.prefersReducedMotion = () => route === 'apply-reduced';
        h.context.applyFleetMode(fleet);
        if (route === 'apply-delayed') h.timeouts[0]();
      }
      assert.ok(h.context.state.navigationGeneration > before);
      refresh.resolve();
      await navigation;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.context.activeTabName(), 'overview');
      assert.equal(h.context.state.observer.lease, null);
      assert.equal(h.sockets.length, 0);
      assert.equal(h.calls.some(({ url }) => url.endsWith('/leases')), false);
    });
  }
});

test('Observer intended remote and local popstate routes still open visible sessions', async (t) => {
  for (const target of ['remote', 'local']) await t.test(target, async () => {
    const h = observerUiHarness();
    h.setFetch((url) => Promise.resolve(observerResponse(String(url).endsWith('/leases')
      ? { id: 'wanted' } : { state: 'installed', desired: { enabled: true } })));
    h.context.initTabs();
    if (target === 'local') h.context.state.remoteAgent = 'alpha';
    h.context.window.location.pathname = target === 'remote' ? '/fleet/alpha/observer' : '/observer';
    await h.listeners.popstate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.context.state.fleetViewActive, false);
    assert.equal(h.context.activeTabName(), 'observer');
    assert.equal(h.context.state.observer.lease.id, 'wanted');
    assert.equal(h.sockets.length, 1);
  });
});

test('Observer lifecycle buttons remain owned by the newest pending action across completion and refresh', async (t) => {
  for (const outcome of ['success', 'error']) await t.test(outcome, async () => {
    const h = observerUiHarness();
    const first = deferred();
    const second = deferred();
    h.setFetch((url) => {
      if (String(url).endsWith('/enable')) return first.promise;
      if (String(url).endsWith('/disable')) return second.promise;
      return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    });
    const a = h.context.runObserverLifecycle('enable');
    const b = h.context.runObserverLifecycle('disable');
    await new Promise((resolve) => setImmediate(resolve));
    first.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    await a;
    assert.equal(h.buttons.every((button) => button.disabled), true);
    assert.equal(h.settings['#observer-settings-status'].textContent, 'observer.working');
    await h.context.refreshObserverStatus();
    assert.equal(h.buttons.every((button) => button.disabled), true);
    if (outcome === 'error') second.reject(new Error('failed second'));
    else second.resolve(observerResponse({ state: 'installed', desired: { enabled: false } }));
    await b;
    assert.equal(h.buttons.every((button) => !button.disabled), true);
    assert.equal(h.settings['#observer-settings-status'].textContent, outcome === 'error' ? 'failed second' : 'observer.action_done');
  });
});

test('Observer latest malformed-null status terminates without a lease', async () => {
  const h = observerUiHarness();
  const first = deferred();
  let statuses = 0;
  h.setFetch(() => ++statuses === 1 ? first.promise : Promise.resolve(observerResponse(null)));
  const opening = h.context.openObserver();
  await h.context.refreshObserverStatus({ quiet: true });
  first.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  await opening;
  assert.equal(h.sockets.length, 0);
  assert.equal(h.elements['#observer-notice'].dataset.state, 'error');
  assert.equal(h.context.state.observer.opening, false);
});

test('Observer lifecycle button ownership resets on target change before stale completion', async () => {
  const h = observerUiHarness();
  h.context.state.remoteAgent = 'alpha';
  const action = deferred();
  h.setFetch((url) => String(url).endsWith('/enable') ? action.promise
    : Promise.resolve(observerResponse({ state: 'not_installed' })));
  const pending = h.context.runObserverLifecycle('enable');
  assert.equal(h.buttons.every((button) => button.disabled), true);
  await h.context.exitRemoteAgent({ push: false });
  assert.equal(h.buttons.every((button) => !button.disabled), true);
  action.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  await pending;
  assert.equal(h.buttons.every((button) => !button.disabled), true);
});

test('Observer no-op target re-entry does not cancel an intended pending route', async () => {
  const h = observerUiHarness();
  const refresh = deferred();
  h.context.refreshAll = () => refresh.promise;
  h.setFetch((url) => Promise.resolve(observerResponse(String(url).endsWith('/leases')
    ? { id: 'wanted' } : { state: 'installed', desired: { enabled: true } })));
  h.context.initTabs();
  h.context.window.location.pathname = '/fleet/alpha/observer';
  const pending = h.listeners.popstate();
  await h.context.enterRemoteAgent('alpha');
  refresh.resolve();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.context.activeTabName(), 'observer');
  assert.equal(h.sockets.length, 1);
});

test('Observer follows more than eight distinct same-target supersessions to a live session', async () => {
  const h = observerUiHarness();
  const requests = [];
  h.setFetch((url) => {
    if (String(url).endsWith('/status')) {
      const request = deferred();
      requests.push(request);
      return request.promise;
    }
    return Promise.resolve(observerResponse({ id: 'long-chain' }));
  });
  const opening = h.context.openObserver();
  const refreshes = [];
  for (let i = 0; i < 12; i += 1) {
    refreshes.push(h.context.refreshObserverStatus({ quiet: true }));
    requests[i].resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    await new Promise((resolve) => setImmediate(resolve));
  }
  requests.at(-1).resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
  await Promise.all([...refreshes, opening]);
  assert.equal(h.context.state.observer.lease.id, 'long-chain');
  assert.equal(h.sockets.length, 1);
});

test('memory browser is admin-scoped, agent-routed, and cache-busted', () => {
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8'));

  assert.match(index, /data-tab="memory"/);
  assert.match(index, /id="tab-memory"/);
  assert.match(index, /id="memory-tree"/);
  assert.match(index, /id="memory-content"/);
  assert.match(index, /app\.js\?v=80/);
  assert.match(index, /style\.css\?v=54/);

  assert.match(app, /fetchAgentJson\('\/api\/memory\/tree'\)/);
  assert.match(app, /fetchAgentJson\(`\/api\/memory\/file\?path=\$\{encoded\}`\)/);
  assert.match(app, /fetchAgentJson\(`\/api\/memory\/git\?path=\$\{encoded\}`\)/);
  assert.match(app, /requestAgentJson\(`\/api\/memory\/file\?path=\$\{encodeURIComponent\(file\.path\)\}`/);
  assert.match(app, /method: 'PUT'/);
  assert.match(app, /JSON\.stringify\(\{ text, sha256 \}\)/);
  assert.match(app, /zylos\.memoryDraft\.\$\{memoryAgentKey\(\)\}\.\$\{filePath\}/);
  assert.match(app, /state\.memory\.draftTimer = setTimeout\(\(\) => \{/);
  assert.match(app, /\}, 500\);/);
  assert.match(app, /flushMemoryDraftSave\(\);[\s\S]+state\.memory\.selectedPath = filePath;/);
  assert.match(app, /setInterval\(\(\) => \{\s*\n\s*checkMemoryLiveSha\(\)\.catch\(\(\) => \{\}\);\s*\n\s*\}, 20_000\)/);
  assert.match(app, /state\.memory\.saving \|\| document\.hidden/);
  assert.match(app, /buildMemoryConflict\(latest, state\.memory\.draft, state\.memory\.draft\)/);
  assert.match(app, /isCompleteMemoryFile\(latest\)/);
  assert.doesNotMatch(app, /catch\(\(\) => err\.current \|\| null\)/);
  assert.match(app, /state\.memory\.error = 'memory_conflict_latest_failed'/);
  assert.match(app, /data-memory-retry-conflict/);
  assert.match(app, /if \(!isCompleteMemoryFile\(conflict\?\.theirs\)\) return;/);
  assert.match(app, /state\.memory\.file = conflict\.theirs;/);
  assert.doesNotMatch(app, /saveMemoryDraftToServer\(\{ text: conflict\.theirs\.text \|\| '', sha256: conflict\.theirs\.sha256 \}\)/);
  assert.match(app, /leftMid\.length \* rightMid\.length > 1_000_000/);
  assert.match(app, /memory\.diff_degraded/);
  assert.match(app, /memory\.diff_truncated/);
  assert.match(app, /data-memory-conflict="mine"/);
  assert.match(app, /data-memory-conflict="theirs"/);
  assert.match(app, /data-memory-conflict="manual"/);
  assert.match(app, /if \(name === 'memory' && remoteIsReadOnly\(\)\) name = 'overview';/);
  assert.match(app, /tab\.disabled = readOnly;/);
  assert.match(app, /memory\.remote_read_only/);
  assert.match(app, /resetMemoryState\(\);/);
  assert.match(app, /memory_file_too_large/);
  assert.match(app, /unsupported_memory_file/);
  assert.match(app, /memory_conflict/);

  assert.match(css, /\.memory-layout/);
  assert.match(css, /\.memory-markdown/);
  assert.match(css, /\.memory-raw/);
  assert.match(css, /\.memory-editor/);
  assert.match(css, /\.memory-conflict/);

  for (const pack of [en, zh]) {
    assert.equal(typeof pack['tab.memory'], 'string');
    assert.equal(typeof pack['memory.edit'], 'string');
    assert.equal(typeof pack['memory.save'], 'string');
    assert.equal(typeof pack['memory.error_scope'], 'string');
    assert.equal(typeof pack['memory.error_too_large'], 'string');
    assert.equal(typeof pack['memory.error_unsupported'], 'string');
    assert.equal(typeof pack['memory.error_conflict'], 'string');
    assert.equal(typeof pack['memory.error_conflict_latest_failed'], 'string');
    assert.equal(typeof pack['memory.remote_read_only'], 'string');
    assert.equal(typeof pack['memory.retry'], 'string');
    assert.equal(typeof pack['memory.diff_degraded'], 'string');
    assert.equal(typeof pack['memory.diff_truncated'], 'string');
  }
});

test('fleet management entry is local-only and modal is extensible for future management sections', () => {
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8'));

  assert.match(index, /id="fleet-manage-btn"/);
  assert.match(index, /data-i18n-title="fleet_manage\.open"/);
  assert.match(index, /app\.js\?v=80/);
  assert.match(index, /<path d="M12 8V4H8"/);
  assert.match(index, /<rect width="16" height="12" x="4" y="8" rx="2"/);
  assert.match(app, /function initFleetManageButton\(\)[\s\S]*btn\.hidden = !!REMOTE_AGENT/);
  assert.match(app, /if \(e\.target\.closest\('#fleet-manage-btn'\)\) \{ e\.preventDefault\(\); openFleetManageModal\(\); return; \}/);

  // Fleet management configures the local consumer even while viewing a remote
  // agent in-page, so these calls intentionally avoid agentPath().
  assert.match(app, /fetch\(api\('\/api\/fleet\/agents'\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/fleet\/agents\/test'\), \{/);
  assert.match(app, /fetch\(api\('\/api\/agent\/name'\), \{/);
  assert.match(app, /fetch\(api\('\/api\/keys'\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/keys'\), \{/);
  assert.match(app, /fetch\(api\(`\/api\/keys\/\$\{encodeURIComponent\(name\)\}`\), \{ method: 'DELETE' \}\)/);
  assert.match(app, /fetch\(api\(`\/api\/keys\/\$\{encodeURIComponent\(name\)\}\/rotate`\), \{ method: 'POST' \}\)/);
  assert.match(app, /fetch\(api\(`\/api\/keys\/\$\{encodeURIComponent\(name\)\}\?permanent=1`\), \{ method: 'DELETE' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/keys\/purge-revoked'\), \{ method: 'POST' \}\)/);
  assert.doesNotMatch(app, /agentPath\('\/api\/fleet\/agents/);
  assert.doesNotMatch(app, /agentPath\('\/api\/agent\/name/);
  assert.doesNotMatch(app, /agentPath\('\/api\/keys/);
  assert.match(app, /function fleetManageError\(code, fallback\)/);
  assert.match(app, /fleetManageStatus\(fleetManageError\(data\.error \|\| 'unreachable'/);
  assert.match(app, /readKey: fleetManageModal\.querySelector\('#fleet-add-key'\)\?\.value \|\| ''/);
  assert.match(app, /createdKey: fleetManageModal\._createdKey \|\| null/);
  assert.match(app, /if \(wasOpen\) openFleetManageModal\(draft\);/);
  assert.match(app, /function renderFleetManage\(data, draft = null\)/);
  assert.match(app, /if \(!draft\) selfInput\.value = data\?\.self\?\.name \|\| viewedAgentName\(\);/);
  assert.match(app, /renderFleetManage\(data, draft\);/);
  assert.match(app, /function setFleetAddBusy\(isBusy\)/);
  assert.match(app, /fleetManageModal\?\.querySelector\('#fleet-test'\)\?\.toggleAttribute\('disabled', isBusy\);/);
  assert.match(app, /function setApiKeyBusy\(isBusy\)/);
  assert.match(app, /function renderCreatedApiKey\(createdKey\)/);
  assert.match(app, /renderCreatedApiKey\(draft\.createdKey \|\| null\);/);
  assert.match(app, /function rotateApiKey\(name\)/);
  assert.match(app, /function hardDeleteApiKey\(name\)/);
  assert.match(app, /function purgeRevokedApiKeys\(\)/);
  assert.match(app, /class="action-btn api-key-icon-btn api-key-rotate" type="button" title="\$\{rotateLabel\}" aria-label="\$\{rotateLabel\}"/);
  assert.match(app, /class="action-btn api-key-icon-btn api-key-revoke" type="button" title="\$\{revokeLabel\}" aria-label="\$\{revokeLabel\}"/);
  assert.match(app, /class="action-btn api-key-icon-btn api-key-delete" type="button" title="\$\{deleteLabel\}" aria-label="\$\{deleteLabel\}"/);
  assert.match(app, /API_KEY_ROTATE_ICON/);
  assert.match(app, /API_KEY_REVOKE_ICON/);
  assert.match(app, /API_KEY_DELETE_ICON/);
  assert.match(app, /replace_created_key_confirm/);
  assert.match(app, /if \(pendingKeyName && !window\.confirm/);
  assert.match(app, /if \(fleetManageModal\?\._createdKey\?\.name === name\) renderCreatedApiKey\(null\);/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /navigator\.clipboard\.writeText\(key\)/);
  assert.match(app, /id="api-key-admin-warning" hidden/);
  assert.match(app, /finally \{\s*setFleetAddBusy\(false\);\s*\}/);

  assert.match(app, /class="modal-tabs" role="tablist"/);
  assert.match(app, /data-tab="keys"/);
  assert.match(app, /data-panel="keys" hidden/);
  assert.match(app, /class="manage-section"/);
  assert.match(app, /id="fleet-add-key" type="password"/);
  assert.match(app, /id="api-key-scope"/);
  assert.match(css, /\.manage-modal/);
  assert.match(css, /\.modal-tabs/);
  assert.match(css, /\.fleet-help\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.api-key-created/);
  assert.match(css, /\.api-key-actions/);
  assert.match(css, /\.action-btn\.api-key-icon-btn/);
  assert.match(css, /\.action-btn\.api-key-icon-btn svg/);
  assert.match(css, /\.api-key-admin-warning/);

  for (const pack of [en, zh]) {
    assert.equal(typeof pack['fleet_manage.open'], 'string');
    assert.equal(typeof pack['fleet_manage.title'], 'string');
    assert.equal(typeof pack['fleet_manage.tab_fleet'], 'string');
    assert.equal(typeof pack['fleet_manage.tab_keys'], 'string');
    assert.equal(typeof pack['fleet_manage.key_created_once'], 'string');
    assert.equal(typeof pack['fleet_manage.rotate_key'], 'string');
    assert.equal(typeof pack['fleet_manage.revoke_key'], 'string');
    assert.equal(typeof pack['fleet_manage.delete_key'], 'string');
    assert.equal(typeof pack['fleet_manage.purge_revoked'], 'string');
    assert.equal(typeof pack['fleet_manage.replace_created_key_confirm'], 'string');
    assert.equal(typeof pack['fleet_manage.admin_key_warning'], 'string');
    assert.equal(typeof pack['fleet_manage.reserved_name'], 'string');
    assert.equal(typeof pack['fleet_manage.auth_failed'], 'string');
    assert.equal(typeof pack['fleet_manage.invalid_scope'], 'string');
  }

  // #238: the add-agent key field accepts any-scope API key — copy must not say "read key"
  assert.equal(en['fleet_manage.read_key'], 'API key');
  assert.equal(en['fleet_manage.missing_read_api_key'], 'API key is required.');
  assert.doesNotMatch(en['fleet_manage.keys_hint'], /read key/i);
  assert.doesNotMatch(en['fleet_manage.add_key_hint'], /read key/i);

  // #239: copyable Base URL for key handoff in the API Keys tab
  assert.match(app, /function dashboardBaseUrl\(\)/);
  assert.match(app, /\$\{window\.location\.origin\}\$\{BASE_PATH\}/);
  assert.match(app, /id="api-base-url" type="text" readonly/);
  assert.match(app, /id="api-base-url-copy"/);
  assert.match(app, /addEventListener\('click', copyDashboardBaseUrl\)/);
  for (const pack of [en, zh]) {
    assert.equal(typeof pack['fleet_manage.base_url_hint'], 'string');
    assert.equal(typeof pack['fleet_manage.base_url_copied'], 'string');
  }

  // #241: the back-to-fleet button must not stretch when a flex parent
  // (memory-tab-active pinned layout) applies align-items: stretch.
  const backToFleetRule = css.match(/\.back-to-fleet \{[^}]*\}/)[0];
  assert.match(backToFleetRule, /align-self:\s*flex-start/);

  // #242: success statuses auto-dismiss; closing the modal clears the status.
  assert.match(app, /clearTimeout\(fleetManageStatusTimer\)/);
  assert.match(app, /fleetManageStatusTimer = setTimeout\(\(\) => fleetManageStatus\(''\), 5000\);/);
  assert.match(app, /function closeFleetManageModal\(\) \{\s*if \(!fleetManageModal\) return;\s*fleetManageModal\.hidden = true;[\s\S]{0,80}fleetManageStatus\(''\);/);
});

test('i18n loader survives flaky pack fetches (#208)', async () => {
  const { isValidPack } = await import('../public/js/i18n.js');

  // Sentinel-key validation rejects proxy/captive-portal JSON and non-packs.
  assert.equal(isValidPack({ 'btn.actions': 'Actions' }), true);
  assert.equal(isValidPack({ error: 'bad gateway' }), false);
  assert.equal(isValidPack(['btn.actions']), false);
  assert.equal(isValidPack(null), false);
  assert.equal(isValidPack('btn.actions'), false);

  const i18n = fs.readFileSync(new URL('../public/js/i18n.js', import.meta.url).pathname, 'utf8');
  // HTTP failures are detected, retried with backoff, and never thrown out of
  // initI18n (a top-level await rejection would kill the whole app).
  assert.match(i18n, /if \(!resp\.ok\) throw/);
  assert.match(i18n, /for \(let i = 0; i < FETCH_ATTEMPTS; i\+\+\)/);
  assert.match(i18n, /translations = readCachedPack\(targetLocale\) \|\| \{\};/);
  // Last good pack is cached per locale and used as the offline fallback.
  assert.match(i18n, /localStorage\.setItem\(PACK_CACHE_PREFIX \+ locale, JSON\.stringify\(pack\)\)/);
  // Background self-heal re-renders static labels once a late fetch succeeds,
  // and a stale heal loop stops after a locale switch.
  assert.match(i18n, /scheduleHeal\(targetLocale, seq\);/);
  assert.match(i18n, /if \(seq !== requestSeq\) return;/);
  assert.match(i18n, /renderI18n\(\);[\s\S]*?\} catch \{/);

  // The module itself is cache-busted: a stale i18n.js would reintroduce the
  // bug class even with a fresh app.js.
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /from '\.\/i18n\.js\?v=2'/);
});

test('overlapping initI18n calls: stale slow request cannot overwrite the newer locale (#211 review)', async () => {
  const store = new Map();
  const savedGlobals = {
    localStorage: globalThis.localStorage,
    document: globalThis.document,
    fetch: globalThis.fetch
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' }, configurable: true
  });
  globalThis.document = { documentElement: { lang: '' }, querySelectorAll: () => [] };
  const pending = {};
  globalThis.fetch = (url) => new Promise((resolve) => {
    const locale = String(url).includes('/zh.json') ? 'zh' : 'en';
    pending[locale] = (pack) => resolve({ ok: true, json: async () => pack });
  });

  try {
    // Fresh module instance so stubs apply and state is isolated.
    const { initI18n, t } = await import('../public/js/i18n.js?test=race');

    const slowEn = initI18n('en');          // captured first, resolves last
    const fastZh = initI18n('zh');          // newer call supersedes
    pending.zh({ 'btn.actions': '操作', 'race.marker': 'zh-pack' });
    await fastZh;
    assert.equal(t('race.marker'), 'zh-pack');

    pending.en({ 'btn.actions': 'Actions', 'race.marker': 'en-pack' });
    await slowEn;
    // The stale English response must not overwrite translations…
    assert.equal(t('race.marker'), 'zh-pack');
    // …nor pollute any locale's cache (zh cache intact, en cache never written).
    assert.match(store.get('zylos-dashboard-i18n-zh'), /zh-pack/);
    assert.equal(store.has('zylos-dashboard-i18n-en'), false);
  } finally {
    globalThis.localStorage = savedGlobals.localStorage;
    globalThis.document = savedGlobals.document;
    globalThis.fetch = savedGlobals.fetch;
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
  }
});

test('memory tab pins the page frame and panes scroll independently (#222)', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  // The pin is class-driven and must drop when the fleet wall takes over.
  assert.match(app, /function syncMemoryPinned\(\)/);
  assert.match(app, /classList\.toggle\('memory-tab-active', memoryTabActive && !state\.fleetViewActive\)/);
  // Pinned frame: fixed-height body, no page scroll, panes scroll internally.
  assert.match(css, /body\.memory-tab-active \{[^}]*height: 100dvh;[^}]*overflow: hidden;/s);
  assert.match(css, /body\.memory-tab-active \.memory-tree \{ flex: 1; min-height: 0; max-height: none; \}/);
});

test('memory tree directories collapse and expand (#222)', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // Directory rows are buttons carrying their path and expansion state.
  assert.match(app, /<button class="memory-dir" type="button" data-dir="\$\{esc\(node\.path\)\}" aria-expanded="\$\{!collapsed\}"/);
  // #226: caret is an SVG chevron rotated by class, large enough to read.
  assert.match(app, /memory-dir-caret\$\{collapsed \? '' : ' expanded'\}/);
  assert.match(app, /MEMORY_CARET_ICON/);
  // Collapsed directories render no children.
  assert.match(app, /state\.memory\.collapsed\.has\(node\.path\)/);
  // Toggling flips membership in the collapsed set and re-renders.
  assert.match(app, /state\.memory\.collapsed\.delete\(dir\)/);
  assert.match(app, /state\.memory\.collapsed\.add\(dir\)/);
});

test('fleet sound cues use the marimba strike timbre Howard picked (#223)', () => {
  const sounds = fs.readFileSync(new URL('../public/js/fleet-sounds.js', import.meta.url).pathname, 'utf8');
  // Fixed-pitch percussive strike with a 4th-harmonic partial — no glide.
  assert.match(sounds, /function strike\(ctx, \{ freq, at, decay = 0\.28, peak = 0\.34 \}\)/);
  assert.match(sounds, /freq \* 4/);
  assert.doesNotMatch(sounds, /'triangle'/);
  assert.doesNotMatch(sounds, /exponentialRampToValueAtTime\(to,/);
  // Approved phrases: start E5->A5, finish A5->E5->B4 with a longer last decay.
  assert.match(sounds, /strike\(ctx, \{ freq: 659, at \}\)/);
  assert.match(sounds, /strike\(ctx, \{ freq: 880, at: at \+ 0\.13 \}\)/);
  assert.match(sounds, /strike\(ctx, \{ freq: 494, at: at \+ 0\.24, decay: 0\.4 \}\)/);
});

test('stale rate-limit windows stop painting after resets_at passes (#224)', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url).pathname, 'utf8');
  // Single-agent bars null out expired readings instead of showing the last value.
  assert.match(app, /function rateWindowExpired\(resetsAt\)/);
  assert.match(app, /const r5 = r5Expired \? null :/);
  assert.match(app, /const r7 = r7Expired \? null :/);
  // Producer payload (self tile + remote polling) applies the same rule.
  assert.match(index, /rateLimitWindowExpired\(resolved\.dimensions, metricName\)/);
});

test('memory tree has a collapse-all/expand-all toggle (#226)', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const i18nEn = fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8');
  const i18nZh = fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8');
  assert.match(html, /id="memory-fold"/);
  // Toggle folds every directory at once, or expands everything back.
  assert.match(app, /state\.memory\.collapsed = allCollapsed \? new Set\(\) : new Set\(dirs\)/);
  // Button label/icon track whether everything is already collapsed.
  assert.match(app, /allCollapsed \? MEMORY_UNFOLD_ICON : MEMORY_FOLD_ICON/);
  assert.match(app, /allCollapsed \? t\('memory\.expand_all'\) : t\('memory\.collapse_all'\)/);
  assert.match(i18nEn, /memory\.collapse_all/);
  assert.match(i18nZh, /memory\.collapse_all/);
});

test('subagent list is height-capped with internal scroll (#259)', () => {
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const block = css.match(/#subagent-list\s*\{[^}]*\}/);
  assert.ok(block, '#subagent-list rule must exist');
  assert.match(block[0], /max-height:\s*\d+px/);
  assert.match(block[0], /overflow-y:\s*auto/);
});


test('Observer recovery status survives refresh and exposes cleanup without viewer admission', async (t) => {
  const cases = [
    { state: 'installed', desired: { enabled: false, teardownFence: true, lastError: 'teardown_failed' } },
    { state: 'installed', desired: { enabled: true }, startupError: 'lock_timeout' },
    { state: 'not_installed', desired: { enabled: false }, startupError: 'teardown_failed' },
    { state: 'installed', desired: { enabled: false, teardownFence: true, removalState: 'failed' } },
    { state: 'installed', desired: { enabled: true, teardownFence: true } },
  ];
  for (const status of cases) await t.test(JSON.stringify(status), async () => {
    const h = observerUiHarness();
    h.setFetch((url) => {
      assert.ok(String(url).endsWith('/status'), 'recovery must not request a lease or enable/install');
      return Promise.resolve(observerResponse(status));
    });
    await h.context.refreshObserverStatus();
    assert.equal(h.settings['#observer-settings-state'].textContent, 'observer.state_recovery');
    assert.equal(h.settings['#observer-settings-recovery'].hidden, false);
    assert.ok(h.settings['#observer-settings-recovery'].textContent.includes(status.desired.removalState ? 'observer.removal_recovery_hint' : 'observer.recovery_hint'));
    assert.equal(h.settings['#observer-disable'].hidden, Boolean(status.desired.removalState));
    assert.equal(h.settings['#observer-disable'].textContent, 'observer.retry_cleanup');
    assert.equal(h.settings['#observer-uninstall'].textContent, status.desired.removalState ? 'observer.retry_uninstall' : 'observer.uninstall');
    assert.equal(h.settings['#observer-uninstall'].hidden, false);
    assert.equal(h.settings['#observer-enable'].hidden, true);
    assert.equal(h.settings['#observer-install'].hidden, true);
    assert.equal(h.elements['#observer-tab'].hidden, true);
    await h.context.runObserverLifecycle('enable');
    await h.context.runObserverLifecycle('install');
    await h.context.openObserver();
    assert.equal(h.context.state.observer.lease, null);
    assert.equal(h.elements['#observer-notice'].dataset.state, 'error');
    // A subsequent clean status must restore ordinary disabled controls.
    h.setFetch(() => Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: false, teardownFence: true } })));
    await h.context.refreshObserverStatus();
    assert.equal(h.settings['#observer-settings-state'].textContent, 'observer.state_disabled');
    assert.equal(h.settings['#observer-settings-recovery'].hidden, true);
    assert.equal(h.settings['#observer-enable'].hidden, false);
    assert.equal(h.settings['#observer-disable'].hidden, true);
    assert.equal(h.elements['#observer-tab'].hidden, true);
  });
});

test('Observer reconnect uses fresh leases and bounded delays while intent survives', async () => {
  const h = observerUiHarness();
  let attempts = 0;
  let available = false;
  h.setFetch((url) => {
    if (String(url).endsWith('/status')) return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    if (String(url).endsWith('/leases')) {
      attempts++;
      return Promise.resolve(available ? observerResponse({ id: `lease-${attempts}` }) : observerResponse({ error: 'target_unavailable' }, { ok: false, status: 503 }));
    }
    return Promise.resolve(observerResponse({}));
  });
  await h.context.openObserver();
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const timer = h.timeouts.at(-1);
    assert.equal(timer.delay, delay);
    timer();
    await new Promise(setImmediate);
  }
  available = true;
  h.timeouts.at(-1)();
  await new Promise(setImmediate);
  assert.equal(h.sockets.length, 1);
  const first = h.context.state.observer.lease.id;
  h.sockets[0].onclose({ reason: '' });
  await new Promise(setImmediate);
  h.timeouts.at(-1)();
  await new Promise(setImmediate);
  assert.equal(h.sockets.length, 2);
  assert.notEqual(h.context.state.observer.lease.id, first);
});

test('Observer cancelled retry cannot revive viewing, even after returning to the same target', async () => {
  const h = observerUiHarness();
  h.setFetch(() => Promise.reject(new Error('network down')));
  await h.context.openObserver();
  const timer = h.timeouts.at(-1);
  assert.equal(timer.delay, 1000);
  await h.context.closeObserver();
  assert.equal(timer.cancelled, true);
  h.context.state.remoteAgent = 'other';
  h.context.state.remoteAgent = null;
  const before = h.calls.length;
  timer(); // Even an already-queued callback is fenced by intent identity.
  await new Promise(setImmediate);
  assert.equal(h.calls.length, before);
  assert.equal(h.context.state.observer.intent, null);
});

for (const [code, status] of [['auth_required', 401], ['insufficient_scope', 403], ['teardown_failed', 503], ['unsafe_runtime_state', 503], ['not_installed', 404]]) {
  test(`Observer stops automatic retries for ${code}`, async () => {
    const h = observerUiHarness();
    h.setFetch(() => Promise.resolve(observerResponse({ error: code }, { ok: false, status })));
    await h.context.openObserver();
    assert.equal(h.timeouts.length, 0);
    assert.equal(h.context.state.observer.intent, null);
    assert.equal(h.elements['#observer-notice'].dataset.state, 'error');
  });
}

test('Observer waits for renderer readiness before opening stream and forwards validated sizes', async () => {
  const h = observerUiHarness(); h.setAutoFrameReady(false);
  h.setFetch(url => Promise.resolve(observerResponse(String(url).endsWith('/status')
    ? { state: 'installed', desired: { enabled: true } }
    : String(url).endsWith('/leases') ? { id: 'font-wait' } : {})));
  const opening = h.context.openObserver();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets.length, 0);
  const channel = h.context.state.observer.channel;
  channel.onmessage({ data: { type: 'ready' } }); await opening;
  assert.equal(h.sockets.length, 1);
  h.sockets[0].onmessage({ data: JSON.stringify({ type: 'size', cols: 120, rows: 35 }) });
  h.sockets[0].onmessage({ data: JSON.stringify({ type: 'size', cols: 501, rows: 35 }) });
  h.sockets[0].onmessage({ data: JSON.stringify({ type: 'preset', preset: 'large' }) });
  assert.deepEqual(JSON.parse(JSON.stringify(channel.messages)), [{ type: 'size', cols: 120, rows: 35 }]);
  channel.onmessage({ data: { type: 'metrics', width: 1200.1, height: 600.5 } });
  assert.equal(h.elements['#observer-frame'].style.width, 'max(100%, 1201px)');
  channel.onmessage({ data: { type: 'metrics', width: Infinity, height: 100 } });
  assert.equal(h.elements['#observer-frame'].style.width, 'max(100%, 1201px)');
  await h.context.closeObserver({ release: false });
  channel.onmessage({ data: { type: 'metrics', width: 500, height: 100 } });
  assert.equal(h.elements['#observer-frame'].style.width, '');
});

test('Observer abort while font is loading releases lease without opening stream', async () => {
  const h = observerUiHarness(); h.setAutoFrameReady(false);
  h.setFetch(url => Promise.resolve(observerResponse(String(url).endsWith('/status')
    ? { state: 'installed', desired: { enabled: true } }
    : String(url).endsWith('/leases') ? { id: 'font-abort' } : {})));
  const opening = h.context.openObserver(); await new Promise(resolve => setImmediate(resolve));
  const channel = h.context.state.observer.channel;
  await h.context.closeObserver(); await opening;
  channel.onmessage({ data: { type: 'ready' } });
  assert.equal(h.sockets.length, 0);
  assert.equal(h.context.state.observer.lease, null);
  assert.ok(h.calls.some(call => call.url.endsWith('/font-abort/release')));
});

test('Observer renderer readiness timeout releases lease and schedules recovery', async () => {
  const h = observerUiHarness(); h.setAutoFrameReady(false);
  h.setFetch(url => Promise.resolve(observerResponse(String(url).endsWith('/status')
    ? { state: 'installed', desired: { enabled: true } }
    : String(url).endsWith('/leases') ? { id: 'font-timeout' } : {})));
  const opening = h.context.openObserver(); await new Promise(resolve => setImmediate(resolve));
  h.timeouts.find(timer => timer.delay === 5000 && !timer.cancelled)(); await opening;
  assert.equal(h.sockets.length, 0); assert.equal(h.context.state.observer.lease, null);
  assert.ok(h.calls.some(call => call.url.endsWith('/font-timeout/release')));
  assert.equal(h.elements['#observer-notice'].dataset.state, 'connecting');
  assert.ok(h.timeouts.some(timer => timer.delay !== 5000 && !timer.cancelled));
});

test('Observer Set size fills remembered size once per target and hides for older producers', () => {
  const h = observerUiHarness();
  const form = h.elements['#observer-size-form'];
  h.context.renderObserverSizeForm({ agentSize: { cols: 132, rows: 60 } });
  assert.equal(form.hidden, false);
  assert.equal(h.elements['#observer-size-cols'].value, '132');
  assert.equal(h.elements['#observer-size-rows'].value, '60');
  h.elements['#observer-size-rows'].value = '70';
  h.context.renderObserverSizeForm({ agentSize: { cols: 132, rows: 60 } });
  assert.equal(h.elements['#observer-size-rows'].value, '70', 'status refresh must not clobber an edit');

  h.context.state.remoteAgent = 'Remote';
  h.context.renderObserverSizeForm({ agentSize: { cols: 100, rows: 40 } });
  assert.equal(h.elements['#observer-size-rows'].value, '40');
  h.context.renderObserverSizeForm({ state: 'installed' });
  assert.equal(form.hidden, true);

  h.context.renderObserverSizeForm({ agentSize: { cols: 100, rows: 40 } });
  h.context.state.observer.historyMode = true;
  h.context.renderObserverSizeForm({ agentSize: { cols: 100, rows: 40 } });
  assert.equal(form.hidden, true);
});

test('Observer Set size posts to the viewed agent and reports the outcome', async () => {
  const h = observerUiHarness();
  const status = h.elements['#observer-size-status'];
  const apply = h.elements['#observer-size-apply'];
  h.context.state.observer.status = { agentSize: { cols: 120, rows: 50 } };
  h.context.state.remoteAgent = 'Remote';
  h.context.renderObserverSizeForm();
  h.elements['#observer-size-cols'].value = '132';
  h.elements['#observer-size-rows'].value = '60';
  let respond;
  h.setFetch(() => new Promise((resolve) => { respond = resolve; }));
  const pending = h.context.applyObserverSize({ preventDefault() {} });
  assert.equal(apply.disabled, true);
  assert.equal(h.calls[0].url, '/fleet/Remote/api/observer/agent-size');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.body, '{"cols":132,"rows":60}');
  await h.context.applyObserverSize({ preventDefault() {} });
  assert.equal(h.calls.length, 1, 'duplicate submit while pending');
  respond(observerResponse({ agentSize: { cols: 132, rows: 60 }, applied: { cols: 132, rows: 60, statusLines: 1 } }));
  await pending;
  assert.equal(apply.disabled, false);
  assert.equal(status.textContent, 'observer.size.applied');
  assert.deepEqual(h.context.state.observer.status.agentSize, { cols: 132, rows: 60 });

  for (const [error, expected] of [['observer_starting', 'observer.size.error.observer_starting'], ['not_found', 'observer.size.failed']]) {
    h.setFetch(async () => observerResponse({ error }, { ok: false, status: 409 }));
    await h.context.applyObserverSize({ preventDefault() {} });
    assert.equal(status.textContent, expected);
    assert.equal(status.dataset.state, 'error');
  }

  h.setFetch(async () => observerResponse({ error: 'invalid_size', maxRows: 197 }, { ok: false, status: 400 }));
  await h.context.applyObserverSize({ preventDefault() {} });
  assert.equal(status.textContent, 'observer.size.error.rows_limit');

  const before = h.calls.length;
  h.elements['#observer-size-rows'].value = '201';
  await h.context.applyObserverSize({ preventDefault() {} });
  assert.equal(h.calls.length, before);
  assert.equal(status.textContent, 'observer.size.error.invalid_size');

  h.setReadOnly(true);
  h.elements['#observer-size-rows'].value = '60';
  await h.context.applyObserverSize({ preventDefault() {} });
  assert.equal(h.calls.length, before);
  h.context.renderObserverSizeForm();
  assert.equal(apply.disabled, true);
});

test('Observer retries an attachment aborted by a concurrent Agent resize', async () => {
  const h = observerUiHarness();
  let attempts = 0;
  h.setFetch((url) => {
    if (String(url).endsWith('/status')) return Promise.resolve(observerResponse({ state: 'installed', desired: { enabled: true } }));
    if (String(url).endsWith('/leases')) {
      attempts++;
      return Promise.resolve(attempts === 1
        ? observerResponse({ error: 'target_size_changed' }, { ok: false, status: 503 })
        : observerResponse({ id: 'lease-2' }));
    }
    return Promise.resolve(observerResponse({}));
  });
  await h.context.openObserver();
  assert.equal(h.timeouts.at(-1).delay, 1000);
  h.timeouts.at(-1)();
  await new Promise(setImmediate);
  assert.equal(h.sockets.length, 1);
});

test('app.js busts the cached observer-size module whose exports it now needs', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // Static modules are cached for 60s; a new named import from an unversioned
  // URL can bind to the previous copy and abort the whole module graph.
  assert.match(app, /import \{ validAgentSize, validObserverSize \} from '\.\/observer-size\.js\?v=2';/);
});
