#!/usr/bin/env node
import { readThresholdPolicy, sessionThreshold } from './lib/session-threshold.js';
import { CoreState } from './lib/core-state.js';
import { loadCoreModule } from './lib/core-modules.js';
import { createCoalescedBroadcast, createSessionCache, broadcastFleetSnapshot } from './lib/coalesced-broadcast.js';
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
import { handleChatHistory } from './lib/chat/history-routes.js';
import { ChatConversations, isChatLocalIdUsed } from './lib/chat/conversations.js';
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
import { resolveAggregateValue } from './lib/metric-aggregate.js';
import { runMetricMaintenance } from './lib/metric-maintenance.js';
import { EventLoopMonitor } from './lib/event-loop-monitor.js';
import { buildSystemPayload } from './lib/system-api.js';
import { SseHub } from './lib/sse.js';
import { FleetPoller, stateToFleetRecord } from './lib/fleet-poller.js';
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
import { createDisplayNames, validKey } from './lib/workbench/display-names.js';
import { parseSessionGroup } from '../../comm-bridge/scripts/c4-session-group.js';
import { createRuns } from './lib/workbench/runs.js';
import { createGroupConfig } from './lib/workbench/group-config.js';
import { createGroupBacklog } from './lib/workbench/group-backlog.js';
import { createMemoryBacklog } from './lib/workbench/memory-backlog.js';
import { createGroupActions } from './lib/workbench/group-actions.js';
import { usageSeries } from './lib/workbench/usage-series.js';
import { hostSeries } from './lib/workbench/host-series.js';
import { costRows, costSummary, usageBounds } from './lib/workbench/cost-query.js';
import { NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH, namePromptText } from '../public/js/wb/auto-name.js';
import { searchTerm } from './lib/workbench/group-search.js';
import { createGroupSnapshot, workbenchResponse } from './lib/workbench/group-snapshot.js';
import { createScheduleRead, scheduleReadResponse } from './lib/workbench/schedule-read.js';
import { createScheduleWrite } from './lib/workbench/schedule-write.js';
import { createScheduleTz } from './lib/workbench/schedule-tz.js';
import { handleAction, getActionsMeta, readCodexRootString } from './lib/actions.js';
import { buildRestartStatus } from './lib/core-actions.js';
import { createCoreStateChangePublisher } from './lib/core-state-publisher.js';
import { VersionChecker } from './lib/version-checker.js';
import { isNewerVersion } from './lib/version-utils.js';
import { applyVersionUpdateFields, codexRuntimeFields } from './lib/runtime-info.js';
import Database from 'better-sqlite3';

const startedAt = new Date();
const MEMORY_WRITE_BODY_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;

let dashboardVersion = null;
try {
  const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
  dashboardVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
} catch { /* header version stays hidden if package.json is unreadable */ }

let zylosVersion = null;
let ccInstalledVersion = null;
let codexInstalledVersion = null;
try {
  zylosVersion = execFileSync('zylos', ['--version'], { timeout: 5000 }).toString().trim();
} catch { /* zylos CLI not available */ }
try {
  const raw = execFileSync('claude', ['--version'], { timeout: 5000 }).toString().trim();
  ccInstalledVersion = raw.replace(/\s.*$/, '');
} catch { /* claude CLI not available */ }
try {
  const raw = execFileSync('codex', ['--version'], { timeout: 5000 }).toString().trim();
  codexInstalledVersion = raw.replace(/^codex-cli\s+/, '').replace(/\s.*$/, '');
} catch { /* codex CLI not available */ }

function readInstalledVersions() {
  try {
    zylosVersion = execFileSync('zylos', ['--version'], { timeout: 5000 }).toString().trim();
  } catch { /* ignore */ }
  try {
    const raw = execFileSync('claude', ['--version'], { timeout: 5000 }).toString().trim();
    ccInstalledVersion = raw.replace(/\s.*$/, '');
  } catch { /* ignore */ }
  try {
    const raw = execFileSync('codex', ['--version'], { timeout: 5000 }).toString().trim();
    codexInstalledVersion = raw.replace(/^codex-cli\s+/, '').replace(/\s.*$/, '');
  } catch { /* ignore */ }
}

