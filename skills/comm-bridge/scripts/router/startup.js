/** Read mode exactly once and recover before installing any scheduling work. */
export async function initializeRouter(context) {
  const { deps, state, options, diagnostic } = context;
  try {
    const result = deps.readSessionMode();
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
  for (const id of recovered.ageExpired.ids) diagnostic('orphan_expired', { conversation_id: id });
  for (const id of recovered.retryExhausted.ids) diagnostic('orphan_retry_exhausted', { conversation_id: id });
  const ids = [...recovered.requeued.ids, ...recovered.ageExpired.ids, ...recovered.retryExhausted.ids];
  diagnostic('orphan_recovery_summary', { ...recovered, oldestId: ids.length ? Math.min(...ids) : null });
  if (state.mode === 'single') state.legacy = await deps.findLegacySessions();
  await context.refreshScene();
  state.ready = true;
}
