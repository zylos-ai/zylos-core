import { loadCoreModule } from './core-modules.js';
import * as database from '../c4-db.js';
const { readSessionMode, readZylosConfigStrict } = await loadCoreModule('config.js');
const { createSessionReader } = await loadCoreModule('session-state-reader-async.js');
const { readRuntimeHealth } = await loadCoreModule('session-state-reader.js');
const { readReadyIdentity } = await loadCoreModule('runtime/session-target.js');
const { getSessionAdapter } = await loadCoreModule('runtime/index.js');
const { listGroupTmuxSessions } = await loadCoreModule('session-group-paths.js');
const { resolveSessionPoolSize } = await loadCoreModule('session-pool-config.js');
import { createRouter } from './scheduler.js';
import { createDelivery } from './delivery.js';
import { formatConversation } from './format.js';
import { notifyDelivered } from './notify.js';
import { createStatusNoticeSender } from '../c4-status-notice.js';
import { createPendingExpiryHandler } from './expiry.js';
import { createRouterDiagnostics } from './diagnostics.js';
import { createLifecycleProviders } from './lifecycle.js';

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
  const lifecycle = createLifecycleProviders({ env, tmux, diagnostic, log });
  const config = (overrides.readZylosConfigStrict ?? readZylosConfigStrict)();
  const poolSize = options.poolSize ?? resolveSessionPoolSize({ env, config: config.state === 'ok' ? config.config : {} });
  const providers = {
    db, readSessionMode, ...reader, readCurrentSession: readReadyIdentity,
    listGroupTmuxSessions: () => listGroupTmuxSessions(tmux), readRuntimeHealth,
    getSessionAdapter: runtime => getSessionAdapter(runtime, { tmux }), submit,
    ...lifecycle, diagnostic, log,
    alert: (event, fields) => log(`Router alert: ${event} ${JSON.stringify(fields)}`),
    maintainDiagnostics: diagnostics.maintain,
    ...overrides,
  };
  const sendStatusNotice = overrides.sendStatusNotice ?? createStatusNoticeSender({ db, log });
  const handleExpired = overrides.handleExpired ?? createPendingExpiryHandler({
    resolveSessionLaunchConfig: input => db.resolveSessionLaunchConfig(input),
    readRuntimeHealth: providers.readRuntimeHealth, sendStatusNotice,
  });
  let router;
  const delivery = createDelivery({ ...providers, getSessionMode: () => router.state.mode,
    formatConversation: overrides.formatConversation ?? formatConversation,
    notifyDelivered: overrides.notifyDelivered ?? notifyDelivered,
  }, { ...options.delivery, tmux });
  router = createRouter({ ...providers, handleExpired,
    deliverControl: overrides.deliverControl ?? delivery.deliverControl,
    deliverConversation: overrides.deliverConversation ?? delivery.deliverConversation,
  }, { ...options, poolSize });
  return { ...router, async stop() {
    // Prevent new lanes first; outstanding delivery drains before DB closure.
    const stopping = router.stop();
    await delivery.stop();
    await stopping;
  } };
}