function refreshInstalledVersions() {
  readInstalledVersions();
  const current = coreState?.getState();
  if (current) {
    current.runtime_info = buildRuntimeInfo();
    sse.broadcast('state_change', current);
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
  onImport: () => scheduleHistoryBroadcast(),
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
const usageTranscripts = new UsageTranscripts(store, config, { getSnapshot: at => workbench.getSnapshot(at) });
const conversationCollector = new ConversationCollector(store, config, { transcripts: usageTranscripts });
const codexRolloutCollector = new CodexRolloutCollector(store, config, { transcripts: usageTranscripts });

const collectors = { pm2: pm2Collector, system: systemCollector };
if (statuslineCollector) collectors.statusline = statuslineCollector;
if (conversationCollector) collectors.conversation = conversationCollector;
if (codexRolloutCollector) collectors.codexRollout = codexRolloutCollector;

// SSE hub
const sse = new SseHub(15_000);
const scheduleHistoryBroadcast = createCoalescedBroadcast(() => sse.broadcast('history_changed', {}));
let fleetPollerReady = false; // fleetPoller is declared later (TDZ guard)

function broadcastFleetState() {
  try {
    broadcastFleetSnapshot(sse, buildApiStatePayload, statePayload => {
      if (fleetPollerReady) broadcastFleet(fleetPoller.getFleet(), statePayload);
    });
  } catch (err) {
    process.stderr.write(`[fleet] fleet_state SSE broadcast skipped: ${err.message}\n`);
  }
}

const scheduleFleetStateBroadcast = createCoalescedBroadcast(broadcastFleetState);
publishCoreStateChange = createCoreStateChangePublisher({ sse, buildStatePayload: buildApiStatePayload, scheduleFleetStateBroadcast });

// 6b. Version checker (polls GitHub + npm registry every 12h)
const versionChecker = new VersionChecker({
  onUpdate: () => {
    if (stateEngine) {
      const st = coreState.getState();
      st.runtime_info = buildRuntimeInfo();
      sse.broadcast('state_change', st);
      scheduleFleetStateBroadcast();
    }
  },
});
versionChecker.start();

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.zylosDir, '.claude', 'settings.json'), 'utf8'));
  } catch { return {}; }
}

// Installed versions are cached at module load, refreshed by the periodic
// timer below and after upgrade actions. They must NOT be re-read here:
// buildRuntimeInfo runs on every state broadcast (i.e. every ingested hook
// event), and the three `--version` execFileSync spawns cost ~200ms+ — the
// dominant per-event hotspot behind the #260 event-loop wedge.
const INSTALLED_VERSIONS_REFRESH_MS = 10 * 60 * 1000;
setInterval(readInstalledVersions, INSTALLED_VERSIONS_REFRESH_MS).unref();

function buildRuntimeInfo() {
  const live = coreState.getState();
  const usageObservation = coreState.getUsageObservation();
  const usage = usageObservation.valid ? usageObservation.value : null;
  const slInfo = live.runtime === 'claude' && usage ? { model: usage.model?.display_name, model_id: usage.model?.id, effort: usage.effort?.level, cc_version: usage.version } : null;
  const latest = versionChecker.getLatest();
  const ccRunning = slInfo?.cc_version || null;

  const settings = isClaudeRuntime ? readClaudeSettings() : {};
  const codexRuntimeInfo = live.runtime === 'codex' && usage ? { model_id: usage.model ?? null, effort: usage.reasoningEffort ?? null, cli_version: usage.cliVersion ?? null } : null;
  const codexRunning = activeRuntime === 'codex' ? codexRuntimeInfo?.cli_version || null : null;
  const claudeNeedsRestart = isClaudeRuntime &&
    ((settings.model && slInfo?.model_id && settings.model !== slInfo.model_id) ||
    (settings.effortLevel && slInfo?.effort && settings.effortLevel !== slInfo.effort) ||
    (ccInstalledVersion && ccRunning && isNewerVersion(ccInstalledVersion, ccRunning)));
  const codexNeedsRestart = activeRuntime === 'codex' &&
    codexInstalledVersion &&
    codexRunning &&
    isNewerVersion(codexInstalledVersion, codexRunning);
  const needsRestart = claudeNeedsRestart || codexNeedsRestart;

  const info = {
    zylos_version: zylosVersion,
    runtime: live.runtime || 'unknown',
    configured_runtime: activeRuntime,
    ...(live.runtime === 'codex'
      ? codexRuntimeFields(codexRuntimeInfo, {
          model: readCodexRootString('model', config.zylosDir),
          effort: readCodexRootString('model_reasoning_effort', config.zylosDir),
        })
      : { model: slInfo?.model || null, model_id: slInfo?.model_id || null, effort: slInfo?.effort || null, service_tier: null }),
    cc_version: ccRunning,
    cc_installed: ccInstalledVersion || null,
    codex_version: codexRunning || codexInstalledVersion || null,
    codex_running: codexRunning,
    codex_installed: codexInstalledVersion || null,
    pending_restart: !!needsRestart,
  };
  // info bar: installed newer than running → show restart hint
  if (ccInstalledVersion && ccRunning && isNewerVersion(ccInstalledVersion, ccRunning)) {
    info.cc_restart = ccInstalledVersion;
  }
  if (codexInstalledVersion && codexRunning && isNewerVersion(codexInstalledVersion, codexRunning)) {
    info.codex_restart = codexInstalledVersion;
  }
  // upgrade button: installed != latest → show upgrade dot
  const ccEffective = ccInstalledVersion || ccRunning;
  return applyVersionUpdateFields(info, latest, {
    zylosVersion,
    ccEffectiveVersion: ccEffective,
    codexInstalledVersion,
  });
}

function getNewSessionThreshold() {
  const live = coreState.getState();
  const observation = coreState.getUsageObservation();
  return sessionThreshold(readThresholdPolicy(config.zylosDir), { runtime: live.runtime,
    usage: observation.valid ? observation.value : null, launchConfig: coreState.getLaunchConfig() });
}

