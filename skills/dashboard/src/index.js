#!/usr/bin/env node
import { createInstalledVersionReader } from './lib/installed-versions.js';
import { CoreState } from './lib/core-state.js';
import { loadCoreModule } from './lib/core-modules.js';
import { createReadinessCheck } from './lib/readiness.js';
import { bootId, publishHealthProcess } from './lib/health-process.js';
import { createCoalescedBroadcast } from './lib/coalesced-broadcast.js';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { AuthGate, exchangeApiKeyForToken, generateApiKey, hashApiKey, migratePasswordIfNeeded, validateApiSession } from './lib/auth.js';
import { handleChatSettings } from './lib/chat/settings.js';
import { ChatHistory } from './lib/chat/history.js';
import { ChatChangeObserver } from './lib/chat/change-observer.js';
import { handleChatStream } from './lib/chat/stream.js';
import { handleChatHistory } from './lib/chat/history-routes.js';
import { ChatActivity, recordGroupInterrupt, snapshotWorking } from './lib/chat/activity.js';
import { ChatConversations, isChatLocalIdUsed } from './lib/chat/conversations.js';
import { ensureOriginConversation, ORIGIN } from './lib/chat/origin.js';
import { reconcileConversationNames } from './lib/chat/auto-name.js';
import { ChatSender } from './lib/chat/send.js';
import { ChatAnswers } from './lib/chat/answers.js';
import { ChatAnswerDelivery } from './lib/chat/delivery.js';
import { handleChatAnswers } from './lib/chat/answer-routes.js';
import { handleChatConversations } from './lib/chat/write-routes.js';
import { ChatAttachments } from './lib/chat/attachments.js';
import { handleChatAttachments } from './lib/chat/attachment-routes.js';
import { browserBaseFromRequest } from './lib/browser-base.js';
import { mutateConfig } from './lib/config-mutation.js';
import {
  DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS,
  DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES,
  DEFAULT_RUNTIME_MODEL_PRICES,
  ensureDataDirs,
  fastModeMultiplierForRuntime,
  loadConfig,
  modelPricesForRuntime,
  publicDir
} from './lib/config.js';
import { projectEventTimestamps } from './lib/wire-time.js';
import { isRetiredApiPath } from './lib/api-routes.js';
import { readJsonBody, sendHtml, sendJson, sendText, serveStatic } from './lib/http.js';
import { Store } from './lib/store.js';
import { Sanitizer } from './lib/sanitizer.js';
import { CoreLogImporter } from './lib/core-log-importer.js';
import { PM2Collector } from './lib/collectors/pm2-collector.js';
import { SystemCollector } from './lib/collectors/system-collector.js';
import { StatuslineCollector } from './lib/collectors/statusline-collector.js';
import { ConversationCollector } from './lib/collectors/conversation-collector.js';
import { UsageTranscripts } from './lib/collectors/usage-transcripts.js';
import { CodexRolloutCollector } from './lib/collectors/codex-rollout-collector.js';
import { StateEngine } from './lib/state-engine.js';
import { MetricResolver } from './lib/metric-resolver.js';
import { runMetricMaintenance } from './lib/metric-maintenance.js';
import { EventLoopMonitor } from './lib/event-loop-monitor.js';
import { SseHub } from './lib/sse.js';
import { FleetPoller, stateToFleetRecord, fleetStateFromObjects } from './lib/fleet-poller.js';
import { buildSafeFleetPayload } from './lib/fleet-payload.js';
import { FleetProxy } from './lib/fleet-proxy.js';
import { createObserverContainment } from './lib/observer-containment.js';
import { ObserverCoordinator } from './lib/observer-coordinator.js';
import { ObserverControlServer } from './lib/observer-control.js';
import { ObserverInstaller } from './lib/observer-installer.js';
import { createObserverTargets } from './lib/observer-target.js';
import { ObserverManager } from './lib/observer-manager.js';
import { ObserverService } from './lib/observer-service.js';
import { HistoryService } from './lib/history/history-service.js';
import { rejectObserverUpgrade } from './lib/observer-websocket.js';
import { shutdownDashboardTransports } from './lib/dashboard-shutdown.js';
import { MemoryBrowser, memoryErrorPayload } from './lib/memory-browser.js';
import { agentColor } from './lib/agent-color.js';
import { C4Reader } from './lib/c4-reader.js';
import { createDisplayNames } from './lib/workbench/display-names.js';
import { workbenchGroupKey, workbenchGroupDetailKey, workbenchFailure } from './lib/workbench/group-http.js';
import { parseSessionGroup } from '../../comm-bridge/scripts/c4-session-group.js';
import { createRuns } from './lib/workbench/runs.js';
import { createGroupConfig } from './lib/workbench/group-config.js';
import { createGroupBacklog } from './lib/workbench/group-backlog.js';
import { createMemoryBacklog } from './lib/workbench/memory-backlog.js';
import { createOriginBacklog } from './lib/workbench/origin-backlog.js';
import { createGroupActions } from './lib/workbench/group-actions.js';
import { createGroupDeletionRoutes } from './lib/workbench/group-deletion.js';
import { createGroupsApi, groupCounts, projectGroup, projectListRow } from './lib/workbench/groups-api.js';
import { usageSummary, usagePricing } from './lib/workbench/usage-api.js';
import { isSameOriginRequest } from './lib/request-origin.js';
import { usageSeries } from './lib/workbench/usage-series.js';
import { hostSeries } from './lib/workbench/host-series.js';
import { createNamingRequest } from './lib/workbench/naming-request.js';
import { createGroupSnapshot } from './lib/workbench/group-snapshot.js';
import { createScheduleRead, scheduleReadResponse } from './lib/workbench/schedule-read.js';
import { createScheduleWrite } from './lib/workbench/schedule-write.js';
import { createScheduleTz } from './lib/workbench/schedule-tz.js';
import { createInstanceTimezone, handleInstanceTimezone, handleInstanceTimezoneRestart } from './lib/instance-timezone.js';
import { handleAction, getActionsMeta, readCodexRootString } from './lib/actions.js';
import { VersionChecker } from './lib/version-checker.js';
import { isNewerVersion } from './lib/version-utils.js';

const { readConfigStrict } = await loadCoreModule('config-store.js');
const startedAt = new Date();
const MEMORY_WRITE_BODY_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;

let zylosVersion = null;
let ccInstalledVersion = null;
let codexInstalledVersion = null;
const installedVersionReader = createInstalledVersionReader();
async function readInstalledVersions() {
  const versions = await installedVersionReader();
  zylosVersion = versions.zylos;
  ccInstalledVersion = versions.claude;
  codexInstalledVersion = versions.codex;
}
await readInstalledVersions();

async function refreshInstalledVersions() {
  await readInstalledVersions();
  if (coreState?.getState()) {
    scheduleFleetStateBroadcast();
  }
}

const config = loadConfig();
ensureDataDirs(config);
await migratePasswordIfNeeded(config);
// The instance time zone (.env TZ), read on every call; every date and time the Dashboard shows uses it.
const scheduleTz = createScheduleTz({ zylosDir: config.zylosDir });
await scheduleTz();
const instanceTz = () => scheduleTz.current().tz;
const activeRuntime = loadZylosConfig(config.zylosDir).runtime || process.env.ZYLOS_RUNTIME || 'claude';
const isClaudeRuntime = activeRuntime === 'claude';
config.runtime = activeRuntime;

// 1-2. Store
const dbPath = path.join(config.dataDir, 'dashboard.db');
let store;
try {
  store = new Store(dbPath);
} catch (err) {
  console.error(`[dashboard] Failed to open database: ${err.message}`);
  process.exit(1);
}

let publishCoreStateChange = () => {};
const coreState = new CoreState({ zylosDir: config.zylosDir, onChange: state => publishCoreStateChange(state) });
const auth = new AuthGate(config, store);
const memoryBrowser = new MemoryBrowser({ zylosDir: config.zylosDir });
const observerInstaller = new ObserverInstaller({ dataDir: config.dataDir });
const observerTargets = createObserverTargets();
const observerContainment = createObserverContainment({ dataDir: config.dataDir, resolveTarget: observerTargets.resolve });
const observerCoordinator = new ObserverCoordinator({
  configPath: config.configPath,
  installer: observerInstaller,
  teardown: ({ reason }) => observerContainment.stopGeneration({ reason }),
  reconcilePersisted: () => observerContainment.reconcilePersisted(),
  start: ({ generation, binaryPath, observerTarget }) => observerContainment.startGeneration({
    generation,
    binaryPath,
    runtime: observerTarget.runtime,
    observerTarget,
  }),
});
const observerManager = new ObserverManager({
  coordinator: observerCoordinator,
  containment: observerContainment,
  authGate: auth,
  runtime: activeRuntime,
  resolveTarget: observerTargets.resolve,
  sessionMode: observerTargets.mode,
  maxViewers: config.observer.maxViewers,
  leaseTtlMs: config.observer.leaseTtlMs,
  idleGraceMs: config.observer.idleGraceMs,
});
const observerService = new ObserverService({
  coordinator: observerCoordinator,
  containment: observerContainment,
  manager: observerManager,
  authGate: auth,
  config,
});
const observerControl = new ObserverControlServer({
  dataDir: config.dataDir,
  onPreUninstall: () => observerService.preUninstall(),
});
observerService.ensureCoordinatorOwnership = async () => {
  await observerControl.acquire();
  if (observerService._initialized) await observerControl.start();
};

// 3. Sanitizer
const sanitizer = new Sanitizer(config.zylosDir);
const coreLogImporter = new CoreLogImporter({ store, zylosDir: config.zylosDir, sanitizer,
  onImport: event => { scheduleHistoryBroadcast(); conversationCollector?.afterImport(event); },
});

