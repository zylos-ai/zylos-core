import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { afterSentence, buildAgentFleetView, fleetSelfFromSnapshot, handleFleetClick, renderAgentFleetHtml } from '../public/js/agent-fleet.js';
import { documentFixture, node } from './fixtures/settings-dom.js';
import { validAgentSize, validObserverSize } from '../public/js/observer-size.js';
import { agentColor } from '../src/lib/agent-color.js';
import { tabForPath } from '../public/js/wb/view-mode.js';
import { observerPageUsable, observerRecoveryReason } from '../public/js/wb/observer-page.js';

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
    slice('function initFleetMode(', 'async function changeLocale('),
    slice('function initTabs(', 'function initObserverControls('),
    slice('function resetAgentData(', 'function initFleetMode('),
    slice('function observerStatusLabel(', 'let settingsPage = null;')
  ].join('\n');
  let autoFrameReady = true;
  const elements = {
    '#observer-notice': { dataset: {} },
    '#observer-frame': { style: {}, contentWindow: { postMessage(_message, _origin, ports) { if (autoFrameReady) queueMicrotask(() => ports[0].peer.onmessage?.({ data: { type: 'ready' } })); } }, parentElement: { dataset: {} } },
    '#observer-target': { replaceChildren() {}, append() {} },
    '#observer-empty': { hidden: false },
    '#observer-main': { hidden: true },
    '#observer-empty-title': {},
    '#observer-empty-back': { hidden: true },
    '#observer-back': { hidden: true },
    '#observer-title': {},
    '#observer-notice-history': { hidden: true },
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
    settingsLoader: { invalidate() {} },
    settingsModal: { querySelector: (selector) => settings[selector], querySelectorAll: () => buttons },
    $: (selector) => elements[selector],
    document: {
      querySelectorAll: (selector) => selector === '.tab' ? tabs : selector === '.tab-panel' ? panels : [],
      querySelector: (selector) => selector === '.tab.active' ? tabs.find((tab) => tab.classList.active) || null : null,
      addEventListener() {},
      createElement: () => ({}),
      visibilityState: 'visible'
    },
    originSessionUnavailable: () => false,
    t: (key) => key,
    clearTimeout(id) { if (timeouts[id - 1]) timeouts[id - 1].cancelled = true; },
    clearInterval() {},
    setInterval: (handler) => { intervals.push(handler); return intervals.length; },
    setTimeout: (handler, delay) => { handler.delay = delay; timeouts.push(handler); return timeouts.length; },
    URL,
    AbortController,
    validObserverSize,
    validAgentSize,
    tabForPath,
    observerPageUsable,
    observerRecoveryReason,
    handleFleetClick,
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
    remoteAccess: () => (readOnly ? 'read' : 'admin'),
    connectSse() {},
    transitionView() {},
    refreshFleet: async () => {},
    scheduleFleetFallback() {},
    clearFleetFallback() {},
    syncFleetSubscription() {},
    prefersReducedMotion: () => false,
    refreshAll: async () => {},
    refreshCharts() {},
    usagePage: { open() {}, close() {}, setViewDetail() {} },
    refreshUsage() {},
    refreshChat() {},
    chatPage: { close() {} },
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

// What the user sees: the observer page renders its main view and hides the empty state, or the reverse.
function observerPageShown(harness) {
  harness.context.renderObserverPage();
  const empty = harness.elements['#observer-empty'].hidden, main = harness.elements['#observer-main'].hidden;
  assert.equal(empty, !main, 'exactly one of the empty state and the main view is visible');
  return !main;
}

function observerResponse(data, { ok = true, status = ok ? 200 : 503 } = {}) {
  return { ok, status, json: async () => data, text: async () => '<html>renderer</html>' };
}

test('/api/state exposes the agent identity colour for remote machines that still tint by it', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url).pathname, 'utf8');
  assert.match(index, /stateData\.agent = \{ \.\.\.config\.agent, \.\.\.agentColor\(config\.agent\?\.name\) \}/);
});