function getSystemMetrics() {
  const data = systemCollector.getLatestSystemData();
  const memUsed = Number(data?.mem_used_bytes);
  const memTotal = Number(data?.mem_total_bytes);
  return {
    cpu_pct: Number.isFinite(Number(data?.cpu_pct)) ? Number(data.cpu_pct) : null,
    mem_pct: Number.isFinite(memUsed) && Number.isFinite(memTotal) && memTotal > 0 ? (memUsed / memTotal) * 100 : null,
    mem_used_bytes: Number.isFinite(memUsed) ? memUsed : null,
    mem_total_bytes: Number.isFinite(memTotal) ? memTotal : null,
    disk_pct: Number.isFinite(Number(data?.disk_used_pct)) ? Number(data.disk_used_pct) : null,
    disk_free_bytes: Number.isFinite(Number(data?.disk_free_bytes)) ? Number(data.disk_free_bytes) : null
  };
}

const getCachedCostAggregate = createSessionCache(() => metricResolver.resolveAggregated('cost') || {});

function getCostTiers() {
  const aggregate = getCachedCostAggregate(coreState.costKey);
  return {
    session_cost: aggregate.session ?? null,
    daily_cost: aggregate.today ?? metricResolver.resolve('daily_cost').value ?? null,
    weekly_cost: aggregate.seven_day ?? null
  };
}

// 7. State engine
const stateEngine = new StateEngine(store, collectors, config, {
  onStateChange: (st) => {
    const current = coreState.getState();
    current.runtime_info = buildRuntimeInfo();
    sse.broadcast('state_change', current);
    scheduleFleetStateBroadcast();
  }
});

observerService.historyService = new HistoryService({ config, store, stateEngine });