// Event-loop delay observability (#260)
const eventLoopMonitor = new EventLoopMonitor({
  blockWarnMs: config.observability?.event_loop_warn_ms
}).start();

// Core log import owns activity history. Retain old spool files untouched;
// they are not replayed into the new source or automatically deleted.

// 5-6. Collectors
const pm2Collector = new PM2Collector(store, config);
const systemCollector = new SystemCollector(store, config);
const statuslineCollector = new StatuslineCollector(store, config);
const usageTranscripts = new UsageTranscripts(store, config, {
  getSnapshot: at => workbench.getSnapshot(at, { fresh: true }),
  getSnapshotKey: () => coreState.costKey,
});
const conversationCollector = new ConversationCollector(store, config, { transcripts: usageTranscripts });
const codexRolloutCollector = new CodexRolloutCollector(store, config, { transcripts: usageTranscripts });

// Wrap the instance entry points, so timer and initial reads have the same
// attribution, including synchronous continuations after async I/O.
function timeMethod(target, method, name) {
  const original = target[method].bind(target);
  target[method] = (...args) => eventLoopMonitor.runTask(name, () => original(...args));
}
for (const [name, collector] of Object.entries({ pm2: pm2Collector, system: systemCollector,
  statusline: statuslineCollector, conversation: conversationCollector, codexRollout: codexRolloutCollector })) {
  timeMethod(collector, 'collect', `collector.${name}`);
}
timeMethod(coreState, 'refresh', 'core-state.refresh');
timeMethod(coreLogImporter, 'poll', 'core-log.import');

const collectors = { pm2: pm2Collector, system: systemCollector };
if (statuslineCollector) collectors.statusline = statuslineCollector;
if (conversationCollector) collectors.conversation = conversationCollector;
if (codexRolloutCollector) collectors.codexRollout = codexRolloutCollector;

// SSE hub
const sse = new SseHub(15_000, { onClientCountChange: count => coreState.setWatched(count > 0) });
const scheduleHistoryBroadcast = createCoalescedBroadcast(() => eventLoopMonitor.runTask('history.broadcast', () => sse.broadcast('history_changed', {})));
let fleetPollerReady = false; // fleetPoller is declared later (TDZ guard)

const volatilePublicationFields = new Set(['readAt', 'sampledAt', 'sampled_at', 'updated_at', 'duration', 'waitSeconds', 'idleSeconds', 'lastIdleSeconds']);
function publicationKey(value) {
  return JSON.stringify(value, (key, item) => volatilePublicationFields.has(key) ? undefined : item);
}
let lastInstancePublication = null, lastGroupsPublication = null;
async function broadcastFleetState() {
  if (sse.clients.size === 0) return;
  try {
    const [, snapshot] = await Promise.all([coreState.refresh(), workbench.getSnapshot()]);
    const instance = buildInstancePayload();
    const counts = groupCounts(snapshot, { allowUnreadable: true });
    const running = snapshot.rows.map(row => projectGroup(row, snapshot)).filter(row => row.side === 'running').map(projectListRow);
    const instanceKey = publicationKey(instance), groupsKey = publicationKey({ counts, running });
    const instanceChanged = instanceKey !== lastInstancePublication, groupsChanged = groupsKey !== lastGroupsPublication;
    if (instanceChanged) { sse.broadcast('instance', instance); lastInstancePublication = instanceKey; }
    if (groupsChanged) { sse.broadcast('groups', counts); lastGroupsPublication = groupsKey; }
    if ((instanceChanged || groupsChanged) && fleetPollerReady) broadcastFleet(fleetPoller.getFleet());
  } catch (err) {
    process.stderr.write(`[fleet] instance/groups SSE broadcast skipped: ${err.message}\n`);
  }
}
const scheduleFleetStateBroadcast = createCoalescedBroadcast(() => eventLoopMonitor.runTask('fleet.broadcast', broadcastFleetState));
publishCoreStateChange = () => scheduleFleetStateBroadcast();

// 6b. Version checker (polls GitHub + npm registry every 12h)
const versionChecker = new VersionChecker({
  onUpdate: () => {
    if (stateEngine) {
      scheduleFleetStateBroadcast();
    }
  },
});
timeMethod(versionChecker, 'check', 'versions.check-latest');
versionChecker.start();

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.zylosDir, '.claude', 'settings.json'), 'utf8'));
  } catch { return {}; }
}

// Installed versions are cached and refreshed asynchronously by the timer
// and upgrade actions, never by the state broadcast path.
const INSTALLED_VERSIONS_REFRESH_MS = 10 * 60 * 1000;
setInterval(() => eventLoopMonitor.runTask('installed-versions.refresh', readInstalledVersions), INSTALLED_VERSIONS_REFRESH_MS).unref();

function getSystemMetrics() {
  const data = systemCollector.getLatestSystemData();
  const memUsed = data?.mem_used_bytes;
  const memTotal = data?.mem_total_bytes;
  return {
    scope: data?.resource_scope ?? 'host',
    cpu_pct: Number.isFinite(data?.cpu_pct) ? data.cpu_pct : null,
    cpu_count: Number.isFinite(data?.cpu_count) ? data.cpu_count : null,
    cpu_source: data?.cpu_source ?? 'host',
    mem_source: data?.mem_source ?? 'host',
    mem_pct: Number.isFinite(data?.mem_pct) ? data.mem_pct : null,
    mem_used_bytes: Number.isFinite(memUsed) ? memUsed : null,
    mem_total_bytes: Number.isFinite(memTotal) ? memTotal : null,
    disk_pct: Number.isFinite(data?.disk_used_pct) ? data.disk_used_pct : null,
    disk_free_bytes: Number.isFinite(data?.disk_free_bytes) ? data.disk_free_bytes : null,
    disk_total_bytes: Number.isFinite(data?.disk_total_bytes) ? data.disk_total_bytes : null,
    sampledAt: data?.collectedAt ?? null
  };
}

// 7. State engine
const stateEngine = new StateEngine(store, collectors, config, {
  onStateChange: (st) => {
    scheduleFleetStateBroadcast();
  }
});

timeMethod(stateEngine, '_periodicSnapshot', 'state.snapshot');
timeMethod(stateEngine, '_readAMHeartbeat', 'state.heartbeat');

observerService.historyService = new HistoryService({ config, store, stateEngine });

// Wire collector updates to state engine
pm2Collector._onUpdate = (data) => {
  stateEngine.onPM2Update(data);
  workbench.channelRestartCounter.update(data);
};
systemCollector._onUpdate = (data) => {
  stateEngine.onSystemUpdate(data);
  scheduleFleetStateBroadcast();
};
if (conversationCollector) {
  conversationCollector._onEvent = (event) => stateEngine.onEvent(event);
  conversationCollector._onMetric = (metric) => {
    sse.broadcast('metric_update', {
      metric_name: metric.metric_name,
      value: Number(metric.metric_value),
      dimensions: metric.dimensions || null,
      source: metric.source || 'jsonl_usage',
      confidence: metric.confidence || 'actual',
      timestamp: metric.timestamp || new Date().toISOString()
    });
    scheduleFleetStateBroadcast();
  };
}
if (codexRolloutCollector) {
  // Rollout ingestion writes metrics/source health to SQLite. Keep it off the
  // synchronous UI/state broadcast path so transcript backfill cannot block HTTP.
}

// 8. Metric resolver
const metricResolver = new MetricResolver(store, collectors, config);

// 9b. C4 reader (read-only access to comm-bridge DB)
const c4Reader = new C4Reader(config.zylosDir);
const displayNames = createDisplayNames({ store, zylosDir: config.zylosDir, sanitizer });
const workbench = createGroupSnapshot({ zylosDir: config.zylosDir, store, c4Reader, sanitizer, displayNames,
  readConfigRuntime: () => loadZylosConfig(config.zylosDir).runtime ?? null,
  readPm2: () => pm2Collector.getLatestPM2Data(), readSystem: () => systemCollector.getLatestSystemData() });
const instanceTimezone = createInstanceTimezone({ zylosDir: config.zylosDir,
  readTimezone: scheduleTz,
  readPm2: async () => ({ processes: JSON.parse(await pm2Collector._execPm2Jlist()) }) });
const getDetailSnapshot = () => workbench.getCachedSnapshot() ?? workbench.getSnapshot();
const groupRuns = createRuns({ store, getSnapshot: getDetailSnapshot });
const groupConfig = createGroupConfig({ zylosDir: config.zylosDir });
const groupBacklog = createGroupBacklog({ zylosDir: config.zylosDir, c4Reader, getSnapshot: getDetailSnapshot });
const memoryBacklog = createMemoryBacklog({ zylosDir: config.zylosDir, getSnapshot: at => workbench.getSnapshot(at), groupBacklog,
  originBacklog: createOriginBacklog({ zylosDir: config.zylosDir }) });
function recordDashboardInterrupt(record) {
  recordGroupInterrupt(store, record);
}
const groupAction = createGroupActions({ zylosDir: config.zylosDir, config, onInterrupt: recordDashboardInterrupt });
const sendNamingPrompt = createNamingRequest({ zylosDir: config.zylosDir, readMode: () => loadZylosConfig(config.zylosDir).session_mode });

