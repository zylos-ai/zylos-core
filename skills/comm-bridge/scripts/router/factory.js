import { loadCoreModule } from './core-modules.js';
import * as database from '../c4-db.js';
const { readSessionMode, readZylosConfigStrict } = await loadCoreModule('config.js');
const { createSessionReader } = await loadCoreModule('session-state-reader-async.js');
const { readRuntimeHealth } = await loadCoreModule('session-state-reader.js');
const { findRuntime } = await loadCoreModule('runtime/index.js');
const { readReadyIdentity } = await loadCoreModule('runtime/session-target.js');
const { createSessionOps } = await loadCoreModule('runtime/session-ops.js');
const { launchSession } = await loadCoreModule('runtime/launch-flow.js');
const { listGroupTmuxSessions } = await loadCoreModule('session-group-paths.js');
const { readPoolCapacity } = await loadCoreModule('session-pool-config.js');
import { createRouter } from './scheduler.js';
import { createDelivery } from './delivery.js';
import { formatConversation } from './format.js';
import { resolveDashboardQuote } from '../dashboard-source.js';
import { notifyDelivered, notifyDeliveryFailed } from './notify.js';
import { createStatusNoticeSender } from '../c4-status-notice.js';
import { createFailureAlertSender } from '../failure-alert.js';
import { createPendingExpiryHandler } from './expiry.js';
import { createRouterDiagnostics } from './diagnostics.js';
import { createLifecycleProviders } from './lifecycle.js';
import { messageForStatus } from '../status-notice-templates.js';
import { notifyOwner as sendNotification, sendOwnerAlert } from '../c4-owner-alert.js';

// The supervisor owns the transport. Loading it on use allows the scheduler's
// independent paths to be exercised without implementing a second protocol.
async function submit(request) {
  const provider = await loadCoreModule('am-sock-client.js');
  return provider.submit(request);
}

/** Compose the same entry for production and isolated integration. Tests replace
 * only external boundaries; scheduling, claims, formatting and settlement stay
 * on the production path. Both runtimes use the scheduler's shared READY default. */
export function createDispatcher(overrides = {}, options = {}) {
  const env = overrides.env ?? process.env;
  const tmux = options.tmux ?? {};
  const db = overrides.db ?? database;
  const log = overrides.log ?? (message => console.log(`[${new Date().toISOString()}] ${message}`));
  const diagnostics = overrides.diagnostics ?? createRouterDiagnostics({ env });
  const diagnostic = overrides.diagnostic ?? diagnostics.diagnostic;
  const reader = createSessionReader({ env, connectionOptions: tmux });
  const lifecycle = createLifecycleProviders({ env, tmux, diagnostic });
  const now = overrides.now ?? Date.now;
  const poolSize = () => readPoolCapacity({ env, now: now() }).k;
  const readConfig = () => {
    try { const value = (overrides.readZylosConfigStrict ?? readZylosConfigStrict)(); return value.state === 'ok' ? value.config : {}; }
    catch { return {}; }
  };
  const alertController = new AbortController();
  const sendAlert = overrides.sendAlert ?? ((target, message) =>
    sendOwnerAlert(target, message, { env, signal: alertController.signal }));
  const notifyOwner = message => sendNotification(message, { readConfig, sendAlert, log });
  const failureAlert = createFailureAlertSender({
    db, notifyOwner, now: () => Math.floor(now() / 1000) });
  const sendFailureAlert = (row, reason) => {
    // No replay queue: a crash after the failure commit may lose this alert.
    void Promise.resolve().then(() => {
      const record = typeof row === 'number' ? db.getConversationsByRange(row, row)[0] : row;
      if (record) return failureAlert({ ...record, reason });
    }).catch(log);
  };
  const alert = (event, fields) => {
    if (event !== 'continuation_start_failed') { log(`Router alert: ${event} ${JSON.stringify(fields)}`); return; }
    // Notification I/O must neither join scheduler lanes nor delay Router stop.
    void (async () => {
      const message = messageForStatus({ context: 'repeated_failure', noticeCode: 'could_not_restart',
        group: fields.sessionGroup, count: fields.failures, reason: fields.reason, others: fields.others }, readConfig().statusNotices ?? {});
      await notifyOwner(message);
    })().catch(log);
  };
  const providers = {
    db, readSessionMode, ...reader, readCurrentSession: readReadyIdentity,
    listGroupTmuxSessions: () => listGroupTmuxSessions(tmux), readRuntimeHealth,
    session: { ...createSessionOps({ tmux }), launch: input => launchSession(input, { tmux }) }, submit,
    ...lifecycle, diagnostic, log,
    alert, sendFailureAlert,
    maintainDiagnostics: diagnostics.maintain,
    ...overrides,
  };
  const sendStatusNotice = overrides.sendStatusNotice ?? createStatusNoticeSender({ db, log });
  const handleExpired = overrides.handleExpired ?? createPendingExpiryHandler({ sendFailureAlert });
  let router;
  const delivery = createDelivery({ ...providers, getSessionMode: () => router.state.mode,
    findRuntime: overrides.findRuntime ?? findRuntime,
    formatConversation: overrides.formatConversation ?? ((row, options) => formatConversation(row, {
      ...options,
      lookupQuote: current => resolveDashboardQuote(current, db.getDb()),
    })),
    notifyDelivered: overrides.notifyDelivered ?? notifyDelivered,
    notifyDeliveryFailed: overrides.notifyDeliveryFailed ?? notifyDeliveryFailed,
  }, { ...options.delivery, tmux });
  router = createRouter({ ...providers, handleExpired, sendStatusNotice,
    canAttemptDelivery: delivery.canAttempt, finishDeliveryWait: delivery.finishWait, sweepDeliveryWaits: delivery.sweepWaits,
    maybePeriodicEnter: delivery.maybePeriodicEnter, clearPeriodicEnter: delivery.clearPeriodicEnter,
    deliverControl: overrides.deliverControl ?? delivery.deliverControl,
    deliverConversation: overrides.deliverConversation ?? delivery.deliverConversation,
  }, { ...options, poolSize });
  return { ...router, async stop() {
    alertController.abort();
    // Prevent new lanes first; outstanding delivery drains before DB closure.
    const stopping = router.stop();
    await delivery.stop();
    await stopping;
  } };
}