// Wire collector updates to state engine
pm2Collector._onUpdate = (data) => {
  stateEngine.onPM2Update(data);
  workbench.channelDownCounter.update(data);
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
const metricResolver = new MetricResolver(store, collectors, config, { stateEngine: coreState, timeZone: instanceTz });

// 9b. C4 reader (read-only access to comm-bridge DB)
const c4Reader = new C4Reader(config.zylosDir);
const displayNames = createDisplayNames({ store, zylosDir: config.zylosDir, sanitizer });
const workbench = createGroupSnapshot({ zylosDir: config.zylosDir, store, c4Reader, sanitizer, displayNames,
  readConfigRuntime: () => loadZylosConfig(config.zylosDir).runtime ?? null,
  readPm2: () => pm2Collector.getLatestPM2Data() });
const getDetailSnapshot = () => workbench.getCachedSnapshot() ?? workbench.getSnapshot();
const groupRuns = createRuns({ store, getSnapshot: getDetailSnapshot });
const groupConfig = createGroupConfig({ zylosDir: config.zylosDir });
const groupBacklog = createGroupBacklog({ zylosDir: config.zylosDir, getSnapshot: getDetailSnapshot });
const memoryBacklog = createMemoryBacklog({ zylosDir: config.zylosDir, getSnapshot: at => workbench.getSnapshot(at), groupBacklog });
const groupAction = createGroupActions({ zylosDir: config.zylosDir, config });

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
  const term = hasQuery ? searchTerm(params.get('q')) : null;
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

function workbenchGroupKey(encoded) {
  let key;
  try { key = decodeURIComponent(encoded); } catch {}
  if (key !== 'origin' && !validKey(key)) {
    throw Object.assign(new Error('Invalid session group'), { code: 'SESSION_GROUP_INVALID', statusCode: 400 });
  }
  return key;
}

function workbenchFailure(res, error) {
  if ([400, 413].includes(error.status)) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const status = error.statusCode ?? 500;
  sendJson(res, status, { ok: false, error: { code: status === 500 ? 'internal_error' : error.code,
    message: status === 500 ? 'Request failed' : error.message } });
}
const scheduleReader = createScheduleRead({ zylosDir: config.zylosDir, scheduleTz, displayNames,
  getSnapshot: () => workbench.getSnapshot() });
const scheduleWriter = createScheduleWrite({ zylosDir: config.zylosDir, scheduleTz });

function buildApiStatePayload() {
  const stateData = coreState.getState();
  // Include the agent's deterministic identity color/hue; machines that read this
  // instance's state (including older dashboards) still colour it by them.
  stateData.agent = { ...config.agent, ...agentColor(config.agent?.name) };
  stateData.dashboard_version = dashboardVersion;
  stateData.runtime_info = buildRuntimeInfo();
  stateData.new_session_threshold = getNewSessionThreshold();
  stateData.system_metrics = getSystemMetrics();
  const usageObservation = coreState.getUsageObservation();
  const usage = usageObservation.valid ? usageObservation.value : null;
  stateData.context_pct = usage?.context_window?.used_percentage ?? (usage?.contextUsage?.ceiling > 0 ? usage.contextUsage.used / usage.contextUsage.ceiling * 100 : null);
  stateData.rate_limit_7d_pct = coreState.accountUsage?.seven_day?.used_percentage ?? coreState.accountUsage?.sevenDay?.usedPercentage ?? null;
  Object.assign(stateData, getCostTiers());
  return stateData;
}

function buildSelfFleetRecord(statePayload = buildApiStatePayload()) {
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
    const stateResp = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${tokenBody.token}` },
      signal: controller.signal
    });
    if (stateResp.status === 401 || stateResp.status === 403) return { reachable: false, error: 'auth_failed' };
    if (!stateResp.ok) return { reachable: false, error: 'unreachable', scope };
    const stateBody = await stateResp.json();
    return {
      reachable: true,
      scope,
      version: stateBody?.runtime_info?.zylos_version || stateBody?.runtime_info?.version || null
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

function loadZylosConfig(zylosDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function extractFilePath(summary) {
  if (!summary) return null;
  const m = summary.match(/^(?:Read|Edit|Write):\s+(\S+)/);
  return m ? m[1] : null;
}

function extractProject(filePath) {
  if (!filePath) return null;
  const parts = filePath.replace(/^\/+/, '').split('/');
  const wsIdx = parts.indexOf('workspace');
  if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
  const skillsIdx = parts.indexOf('skills');
  if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
  return null;
}

function readSchedulerTodayCount(zylosDir) {
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');
  if (!fs.existsSync(dbFile)) return 0;
  try {
    const db = new Database(dbFile, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const todayStart = Math.floor(new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime() / 1000);
    const row = db.prepare('SELECT COUNT(*) as count FROM task_history WHERE executed_at >= ?').get(todayStart);
    db.close();
    return row?.count || 0;
  } catch {
    return 0;
  }
}

function readSchedulerStatus(zylosDir) {
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');
  if (!fs.existsSync(dbFile)) return null;
  try {
    const db = new Database(dbFile, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const counts = db.prepare(
      `SELECT status, COUNT(*) as count FROM tasks WHERE status IN ('pending','paused','running') GROUP BY status`
    ).all();
    const upcoming = db.prepare(
      `SELECT id, name, next_run_at FROM tasks WHERE status = 'pending' ORDER BY next_run_at ASC LIMIT 5`
    ).all();
    db.close();
    const result = { pending: 0, paused: 0, running: 0 };
    for (const r of counts) result[r.status] = r.count;
    result.upcoming = upcoming.map((t) => ({ id: t.id, name: t.name, run_at: new Date(t.next_run_at * 1000).toISOString() }));
    return result;
  } catch {
    return null;
  }
}

function dayBoundariesUTC(tz, daysBack = 0) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    if (type !== 'literal') p[type] = parseInt(value);
  }
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMs = asIfUTC - now.getTime();
  const midnightUTC = Date.UTC(p.year, p.month - 1, p.day) - offsetMs;
  const since = new Date(midnightUTC - daysBack * 86400000);
  return { since: since.toISOString(), until: now.toISOString() };
}

function periodBounds(period, tz, stateEngine) {
  const now = new Date().toISOString();
  if (period === 'session') {
    const sessionId = stateEngine.getCurrentSessionId();
    return sessionId ? { sessionId, until: now } : null;
  }
  if (period === 'today') return dayBoundariesUTC(tz);
  if (period === '7d') return usageBounds({ range: '7d', tz });
  if (period === '30d') return usageBounds({ range: '30d', tz });
  return undefined;
}

function latestMetricRow(metricName, source) {
  const rows = store.queryMetrics({
    name: metricName,
    since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    until: new Date().toISOString()
  }).filter(r => !source || r.source === source);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

async function handleApi(req, res, pathname, url) {
  if (pathname === '/api/health') {
    const sourceHealth = stateEngine.getSourceHealth();
    sendJson(res, 200, {
      ok: true,
      service: 'zylos-dashboard',
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      phase: 'phase2a',
      event_loop: eventLoopMonitor.snapshot(),
      source: sourceHealth
    });
    return true;
  }

  if (pathname === '/api/restart-status') {
    const requestId = url.searchParams.get('requestId');
    if (!/^[a-f0-9-]{36}$/i.test(requestId || '')) { sendJson(res, 400, { error: 'INVALID_REQUEST_ID' }); return true; }
    let completion = 'unknown';
    try { const { lookupRestartRequest } = await loadCoreModule('am-sock-client.js'); completion = await lookupRestartRequest(requestId, { deadlineAt: Date.now() + 10000 }); } catch {}
    const current = await coreState.refresh();
    sendJson(res, 200, buildRestartStatus(requestId, completion, current));
    return true;
  }
  if (pathname === '/api/session-mode' || pathname === '/api/instance-status') {
    try {
      const args = pathname === '/api/session-mode' ? ['session-mode', 'status', '--json'] : ['status', '--json'];
      const { stdout } = await promisify(execFile)('zylos', args, { timeout: 10000, maxBuffer: 1024 * 1024 });
      sendJson(res, 200, JSON.parse(stdout));
    } catch (error) {
      try {
        const envelope = JSON.parse(String(error.stdout || '').trim());
        if (typeof envelope?.ok === 'boolean') { sendJson(res, 400, envelope); return true; }
      } catch {}
      sendJson(res, 503, { ok: false, error: { code: 'STATUS_UNAVAILABLE', message: error.message } });
    }
    return true;
  }
  if (pathname === '/api/state') {
    await coreState.refresh();
    sendJson(res, 200, { ...buildApiStatePayload(), tz: (await scheduleTz()).tz });
    return true;
  }

  if (pathname === '/api/fleet') {
    try {
      sendJson(res, 200, buildFullFleetPayload().payload);
    } catch (err) {
      sendJson(res, 500, { error: err.code || err.message });
    }
    return true;
  }

  if (pathname === '/api/timeline') {
    const since = url.searchParams.get('since') || undefined;
    const until = url.searchParams.get('until') || undefined;
    const types = url.searchParams.get('types')?.split(',').filter(Boolean) || undefined;
    const sessionId = url.searchParams.get('session_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
    const sessionGroup = url.searchParams.has('session_group') ? (url.searchParams.get('session_group') || null) : undefined;
    const runId = url.searchParams.get('run_id') || undefined;
    const runtime = url.searchParams.get('runtime') || undefined;
    const afterSeq = Number(url.searchParams.get('after_seq'));
    const events = await coreLogImporter.sanitizeEvents(store.queryEvents({ since, until, types, sessionId,
      sessionGroup, runId, runtime, afterSeq, limit: Math.min(1000, limit), offset, order }));
    const stream = url.searchParams.get('stream') || undefined;
    const gapLimit = parseInt(url.searchParams.get('gap_limit') || '100', 10);
    const gapOffset = parseInt(url.searchParams.get('gap_offset') || '0', 10);
    const gaps = await coreLogImporter.sanitizeEvents(store.getHistoryDiagnostics({
      sessionGroup, stream, limit: gapLimit, offset: gapOffset }));
    sendJson(res, 200, { events, count: events.length, gaps });
    return true;
  }

  if (pathname === '/api/workbench/memory/backlog') {
    try { sendJson(res, 200, await memoryBacklog()); }
    catch { sendJson(res, 503, { error: 'backlog_failed' }); }
    return true;
  }

  if (pathname === '/api/workbench/usage' || pathname === '/api/workbench/host') {
    try {
      const range = url.searchParams.get('range') || undefined;
      const tz = pathname.endsWith('/usage') ? (await scheduleTz()).tz : null;
      const data = pathname.endsWith('/usage')
        ? url.searchParams.get('summary') === 'cost'
          ? { costSummary: costSummary(store, { tz }) }
          : usageSeries(store, c4Reader, { range, tz,
            since: url.searchParams.get('since'), until: url.searchParams.get('until') })
        : hostSeries(store, { range, pm2Data: pm2Collector.getLatestPM2Data() });
      sendJson(res, 200, data);
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }

  if (pathname === '/api/workbench/name-prompt') {
    try {
      const todo = await displayNames.listNames({ unnamed: true, activeSinceMs: 3 * 86400000 });
      const script = path.join(config.zylosDir, '.claude', 'skills', 'dashboard', 'scripts', 'group-name.js');
      sendJson(res, 200, { text: namePromptText(script, NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH),
        todo: todo.map(row => row.fallbackName) });
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }

  if (pathname === '/api/workbench/runtime-overrides') {
    try { sendJson(res, 200, await runtimeOverridesPage(url.searchParams)); }
    catch { sendJson(res, 502, { error: 'override_list_failed' }); }
    return true;
  }

  if (pathname === '/api/workbench/pricing') {
    try {
      const bounds = usageBounds({ range: '7d', tz: (await scheduleTz()).tz });
      const models = costRows(store, { ...bounds, bucket: 'total', byModel: true })
        .map(({ runtime, model, value }) => ({ runtime, model, cost: value }));
      const unmatched = store.db.prepare(`SELECT runtime, json_extract(dimensions, '$.model') AS model,
        SUM(COALESCE(json_extract(dimensions, '$.total_input'), 0) + COALESCE(json_extract(dimensions, '$.output'), 0)) AS tokens
        FROM metric_points WHERE metric_name='usage_event' AND timestamp BETWEEN ? AND ?
        AND json_extract(dimensions, '$.cost') IS NULL
        AND (COALESCE(json_extract(dimensions, '$.total_input'), 0) > 0 OR COALESCE(json_extract(dimensions, '$.output'), 0) > 0)
        GROUP BY runtime, model`).all(bounds.since, bounds.until);
      sendJson(res, 200, { models, unmatched });
    } catch { sendJson(res, 500, { error: 'pricing_unreadable' }); }
    return true;
  }

  const detailRead = pathname.match(/^\/api\/workbench\/groups\/([^/]+)\/(runs|messages|backlog|config)$/);
  if (detailRead) {
    try {
      const key = workbenchGroupKey(detailRead[1]);
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
        case 'config': data = await groupConfig.get(key); break;
      }
      sendJson(res, 200, data);
    } catch (error) { workbenchFailure(res, error); }
    return true;
  }

  if (pathname === '/api/workbench/schedule' || pathname.startsWith('/api/workbench/schedule/')) {
    try {
      const value = await scheduleReadResponse(scheduleReader, pathname, url.searchParams);
      if (value === undefined) return false;
      sendJson(res, 200, value);
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? error.code : 'internal_error' });
    }
    return true;
  }

  if (['/api/workbench/groups', '/api/workbench/groups/search', '/api/workbench/activity'].includes(pathname)) {
    try { sendJson(res, 200, await workbenchResponse(workbench, pathname, url.searchParams)); }
    catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? error.code : 'internal_error',
        ...(error.reason ? { reason: error.reason } : {}) });
    }
    return true;
  }

  if (pathname === '/api/system') {
    const pm2Data = pm2Collector.getLatestPM2Data();
    const sysData = systemCollector.getLatestSystemData();
    const pm2State = store.getAllPm2State?.() || [];
    const systemSummary = sysData ? null : latestMetricRow('system_summary', 'system');
    const scheduler = readSchedulerStatus(config.zylosDir);
    sendJson(res, 200, buildSystemPayload({ pm2Data, sysData, pm2State, systemSummary, scheduler }));
    return true;
  }

  if (pathname.startsWith('/api/metrics/history/')) {
    const metricName = pathname.slice('/api/metrics/history/'.length);
    if (!metricName) {
      sendJson(res, 400, { error: 'missing metric name' });
      return true;
    }
    const since = url.searchParams.get('since') || new Date(Date.now() - 6 * 3600_000).toISOString();
    const until = url.searchParams.get('until') || new Date().toISOString();
    const rows = store.queryMetrics({ name: metricName, since, until });
    const points = rows.map(r => ({
      timestamp: r.timestamp,
      value: r.metric_value,
      source: r.source,
      confidence: r.confidence,
      dimensions: r.dimensions
    }));
    sendJson(res, 200, { metric: metricName, since, until, points, count: points.length });
    return true;
  }

  if (pathname === '/api/metrics/aggregate') {
    const metric = url.searchParams.get('metric');
    const period = url.searchParams.get('period') || 'session';
    const tz = url.searchParams.get('tz') || (await scheduleTz()).tz || 'UTC';
    if (!metric || !['cost', 'cache', 'tokens'].includes(metric)) {
      sendJson(res, 400, { error: 'metric must be "cost", "cache", or "tokens"' });
      return true;
    }
    let bounds = periodBounds(period, tz, coreState);
    if (bounds === undefined) { sendJson(res, 400, { error: `invalid period: ${period}` }); return true; }
    const resolved = resolveAggregateValue(store, metric, bounds, { runtime: activeRuntime, period });
    const value = resolved.value;
    bounds = resolved.bounds;
    if (bounds === null) {
      sendJson(res, 200, { metric, period, value: null, since: null, until: null, sessionId: null });
      return true;
    }
    sendJson(res, 200, { metric, period, value, since: bounds.since, until: bounds.until, sessionId: bounds.sessionId || null });
    return true;
  }

  if (pathname === '/api/metrics/series') {
    const metric = url.searchParams.get('metric');
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until') || new Date().toISOString();
    const bucket = parseInt(url.searchParams.get('bucket') || '3600', 10);
    if (!metric || !['cost', 'cache', 'tokens', 'messages', 'projects'].includes(metric)) {
      sendJson(res, 400, { error: 'metric must be "cost", "cache", "tokens", "messages", or "projects"' });
      return true;
    }
    if (metric === 'projects') {
      const s = since || new Date(Date.now() - 7 * 86400_000).toISOString();
      const result = store.getProjectDistribution({ since: s, until });
      sendJson(res, 200, { metric, since: s, until, items: result.items, totalTokens: result.totalTokens, totalCost: result.totalCost });
      return true;
    }
    if (!since) { sendJson(res, 400, { error: 'since is required' }); return true; }
    let points, total;
    if (metric === 'messages') {
      const result = c4Reader.getMessageSeries({ since, until, bucketSeconds: bucket });
      sendJson(res, 200, { metric, since, until, bucket, points: result.points, total: result.total });
      return true;
    }
    if (metric === 'cost') { points = store.aggregateCostSeries({ since, until, bucketSeconds: bucket }); total = store.aggregateCost({ since, until }); }
    else if (metric === 'cache') { points = store.aggregateCacheRateSeries({ since, until, bucketSeconds: bucket }); total = store.aggregateCacheRate({ since, until }); }
    else { points = store.aggregateTokenSeries({ since, until, bucketSeconds: bucket }); total = store.aggregateTokens({ since, until }); }
    sendJson(res, 200, { metric, since, until, bucket, points, total });
    return true;
  }

  if (pathname.startsWith('/api/metrics/')) {
    const metricName = pathname.slice('/api/metrics/'.length);
    if (!metricName) {
      sendJson(res, 400, { error: 'missing metric name' });
      return true;
    }
    let result;
    if (metricName === 'rate_limit') {
      sendJson(res, 404, { error: 'unknown_metric' });
      return true;
    }
    if (['context_pct', 'rate_limit_7d'].includes(metricName)) {
      await coreState.refresh();
      const current = buildApiStatePayload();
      const usage = coreState.getUsageObservation();
      const value = current[{ context_pct: 'context_pct', rate_limit_7d: 'rate_limit_7d_pct' }[metricName]];
      result = { value, selected_source: 'core-session-reader', freshness: usage.sampledAt ? (Date.now() - usage.sampledAt) / 1000 : null, confidence: value === null ? 'none' : 'actual', alternatives: [], fallback_reason: value === null ? usage.reason || 'missing' : null };
    } else result = metricResolver.resolve(metricName);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/api/summary') {
    const today = new Date().toISOString().slice(0, 10);
    const todayStart = `${today}T00:00:00.000Z`;
    const events = store.queryEvents({ since: todayStart, types: ['post_tool_use'], limit: 10000 });
    const toolCalls = events.length;
    const stopEvents = store.queryEvents({ since: todayStart, types: ['stop'], limit: 10000 });
    const sessions = stopEvents.length;

    const projectBreakdown = {};
    for (const e of events) {
      const fp = extractFilePath(e.summary);
      const project = extractProject(fp);
      if (project) projectBreakdown[project] = (projectBreakdown[project] || 0) + 1;
    }
    const topProject = Object.entries(projectBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const c4Stats = c4Reader.getTodayStats();
    const messagesProcessed = c4Stats ? c4Stats.total_in + c4Stats.total_out : 0;

    sendJson(res, 200, {
      date: today,
      tool_calls: toolCalls,
      sessions,
      top_project: topProject,
      project_breakdown: projectBreakdown,
      messages_processed: messagesProcessed
    });
    return true;
  }

  if (pathname === '/api/communication') {
    const stats = c4Reader.getTodayStats();
    const pending = c4Reader.getPendingQueue();
    const lastOutbound = c4Reader.getLastOutbound();
    const avgResponse = c4Reader.getAvgResponseTime();

    sendJson(res, 200, {
      channels: stats?.channels || {},
      total_in: stats?.total_in || 0,
      total_out: stats?.total_out || 0,
      pending_depth: pending.depth,
      pending_oldest_age_s: pending.oldest_age_s,
      last_outbound: lastOutbound,
      avg_response_s: avgResponse
    });
    return true;
  }

  if (pathname === '/api/actions/meta') {
    const selectedRuntime = url.searchParams.get('runtime') ?? activeRuntime;
    if (!['claude', 'codex'].includes(selectedRuntime)) {
      sendJson(res, 400, { error: 'INVALID_RUNTIME' }); return true;
    }
    const zylosConfig = loadZylosConfig(config.zylosDir);
    zylosConfig.zylosDir = config.zylosDir;
    zylosConfig.runtime = selectedRuntime;
    zylosConfig.thresholdModel = url.searchParams.get('model');
    const runtimeMeta = !url.searchParams.has('runtime') && selectedRuntime === activeRuntime
      ? (activeRuntime === 'codex' ? buildRuntimeInfo() : statuslineCollector?.getRuntimeInfo())
      : null;
    const meta = getActionsMeta(zylosConfig, runtimeMeta);
    meta.zylos_version = zylosVersion;
    meta.runtime_cli = selectedRuntime;
    meta.cc_version = selectedRuntime === 'codex'
      ? runtimeMeta?.codex_running || runtimeMeta?.codex_version || codexInstalledVersion || null
      : ccInstalledVersion || runtimeMeta?.cc_version || null;
    sendJson(res, 200, meta);
    return true;
  }

  if (pathname === '/api/stream') {
    const apiToken = req._apiToken;
    const validator = apiToken ? () => !!validateApiSession(apiToken) : null;
    sse.addClient(res, validator);
    res.write(`event: fleet_state\ndata: ${JSON.stringify(buildApiStatePayload())}\n\n`);
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
  const priceRuntime = activeRuntime === 'codex' ? 'codex' : 'claude';
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
  } else updates = { [priceRuntime]: body };
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
    sendJson(res, 200, multiple ? allSettingsPayload() : { ok: true, ...settingsPayload(priceRuntime) });
  } catch (err) { sendJson(res, 500, { error: `Failed to save settings: ${err.message}` }); }
}

async function handleMemoryApi(req, res, pathname, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'PUT' && pathname === '/api/memory/file')) {
    sendText(res, 405, 'method not allowed');
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
  const attachments = new ChatAttachments({ store, c4Reader, zylosDir: config.zylosDir });
  const sender = new ChatSender({ conversations, c4Reader, zylosDir: config.zylosDir, attachments });
  const answers = new ChatAnswers({ store });
  const answerDelivery = new ChatAnswerDelivery({ answers, sender, c4Reader });
  const answersReady = answerDelivery.recover().catch(() => {
    console.error('[chat] Answer delivery recovery remains pending.');
  });
  const history = new ChatHistory({ c4Reader, conversations, attachments });
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
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`); } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    let pathname = url.pathname;

    if (await auth.handle(req, res, url)) {
      return;
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

    if (await handleChatSettings(req, res, url, { auth, config })) return;
    if (await handleChatAttachments(req, res, url, { auth, config, sender, attachments,
      readMode: () => loadZylosConfig(config.zylosDir).session_mode })) return;
    if (pathname.startsWith('/api/chat/conversations/')) {
      await answersReady;
      if (await handleChatAnswers(req, res, url, { auth, config, answers, delivery: answerDelivery, sender,
        readMode: () => loadZylosConfig(config.zylosDir).session_mode })) return;
    }
    if (await handleChatConversations(req, res, url, { auth, config, conversations, sender,
      readMode: () => loadZylosConfig(config.zylosDir).session_mode })) return;
    if (await handleChatHistory(req, res, url, { auth, config, history, instanceTz: scheduleTz })) return;

    if (await observerService.handle(req, res, url)) {
      return;
    }

    if (pathname.startsWith('/fleet/')) {
      await fleetProxy.handle(req, res, url);
      return;
    }

    if (pathname === '/api/stream') {
      await handleApi(req, res, pathname, url);
      return;
    }

    if (pathname.startsWith('/api/actions/') && req.method === 'POST') {
      const action = pathname.slice('/api/actions/'.length);
      if (action && action !== 'meta') {
        let body = {};
        try { body = await readJsonBody(req, 4096); } catch { /* no body is ok for some actions */ }
        const zylosConfig = loadZylosConfig(config.zylosDir);
        zylosConfig.zylosDir = config.zylosDir;
        const result = await handleAction(action, body, zylosConfig);
        if (result.ok && (action === 'upgrade-cc' || action === 'upgrade-zylos')) {
          refreshInstalledVersions();
        }
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      const priceRuntime = activeRuntime === 'codex' ? 'codex' : 'claude';
      sendJson(res, 200, url.searchParams.get('all') === '1' ? allSettingsPayload() : settingsPayload(priceRuntime));
      return;
    }

    if (pathname === '/api/settings' && req.method === 'PUT') {
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

    const detailWrite = pathname.match(/^\/api\/workbench\/groups\/([^/]+)\/(config|actions\/(interrupt|chop-chop|restart))$/);
    if (detailWrite && req.method === 'POST') {
      try {
        const key = workbenchGroupKey(detailWrite[1]);
        const body = await readJsonBody(req, 4096);
        const result = detailWrite[2] === 'config'
          ? await groupConfig.submit(key, body)
          : await groupAction(key, detailWrite[3], body);
        sendJson(res, 200, result);
      } catch (error) { workbenchFailure(res, error); }
      return;
    }

    const groupNameRoute = pathname.match(/^\/api\/workbench\/groups\/([^/]+)\/name$/);
    if (groupNameRoute && ['PUT', 'DELETE'].includes(req.method)) {
      try {
        let key;
        try { key = decodeURIComponent(groupNameRoute[1]); }
        catch { throw Object.assign(new Error('Invalid session group'), { code: 'KEY_INVALID' }); }
        const data = req.method === 'PUT'
          ? displayNames.setName(key, (await readJsonBody(req, 4096))?.name, 'human')
          : displayNames.clearName(key, 'human');
        sendJson(res, 200, { ok: true, data });
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

    if ((pathname === '/api/workbench/schedule' || pathname.startsWith('/api/workbench/schedule/')) &&
      ['POST', 'PUT', 'DELETE'].includes(req.method)) {
      try {
        const outcome = await scheduleWriter.write(req.method, pathname, () => readJsonBody(req, 64 * 1024));
        if (outcome) sendJson(res, outcome.status, outcome.body);
        else sendText(res, 405, 'method not allowed');
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

    if (pathname === '/api/agent/name') {
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
      sendText(res, 405, 'method not allowed');
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, pathname, url);
      if (!handled && !res.headersSent) sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (['/', '/index.html', '/trends', '/memory', '/observer', '/schedule', '/usage', '/settings', '/chat'].includes(pathname)) {
      renderIndex(req, res);
      return;
    }

    if (!serveStatic(req, res, rootDir)) {
      sendText(res, 404, 'not found');
    }
  });
  const collect = () => {
    attachments.gc().catch(() => {
      console.error('[chat] Attachment cleanup remains pending.');
    });
  };
  collect();
  const attachmentTimer = setInterval(collect, 5 * 60 * 1000);
  attachmentTimer.unref();
  let attachmentClose = null;
  server.closeAttachments = () => {
    clearInterval(attachmentTimer);
    return attachmentClose ??= attachments.close();
  };
  server.on('close', () => {
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
    phase: 'phase2a',
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
          retentionRun = runMetricMaintenance(store, {
            lastConversionDate, signal: retentionAbort.signal,
          }).then((result) => {
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
      c4Reader.close();
      store.close();
      process.exit(exitCode);
    });
  }
}