function runtimeOverrideSearchTerm(q) {
  const term = String(q ?? '').trim();
  return !term || term.length > 64 ? { none: true }
    : { term, keyable: /^[A-Za-z0-9_.:-]+$/.test(term) && !term.startsWith('--') };
}
async function runtimeOverridesPage(params) {
  const childEnv = { ...process.env, ZYLOS_DIR: config.zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  async function read(args) {
    const { stdout } = await promisify(execFile)('zylos', ['group', 'overrides', ...args, '--json'], {
      env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    const envelope = JSON.parse(stdout);
    const data = envelope?.data;
    if (envelope?.ok !== true || !Array.isArray(data?.runtime) ||
        data.runtime.some(row => !row || typeof row.sessionGroup !== 'string' || !['claude', 'codex'].includes(row.runtime)) ||
        (data.nextAfter != null && typeof data.nextAfter !== 'string')) throw Error('override_list_failed');
    return data;
  }
  const hasQuery = params.has('q');
  const term = hasQuery ? runtimeOverrideSearchTerm(params.get('q')) : null;
  if (term?.none) return { runtime: [], nextAfter: null };
  const after = params.get('after');
  const cursor = after === null ? [] : ['--after', after];
  const names = await displayNames.listAll();
  const named = row => ({ ...row, name: names.get(row.sessionGroup) ?? null });
  if (!hasQuery) {
    const page = await read(cursor);
    if (!Number.isInteger(page.runtimeTotal) || page.runtimeTotal < 0) throw Error('override_list_failed');
    return { runtimeTotal: page.runtimeTotal, runtime: page.runtime.map(named), nextAfter: page.nextAfter ?? null };
  }
  const hits = (await displayNames.search(term.term, 500)).map(row => row.sessionGroup);
  const hitKeys = new Set(hits);
  const nameRows = after === null && hits.length
    ? (await read(hits.flatMap(key => ['--group', key]))).runtime.sort((a, b) => a.sessionGroup < b.sessionGroup ? -1 : a.sessionGroup > b.sessionGroup ? 1 : 0) : [];
  const page = term.keyable ? await read(['--match', term.term, ...cursor]) : { runtime: [], nextAfter: null };
  return { runtime: [...nameRows, ...page.runtime.filter(row => !hitKeys.has(row.sessionGroup))].map(named),
    nextAfter: page.nextAfter ?? null };
}

function runtimeVersionRecord(runtime) {
  const installed = ({ zylos: zylosVersion, claude: ccInstalledVersion, codex: codexInstalledVersion })[runtime] ?? null;
  const latest = versionChecker.getLatest()[runtime === 'claude' ? 'cc' : runtime] ?? null;
  return { installed, latest, update: installed && latest && isNewerVersion(latest, installed) ? latest : null };
}
function groupRuntimeInfo(row) {
  const runtime = row.runtime ?? row.target?.runtime ?? null;
  const versions = runtimeVersionRecord(runtime);
  const runningVersion = row.runningVersion ?? null;
  const desired = row.desired ? row.desired.mode === 'override' ? row.desired : 'default' : row.target?.model;
  const defaultModel = runtime === 'claude' ? readClaudeSettings().model : runtime === 'codex' ? readCodexRootString('model', config.zylosDir) : null;
  const defaultEffort = runtime === 'claude' ? readClaudeSettings().effortLevel : runtime === 'codex' ? readCodexRootString('model_reasoning_effort', config.zylosDir) : null;
  const model = row.model ?? null, effort = row.effort ?? null;
  const desiredModel = typeof desired === 'object' && desired ? desired.model : defaultModel;
  const desiredEffort = typeof desired === 'object' && desired ? desired.effort : defaultEffort;
  return { runtime, model, effort, runningVersion, installedVersion: versions.installed, update: versions.update,
    pendingRestart: row.side === 'running' && !!((runningVersion && versions.installed && isNewerVersion(versions.installed, runningVersion)) ||
      (row.desired?.runtime && runtime !== row.desired.runtime) || (model && desiredModel && model !== desiredModel) || (effort && desiredEffort && effort !== desiredEffort)) };
}
const groupsApi = createGroupsApi({ workbench, groupConfig, getRuntimeInfo: groupRuntimeInfo });
const scheduleReader = createScheduleRead({ zylosDir: config.zylosDir, scheduleTz, displayNames,
  getSnapshot: () => workbench.getSnapshot() });
const scheduleWriter = createScheduleWrite({ zylosDir: config.zylosDir, scheduleTz });

function buildInstancePayload() {
  const snapshot = workbench.getCachedSnapshot();
  const observed = snapshot?.instance ?? {};
  const zylosConfig = { ...loadZylosConfig(config.zylosDir), zylosDir: config.zylosDir };
  const defaults = Object.fromEntries(['claude', 'codex'].map(runtime => {
    const meta = getActionsMeta({ ...zylosConfig, runtime });
    return [runtime, { model: meta.current_model, effort: meta.current_effort,
      threshold: meta.new_session_threshold, model_thresholds: meta.model_thresholds,
      session_hot_ttl: meta.session_hot_ttl }];
  }));
  const resources = getSystemMetrics();
  return { agent: { ...config.agent, ...agentColor(config.agent?.name) }, tz: instanceTz(),
    session_mode: observed.sessionModeStatus ?? { sessionMode: readFleetSessionMode(), transition: null, globalGate: null, blocked: null, supervisor: 'unknown', lastCompleted: null, lastEvents: [] }, default_runtime: zylosConfig.runtime ?? activeRuntime, defaults,
    versions: Object.fromEntries(['zylos', 'claude', 'codex'].map(runtime => [runtime, runtimeVersionRecord(runtime)])),
    runtimeHealth: observed.runtimeHealth ?? null, accounts: observed.accounts ?? null,
    supervisorPaused: observed.supervisorPaused ?? null, autoRestarts: observed.autoRestarts ?? null,
    resources, services: observed.services ?? null };
}

// HTTP reads and existing coalesced SSE publications share Workbench
// collection, including its 2 s cache and in-flight read. No extra timer is needed.
function readFleetSessionMode() {
  const result = readConfigStrict(path.join(config.zylosDir, '.zylos', 'config.json'));
  if (result.state === 'missing') return 'single';
  if (result.state !== 'ok') return null;
  if (!Object.hasOwn(result.config, 'session_mode')) return 'single';
  return ['single', 'multi'].includes(result.config.session_mode) ? result.config.session_mode : null;
}

async function refreshFleetGroupSummary() {
  try { await workbench.getSnapshot(); } catch { /* Optional observations cannot break the existing state API. */ }
}

function buildSelfFleetRecord(statePayload) {
  if (statePayload === undefined) {
    const snapshot = workbench.getCachedSnapshot() ?? { rows: [], readAt: Date.now(), listKnown: false };
    const rows = snapshot.rows.map(row => projectGroup(row, snapshot));
    statePayload = fleetStateFromObjects(buildInstancePayload(), groupCounts(snapshot, { allowUnreadable: true }),
      usageSummary(store, { tz: instanceTz() }), {
        rows: rows.filter(row => row.side === 'running').map(projectListRow),
        failedRows: rows.filter(row => row.side === 'offline' && row.flags?.startFailed).map(projectListRow),
      });
  }
  return stateToFleetRecord({
    name: config.agent?.name,
    color: agentColor(config.agent?.name)
  }, statePayload, {
    self: true,
    base_url: null
  });
}

function buildFullFleetPayload(remoteFleet = fleetPoller.getFleet(), statePayload) {
  return buildSafeFleetPayload({
    remoteFleet,
    selfRecord: buildSelfFleetRecord(statePayload),
    nowIso: new Date().toISOString()
  });
}

function broadcastFleet(remoteFleet, statePayload) {
  if (sse.clients.size === 0) return;
  try {
    const { payload, redacted } = buildFullFleetPayload(remoteFleet, statePayload);
    sse.broadcast('fleet', payload);
    if (redacted) process.stderr.write('[fleet] SSE broadcast redacted: fleet_secret_leak_guard\n');
  } catch (err) {
    if (err?.code === 'fleet_secret_leak_guard') {
      process.stderr.write('[fleet] SSE broadcast skipped: fleet_secret_leak_guard (redaction insufficient)\n');
      return;
    }
    process.stderr.write(`[fleet] SSE broadcast skipped: ${err.message}\n`);
  }
}

const fleetPoller = new FleetPoller(config, { onPoll: broadcastFleet });
for (const [method, name] of [
  ['pollOnce', 'fleet.poll'], ['_pollAgentAndNotify', 'fleet.fallback-poll'],
  ['_probeAgentLatency', 'fleet.latency-probe'], ['_connectSse', 'fleet.sse-connect'],
  ['_checkSelfHeal', 'fleet.watchdog'],
]) timeMethod(fleetPoller, method, name);
fleetPollerReady = true;
const RESERVED_FLEET_AGENT_NAMES = new Set(['test']);

function normalizeAgentName(value) {
  return String(value || '').trim();
}

function normalizeAgentUrl(value) {
  const raw = String(value || '').trim();
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_url');
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function maskApiKey(value) {
  const key = String(value || '');
  if (!key) return '';
  const suffix = key.slice(-4);
  return key.startsWith('zylos_ak_') ? `zylos_ak_...${suffix}` : `...${suffix}`;
}

function normalizeApiKeyName(value) {
  return String(value || '').trim();
}

function apiKeysPayload() {
  return {
    keys: store.listApiKeys().map(key => ({
      name: key.name,
      scope: key.scope,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
      revoked_at: key.revoked_at,
      status: key.revoked_at ? 'revoked' : 'active'
    }))
  };
}

function apiKeyPayload(key) {
  return {
    name: key.name,
    scope: key.scope,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at,
    status: key.revoked_at ? 'revoked' : 'active'
  };
}

function validateApiKeyName(name) {
  if (!/^[\w.-]{1,64}$/.test(name)) return 'invalid_name';
  if (store.getApiKeyByName(name)) return 'duplicate_name';
  return null;
}

function validateApiKeyScope(scope) {
  return scope === 'read' || scope === 'admin';
}

function isUniqueConstraintError(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE constraint failed: api_keys\.name/.test(String(err?.message || ''));
}

function currentFleetAgents() {
  return Array.isArray(config.fleet?.agents) ? config.fleet.agents : [];
}

function fleetAgentsPayload() {
  return {
    self: { name: config.agent?.name || '' },
    agents: currentFleetAgents().map(agent => ({
      name: agent.name,
      base_url: agent.base_url,
      key_masked: maskApiKey(agent.read_api_key),
      access: fleetPoller.getAgentAccess?.(agent.name) || 'read'
    }))
  };
}

function validateAgentName(name, { allowCurrentSelf = false, currentName = null } = {}) {
  if (!/^[\w.-]{1,32}$/.test(name)) return 'invalid_name';
  if (RESERVED_FLEET_AGENT_NAMES.has(name.toLowerCase())) return 'reserved_name';
  const selfName = config.agent?.name || '';
  if (name === selfName && !(allowCurrentSelf && name === currentName)) return 'duplicate_name';
  if (currentFleetAgents().some(a => a.name === name && a.name !== currentName)) return 'duplicate_name';
  return null;
}

async function persistFleetConfig(mutator) {
  const { config: existing, result } = await mutateConfig(config.configPath, (lockedConfig) => {
    const nextFleet = {
      ...(lockedConfig.fleet || {}),
      agents: Array.isArray(lockedConfig.fleet?.agents)
        ? lockedConfig.fleet.agents.map(a => ({ ...a }))
        : currentFleetAgents().map(a => ({ ...a }))
    };
    const nextAgent = {
      ...(lockedConfig.agent || {}),
      ...(config.agent || {})
    };
    const mutationResult = mutator({ existing: lockedConfig, fleet: nextFleet, agent: nextAgent });
    lockedConfig.fleet = nextFleet;
    lockedConfig.agent = nextAgent;
    return mutationResult;
  });
  const nextFleet = existing.fleet;
  const nextAgent = existing.agent;
  config.fleet = {
    ...(config.fleet || {}),
    ...nextFleet,
    agents: nextFleet.agents.map(a => ({ ...a }))
  };
  config.agent = { ...(config.agent || {}), ...nextAgent };
  return result;
}

async function probeFleetAgent(baseUrl, readApiKey) {
  const controller = new AbortController();
  const timeoutMs = Number(config.fleet?.timeout_ms) || 2500;
  const timer = setTimeout(() => controller.abort(), timeoutMs * 2);
  timer.unref?.();
  try {
    const tokenResp = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readApiKey}` },
      signal: controller.signal
    });
    if (tokenResp.status === 401 || tokenResp.status === 403) return { reachable: false, error: 'auth_failed' };
    if (tokenResp.status === 404) return { reachable: false, error: 'version_unsupported' };
    if (!tokenResp.ok) return { reachable: false, error: 'unreachable' };
    const tokenBody = await tokenResp.json();
    if (!tokenBody?.token) return { reachable: false, error: 'auth_failed' };
    const scope = tokenBody.scope === 'admin' ? 'admin' : 'read';
    const stateResp = await fetch(`${baseUrl}/api/instance`, {
      headers: { Authorization: `Bearer ${tokenBody.token}` },
      signal: controller.signal
    });
    if (stateResp.status === 401 || stateResp.status === 403) return { reachable: false, error: 'auth_failed' };
    if (!stateResp.ok) return { reachable: false, error: 'unreachable', scope };
    const stateBody = await stateResp.json();
    return {
      reachable: true,
      scope,
      version: stateBody?.versions?.zylos?.installed ?? null
    };
  } catch {
    return { reachable: false, error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleFleetAgents(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, fleetAgentsPayload());
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  const name = normalizeAgentName(body.name);
  const nameError = validateAgentName(name);
  if (nameError) {
    sendJson(res, 400, { error: nameError });
    return;
  }
  let baseUrl;
  try {
    baseUrl = normalizeAgentUrl(body.base_url);
  } catch {
    sendJson(res, 400, { error: 'invalid_url' });
    return;
  }
  const readApiKey = String(body.read_api_key || '').trim();
  if (!readApiKey) {
    sendJson(res, 400, { error: 'missing_read_api_key' });
    return;
  }
  const agent = { name, base_url: baseUrl, read_api_key: readApiKey };
  try {
    const probe = await probeFleetAgent(baseUrl, readApiKey);
    const postProbeNameError = validateAgentName(name);
    if (postProbeNameError) {
      sendJson(res, 400, { error: postProbeNameError });
      return;
    }
    await persistFleetConfig(({ fleet }) => {
      if (fleet.agents.some((entry) => entry.name === name)) {
        const error = new Error('duplicate_name');
        error.code = 'duplicate_name';
        throw error;
      }
      fleet.agents.push(agent);
    });
    fleetPoller.addAgent(config.fleet.agents.find(a => a.name === name));
    sendJson(res, 200, {
      ok: true,
      agent: {
        name,
        base_url: baseUrl,
        key_masked: maskApiKey(readApiKey),
        access: probe.reachable ? probe.scope : 'unknown'
      }
    });
  } catch (err) {
    if (err?.code === 'duplicate_name') {
      sendJson(res, 400, { error: 'duplicate_name' });
      return;
    }
    process.stderr.write(`[fleet-config] Failed to save fleet agent: ${err.message}\n`);
    sendJson(res, 500, { error: 'failed_to_save_config' });
  }
}

async function handleFleetAgentTest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  let baseUrl;
  try {
    baseUrl = normalizeAgentUrl(body.base_url);
  } catch {
    sendJson(res, 400, { error: 'invalid_url' });
    return;
  }
  const readApiKey = String(body.read_api_key || '').trim();
  if (!readApiKey) {
    sendJson(res, 400, { error: 'missing_read_api_key' });
    return;
  }
  sendJson(res, 200, await probeFleetAgent(baseUrl, readApiKey));
}

async function handleFleetAgentDelete(req, res, pathname) {
  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const encodedName = pathname.slice('/api/fleet/agents/'.length);
  let name = '';
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    sendJson(res, 400, { error: 'invalid_name' });
    return;
  }
  if (!currentFleetAgents().some(a => a.name === name)) {
    sendJson(res, 404, { error: 'unknown_agent' });
    return;
  }
  try {
    await persistFleetConfig(({ fleet }) => {
      fleet.agents = fleet.agents.filter(a => a.name !== name);
    });
    fleetPoller.removeAgent(name);
    sendJson(res, 200, { ok: true, ...fleetAgentsPayload() });
  } catch (err) {
    process.stderr.write(`[fleet-config] Failed to delete fleet agent: ${err.message}\n`);
    sendJson(res, 500, { error: 'failed_to_save_config' });
  }
}

async function handleAgentRename(req, res) {
  if (req.method !== 'PUT') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, 4096);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  const currentName = config.agent?.name || '';
  const name = normalizeAgentName(body.name);
  const nameError = validateAgentName(name, { allowCurrentSelf: true, currentName });
  if (nameError) {
    sendJson(res, 400, { error: nameError });
    return;
  }
  try {
    await persistFleetConfig(({ agent }) => {
      agent.name = name;
    });
    scheduleFleetStateBroadcast();
    broadcastFleet(fleetPoller.getFleet());
    sendJson(res, 200, { ok: true, self: { name } });
  } catch (err) {
    process.stderr.write(`[fleet-config] Failed to rename local agent: ${err.message}\n`);
    sendJson(res, 500, { error: 'failed_to_save_config' });
  }
}

async function handleApiKeys(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, apiKeysPayload());
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, 4096);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  const name = normalizeApiKeyName(body.name);
  const nameError = validateApiKeyName(name);
  if (nameError) {
    sendJson(res, 400, { error: nameError });
    return;
  }
  const scope = String(body.scope || 'read').trim();
  if (!validateApiKeyScope(scope)) {
    sendJson(res, 400, { error: 'invalid_scope' });
    return;
  }
  const key = generateApiKey();
  try {
    store.insertApiKey({ name, keyHash: hashApiKey(key), scope });
    const created = store.getApiKeyByName(name);
    sendJson(res, 200, {
      ok: true,
      key: apiKeyPayload(created),
      plaintext_key: key,
      ...apiKeysPayload()
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      sendJson(res, 409, { error: 'name_taken' });
      return;
    }
    process.stderr.write(`[api-keys] Failed to create API key: ${err.message}\n`);
    sendJson(res, 500, { error: 'failed_to_save_key' });
  }
}

async function handleApiKeyRotate(req, res, pathname) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const encodedName = pathname.slice('/api/keys/'.length, -'/rotate'.length);
  let name = '';
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    sendJson(res, 400, { error: 'invalid_name' });
    return;
  }
  if (!/^[\w.-]{1,64}$/.test(name)) {
    sendJson(res, 400, { error: 'invalid_name' });
    return;
  }
  const key = generateApiKey();
  const rotated = store.rotateApiKey(name, hashApiKey(key));
  if (!rotated) {
    sendJson(res, 404, { error: 'unknown_key' });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    key: apiKeyPayload(rotated),
    plaintext_key: key,
    ...apiKeysPayload()
  });
}

async function handleApiKeysPurge(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const purged = store.purgeRevokedApiKeys();
  sendJson(res, 200, { ok: true, purged, ...apiKeysPayload() });
}

async function handleApiKeyDelete(req, res, pathname, url) {
  if (req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const encodedName = pathname.slice('/api/keys/'.length);
  let name = '';
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    sendJson(res, 400, { error: 'invalid_name' });
    return;
  }
  if (url.searchParams.get('permanent') === '1') {
    const result = store.hardDeleteApiKey(name);
    if (result.deleted > 0) {
      sendJson(res, 200, { ok: true, deleted: result.deleted, ...apiKeysPayload() });
      return;
    }
    if (result.active) {
      sendJson(res, 409, { error: 'must_revoke_first' });
      return;
    }
    sendJson(res, 404, { error: 'unknown_key' });
    return;
  }
  const result = store.revokeApiKey(name);
  if (result.changes === 0) {
    sendJson(res, 404, { error: 'unknown_key' });
    return;
  }
  sendJson(res, 200, { ok: true, ...apiKeysPayload() });
}

async function runInitialCollectors() {
  try { await pm2Collector.collect(); } catch (err) {
    process.stderr.write(`[startup] PM2 collector initial run failed: ${err.message}\n`);
  }
  try { await systemCollector.warmup(); } catch (err) {
    process.stderr.write(`[startup] System collector warmup failed: ${err.message}\n`);
  }
  if (statuslineCollector) {
    try { await statuslineCollector.collect(); } catch (err) {
      process.stderr.write(`[startup] StatusLine collector initial run failed: ${err.message}\n`);
    }
  }
  if (conversationCollector) {
    try { await conversationCollector.collect(); } catch (err) {
      process.stderr.write(`[startup] Conversation collector initial run failed: ${err.message}\n`);
    }
  }
  if (codexRolloutCollector) {
    try { await codexRolloutCollector.collect(); } catch (err) {
      process.stderr.write(`[startup] Codex rollout collector initial run failed: ${err.message}\n`);
    }
  }
}

async function startupSequence({ initialCollectors = true } = {}) {
  if (initialCollectors) await runInitialCollectors();

  // State engine initialize (snapshot restore + replay)
  await stateEngine.initialize();
  await coreState.start();
}

function loadZylosConfig(zylosDir, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'));
  } catch {
    return fallback;
  }
}

const checkReadiness = createReadinessCheck();

async function handleApi(req, res, pathname, url) {
  if (pathname === '/api/health' || pathname === '/api/health/ready') {
    if (pathname === '/api/health' && url.searchParams.has('probe')) { sendJson(res, 404, { error: 'not_found' }); return true; }
    if (pathname === '/api/health/ready') {
      const readiness = await checkReadiness();
      sendJson(res, readiness.ready ? 200 : 503, readiness);
      return true;
    }
    const details = auth.resolveAuthContext(req, { touch: false });
    res.setHeader('Vary', 'Cookie, Authorization');
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      bootId,
      ...(details ? {
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        event_loop: eventLoopMonitor.snapshot(),
        source: stateEngine.getSourceHealth()
      } : {})
    });
    return true;
  }

  if (pathname === '/api/instance') {
    await Promise.all([coreState.refresh(), workbench.getSnapshot(), scheduleTz()]);
    sendJson(res, 200, buildInstancePayload());
    return true;
  }
  if (pathname === '/api/groups/counts' || pathname === '/api/groups/running' || pathname === '/api/groups/offline' || pathname === '/api/groups/search' || pathname === '/api/groups/activity') {
    try {
      const operation = pathname.split('/').at(-1);
      sendJson(res, 200, await groupsApi[operation](url.searchParams));
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }
  const usageRoute = pathname.match(/^\/api\/groups\/([^/]+)\/usage$/);
  if (pathname === '/api/usage/summary' || usageRoute) {
    try { sendJson(res, 200, usageSummary(store, { tz: (await scheduleTz()).tz,
      ...(usageRoute ? { group: await groupsApi.readKey(workbenchGroupDetailKey(usageRoute[1])) } : {}) })); }
    catch (error) { workbenchFailure(res, error); }
    return true;
  }
  const restartRoute = pathname.match(/^\/api\/groups\/([^/]+)\/restarts\/([^/]+)$/);
  if (restartRoute) {
    try {
      const key = await groupsApi.readKey(workbenchGroupDetailKey(restartRoute[1]));
      const requestId = restartRoute[2];
      if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw Object.assign(new Error('Invalid request ID'), { code: 'INVALID_REQUEST_ID', statusCode: 400 });
      const { lookupRestartRequest } = await loadCoreModule('am-sock-client.js');
      const completion = await lookupRestartRequest(requestId, { deadlineAt: Date.now() + 10000, sessionGroup: key });
      await workbench.getSnapshot(undefined, { fresh: true });
      const row = await groupsApi.detail(key, { include: [] });
      sendJson(res, 200, { requestId, completion: completion === 'deadline_exceeded' ? 'unknown' : completion,
        group: { id: key, runId: row.runId ?? row.run?.runId ?? null, sessionId: row.sessionId ?? row.run?.sessionId ?? null,
          ready: row.presence === 'running' && row.live?.status?.valid === true, state: row.state } });
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }
  if (pathname === '/api/fleet') {
    try {
      // Remote records arrive through the existing poller/SSE lifecycle. A slow
      // or unreachable remote must not delay a local Fleet response.
      await Promise.all([coreState.refresh(), refreshFleetGroupSummary()]);
      sendJson(res, 200, buildFullFleetPayload().payload);
    } catch (err) {
      sendJson(res, 500, { error: err.code || err.message });
    }
    return true;
  }

  const groupEvents = pathname.match(/^\/api\/groups\/([^/]+)\/events$/);
  if (groupEvents) {
    const key = await groupsApi.readKey(workbenchGroupDetailKey(groupEvents[1]));
    const since = url.searchParams.get('since') || undefined;
    const until = url.searchParams.get('until') || undefined;
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const sessionId = url.searchParams.get('session_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
    const sessionGroup = key === 'origin' && readFleetSessionMode() === 'single' ? null : key;
    const runId = url.searchParams.get('run_id') || undefined;
    const runtime = url.searchParams.get('runtime') || undefined;
    const afterSeq = Number(url.searchParams.get('after_seq'));
    const events = await coreLogImporter.sanitizeEvents(store.queryEvents({ since, until, types, sessionId,
      sessionGroup, includeLegacyOrigin: key === 'origin' && readFleetSessionMode() === 'single', runId, runtime, afterSeq, limit: Math.min(1000, limit), offset, order }));
    const stream = url.searchParams.get('stream') || undefined;
    const gapLimit = parseInt(url.searchParams.get('gap_limit') || '100', 10);
    const gapOffset = parseInt(url.searchParams.get('gap_offset') || '0', 10);
    const gaps = await coreLogImporter.sanitizeEvents(store.getHistoryDiagnostics({
      sessionGroup, includeLegacyOrigin: key === 'origin' && readFleetSessionMode() === 'single', stream, limit: gapLimit, offset: gapOffset }));
    sendJson(res, 200, { events, count: events.length, gaps });
    return true;
  }

  if (pathname === '/api/memory/backlog') {
    try { sendJson(res, 200, await memoryBacklog()); }
    catch { sendJson(res, 503, { error: 'backlog_failed' }); }
    return true;
  }

  if (pathname === '/api/usage/series' || pathname === '/api/instance/resources') {
    try {
      const range = url.searchParams.get('range') || undefined;
      const tz = pathname === '/api/usage/series' ? (await scheduleTz()).tz : null;
      const data = pathname === '/api/usage/series'
        ? usageSeries(store, c4Reader, { range, tz,
            since: url.searchParams.get('since'), until: url.searchParams.get('until') })
        : hostSeries(store, { range, pm2Data: pm2Collector.getLatestPM2Data() });
      sendJson(res, 200, data);
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }

  // Reserved for the POST that sends the naming prompt to Origin: a read is neither a prompt nor a group detail.
  if (pathname === '/api/groups/naming-prompt') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  if (pathname === '/api/groups/runtime-overrides') {
    try { sendJson(res, 200, await runtimeOverridesPage(url.searchParams)); }
    catch { sendJson(res, 502, { error: 'override_list_failed' }); }
    return true;
  }

  if (pathname === '/api/usage/pricing') {
    try { sendJson(res, 200, usagePricing(store, { tz: (await scheduleTz()).tz })); }
    catch (error) { workbenchFailure(res, error); }
    return true;
  }

  const groupDetail = pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupDetail) {
    try { sendJson(res, 200, await groupsApi.detail(workbenchGroupDetailKey(groupDetail[1]), { include: url.searchParams })); }
    catch (error) { workbenchFailure(res, error); }
    return true;
  }

  const detailRead = pathname.match(/^\/api\/groups\/([^/]+)\/(runs|messages|backlog)$/);
  if (detailRead) {
    try {
      const key = await groupsApi.readKey(workbenchGroupDetailKey(detailRead[1]));
      let data;
      switch (detailRead[2]) {
        case 'runs':
          data = await groupRuns(key, {
            before: url.searchParams.get('before') ?? undefined,
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 3,
            types: url.searchParams.get('types')?.split(',').filter(Boolean) || undefined,
          });
          break;
        case 'messages':
          data = { messages: c4Reader.getGroupMessages(key === 'origin' &&
            (await getDetailSnapshot()).view === 'single' ? null : key, {
            since: url.searchParams.get('since') ?? 0,
            until: url.searchParams.get('until') ?? Date.now(),
          }) };
          break;
        case 'backlog': data = await groupBacklog(key); break;
      }
      sendJson(res, 200, data);
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }

  if (pathname === '/api/schedules' || pathname.startsWith('/api/schedules/')) {
    try {
      const value = await scheduleReadResponse(scheduleReader, pathname, url.searchParams);
      if (value === undefined) return false;
      sendJson(res, 200, value);
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? error.code : 'internal_error' });
    }
    return true;
  }

  if (pathname === '/api/instance/runtime-options') {
    const selectedRuntime = url.searchParams.get('runtime') ?? activeRuntime;
    if (!['claude', 'codex'].includes(selectedRuntime)) {
      sendJson(res, 400, { error: 'INVALID_RUNTIME' }); return true;
    }
    const zylosConfig = loadZylosConfig(config.zylosDir);
    zylosConfig.zylosDir = config.zylosDir;
    zylosConfig.runtime = selectedRuntime;
    zylosConfig.thresholdModel = url.searchParams.get('model');
    const meta = getActionsMeta(zylosConfig);
    meta.zylos_version = zylosVersion;
    meta.runtime_cli = selectedRuntime;
    meta.cc_version = selectedRuntime === 'codex'
      ? codexInstalledVersion || null
      : ccInstalledVersion || null;
    sendJson(res, 200, meta);
    return true;
  }

  if (pathname === '/api/stream') {
    await Promise.all([coreState.refresh(), refreshFleetGroupSummary()]);
    const initialCounts = groupCounts(await workbench.getSnapshot(), { allowUnreadable: true });
    const initialInstance = buildInstancePayload();
    const apiToken = req._apiToken;
    const validator = apiToken ? () => !!validateApiSession(apiToken) : null;
    sse.addClient(res, validator);
    res.write(`event: instance\ndata: ${JSON.stringify(projectEventTimestamps('instance', initialInstance))}\n\n`);
    res.write(`event: groups\ndata: ${JSON.stringify(projectEventTimestamps('groups', initialCounts))}\n\n`);
    return true;
  }

  return false;
}


function builtInModelsForRuntime(runtime) {
  return Object.keys(DEFAULT_RUNTIME_MODEL_PRICES[runtime === 'codex' ? 'codex' : 'claude'] || {});
}

function builtInServiceTierModelsForRuntime(runtime, serviceTier) {
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  return Object.keys(DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES[rt]?.[serviceTier] || {});
}

function supportsFastMode(runtime) {
  return runtime === 'claude' || runtime === 'codex';
}

function settingsPayload(runtime) {
  const priceRuntime = runtime === 'codex' ? 'codex' : 'claude';
  const fastModeAvailable = supportsFastMode(priceRuntime);
  const fastModeMultiplier = priceRuntime === 'claude' ? fastModeMultiplierForRuntime(config, priceRuntime) : null;
  return {
    runtime: priceRuntime,
    builtInModels: builtInModelsForRuntime(priceRuntime),
    builtInPriorityModels: builtInServiceTierModelsForRuntime(priceRuntime, 'priority'),
    modelPrices: modelPricesForRuntime(config, priceRuntime),
    priorityModelPrices: priceRuntime === 'codex' ? modelPricesForRuntime(config, priceRuntime, 'priority') : null,
    runtimeModelPrices: config.runtimeModelPrices,
    runtimeServiceTierModelPrices: config.runtimeServiceTierModelPrices,
    fastMode: {
      available: fastModeAvailable,
      mode: priceRuntime === 'codex' ? 'service_tier' : 'multiplier',
      serviceTier: priceRuntime === 'codex' ? 'priority' : null,
      multiplier: fastModeMultiplier,
      configuredMultiplier: config.configuredRuntimeFastModeMultipliers?.[priceRuntime] ?? null
    },
    fastModeMultiplier
  };
}

function validateModelPrices(modelPrices, runtime, requiredModels = builtInModelsForRuntime(runtime)) {
  const errors = [];
  if (typeof modelPrices !== 'object' || modelPrices === null || Array.isArray(modelPrices)) {
    errors.push('modelPrices must be an object');
    return errors;
  }
  for (const builtIn of requiredModels) {
    if (!(builtIn in modelPrices)) {
      errors.push(`Cannot remove built-in model: ${builtIn}`);
    }
  }
  for (const [prefix, prices] of Object.entries(modelPrices)) {
    if (!prefix || typeof prefix !== 'string') {
      errors.push('Model prefix must be a non-empty string');
      continue;
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheCreation']) {
      const v = prices?.[field];
      if (v == null || typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        errors.push(`${prefix}.${field} must be a finite number >= 0`);
      }
    }
    if (prices?.longContext !== undefined) {
      const long = prices.longContext;
      if (!long || typeof long !== 'object' || Array.isArray(long)) {
        errors.push(`${prefix}.longContext must be an object`);
      } else {
        if (!Number.isFinite(long.inputTokenThreshold) || long.inputTokenThreshold <= 0) {
          errors.push(`${prefix}.longContext.inputTokenThreshold must be a finite number > 0`);
        }
        for (const field of ['input', 'output', 'cacheRead', 'cacheCreation']) {
          if (!Number.isFinite(long[field]) || long[field] < 0) {
            errors.push(`${prefix}.longContext.${field} must be a finite number >= 0`);
          }
        }
      }
    }
    if (prices?.fastModeMultiplier !== undefined &&
        (!Number.isFinite(prices.fastModeMultiplier) || prices.fastModeMultiplier <= 0)) {
      errors.push(`${prefix}.fastModeMultiplier must be a finite number > 0`);
    }
  }
  return errors;
}

function allSettingsPayload() {
  return { active: activeRuntime, runtimes: { claude: settingsPayload('claude'), codex: settingsPayload('codex') } };
}

function validateRuntimeSettings(body, runtime) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Runtime settings must be an object'];
  const unknown = Object.keys(body).filter(key => !['modelPrices', 'priorityModelPrices', 'fastModeMultiplier'].includes(key));
  if (unknown.length) errors.push(`Unknown keys not allowed: ${unknown.join(', ')}`);
  if (body.modelPrices !== undefined) errors.push(...validateModelPrices(body.modelPrices, runtime));
  if (body.priorityModelPrices !== undefined) {
    if (runtime !== 'codex') errors.push(`priorityModelPrices is not supported for ${runtime} runtime`);
    else errors.push(...validateModelPrices(body.priorityModelPrices, runtime, builtInServiceTierModelsForRuntime(runtime, 'priority')));
  }
  if (body.fastModeMultiplier !== undefined) {
    if (runtime !== 'claude') errors.push(`fastModeMultiplier is not supported for ${runtime} runtime`);
    else if (body.fastModeMultiplier !== null && (!Number.isFinite(body.fastModeMultiplier) || body.fastModeMultiplier <= 0)) {
      errors.push('fastModeMultiplier must be null or a finite number > 0');
    }
  }
  return errors;
}

async function handleSettingsUpdate(req, res) {
  let body;
  try { body = await readJsonBody(req, 16 * 1024); }
  catch (err) { sendJson(res, err.status || 400, { error: err.message }); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Request body must be a JSON object' }); return;
  }
  const multiple = Object.hasOwn(body, 'runtimes');
  if (!multiple) { sendJson(res, 400, { error: { code: 'invalid_pricing', message: 'runtimes must be an object' } }); return; }
  const errors = [];
  let updates;
  if (multiple) {
    const unknown = Object.keys(body).filter(key => key !== 'runtimes');
    if (unknown.length) errors.push(`Unknown keys not allowed: ${unknown.join(', ')}`);
    if (!body.runtimes || typeof body.runtimes !== 'object' || Array.isArray(body.runtimes)) {
      errors.push('runtimes must be an object'); updates = {};
    } else {
      updates = body.runtimes;
      for (const runtime of Object.keys(updates)) {
        if (!['claude', 'codex'].includes(runtime)) errors.push(`Unknown keys not allowed: ${runtime}`);
      }
    }
  } else updates = {};
  for (const [runtime, patch] of Object.entries(updates)) errors.push(...validateRuntimeSettings(patch, runtime));
  if (errors.length) { sendJson(res, 400, { error: errors.join('; ') }); return; }

  try {
    await mutateConfig(config.configPath, existing => {
      for (const [runtime, patch] of Object.entries(updates)) {
        if (patch.modelPrices !== undefined) {
          existing.runtimeModelPrices = { ...(existing.runtimeModelPrices || {}), [runtime]: patch.modelPrices };
          if (runtime === 'claude') existing.modelPrices = patch.modelPrices;
        }
        if (patch.fastModeMultiplier !== undefined) {
          existing.runtimeFastModeMultipliers = { ...(existing.runtimeFastModeMultipliers || {}), claude: patch.fastModeMultiplier };
          existing.fastModeMultiplier = patch.fastModeMultiplier;
          if (patch.fastModeMultiplier === null) {
            delete existing.runtimeFastModeMultipliers.claude;
            delete existing.fastModeMultiplier;
          }
        }
        if (patch.priorityModelPrices !== undefined) {
          existing.runtimeServiceTierModelPrices = { ...(existing.runtimeServiceTierModelPrices || {}),
            codex: { ...(existing.runtimeServiceTierModelPrices?.codex || {}), priority: patch.priorityModelPrices } };
        }
      }
    });
    for (const [runtime, patch] of Object.entries(updates)) {
      if (patch.modelPrices !== undefined) {
        config.runtimeModelPrices = { ...(config.runtimeModelPrices || {}), [runtime]: patch.modelPrices };
        config.modelPrices = config.runtimeModelPrices.claude;
      }
      if (patch.fastModeMultiplier !== undefined) {
        config.runtimeFastModeMultipliers = { ...(config.runtimeFastModeMultipliers || {}),
          claude: patch.fastModeMultiplier ?? DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS.claude };
        config.configuredRuntimeFastModeMultipliers = { ...(config.configuredRuntimeFastModeMultipliers || {}) };
        if (patch.fastModeMultiplier === null) delete config.configuredRuntimeFastModeMultipliers.claude;
        else config.configuredRuntimeFastModeMultipliers.claude = patch.fastModeMultiplier;
        config.fastModeMultiplier = config.runtimeFastModeMultipliers.claude;
      }
      if (patch.priorityModelPrices !== undefined) {
        config.runtimeServiceTierModelPrices = { ...(config.runtimeServiceTierModelPrices || {}),
          codex: { ...(config.runtimeServiceTierModelPrices?.codex || {}), priority: patch.priorityModelPrices } };
      }
    }
    sendJson(res, 200, { ok: true, ...allSettingsPayload() });
  } catch (err) { sendJson(res, 500, { error: `Failed to save settings: ${err.message}` }); }
}

async function handleMemoryApi(req, res, pathname, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'PUT' && pathname === '/api/memory/file')) {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  try {
    if (req.method === 'PUT' && pathname === '/api/memory/file') {
      const body = await readJsonBody(req, MEMORY_WRITE_BODY_MAX_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'invalid_memory_write' });
        return true;
      }
      sendJson(res, 200, await memoryBrowser.writeFile(url.searchParams.get('path') || '', body));
      return true;
    }
    if (pathname === '/api/memory/tree') {
      const tree = await memoryBrowser.tree();
      const names = displayNames.listAll();
      const groupRoot = tree.root.children.find(node => node.path === 'session-groups' && node.type === 'directory');
      const sessionGroups = (groupRoot?.children ?? [])
        .filter(node => node.type === 'directory' && parseSessionGroup(node.name) !== null)
        .map(node => ({ sessionGroup: node.name, displayName: names.get(node.name)?.displayName ?? null }));
      sendJson(res, 200, { ...tree, sessionGroups });
      return true;
    }
    if (pathname === '/api/memory/file') {
      sendJson(res, 200, await memoryBrowser.file(url.searchParams.get('path') || ''));
      return true;
    }
    if (pathname === '/api/memory/git') {
      sendJson(res, 200, await memoryBrowser.git(url.searchParams.get('path') || ''));
      return true;
    }
    return false;
  } catch (err) {
    const payload = memoryErrorPayload(err);
    if (!err?.memoryBrowserError && err?.status && (err.message === 'invalid_json' || err.message === 'payload_too_large')) {
      sendJson(res, err.status, { error: err.message });
      return true;
    }
    sendJson(res, payload.status, payload.body);
    return true;
  }
}

export function createServer() {
  const conversations = new ChatConversations({ store, isUsed: localId => isChatLocalIdUsed(c4Reader, localId) });
  ensureOriginConversation(store.db);
  const groupDeletionRoutes = createGroupDeletionRoutes({ auth, config, conversations });
  const attachments = new ChatAttachments({ store, c4Reader, zylosDir: config.zylosDir });
  const sender = new ChatSender({ conversations, c4Reader, zylosDir: config.zylosDir, attachments });
  const answers = new ChatAnswers({ store });
  const answerDelivery = new ChatAnswerDelivery({ answers, sender, c4Reader });
  const answersReady = answerDelivery.recover().catch(() => {
    console.error('[chat] Answer delivery recovery remains pending.');
  });
  const history = new ChatHistory({ c4Reader, conversations, attachments });
  // The conversation page's live area reads the same group row as its header, so both agree on whether it works.
  const chatActivity = new ChatActivity({ history, store, working: snapshotWorking(workbench, { origin: ORIGIN }) });
  const chatObserver = new ChatChangeObserver({ c4Reader, history });
  timeMethod(chatObserver, '_sample', 'chat.observe');
  const rootDir = publicDir();
  const fleetProxy = new FleetProxy({ config, rootDir, poller: fleetPoller, authGate: auth });

  function renderIndex(req, res) {
    const browserBase = browserBaseFromRequest(req);
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8')
      .replaceAll('__BASE_PATH__', browserBase)
      .replaceAll('__ASSET_ROOT__', browserBase ? `${browserBase}/_assets` : '/_assets')
      .replaceAll('__REMOTE_ACCESS__', 'admin');
    sendHtml(res, 200, html);
  }

  const server = http.createServer(async (req, res) => {
    try {
    // Enforce at header emission so upstream Fleet headers cannot override it.
    const writeHead = res.writeHead;
    res.writeHead = function (statusCode, ...args) {
      const index = typeof args[0] === 'string' ? 1 : 0;
      const headers = args[index];
      if (headers && !Array.isArray(headers)) {
        args[index] = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-robots-tag'));
      }
      this.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return writeHead.call(this, statusCode, ...args);
    };
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    let pathname = url.pathname;
    res.apiPath = pathname;
    res.apiWrite = pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

    if (pathname === '/robots.txt') {
      sendText(res, 200, 'User-agent: *\nDisallow: /\n');
      return;
    }

    if (await auth.handle(req, res, url)) {
      return;
    }

    if (isRetiredApiPath(pathname)) { sendJson(res, 404, { error: 'not_found' }); return; }
    if ((pathname.startsWith('/api/') || pathname.startsWith('/fleet/')) && pathname !== '/api/auth/token' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const context = auth.resolveAuthContext(req);
      if (auth.enabled && context?.scope !== 'admin') { sendJson(res, 403, { error: 'insufficient_scope', required: 'admin' }); return; }
      if (context?.kind === 'cookie' && !isSameOriginRequest(req)) { sendJson(res, 403, { error: 'same_origin_required' }); return; }
    }

    if (pathname === '/api/auth/token' && req.method === 'POST') {
      const bearer = req.headers.authorization;
      if (!bearer || !bearer.startsWith('Bearer zylos_ak_')) {
        sendJson(res, 401, { error: 'invalid_api_key' });
        return;
      }
      const result = exchangeApiKeyForToken(bearer.slice(7));
      if (!result) {
        sendJson(res, 401, { error: 'invalid_api_key' });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (await handleChatSettings(req, res, url, { auth, config, onChange: () => {
      observerService.closeRemoteAccess();
      publishCoreStateChange();
    } })) return;
    if (await handleChatAttachments(req, res, url, { auth, config, sender, attachments,
      readMode: () => loadZylosConfig(config.zylosDir).session_mode })) return;
    if (pathname.startsWith('/api/chat/conversations/')) {
      await answersReady;
      if (await handleChatAnswers(req, res, url, { auth, config, answers, delivery: answerDelivery, sender,
        readMode: () => loadZylosConfig(config.zylosDir).session_mode })) return;
    }
    if (await groupDeletionRoutes(req, res, url)) return;
    if (await handleChatConversations(req, res, url, { auth, config, conversations, sender,
      readMode: () => loadZylosConfig(config.zylosDir).session_mode })) return;
    if (await handleChatHistory(req, res, url, { auth, config, history, activity: chatActivity, instanceTz: scheduleTz })) return;

    if (await observerService.handle(req, res, url)) {
      return;
    }

    if (pathname.startsWith('/fleet/')) {
      await fleetProxy.handle(req, res, url);
      return;
    }

    if (pathname === '/api/stream') {
      if (handleChatStream(req, res, url, { auth, config, hub: sse, observer: chatObserver })) return;
      try { await handleApi(req, res, pathname, url); }
      catch (error) { workbenchFailure(res, error); }
      return;
    }

    if (await handleInstanceTimezone(req, res, url, { auth, timezone: instanceTimezone })) return;
    if (await handleInstanceTimezoneRestart(req, res, url, { auth, timezone: instanceTimezone,
      runAction: body => handleAction('restart-timezone-services', body, { zylosDir: config.zylosDir }, { timezone: instanceTimezone }) })) return;

    const instanceAction = pathname.match(/^\/api\/instance\/actions\/(switch-mode|switch-runtime|upgrade|upgrade-runtime)$/);
    if ((instanceAction && req.method === 'POST') || (pathname === '/api/instance/defaults' && req.method === 'PUT')) {
      try {
        const body = await readJsonBody(req, 4096, { allowEmpty: Boolean(instanceAction) });
        const action = instanceAction ? ({ upgrade: 'upgrade-zylos', 'upgrade-runtime': 'upgrade-cc' }[instanceAction[1]] ?? instanceAction[1])
          : ({ model: 'switch-model', effort: 'switch-effort', threshold: 'set-threshold', 'session-hot-ttl': 'set-session-hot-ttl' }[body?.kind]);
        if (!action) { sendJson(res, 400, { ok: false, error: { code: 'INVALID_DEFAULT', message: 'Choose model, effort, threshold or session-hot-ttl' } }); return; }
        const result = await handleAction(action, body, { ...loadZylosConfig(config.zylosDir), zylosDir: config.zylosDir });
        if (result.ok && ['upgrade-cc', 'upgrade-zylos'].includes(action)) eventLoopMonitor.runTask('installed-versions.refresh', refreshInstalledVersions);
        sendJson(res, result.status ?? 200, result);
        if (result.ok) scheduleFleetStateBroadcast();
      } catch (error) { workbenchFailure(res, error); }
      return;
    }

    if (pathname === '/api/settings/pricing' && req.method === 'GET') {
      sendJson(res, 200, allSettingsPayload());
      return;
    }

    if (pathname === '/api/settings/pricing' && req.method === 'PUT') {
      await handleSettingsUpdate(req, res);
      return;
    }

    if (pathname === '/api/fleet/agents/test') {
      await handleFleetAgentTest(req, res);
      return;
    }

    if (pathname === '/api/fleet/agents') {
      await handleFleetAgents(req, res);
      return;
    }

    if (pathname.startsWith('/api/fleet/agents/')) {
      await handleFleetAgentDelete(req, res, pathname);
      return;
    }

    const detailWrite = pathname.match(/^\/api\/groups\/([^/]+)\/(config|actions\/(interrupt|chop-chop|restart))$/);
    if (detailWrite && req.method === (detailWrite[2] === 'config' ? 'PUT' : 'POST')) {
      try {
        const key = workbenchGroupKey(detailWrite[1]);
        const body = await readJsonBody(req, 4096);
        const result = detailWrite[2] === 'config'
          ? await groupConfig.submit(key, body)
          : await groupAction(key, detailWrite[3], body);
        sendJson(res, 200, result);
        if (result.ok) scheduleFleetStateBroadcast();
      } catch (error) { workbenchFailure(res, error); }
      return;
    }

    // Automatic naming hands its prompt to Origin; the answer is whether C4 queued it, not the naming result.
    if (pathname === '/api/groups/naming-prompt' && req.method === 'POST') {
      try { sendJson(res, 200, await sendNamingPrompt()); }
      catch (error) { workbenchFailure(res, error); }
      return;
    }

    const groupNameRoute = pathname.match(/^\/api\/groups\/([^/]+)\/name$/);
    if (groupNameRoute && ['PUT', 'DELETE'].includes(req.method)) {
      try {
        let key;
        try { key = decodeURIComponent(groupNameRoute[1]); }
        catch { throw Object.assign(new Error('Invalid session group'), { code: 'KEY_INVALID' }); }
        const data = req.method === 'PUT'
          ? displayNames.setName(key, (await readJsonBody(req, 4096))?.name, 'human')
          : displayNames.clearName(key, 'human');
        sendJson(res, 200, { ok: true, data });
        scheduleFleetStateBroadcast();
      } catch (error) {
        if (['KEY_INVALID', 'NAME_INVALID', 'NAME_SET_BY_HUMAN'].includes(error.code)) {
          sendJson(res, 400, { ok: false, error: { code: error.code, message: error.message } });
        } else if ((error.status === 400 && error.message === 'invalid_json') ||
          (error.status === 413 && error.message === 'payload_too_large')) {
          sendJson(res, error.status, { error: error.message });
        } else {
          sendJson(res, 500, { error: 'internal_error' });
        }
      }
      return;
    }

    if ((pathname === '/api/schedules' || pathname.startsWith('/api/schedules/')) &&
      ['POST', 'PUT', 'DELETE'].includes(req.method)) {
      try {
        const outcome = await scheduleWriter.write(req.method, pathname, () => readJsonBody(req, 64 * 1024));
        if (outcome) sendJson(res, outcome.status, outcome.body);
        else sendJson(res, 405, { error: 'method_not_allowed' });
      } catch (error) {
        if ((error.status === 400 && error.message === 'invalid_json') ||
          (error.status === 413 && error.message === 'payload_too_large')) {
          sendJson(res, error.status, { error: error.message });
        } else {
          sendJson(res, 500, { error: 'internal_error' });
        }
      }
      return;
    }

    if (pathname === '/api/instance/name') {
      await handleAgentRename(req, res);
      return;
    }

    if (pathname === '/api/keys') {
      await handleApiKeys(req, res);
      return;
    }

    if (pathname === '/api/keys/purge-revoked' && req.method === 'POST') {
      await handleApiKeysPurge(req, res);
      return;
    }

    if (/^\/api\/keys\/[^/]+\/rotate$/.test(pathname)) {
      await handleApiKeyRotate(req, res, pathname);
      return;
    }

    if (pathname.startsWith('/api/keys/')) {
      await handleApiKeyDelete(req, res, pathname, url);
      return;
    }

    if (pathname === '/api/memory/tree' || pathname === '/api/memory/file' || pathname === '/api/memory/git') {
      await handleMemoryApi(req, res, pathname, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, pathname.startsWith('/api/') ? 404 : 405, { error: pathname.startsWith('/api/') ? 'not_found' : 'method_not_allowed' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      try {
        const handled = await handleApi(req, res, pathname, url);
        if (!handled && !res.headersSent) sendJson(res, 404, { error: 'not_found' });
      } catch (error) { workbenchFailure(res, error); }
      return;
    }

    if (['/', '/index.html', '/trends', '/memory', '/observer', '/schedule', '/usage', '/settings', '/chat'].includes(pathname)) {
      renderIndex(req, res);
      return;
    }

    if (!serveStatic(req, res, rootDir)) {
      sendText(res, 404, 'not found');
    }
    } catch (error) {
      if (!res.headersSent) workbenchFailure(res, error);
      else if (!res.writableEnded) res.end();
    }
  });
  const collect = () => {
    attachments.gc().catch(() => {
      console.error('[chat] Attachment cleanup remains pending.');
    });
  };
  collect();
  const attachmentTimer = setInterval(() => eventLoopMonitor.runTask('attachments.gc', collect), 5 * 60 * 1000);
  attachmentTimer.unref();
  const reconcileNames = () => {
    try { reconcileConversationNames({ store, c4Reader }); }
    catch { console.error('[chat] Conversation naming reconciliation remains pending.'); }
  };
  reconcileNames();
  const namingTimer = setInterval(() => eventLoopMonitor.runTask('conversation.naming', reconcileNames), 30000);
  namingTimer.unref();
  let attachmentClose = null;
  server.closeAttachments = () => {
    clearInterval(attachmentTimer);
    return attachmentClose ??= attachments.close();
  };
  server.on('close', () => {
    clearInterval(namingTimer);
    chatObserver.close();
    server.closeAttachments().catch(() => {
      console.error('[chat] Attachment cleanup did not close cleanly.');
    });
  });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch {
      socket.on('error', () => socket.destroy());
      rejectObserverUpgrade(socket, 400, 'invalid_request');
      return;
    }
    if (url.pathname.startsWith('/fleet/')) {
      req._authContext = auth.resolveAuthContext(req);
      fleetProxy.handleUpgrade(req, socket, head).then((handled) => {
        if (!handled) socket.destroy();
      }).catch(() => socket.destroy());
      return;
    }
    observerService.handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  return server;
}

function isMainModule(entry) {
  try { return !!entry && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

const isMain = isMainModule(process.argv[1]) || isMainModule(process.env.pm_exec_path);

if (isMain && process.argv.includes('--smoke')) {
  await startupSequence();
  console.log(JSON.stringify({
    ok: true,
    port: config.port,
    host: config.host,
    db: dbPath,
    state: coreState.getState().state
  }, null, 2));
  store.close();
} else if (isMain) {
  await observerService.startup();
  if (observerService.startupError) process.stderr.write(`[observer] startup failed: ${observerService.startupError.code || 'startup_failed'}\n`);
  if (observerControl.lock) {
    try {
      await observerControl.start();
    } catch (error) {
      // Observer is optional; ownership failure fences its API, not Dashboard.
      observerService.startupError = error;
      process.stderr.write(`[observer] control startup failed: ${error.code || 'control_failed'}\n`);
    }
  }
  const server = createServer();
  server.on('error', (err) => {
    console.error(`[dashboard] Failed to start: ${err.message}`);
    process.exit(1);
  });

  let retentionTimer = null;
  let retentionRun = null;
  const retentionAbort = new AbortController();

  publishHealthProcess(config.dataDir);
  server.listen(config.port, config.host, () => {
    coreLogImporter.start();
    console.log(`zylos-dashboard listening on http://${config.host}:${config.port}`);
    setTimeout(() => {
      (async () => {
        await startupSequence({ initialCollectors: false });
        fleetPoller.start();

        // Start periodic collectors
        pm2Collector.start(60_000);
        systemCollector.start(30_000);
        if (statuslineCollector) statuslineCollector.start();
        if (conversationCollector) conversationCollector.start(5_000);
        if (codexRolloutCollector) codexRolloutCollector.start(5_000);

        // Start snapshot timer
        stateEngine.startSnapshotTimer();

        runInitialCollectors().catch((err) => {
          process.stderr.write(`[startup] Initial collectors failed after listen: ${err.message}\n`);
        });

        // Retention cleanup timer (hourly)
        let lastConversionDate = null;
        retentionTimer = setInterval(() => {
          if (retentionRun || retentionAbort.signal.aborted) return;
          retentionRun = eventLoopMonitor.runTask('metrics.retention', () => runMetricMaintenance(store, {
            lastConversionDate, signal: retentionAbort.signal,
          })).then((result) => {
            lastConversionDate = result.lastConversionDate;
          }).catch((err) => {
            process.stderr.write(`[retention] Error: ${err.message}\n`);
          }).finally(() => { retentionRun = null; });
        }, 60 * 60 * 1000);
        retentionTimer.unref();
      })().catch((err) => {
        process.stderr.write(`[startup] Background startup failed: ${err.message}\n`);
      });
    }, 15_000).unref();
  });

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const shutdownDeadline = performance.now() + 10_000;
      pm2Collector.stop();
      systemCollector.stop();
      if (statuslineCollector) await statuslineCollector.stop();
      if (conversationCollector) conversationCollector.stop();
      if (codexRolloutCollector) codexRolloutCollector.stop();
      stateEngine.stopSnapshotTimer();
      await coreState.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      retentionAbort.abort();
      await retentionRun;
      fleetPoller.stop();
      sse.closeAll();
      let exitCode = 0;
      const shutdown = await shutdownDashboardTransports({
        server, observerService, observerControl,
        deadline: shutdownDeadline,
      });
      if (shutdown.http.error || shutdown.http.timedOut) {
        exitCode = 1;
        process.stderr.write(`[dashboard] HTTP drain ${shutdown.http.timedOut ? 'timed out' : 'failed'} during shutdown\n`);
      }
      if (shutdown.observer.error || shutdown.observer.timedOut) {
        exitCode = 1;
        const code = shutdown.observer.error?.code ||
          (shutdown.observer.timedOut ? 'observer_shutdown_timeout' : 'observer_shutdown_failed');
        process.stderr.write(`[observer] shutdown failed: ${code}\n`);
      }
      await coreLogImporter.stop();
      await server.closeAttachments();
      eventLoopMonitor.stop();
      c4Reader.close();
      store.close();
      process.exit(exitCode);
    });
  }
}
