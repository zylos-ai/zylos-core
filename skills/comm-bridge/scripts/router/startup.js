/** Read mode exactly once and recover before installing any scheduling work. */
export async function initializeRouter(context) {
  const { deps, state, options, diagnostic } = context;
  try {
    const result = deps.readSessionMode();
    state.keyPresent = result.keyPresent === true;
    state.mode = result.mode === null ? 'single' : result.mode;
    if (!['single', 'multi'].includes(state.mode)) throw Object.assign(new Error('Invalid session mode'), { code: 'CONFIG_UNREADABLE' });
  } catch (error) {
    if (error.code !== 'CONFIG_UNREADABLE') throw error;
    state.inert = true;
    diagnostic('config_unreadable', { reason: error.code });
    deps.alert?.('config_unreadable', {});
    return;
  }
  deps.log?.(`C4_PENDING_MAX_AGE_SECONDS=${options.pendingMaxAgeSeconds}`);
  deps.log?.(`C4_RECOVER_MAX_AGE_SECONDS=${options.recoverMaxAgeSeconds}`);
  const recovered = deps.db.recoverOrphanRunning({ maxAgeSeconds: options.recoverMaxAgeSeconds });
  for (const [kind, reason] of [['ageExpired', 'orphan_expired'], ['retryExhausted', 'orphan_retry_exhausted']]) {
    for (const id of recovered[kind].ids) {
      diagnostic(reason, { conversation_id: id });
      deps.sendFailureAlert?.(id, reason);
    }
  }
  const ids = [...recovered.requeued.ids, ...recovered.ageExpired.ids, ...recovered.retryExhausted.ids];
  diagnostic('orphan_recovery_summary', { ...recovered, oldestId: ids.length ? Math.min(...ids) : null });
  if (state.mode === 'single' && !state.keyPresent) {
    state.legacy = await deps.findLegacySessions();
    state.ready = true;
    return;
  }
  // Initial observation remains asynchronous, as it was for individual identities.
  // The first lane round must not consume work ahead of startup recovery.
  await context.refreshScene([], { startup: true });
  state.ready = true;
}