test('SSE state updates preserve the agent identity color between full state reads', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  // The SSE state_change payload omits the agent color (added only by
  // /api/state). The client must carry it over, the same way it already does
  // for runtime_info, so a live update does not drop the identity colour.
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

test('Codex runtime renders CLI update badge in settings', () => {
  const version = fs.readFileSync(new URL('../public/js/wb/settings-version.js', import.meta.url), 'utf8');
  assert.match(version, /ri\.codex_running \|\| ri\.codex_version \|\| ri\.codex_installed/);
  assert.match(version, /ri\.codex_restart \|\| ri\.codex_update/);
  assert.match(version, /badge\.classList\.toggle\('action-ver-dot', !!update\)/);
});

test('zylos-core upgrade stays an agent hint in settings', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const version = fs.readFileSync(new URL('../public/js/wb/settings-version.js', import.meta.url), 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(app, /data-action="upgrade-zylos"/);
  assert.doesNotMatch(app, /action-zylos-ver/);
  assert.match(app, /data-action="upgrade-cc"/);
  assert.match(version, /hint\.title = t\('info.zylos_update_hint'/);
  assert.match(version, /onHint\(hint\)/);
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
        name: 'zz-lab',
        color: agentColor('zz-lab').color,
        hue: agentColor('zz-lab').hue,
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

test('Machines page renders one card per machine with state, quota, cost and host, problems first', () => {
  const view = buildAgentFleetView(fleetFixture(), { basePath: '/dash' });
  const html = renderAgentFleetHtml(fleetFixture(), { basePath: '/dash' });
  assert.equal(view.tiles.length, 4);
  assert.deepEqual([view.counts.busy, view.counts.idle, view.counts.stuck, view.counts.offline], [1, 1, 1, 1]);
  // Unreachable machines come before reachable ones (no self in this fixture); by name alone zz-lab would be last.
  assert.deepEqual(view.tiles.map(tile => tile.name), ['zz-lab', 'zylos01', 'zylos02', 'zylos0t']);
  assert.match(html, /class="wb-f-card bad" data-agent="zz-lab"/);
  assert.match(html, /Cannot connect/);
  assert.match(html, /class="wb-tech agent-fleet-reason">Unreachable</);
  assert.match(html, /class="wb-pill wb-busy" data-mood="busy"/);
  assert.match(html, /class="wb-pill wb-waiting" data-mood="stuck"/);
  assert.match(html, /class="wb-btn agent-open" href="\/dash\/fleet\/zylos01\/" data-agent="zylos01"/);
  assert.match(html, /GPT-5 \/ medium/);
  assert.match(html, /Today \/ 7 days/);
  assert.match(html, /CPU · Memory · Disk/);
  assert.match(html, /21 · 43 · 65%/);
  // Retired wall elements: mascots, rings, 5-hour quota, pulse.
  for (const gone of [/mascot/, /fleet-mini-ring/, /rate_limit_pct|5h/, /pulse-sparkline/, /agent-upgrade-badge/]) assert.doesNotMatch(html, gone);
});

test('this machine shows the multi-session view: groups by state, running pool and both weekly quotas', () => {
  const fleet = { agents: [{ name: 'local', self: true, state: 'BUSY', daily_cost: 1, weekly_cost: 2, cpu_pct: 1, mem_pct: 2, disk_pct: 3 }] };
  const self = { mode: 'multi', groups: 6, counts: { busy: 2, waiting: 0, error: 1, idle: 2, not_running: 1 }, pool: { used: 3, capacity: 4 }, accounts: { claude: 42, codex: 9 } };
  const html = renderAgentFleetHtml(fleet, { self });
  assert.match(html, /wb-f-card self"/);
  assert.match(html, /Multi-session/);
  assert.match(html, /6 groups · 2 working · 1 error · running 3\/4/);
  assert.match(html, /<i class="wb-gbar-busy" style="flex:2"><\/i>/);
  assert.match(html, /Claude<\/span><span class="wb-qbar-tr"><i style="width:42%" class="wb-sw-claude">/);
  assert.match(html, /Codex<\/span><span class="wb-qbar-tr"><i style="width:9%" class="wb-sw-codex">/);
  const noCapacity = renderAgentFleetHtml(fleet, { self: { ...self, pool: { used: 3, capacity: null } } });
  assert.match(noCapacity, /running 3</);
  assert.match(renderAgentFleetHtml({ agents: [{ name: 'local', self: true }] }), /No other machines yet/);
});

test('this machine reads both weekly quotas from the raw groups snapshot, Claude in snake_case and Codex in camelCase', () => {
  const snapshot = {
    mode: 'multi', counts: { busy: 1, idle: 1 }, rows: [{}, {}],
    instance: { pool: { used: 1, capacity: 4 }, accounts: { claude: { used_percentage: 42, resets_at: 1 }, codex: { usedPercentage: 35, windowDurationMins: 10080 } } }
  };
  const self = fleetSelfFromSnapshot(snapshot);
  assert.deepEqual(self.accounts, { claude: 42, codex: 35 });
  assert.deepEqual(fleetSelfFromSnapshot({ instance: { accounts: { claude: { utilization: 7 } } } }).accounts, { claude: 7, codex: null });
  const html = renderAgentFleetHtml({ agents: [{ name: 'local', self: true, state: 'IDLE', daily_cost: 1 }] }, { self });
  const card = html.slice(html.indexOf('wb-f-card self'));
  assert.match(card, /Claude<\/span><span class="wb-qbar-tr"><i style="width:42%" class="wb-sw-claude">/);
  assert.match(card, /Codex<\/span><span class="wb-qbar-tr"><i style="width:35%" class="wb-sw-codex">/);
  const compare = html.slice(html.indexOf('wb-f-compare'), html.indexOf('wb-f-card'));
  assert.match(compare, /Codex<\/span><span class="wb-qbar-tr"><i style="width:35%" class="wb-sw-codex">/);
});

test('an unreachable machine says how long ago it was last reachable in the page language', () => {
  const lastSeen = new Date(Date.now() - 2 * 3600e3 - 60e3).toISOString();
  const fleet = { agents: [{ name: 'lab', state: 'OFFLINE', health_reason: 'unreachable', last_seen: lastSeen }] };
  const english = renderAgentFleetHtml(fleet);
  assert.match(english, /changed\. Last reachable 2h ago/, 'a new sentence after the full stop, no separator');
  const chinese = renderAgentFleetHtml(fleet, { labels: { lastSeen: '{time}最后在线', fixDown: '对方可能已关机，或地址变了。' }, ageText: () => '2 小时前' });
  assert.match(chinese, /地址变了。2 小时前最后在线/);
  assert.doesNotMatch(chinese, /。 ·/);
  assert.doesNotMatch(chinese, /2h/);
  assert.equal(renderAgentFleetHtml({ agents: [{ name: 'lab', state: 'OFFLINE', health_reason: 'unreachable', last_seen: 'not a time' }] }).includes('last reachable'), false);
});

test('machine names that may be cut short keep the full name in their tooltip', () => {
  const long = 'build-server-in-the-basement-rack-3';
  const html = renderAgentFleetHtml({ agents: [{ name: long, state: 'IDLE', pulse_rate: 0 }, { name: long + '-down', state: 'OFFLINE', health_reason: 'unreachable' }] });
  assert.match(html, new RegExp('<b title="' + long + '">' + long + '</b>'));
  assert.match(html, new RegExp('<b title="' + long + '-down">'));
});

test('a sentence that ends with a full stop is not followed by a separator', () => {
  assert.equal(afterSentence('请对方重新发密钥。', '2 小时前最后在线'), '请对方重新发密钥。2 小时前最后在线');
  assert.equal(afterSentence('Ask them for a new key.', 'last reachable 2h ago'), 'Ask them for a new key. Last reachable 2h ago');
  assert.equal(afterSentence('Unreachable', 'last reachable 2h ago'), 'Unreachable · last reachable 2h ago');
  assert.equal(afterSentence('Unreachable', ''), 'Unreachable');
});

test('problem cards say why in plain words, keep the precise reason for technical view and offer settings and refresh', () => {
  const html = renderAgentFleetHtml({ agents: [
    { name: 'k', state: 'UNKNOWN', health_reason: 'auth_failed', pulse_rate: 0, base_url: 'https://k.example' },
    { name: 'v', state: 'UNKNOWN', health_reason: 'version_unsupported', pulse_rate: 0 },
  ] });
  assert.match(html, /<span class="wb-plain">Key no longer valid<\/span>/);
  assert.match(html, /<span class="wb-plain">Version too old<\/span>/);
  assert.match(html, /wb-tech wb-mono"> · auth_failed/);
  assert.equal((html.match(/data-fleet-action="settings"/g) || []).length, 2);
  assert.equal((html.match(/data-fleet-action="refresh"/g) || []).length, 2);
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
  assert.match(app, /state\.eventSource\.addEventListener\(ev,/);
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
  assert.match(app, /if \(\['settings', 'chat'\]\.includes\(tabForPath\(window\.location\.pathname\)\)\) \{/);
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
  assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?if \(!\['settings', 'chat'\]\.includes\(tabForPath\(window\.location\.pathname\)\)\) showFleetView\(\{ animate: true \}\);[\s\S]*?\}, 380\)/);
  // CSS defines the stack and the zoom enter/leave states.
  assert.match(css, /\.view-stack\s*\{\s*display:\s*grid/);
  assert.match(css, /\.app-view\.v-enter/);
  assert.match(css, /\.app-view\.v-leave-to-fleet/);
  assert.match(css, /\.app-view\.v-leave-to-agent/);
});

test('this machine opens its own workbench and others open through the fleet path', () => {
  const selfFleet = {
    updated_at: '2026-06-07T15:20:00.000Z',
    agents: [
      { name: 'local', state: 'IDLE', last_seen: '2026-06-07T15:20:00.000Z', pulse_rate: 1, health_reason: 'idle', self: true },
      { name: 'remote', state: 'BUSY', activity: 'work', last_seen: '2026-06-07T15:20:00.000Z', pulse_rate: 1, health_reason: 'ok', self: false }
    ]
  };
  const view = buildAgentFleetView(selfFleet, { basePath: '/dash' });
  const byName = Object.fromEntries(view.tiles.map((tile) => [tile.name, tile]));
  assert.equal(byName.local.isSelf, true);
  assert.equal(byName.local.href, '/dash/');
  assert.equal(byName.remote.href, '/dash/fleet/remote/');
  const html = renderAgentFleetHtml(selfFleet, { basePath: '/dash' });
  assert.match(html, /class="wb-btn agent-open" href="\/dash\/" data-agent="local" data-self="true"/);
  assert.match(html, /class="wb-btn agent-open" href="\/dash\/fleet\/remote\/" data-agent="remote">/);
  // Clicking "Open": this machine opens in place, another machine through the fleet path; problem-card buttons
  // open settings or re-read the fleet. Nothing else on the page reacts.
  const document = documentFixture(), calls = [];
  const button = (className, dataset) => { const el = node(document, 'a'); el.className = className; Object.assign(el.dataset, dataset); const label = node(document, 'span'); el.append(label); return { el, label }; };
  const handlers = { onSelf: () => calls.push('self'), onRemote: name => calls.push('remote:' + name), onSettings: () => calls.push('settings'), onRefresh: () => calls.push('refresh') };
  const click = target => { let prevented = false; handleFleetClick({ target, preventDefault: () => { prevented = true; } }, handlers); return prevented; };
  assert.equal(click(button('wb-btn agent-open', { agent: 'local', self: 'true' }).label), true, 'the link does not navigate away');
  assert.equal(click(button('wb-btn agent-open', { agent: 'remote' }).el), true);
  click(button('wb-btn', { fleetAction: 'settings' }).label);
  click(button('wb-btn', { fleetAction: 'refresh' }).el);
  assert.equal(click(node(document, 'div')), false);
  assert.deepEqual(calls, ['self', 'remote:remote', 'settings', 'refresh']);
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
  assert.match(html, /class="wb-tech agent-fleet-reason">Bad payload<\/span>/);
  assert.doesNotMatch(html, /agent-link-chip link-ok/);
  assert.doesNotMatch(html, /Link latency 0ms/, 'an unmeasured link has no latency');
});

test('a reachable machine card shows its running tool as the current action', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'BUSY', activity: 'older summary', activity_feed: [{ kind: 'tool', label: 'Bash: npm test', started_at: null }] }]
  });
  assert.match(html, /<span title="Bash: npm test">Bash: npm test<\/span>/);
});

test('fleet tile activity feed falls back to legacy single-line activity', () => {
  const html = renderAgentFleetHtml({
    agents: [{ name: 'a', state: 'IDLE', activity: 'Prompt from lark', activity_feed: [] }]
  });
  assert.match(html, /Prompt from lark/);
});

test('a thinking feed entry counts the machine as working and labels it thinking', () => {
  const fleet = { agents: [{ name: 'a', state: 'BUSY', activity: 'Prompt from lark', activity_feed: [{ kind: 'thinking', label: null, started_at: null }] }] };
  const view = buildAgentFleetView(fleet);
  assert.equal(view.tiles[0].mood, 'thinking');
  assert.equal(view.tiles[0].stateLabel, 'Thinking');
  const html = renderAgentFleetHtml(fleet);
  assert.match(html, /data-state="thinking"/);
  assert.match(html, /<span class="wb-pill wb-busy" data-mood="thinking"><span class="wb-dot"><\/span>Thinking<\/span>/);
  assert.match(html, /1 Working/);
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

test('machine context and weekly quota stay 0-100 percentages, with the 80% quota tick', () => {
  const view = buildAgentFleetView({ agents: [{ name: 'a', state: 'IDLE', context_pct: 60 }] });
  assert.equal(view.tiles[0].contextLevel, 'warning');
  // #251: values are 0-100 percentages — never fraction-inferred. A genuine
  // 1% weekly usage must render 1%, not a full red bar.
  const tiny = buildAgentFleetView({ agents: [{ name: 'a', state: 'IDLE', context_pct: 0.6, rate_limit_7d_pct: 1 }] });
  assert.equal(tiny.tiles[0].contextLevel, 'ok');
  assert.equal(tiny.tiles[0].rate7dPct, 1);
  const bar = pct => renderAgentFleetHtml({ agents: [{ name: 'a', state: 'IDLE', rate_limit_7d_pct: pct }] });
  assert.match(bar(79), /class="wb-qbar"><span>This week/);
  assert.match(bar(80), /class="wb-qbar hi"/);
  assert.match(bar(100), /class="wb-qbar full"/);
  assert.match(bar(null), /<b>--<\/b>/);
  assert.match(renderAgentFleetHtml({ agents: [{ name: 'a', state: 'IDLE', context_pct: 79, new_session_threshold: 70 }] }), /<b class="wb-txt-warn">79%<\/b>/);
  // Static guard: the fraction heuristic must not creep back into any percent-typed frontend file.
  for (const f of ['public/js/app.js', 'public/js/agent-fleet.js']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url).pathname, 'utf8');
    assert.doesNotMatch(src, /<=? ?1 \? [\w.]+ \* 100/, `${f} reintroduced the fraction heuristic`);
  }
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
  assert.match(html, /<span class="sum-seg is-zero"><i class="sum-dot dot-offline"><\/i>0 Offline<\/span>/);
  assert.match(html, /<small>Session<\/small> <strong>\$113\.33<\/strong>/);
  assert.match(html, /<small>Today<\/small> <strong>\$205\.58<\/strong>/);
  assert.match(html, /<small>7 days<\/small> <strong>\$1986\.55<\/strong>/);
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
  assert.match(app, /const r = await draftFetch\(api\(agentPath\(path\)\), \{ cache: 'no-store' \}\);/);
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
  assert.match(reset, /resetMemoryState\(\);/);
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
  // The standalone remote document keeps plain tab routing.
  assert.match(app, /if \(!REMOTE_AGENT\) \{\s*\n\s*const m = path\.match\(\/\\\/fleet\\\/\(\[\^\/\]\+\)\\\/\?\(\?::?trends\|usage\|schedule\|settings\|memory\|observer\|chat\)\?\$\/\);?/);
  assert.match(app, /await enterRemoteAgent\(decodeURIComponent\(m\[1\]\), \{ push: false \}\);/);
  assert.match(app, /else if \(state\.remoteAgent\) \{\s*\n\s*await exitRemoteAgent\(\{ push: false \}\);/);
  assert.match(app, /const path = name === 'overview' \? `\$\{prefix\}\/` : `\$\{prefix\}\/\$\{name === 'trends' \? 'usage' : name\}`;/);
});

test('machine cards enter remote agents in-page instead of full navigation', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const fleetMode = app.indexOf('function initFleetMode(');
  const block = app.slice(fleetMode, app.indexOf("const backBtn = $('#back-to-fleet');", fleetMode));
  // What a click does is tested on handleFleetClick itself; here only that the app hands it the in-page entry.
  assert.match(block, /addEventListener\('click', e => handleFleetClick\(e, \{[\s\S]*onSelf: showAgentDetail, onRemote: enterRemoteAgent,/);
});

test('remote Actions/Settings are gated by access and routed through the viewed agent', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const version = fs.readFileSync(new URL('../public/js/wb/settings-version.js', import.meta.url), 'utf8');
  assert.match(app, /function remoteAccess\(\)/);
  assert.match(app, /agent\?\.access === 'admin' \? 'admin' : 'read'/);
  assert.match(app, /const REMOTE_ACCESS = document\.documentElement\.dataset\.remoteAccess === 'admin' \? 'admin' : 'read';/);
  assert.match(version, /upgrade\.disabled = readOnly/);
  assert.match(version, /remote\.actions_read_only_tooltip/);
  assert.match(app, /write: body => requestAgentJson\('\/api\/settings'/);
  assert.match(app, /applySettingsReadOnly\(remoteIsReadOnly\(\)\)/);
  // The action runner refuses to send for a read-only key (wb-action-runner tests); the app tells it when that is.
  assert.match(app, /readOnly: \(\) => Boolean\(remoteIsReadOnly\(\)\)/);
  assert.match(app, /const actionPath = agentPath\(`\/api\/actions\/\$\{action\}`\);/);
  assert.match(app, /const healthPath = agentPath\('\/api\/health'\);/);
  assert.match(app, /startCountdownAndReload\(15, statusEl, healthPath, summary\);/);
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
  assert.ok(app.indexOf('await refreshObserverStatus({ quiet: true });') < app.lastIndexOf('initTabs();'));
  assert.ok(app.indexOf('await refreshObserverStatus({ quiet: true });') > -1);
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
  assert.equal(observerPageShown(harness), true);

  firstStatus.resolve(observerResponse({ state: 'not_installed' }));
  await alpha;
  assert.equal(harness.context.state.remoteAgent, 'bravo');
  assert.equal(harness.context.state.observer.status.state, 'installed');
  assert.equal(observerPageShown(harness), true);
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
  assert.equal(observerPageShown(harness), true);
});

test('Observer reset uses the real resetAgentData path to clear target status before navigation fetches', async () => {
  const harness = observerUiHarness();
  harness.context.state.observer.statusGeneration = 4;
  harness.context.state.observer.status = { state: 'installed', desired: { enabled: true } };
  harness.elements['#observer-tab'].hidden = false;

  harness.context.resetAgentData();

  assert.equal(harness.context.state.observer.statusGeneration, 5);
  assert.equal(harness.context.state.observer.status, null);
  assert.equal(observerPageShown(harness), false);
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
      assert.equal(observerPageShown(harness), false);
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
    assert.equal(observerPageShown(h), false);
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
  assert.equal(observerPageShown(h), false);
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
  assert.equal(observerPageShown(h), false);
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
  const memoryScope = fs.readFileSync(new URL('../public/js/wb/memory-scope.js', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8'));

  assert.match(index, /data-tab="memory"/);
  assert.match(index, /id="tab-memory"/);
  assert.match(index, /id="memory-tree"/);
  assert.match(index, /id="memory-content"/);
  assert.match(index, /app\.js\?v=\d+/);
  assert.match(index, /style\.css\?v=61/);

  assert.match(app, /fetchAgentJson\('\/api\/memory\/tree'\)/);
  assert.match(app, /fetchAgentJson\(`\/api\/memory\/file\?path=\$\{encoded\}`\)/);
  assert.match(app, /fetchAgentJson\(`\/api\/memory\/git\?path=\$\{encoded\}`\)/);
  assert.match(app, /saveMemoryOnce\(\{ request: requestAgentJson, readFile: fetchAgentJson,/);
  assert.match(app, /path: file\.path, text, sha256,/);
  assert.match(app, /if \(!applyMemorySave\(captured, state\.memory, saved\)\) return;/);
  const memoryActions = app.slice(app.indexOf('function renderMemoryActions()'), app.indexOf('function renderMemory()'));
  assert.match(memoryActions, /applyMemoryWriteAccess\(editBtn, saveBtn, state\.memory\.tree, file\?\.path\)/);
  const memorySave = app.slice(app.indexOf('async function saveMemoryDraftToServer('), app.indexOf('async function resolveMemoryConflict('));
  assert.doesNotMatch(memorySave, /loadMemoryTree\(/);
  assert.match(memorySave, /renderMemoryPreservingEditor\(renderMemory, document\)/);
  assert.match(memoryScope, /request\(`\/api\/memory\/file\?path=\$\{encodeURIComponent\(path\)\}`/);
  assert.match(memoryScope, /method: 'PUT'/);
  assert.match(memoryScope, /JSON\.stringify\(\{ text, sha256 \}\)/);
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

test('fleet management entry stays local and its controls are retained in settings sections', () => {
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8'));

  assert.match(index, /id="fleet-manage-btn"/);
  assert.match(index, /data-i18n-title="fleet_manage\.open"/);
  assert.match(index, /app\.js\?v=\d+/);
  assert.match(index, /id="fleet-manage-btn"[^>]*><i class="wb-ico wb-ico-fleet" aria-hidden="true"><\/i>/);
  assert.match(app, /function initFleetManageButton\(\)[\s\S]*btn\.hidden = !!REMOTE_AGENT/);
  // With other machines configured the icon opens the fleet wall; otherwise fleet settings.
  assert.match(app, /if \(e\.target\.closest\('#fleet-manage-btn'\)\) \{ e\.preventDefault\(\); if \(state\.multiAgent && !state\.remoteAgent\) showFleetView\(\); else openSettingsModal\('fleet'\); \}/);

  // Fleet management configures the local consumer even while viewing a remote
  // agent in-page, so these calls intentionally avoid agentPath().
  assert.match(app, /fetch\(api\('\/api\/fleet\/agents'\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/fleet\/agents\/test'\), \{/);
  assert.match(app, /fetch\(api\('\/api\/agent\/name'\), \{/);
  assert.match(app, /fetch\(api\('\/api\/keys'\), \{ cache: 'no-store' \}\)/);
  assert.match(app, /fetch\(api\('\/api\/keys'\), \{/);
  // Which request each key action makes is decided by keyActionRequest (wb-settings-wiring tests); the app sends it as built.
  assert.match(app, /fetch\(api\(request\.path\), \{ method: request\.method \}\)/);
  assert.match(app, /fetch\(api\('\/api\/keys\/purge-revoked'\), \{ method: 'POST' \}\)/);
  assert.doesNotMatch(app, /agentPath\('\/api\/fleet\/agents/);
  assert.doesNotMatch(app, /agentPath\('\/api\/agent\/name/);
  assert.doesNotMatch(app, /agentPath\('\/api\/keys/);
  assert.match(app, /function fleetManageError\(code, fallback\)/);
  assert.match(app, /fleetManageStatus\(fleetManageError\(data\.error \|\| 'unreachable'/);
  const render = app.slice(app.indexOf('function renderAll('), app.indexOf('// ─── Data fetching'));
  assert.doesNotMatch(render, /fleetManageModal\.remove\(\)/);
  assert.match(app, /settingsModal = root; fleetManageModal = root; actionsModal = settingsPage\.actionsScope/);
  assert.match(app, /composeSettings\(root, \{ settings: oldSettings, fleet: oldFleet, actions: oldActions/);
  assert.match(app, /function renderFleetManage\(data, draft = null\)/);
  assert.match(app, /if \(!draft\) fleetManageModal\.querySelector\('#fleet-self-name'\)\.value = selfName;/);
  assert.match(app, /renderFleetManage\(value\)/);
  assert.match(app, /function setFleetAddBusy\(isBusy\)/);
  assert.match(app, /fleetManageModal\?\.querySelector\('#fleet-test'\)\?\.toggleAttribute\('disabled', isBusy\);/);
  assert.match(app, /function setApiKeyBusy\(isBusy\)/);
  assert.match(app, /function renderCreatedApiKey\(createdKey\)/);
  assert.match(app, /fleetManageModal\._createdKey = createdKey \|\| null/);
  assert.match(app, /function sendApiKeyRequest\(request, name\)/);
  assert.match(app, /function purgeRevokedApiKeys\(\)/);
  assert.match(app, /renderKeyTable\(fleetManageModal\.querySelector\('#api-key-list'\), keys/);
  assert.match(app, /replace_created_key_confirm/);
  // Destructive key and machine actions confirm in the dashboard's own dialog, never the browser prompt.
  assert.doesNotMatch(app, /window\.confirm/);
  assert.match(app, /if \(fleetManageModal\?\._createdKey\?\.name === name\) renderCreatedApiKey\(null\);/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /navigator\.clipboard\.writeText\(key\)/);
  assert.match(app, /id="api-key-admin-warning" hidden/);
  assert.match(app, /finally \{\s*setFleetAddBusy\(false\);\s*\}/);
  assert.match(app, /data-panel="keys" hidden/);
  assert.match(app, /id="fleet-add-key" type="password"/);
  assert.match(app, /id="api-key-scope" role="group"/);

  for (const pack of [en, zh]) {
    assert.equal(typeof pack['fleet_manage.open'], 'string');
    assert.equal(typeof pack['fleet_manage.key_created_once'], 'string');
    assert.equal(typeof pack['fleet_manage.rotate_key'], 'string');
    assert.equal(typeof pack['fleet_manage.revoke_key'], 'string');
    assert.equal(typeof pack['fleet_manage.delete_key'], 'string');
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
  assert.match(app, /id="api-base-url">\$\{esc\(dashboardBaseUrl\(\)\)\}<\/span>/);
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

  // Success statuses auto-dismiss; leaving fleet management clears its status
  // without hiding or removing the shared settings page.
  assert.match(app, /clearTimeout\(fleetManageStatusTimer\)/);
  assert.match(app, /fleetManageStatusTimer = setTimeout\(\(\) => fleetManageStatus\(''\), 5000\);/);
  const fleetClose = app.match(/function closeSettingsModal\(\) \{[^}]*\}/)?.[0];
  assert.ok(fleetClose);
  assert.match(fleetClose, /fleetManageStatus\(''\)/);
  assert.doesNotMatch(fleetClose, /\.hidden\s*=|\.remove\(/);
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

  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  assert.match(app, /from '\.\/i18n\.js\?v=87'/);
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
  const resolver = fs.readFileSync(new URL('../src/lib/metric-resolver.js', import.meta.url).pathname, 'utf8');
  // The remaining weekly metric rejects expired account windows.
  assert.match(resolver, /if \(metricName === 'rate_limit_7d'\)[\s\S]*?const valid = Number\.isFinite\(value\) && !rateLimitWindowExpired\(dimensions, metricName\)/);
});

test('memory tree has a collapse-all/expand-all toggle (#226)', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url).pathname, 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const i18nEn = fs.readFileSync(new URL('../public/i18n/en.json', import.meta.url).pathname, 'utf8');
  const i18nZh = fs.readFileSync(new URL('../public/i18n/zh.json', import.meta.url).pathname, 'utf8');
  assert.match(html, /id="memory-fold"/);
  // Toggle folds every directory at once, or expands everything back.
  assert.match(app, /state\.memory\.collapsed = allCollapsed \? new Set\(\) : new Set\(dirs\)/);
  // Button label tracks whether everything is already collapsed.
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
    assert.equal(observerPageShown(h), false);
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
    assert.equal(observerPageShown(h), false);
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

test('usage and legacy trends paths share tab mapping across local and fleet history', () => {
  for (const prefix of ['', '/fleet/remote']) {
    const paths = [prefix + '/', prefix + '/usage', prefix + '/memory', prefix + '/trends'];
    const expected = ['overview', 'trends', 'memory', 'trends'];
    for (let index = paths.length - 1; index >= 0; index--) assert.equal(tabForPath(paths[index]), expected[index]);
    for (let index = 0; index < paths.length; index++) assert.equal(tabForPath(paths[index]), expected[index]);
    assert.equal(tabForPath(prefix + '/settings'), 'settings');
    assert.equal(tabForPath(prefix + '/observer'), 'observer');
    assert.equal(tabForPath(prefix + '/schedule'), 'schedule');
  }
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const tabs = app.slice(app.indexOf('function initTabs()'), app.indexOf('function initObserverControls()'));
  assert.match(tabs, /window\.addEventListener\('popstate',[\s\S]*?const tab = tabForPath\(path\);/);
  assert.match(tabs, /const initialTab = tabForPath\(window\.location\.pathname\);/);
});
test('unchanged navigation labels stay in the primary language pack', () => {
  const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const tab of ['overview', 'memory', 'observer']) {
    assert.ok(index.includes('data-tab="' + tab + '" data-i18n="tab.' + tab + '"'));
  }
  assert.match(index, /data-tab="trends" data-i18n="wb\.nav\.usage"/);
});

// Workbench shell cases directly import product modules and inject DOM/API stubs.
// Existing legacy cases above retain their old harness and are selected separately.
import { mountWorkbench } from '../public/js/wb/shell.js';
import { createDocument as wbDocument, storage as wbStorage, tick as wbTick, deferred as wbDeferred } from './fixtures/workbench-dom.js';
const wbName = row => row.children[0].children[1].children[0].textContent;
function workbenchSnapshot(kind = 'idle', key = 'a') {
  return { mode: 'multi', view: 'multi',
    rows: [{ sessionGroup: key, name: { displayName: key.toUpperCase() }, state: { kind } }],
    instance: { pool: { used: 1 } } };
}
function workbenchHarness(context, read, options = {}) {
  const document = wbDocument(), listeners = new Map(), windowListeners = new Map();
  const selectors = ['#wb-board', '#wb-search', '#wb-range', '#wb-detail-toggle', '#observer-tab', '#wb-instance', '#wb-attention', '#wb-side', '#wb-auto-name', '#wb-auto-name-dialog', '#tab-overview', '#agent-detail'];
  const nodes = new Map(selectors.map(selector => [selector, document.createElement('div')]));
  nodes.get('#tab-overview').className = 'active'; document.visibilityState = options.hidden ? 'hidden' : 'visible';
  document.querySelector = selector => nodes.get(selector);
  document.addEventListener = (event, handler) => listeners.set(event, handler);
  document.removeEventListener = event => listeners.delete(event);
  let mutation;
  const window = {
    addEventListener: (event, handler) => windowListeners.set(event, handler),
    removeEventListener: event => windowListeners.delete(event),
    MutationObserver: class { constructor(handler) { mutation = handler; } observe() {} disconnect() { mutation = null; } },
  };
  let nextTimer = 0, owner = 'local', navigationGeneration = 0;
  const intervals = new Map(), timeouts = new Map(), calls = [], saved = wbStorage(options.storage);
  context.mock.method(globalThis, 'setInterval', (handler, delay) => { const id = ++nextTimer; intervals.set(id, { handler, delay }); return id; });
  context.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
  context.mock.method(globalThis, 'setTimeout', (handler, delay) => { const id = ++nextTimer; timeouts.set(id, { handler, delay }); return id; });
  context.mock.method(globalThis, 'clearTimeout', id => timeouts.delete(id));
  const makeSnapshot = workbenchSnapshot;
  const fallback = path => path.includes('/api/workbench/groups') ? makeSnapshot() :
    path.includes('/api/workbench/activity') ? { start: 0, cellSeconds: 60, groups: { a: { cells: Array(60).fill('none'), inbound: [] } } } : {};
  const mounted = mountWorkbench({ document, window, storage: saved, t: key => key,
    identity: () => owner, endpoint: path => owner === 'local' ? path : '/fleet/' + owner + path,
    observerStatus: options.observerStatus ?? (() => null), observerAvailable: options.observerAvailable ?? (() => true),
    openSettings: options.openSettings ?? (() => {}),
    writable: options.writable ?? (() => true),
    fetch: async (path, requestOptions) => {
      options.onRequest?.(path, requestOptions);
      calls.push(path);
      const value = read ? await read(path, fallback) : fallback(path);
      return value?.json ? value : { ok: true, json: async () => value };
    } });
  const stop = () => mounted.destroy();
  context.after(stop);
  return { document, nodes, saved, calls, listeners, windowListeners, intervals, timeouts, stop, openGroup: key => mounted.openGroup(key), makeSnapshot,
    poll: delay => { const timer = [...intervals.values()].find(timer => timer.delay === delay); assert.ok(timer, 'expected polling timer'); return timer.handler(); },
    debounce: async () => { const job = [...timeouts.entries()].find(([, timer]) => timer.delay === 300); assert.ok(job, 'search debounce exists'); timeouts.delete(job[0]); await job[1].handler(); },
    setOwner: value => { owner = value; },
    navigate: active => { navigationGeneration++; nodes.get('#tab-overview').className = active ? 'active' : ''; mutation?.(); },
    navigationGeneration: () => navigationGeneration,
    mutate: () => mutation?.(),
  };
}
// Cross-module DOM integration: real shell, board, search and detail modules.
// Run for workbench lifecycle/wiring changes; skip server-only changes. All DOM,
// storage, fetches, timers and observers are injected; no sockets, DB, PM2, tmux
// or children. The runner must isolate HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR
// and a private tmux namespace, verify those paths before running, then clean
// them up. Teardown unmounts and releases every fake lifecycle listener.
test('workbench shell detail changes redraw without network and activity range persists', async context => {
  const h = workbenchHarness(context); await wbTick(); await wbTick();
  const before = h.calls.length, toggle = h.nodes.get('#wb-detail-toggle'); toggle.checked = true; toggle.dispatch('change');
  assert.equal(h.calls.length, before); assert.equal(h.saved.getItem('zylos-dashboard-detail-level'), 'technical');
  const range = h.nodes.get('#wb-range'); range.children.find(button => button.dataset.range === '6h').dispatch('click'); await wbTick();
  assert.equal(h.nodes.get('#wb-range').children.find(button => button.attributes['aria-pressed'] === 'true').dataset.range, '6h');
  assert.equal(h.saved.getItem('zylos-dashboard-activity-range'), '6h'); assert.equal(h.calls.at(-1), '/api/workbench/activity?range=6h');
  h.stop(); assert.equal(h.intervals.size, 0); assert.equal(h.timeouts.size, 0);
});
// Visibility resume and teardown boundary: run for shell lifecycle changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell visibility resumes polling and removes lifecycle listeners', async context => {
  const h = workbenchHarness(context); await wbTick(); const before = h.calls.length;
  h.listeners.get('visibilitychange')(); await wbTick(); assert.ok(h.calls.length > before);
  h.stop(); assert.equal(h.listeners.has('visibilitychange'), false); assert.equal(h.windowListeners.has('popstate'), false);
});
// Polling visibility boundary: run for visibility/tab changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell polls only a visible overview', async context => {
  const h = workbenchHarness(context, null, { hidden: true }); await wbTick();
  const before = h.calls.length;
  await h.poll(5000); assert.equal(h.calls.length, before);
  h.document.visibilityState = 'visible'; await h.poll(5000); await wbTick();
  const shown = h.calls.length; assert.ok(shown > before); assert.equal(h.nodes.get('#wb-board').children.length, 1);
  h.navigate(false); await h.poll(5000); assert.equal(h.calls.length, shown);
  h.navigate(true); await wbTick(); assert.ok(h.calls.length > shown);
});
// Search/snapshot overlay boundary: run for board/search wiring changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell refreshes search row state from the newest snapshot without changing membership', async context => {
  let kind = 'idle';
  const h = workbenchHarness(context, (path, fallback) => {
    if (path.includes('/search?')) return { rows: [workbenchSnapshot('idle').rows[0], workbenchSnapshot('not_running', 'historical').rows[0]] };
    if (path.endsWith('/api/workbench/groups')) return { ...fallback(path), rows: [workbenchSnapshot(kind).rows[0], workbenchSnapshot('idle', 'unmatched').rows[0]] };
    return fallback(path);
  });
  await wbTick(); await wbTick();
  const input = h.nodes.get('#wb-search'); input.value = 'a'; input.dispatch('input'); await h.debounce();
  const board = h.nodes.get('#wb-board'); assert.equal(board.children.length, 2);
  assert.equal(board.children[0].children[1].textContent, 'wb.state.idle');
  kind = 'busy'; await h.poll(5000); await wbTick();
  assert.equal(board.children.length, 2); assert.equal(board.children[0].children[1].textContent, 'wb.state.busy');
  assert.equal(wbName(board.children[1]), 'HISTORICAL'); assert.equal(board.textContent.includes('UNMATCHED'), false);
});
// Agent identity boundary after JSON decoding: run for request/identity changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell discards an agent response whose JSON finishes after the viewed agent changes', async context => {
  const json = wbDeferred(); let jsonStarted = false;
  const h = workbenchHarness(context, (path, fallback) => path === '/api/workbench/groups'
    ? { ok: true, json: () => { jsonStarted = true; return json.promise; } } : fallback(path));
  await wbTick(); assert.equal(jsonStarted, true);
  h.setOwner('Other'); json.resolve(h.makeSnapshot('busy', 'previous-agent')); await wbTick(); await wbTick();
  assert.equal(h.nodes.get('#wb-board').textContent.includes('PREVIOUS-AGENT'), false);
  await h.poll(5000); await wbTick();
  assert.equal(wbName(h.nodes.get('#wb-board').children[0]), 'A');
  assert.ok(h.calls.includes('/fleet/Other/api/workbench/groups'));
});
// Mounted read-failure boundary: run for shell/controller changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell retains and redraws old rows after a snapshot read failure', async context => {
  let failed = false;
  const h = workbenchHarness(context, (path, fallback) => {
    if (failed && path.endsWith('/api/workbench/groups')) throw Error('offline');
    return fallback(path);
  });
  await wbTick(); await wbTick(); const board = h.nodes.get('#wb-board');
  assert.equal(wbName(board.children[0]), 'A'); failed = true;
  await h.poll(5000); await wbTick();
  assert.equal(board.children.length, 1); assert.equal(wbName(board.children[0]), 'A');
  assert.match(h.nodes.get('#wb-attention').textContent, /wb.readFailed/);
  const oldRow = board.children[0], before = h.calls.length;
  assert.equal(oldRow.children.length, 4);
  const toggle = h.nodes.get('#wb-detail-toggle'); toggle.checked = true; toggle.dispatch('change');
  assert.equal(h.calls.length, before);
  assert.notEqual(board.children[0], oldRow);
  assert.equal(board.children.length, 1);
  assert.equal(board.children[0].children.length, 7);
  assert.equal(board.children[0].children[0].textContent, 'Aa');
  assert.equal(board.children[0].children[1].textContent, 'wb.state.idle');
  assert.match(h.nodes.get('#wb-attention').textContent, /wb.readFailed/);
});
// Mode/board timer boundary: run for polling changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell samples session mode on mount and every minute independently of board polling', async context => {
  const h = workbenchHarness(context); await wbTick(); await wbTick();
  const modeReads = () => h.calls.filter(path => path === '/api/session-mode').length;
  assert.equal(modeReads(), 1);
  const beforeGroups = h.calls.filter(path => path === '/api/workbench/groups').length;
  for (let index = 0; index < 3; index++) { await h.poll(5000); await wbTick(); }
  assert.equal(modeReads(), 1); assert.equal(h.calls.filter(path => path === '/api/workbench/groups').length, beforeGroups + 3);
  await h.poll(60000); await wbTick(); assert.equal(modeReads(), 2);
  h.document.visibilityState = 'hidden'; await h.poll(60000); assert.equal(modeReads(), 2);
  h.stop(); assert.equal(h.intervals.size, 0);
});
// Mode failure rendering boundary: run for mode-read/attention changes; skip
// server-only changes. Uses the isolated injected lifecycle and teardown above.
test('workbench shell removes the transition hint after a session mode read failure', async context => {
  let failed = false, modeReads = 0;
  const h = workbenchHarness(context, (path, fallback) => {
    if (path === '/api/session-mode') {
      modeReads++;
      if (failed) throw Error('offline');
      return { data: { transition: { phase: 'draining' } } };
    }
    return fallback(path);
  });
  await wbTick(); await wbTick();
  const attention = h.nodes.get('#wb-attention');
  const hints = () => attention.children.filter(node => node.classList.contains('wb-transition'));
  assert.equal(modeReads, 1);
  assert.equal(hints().length, 1);
  assert.equal(hints()[0].textContent, 'wb.transition · draining');
  failed = true; await h.poll(60000); await wbTick();
  assert.equal(modeReads, 2);
  assert.equal(hints().length, 0);
  assert.equal(attention.textContent.includes('wb.transition'), false);
  assert.equal(wbName(h.nodes.get('#wb-board').children[0]), 'A');
  h.stop(); assert.equal(h.intervals.size, 0);
});
// Same-agent navigation boundary: run for identity/navigation changes; skip server-only changes. Uses the isolated fake lifecycle above.
test('workbench shell navigation preserves the current agent snapshot and search', async context => {
  const h = workbenchHarness(context, (path, fallback) => path.includes('/search?') ? { rows: [workbenchSnapshot('idle').rows[0]] } : fallback(path));
  await wbTick(); await wbTick();
  const search = h.nodes.get('#wb-search'); search.value = 'a'; search.dispatch('input'); await h.debounce();
  const board = h.nodes.get('#wb-board'), before = board.textContent;
  board.children[0].dispatch('click'); assert.equal(h.nodes.get('#wb-side').hidden, false);
  h.navigate(false); assert.equal(search.value, 'a'); assert.equal(board.textContent, before);
  assert.equal(h.nodes.get('#wb-side').hidden, false);
  h.navigate(true); await wbTick(); assert.equal(h.navigationGeneration(), 2);
  assert.equal(search.value, 'a'); assert.equal(board.textContent, before);
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const mount = app.slice(app.lastIndexOf('mountWorkbench('));
  assert.match(mount, /identity: \(\) => state\.remoteAgent \?\? REMOTE_AGENT \?\? 'local'/);
  assert.doesNotMatch(mount, /navigationGeneration/);
});
// Observer visibility and click integration: run when shell/app availability wiring
// changes; skip server-only work. Uses the injected DOM/API/timers above; no live
// resources. The shared teardown unmounts listeners, observers and fake timers.
test('workbench shell hides unknown recovering and unavailable observer navigation and lets a missing observer open its page', async context => {
  let status = null, readOnly = false;
  const settings = [];
  const h = workbenchHarness(context, null, { storage: { 'zylos-dashboard-detail-level': 'technical' },
    observerStatus: () => status,
    observerAvailable: value => !readOnly && !value?.recoveryReason });
  await wbTick(); await wbTick();
  const nav = h.nodes.get('#observer-tab');
  const redraw = () => h.listeners.get('dashboard-locale-change')();
  const click = () => {
    let prevented = 0, stopped = 0;
    nav.dispatch('click', { preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
    return { prevented, stopped };
  };
  assert.equal(nav.hidden, true);
  assert.equal(click().prevented, 1);
  status = { installed: true, enabled: true }; redraw(); assert.equal(nav.hidden, false);
  assert.equal(nav.textContent, 'tab.observer');
  assert.equal(click().prevented, 0);
  readOnly = true; redraw(); assert.equal(nav.hidden, true);
  nav.hidden = false; h.mutate(); assert.equal(nav.hidden, true);
  assert.equal(click().stopped, 1); assert.equal(settings.length, 0);
  readOnly = false; redraw(); assert.equal(nav.hidden, false);
  status = { installed: true, enabled: true, recoveryReason: 'recovering' }; redraw();
  assert.equal(nav.hidden, true);
  nav.hidden = false; h.mutate(); assert.equal(nav.hidden, true);
  assert.equal(click().stopped, 1); assert.equal(settings.length, 0);
  status = { installed: false }; redraw();
  assert.equal(nav.hidden, false); assert.equal(nav.textContent, 'tab.observer'); assert.equal(nav.title, 'wb.observerInstall'); assert.equal(nav.dataset.wbHint, 'wb.observerInstall', 'app.js restores this hint after its Origin lock');
  assert.equal(nav.classList.contains('wb-tab-muted'), true);
  // The observer page itself explains a missing or disabled observer and links to settings.
  assert.equal(click().prevented, 0);
  status = { installed: true, enabled: false }; redraw();
  assert.equal(nav.hidden, false); assert.equal(nav.textContent, 'tab.observer'); assert.equal(nav.title, 'wb.observerDisabled');
  assert.equal(click().prevented, 0); assert.equal(settings.length, 0);
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /observerAvailable: status => !remoteIsReadOnly\(\) && !observerRecoveryReason\(status\)/);
});

// Detail mounting boundary: real shell row selection and injected transport only;
// run for detail/shell wiring, skip backend-only work. The harness owns timers,
// DOM, and fetches, and teardown releases all listeners without live resources.
test('workbench shell opens selected detail and aborts its reads when agent changes', async context => {
  const pending = wbDeferred(), requests = [];
  const h = workbenchHarness(context, (path, fallback) => path.includes('/groups/a/runs')
    ? pending.promise : fallback(path), { onRequest: (path, options) => requests.push({ path, options }) });
  await wbTick(); await wbTick();
  h.nodes.get('#wb-board').children[0].dispatch('click');
  await wbTick();
  assert.equal(h.nodes.get('#wb-side').hidden, false);
  const runRequest = requests.find(item => item.path.includes('/groups/a/runs'));
  assert.ok(runRequest?.options?.signal);
  h.setOwner('Other'); h.mutate();
  assert.equal(runRequest.options.signal.aborted, true);
  assert.equal(h.nodes.get('#wb-side').hidden, true);
  pending.resolve({ runs: [], totalEvents: 901, totalRuns: 30 });
  await wbTick(); await wbTick();
  assert.equal(h.nodes.get('#wb-side').textContent, '');
});
// Auto-name mounting boundary: GET-only prompt and writable gate; injected DOM,
// timers and transport as above, no clipboard write or external message is sent.
test('workbench shell gates automatic naming and discards an old agent prompt', async context => {
  let writable = false;
  const pending = wbDeferred(), requests = [];
  const h = workbenchHarness(context, (path, fallback) => path.endsWith('/name-prompt')
    ? pending.promise : fallback(path), { writable: () => writable,
    onRequest: (path, options) => requests.push({ path, options }) });
  await wbTick(); await wbTick();
  const button = h.nodes.get('#wb-auto-name'), dialog = h.nodes.get('#wb-auto-name-dialog');
  assert.equal(button.disabled, true);
  assert.equal(button.title, 'wb.readOnly');
  button.dispatch('click'); await wbTick();
  assert.equal(requests.some(item => item.path.endsWith('/name-prompt')), false);
  writable = true; h.listeners.get('dashboard-locale-change')();
  assert.equal(button.disabled, false);
  assert.equal(button.title, 'wb.name.autoHint', 'redraw keeps the auto-name explanation as the tooltip');
  button.dispatch('click'); await wbTick();
  const prompt = requests.find(item => item.path.endsWith('/name-prompt'));
  assert.ok(prompt?.options?.signal);
  assert.equal(dialog.hidden, false);
  h.setOwner('Other'); h.mutate();
  assert.equal(prompt.options.signal.aborted, true);
  pending.resolve({ text: 'old private prompt', todo: [] });
  await wbTick(); await wbTick();
  assert.equal(dialog.hidden, true);
  assert.equal(dialog.textContent, '');
  assert.equal(requests.some(item => item.options?.method === 'POST'), false);
});

// Observer entry wiring: the real shell decides per group whether the drawer offers the live terminal.
test('the workbench drawer offers the live terminal for Origin only, never for another running group', async context => {
  const live = (sessionGroup, extra = {}) => ({ sessionGroup, name: { displayName: sessionGroup }, state: { kind: 'busy' }, presence: 'running', live: { runId: 'run-' + sessionGroup, sessionId: 's' }, ...extra });
  const h = workbenchHarness(context, (path, fallback) => {
    if (path.endsWith('/api/workbench/groups')) return { mode: 'multi', view: 'multi', rows: [live('origin', { origin: true }), live('telegram:a')], instance: { pool: { used: 2 } } };
    if (path.includes('/runs')) return { runs: [], totalRuns: 0, totalEvents: 0, unattributed: 0 };
    if (path.includes('/backlog')) return { count: 0, firstAt: null, syncing: false };
    if (path.startsWith('/api/timeline')) return { events: [] };
    return fallback(path);
  }, { storage: { 'zylos-dashboard-detail-level': 'technical' }, observerStatus: () => ({ installed: true, enabled: true }) });
  await wbTick(); await wbTick();
  await h.openGroup('origin'); await wbTick();
  assert.match(h.nodes.get('#wb-side').textContent, /wb\.detail\.observeLive/, 'Origin offers the live terminal');
  await h.openGroup('telegram:a'); await wbTick();
  assert.match(h.nodes.get('#wb-side').textContent, /telegram/);
  assert.doesNotMatch(h.nodes.get('#wb-side').textContent, /wb\.detail\.observe/, 'another group offers no terminal entry');
});

// Programmatic group selection uses the real mounted shell/detail/olderRow;
// run for cross-page selection wiring, skip backend-only changes. The harness
// owns DOM, fetch, timers and observers; no live processes/DB/network are used.
test('workbench shell opens a key outside the snapshot and requests only that group', async context => {
  const key = 'telegram:historic-room';
  const h = workbenchHarness(context, (path, fallback) => {
    if (path.includes('/runs')) return { runs: [], totalRuns: 0, totalEvents: 0, unattributed: 0 };
    if (path.includes('/backlog')) return { count: 0, firstAt: null, syncing: false };
    if (path.startsWith('/api/timeline')) return { events: [] };
    return fallback(path);
  });
  await wbTick(); await wbTick();
  h.calls.length = 0;
  await h.openGroup(key);
  assert.equal(h.nodes.get('#wb-side').hidden, false);
  assert.match(h.nodes.get('#wb-side').textContent, /wb\.platform\.telegram · historic-room/);
  assert.equal(h.calls.length, 3);
  for (const path of h.calls) {
    const url = new URL(path, 'http://fixture');
    if (url.pathname === '/api/timeline') {
      assert.equal(url.searchParams.get('session_group'), key);
      assert.equal(url.searchParams.has('run_id'), false);
    } else assert.ok(url.pathname.startsWith('/api/workbench/groups/' + encodeURIComponent(key) + '/'));
  }
  h.stop(); h.calls.length = 0;
  await h.openGroup('telegram:after-unmount');
  assert.equal(h.calls.length, 0);
});

// Shared drawer ownership: run when host/group selection or Escape changes;
// all transport, DOM, storage and lifecycle resources are injected above.
test('workbench shell releases host ownership before selecting a group so Escape closes the group detail', async context => {
  for (const selection of ['board', 'programmatic']) await context.test(selection, async testContext => {
    const h = workbenchHarness(testContext, (path, fallback) => {
      if (path.includes('/api/workbench/host')) return { current: { cpu_pct: 17 } };
      if (path.includes('/runs')) return { runs: [], totalRuns: 0, totalEvents: 0, unattributed: 0 };
      if (path.includes('/backlog')) return { count: 0, firstAt: null, syncing: false };
      if (path.startsWith('/api/timeline')) return { events: [] };
      return fallback(path);
    });
    await wbTick(); await wbTick();
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    const hostButton = descendants(h.nodes.get('#wb-instance')).find(node => node.id === 'wb-host-open');
    assert.ok(hostButton);
    hostButton.dispatch('click'); await wbTick();
    const side = h.nodes.get('#wb-side');
    assert.ok(side.textContent.includes('wb.host.title'));
    assert.ok(side.textContent.includes('17.0%'));
    if (selection === 'board') h.nodes.get('#wb-board').children[0].dispatch('click');
    else await h.openGroup('a');
    await wbTick(); await wbTick();
    assert.equal(side.hidden, false);
    assert.equal(side.textContent.includes('wb.host.title'), false);
    assert.ok(side.textContent.includes('wb.detail.overview'));
    const groupContent = side.textContent;
    h.nodes.get('#wb-auto-name-dialog').hidden = true;
    const escape = h.listeners.get('keydown');
    assert.equal(typeof escape, 'function');
    // The released host panel no longer owns the drawer: Escape closes the group, never reopens host status.
    escape({ key: 'Escape' });
    assert.equal(side.hidden, true);
    assert.equal(side.textContent.includes('wb.host.title'), false);
    assert.notEqual(groupContent, '');
    h.stop();
    assert.equal(h.listeners.has('keydown'), false);
  });
});

test('browser visibility changes do not refresh conversation pagination', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf("document.addEventListener('visibilitychange', () => {", app.indexOf('function initTabs()'));
  const handler = app.slice(start, app.indexOf("const initialTab", start));
  assert.ok(start > 0);
  assert.doesNotMatch(handler, /refreshChat|chatPage/);
});

test('hidden documents keep conversation initialization enabled', () => {
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function refreshChat()');
  const handler = app.slice(start, app.indexOf('function refreshUsage()', start));
  assert.ok(start > 0);
  assert.doesNotMatch(handler, /visibilityState/);
  assert.match(handler, /activeTabName\(\) === 'chat'.*chatPage\?\.open\(\)/);
});

// Keyboard boundary: run for shell key handling changes; uses the injected harness above.
test('workbench shell moves between board rows with j/k and leaves typing alone', async context => {
  const h = workbenchHarness(context, (path, fallback) => path === '/api/workbench/groups'
    ? { ...fallback(path), rows: [workbenchSnapshot('idle', 'a').rows[0], workbenchSnapshot('busy', 'b').rows[0]] } : fallback(path));
  await wbTick(); await wbTick();
  const key = h.listeners.get('keydown'), rows = h.nodes.get('#wb-board').children;
  key({ key: 'j', target: {} }); assert.equal(rows[0].focused, true);
  h.document.activeElement = rows[0]; key({ key: 'j', target: rows[0] }); assert.equal(rows[1].focused, true);
  h.document.activeElement = rows[1]; key({ key: 'ArrowDown', target: rows[1] }); assert.equal(rows[1].focused, true, 'the last row stays focused');
  rows[0].focused = false; key({ key: 'k', target: { tagName: 'INPUT' } }); assert.equal(rows[0].focused, false, 'typing in a field is not navigation');
  key({ key: 'k', target: rows[1] }); assert.equal(rows[0].focused, true);
});
