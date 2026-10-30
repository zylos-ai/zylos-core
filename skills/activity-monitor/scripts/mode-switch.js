import { LauncherRestartConfirmation } from './launcher-restart-confirmation.js';
import { binaryCompare as groupSort } from '../../comm-bridge/scripts/c4-query-format.js';

const failure = (code, message) => Object.assign(new Error(message), { code, persisted: [] });
const modeOf = value => value?.keyPresent === false && value.mode === null ? 'single' : value?.mode;
const modes = new Set(['single', 'multi']);

/** D9 is the acceptance and recovery record. Only restart confirmation lives in
 * memory; no filesystem or diagnostic fact substitutes for a database read.
 * Admission/automatic callers hold the lifecycle queue. advance acquires it.
 */
export class ModeSwitchCoordinator {
  constructor({ db, readMode, readConfiguration, readRequests, legacyPresent, observe,
    lifecycle, serialize = operation => operation(), convert, writeMode,
    restart = new LauncherRestartConfirmation(), diagnostic = () => {}, now = Date.now } = {}) {
    Object.assign(this, { db, readMode, readConfiguration, readRequests, legacyPresent,
      observe, lifecycle, serialize, convert, writeMode, restart, diagnostic, now });
    this.lastReasons = new Map();
    this.lastAutoMigrationSkip = null;
    this.attempt = null;
  }

  event(event, row, extra = {}) {
    this.diagnostic({ event, session_group: '*', run_id: row?.run_id ?? null,
      phase: row?.phase ?? null, reason: row?.reason ?? null, ...extra });
  }

  async block(row, reason, event = 'transition_blocked', extra = {}) {
    // Failed persistence must not be reported as a durable blocked state.
    if (row.reason !== reason) await this.db.setModeTransitionPhase(row.run_id, row.phase, { reason });
    if (this.lastReasons.get(row.run_id) !== reason) this.event(event, row, { reason, ...extra });
    this.lastReasons.set(row.run_id, reason);
  }

  async unblock(row) {
    if (row.reason !== null && row.reason !== undefined) {
      await this.db.setModeTransitionPhase(row.run_id, row.phase, { reason: null });
      this.event('transition_unblocked', row, { reason: null });
    }
    this.lastReasons.set(row.run_id, null);
  }

  async handle(request) {
    const open = await this.db.getModeTransition();
    if (open) return { ok: false, code: 'transition_open', runId: open.run_id, target: open.target_mode };
    let source;
    try { source = modeOf(await this.readMode()); if (!modes.has(source)) throw failure('CONFIG_UNREADABLE', 'Invalid session mode'); }
    catch { return { ok: false, code: 'config_unreadable' }; }
    if (source === request.target) return { ok: true, result: 'noop' };
    if (source === 'single' && request.target === 'multi' && await this.legacyPresent()) return { ok: false, code: 'legacy_session_present' };
    const requests = await this.readRequests();
    if (requests.some(row => row.reason === 'manual_restart')) return { ok: false, code: 'manual_restart_pending' };
    let current;
    try { current = modeOf(await this.readMode()); if (!modes.has(current)) throw failure('CONFIG_UNREADABLE', 'Invalid session mode'); }
    catch { return { ok: false, code: 'config_unreadable' }; }
    if (current !== source) throw failure('TRANSITION_PRECONDITION', 'Session mode changed before transition admission');
    const { runId } = await this.db.beginModeTransition(source, request.target);
    this.event('transition_begin', { run_id: runId, phase: 'gating' }, { source, target: request.target });
    return { ok: true, result: 'accepted', runId };
  }

  recordConfigurationRead(error = null) {
    if (!error) { this.lastAutoMigrationSkip = null; return; }
    const reason = error.code ?? 'CONFIG_UNREADABLE';
    if (this.lastAutoMigrationSkip !== reason) this.event('auto_migration_skipped', null, { reason });
    this.lastAutoMigrationSkip = reason;
  }

  async automatic() {
    if (await this.db.getModeTransition()) return;
    const value = await this.readMode();
    if (value.keyPresent !== false || modeOf(value) !== 'single' || await this.legacyPresent()) return;
    if ((await this.readRequests()).some(request => request.reason === 'manual_restart')) return;
    const { runId } = await this.db.beginModeTransition('single', 'multi');
    this.event('auto_migration_begin', { run_id: runId, phase: 'gating' });
  }

  async advance() {
    const attempt = await this.serialize(() => this.advanceLocked());
    if (!attempt) return;
    // PM2 never runs under the lifecycle queue. One attempt retains its write
    // baseline and timer across ticks, including successful-but-uncommitted D9.
    if (!attempt.confirmed) {
      let result;
      try { result = await this.restart.advance({ runId: attempt.runId, writtenAt: attempt.writtenAt }); }
      catch { result = { confirmed: false, pending: false }; }
      if (!result.confirmed && result.pending) return;
      if (!result.confirmed) {
        await this.serialize(async () => {
          const row = await this.db.getModeTransition();
          if (row?.run_id === attempt.runId && row.phase === 'cutover') await this.block(row, 'launcher_restart_unconfirmed', 'transition_launcher_restart_failed');
        });
        if (this.attempt === attempt) this.attempt = null;
        return;
      }
      attempt.confirmed = true;
    }
    await this.serialize(async () => {
      const row = await this.db.getModeTransition();
      if (!row || row.run_id !== attempt.runId || row.phase !== 'cutover') return;
      let mode;
      try { mode = modeOf(await this.readMode()); }
      catch { await this.block(row, 'config_unreadable'); return; }
      if (mode !== row.target_mode) { await this.block(row, `mode_conflict:${row.phase}:${mode}`); return; }
      if (!await this.onlyGlobal(row)) return;
      await this.unblock(row);
      // The store atomically verifies the global transition fence and removes it.
      await this.db.setModeTransitionPhase(row.run_id, 'complete');
      this.event('transition_complete', row, { phase: 'complete', reason: null });
      this.attempt = null;
      this.lastReasons.delete(row.run_id);
    });
  }

  async onlyGlobal(row) {
    const fences = await this.db.listDrainFences();
    if (fences.length === 1 && fences[0].sessionGroup === '*' && fences[0].reason === null && fences[0].runId === null) return true;
    const groups = fences.filter(fence => fence.sessionGroup !== '*').map(fence => fence.sessionGroup).sort(groupSort);
    await this.block(row, `fence_extra:${groups.join(',')}`);
    return false;
  }

  async advanceLocked() {
    const row = await this.db.getModeTransition();
    if (!row) return null;
    let mode;
    try { mode = modeOf(await this.readMode()); if (!modes.has(mode)) throw failure('CONFIG_UNREADABLE', 'Invalid session mode'); }
    catch { await this.block(row, 'config_unreadable'); return null; }
    if (!(['gating', 'converting'].includes(row.phase) && mode === row.source_mode || row.phase === 'cutover' && [row.source_mode, row.target_mode].includes(mode))) {
      await this.block(row, `mode_conflict:${row.phase}:${mode}`); return null;
    }
    if (row.phase === 'gating') { await this.gate(row, mode); return null; }
    if (row.phase === 'converting') {
      try { await this.convert(row); }
      catch (error) { await this.block(row, `conversion_failed:${error.step ?? 'check'}:${error.code ?? 'UNKNOWN'}`, 'transition_convert_failed', { step: error.step ?? 'check', code: error.code ?? 'UNKNOWN' }); return null; }
      if (!await this.onlyGlobal(row)) return null;
      await this.db.expirePendingControls({ machine: true });
      await this.db.expirePendingControls({ allSessionGroups: true });
      await this.unblock(row);
      await this.db.setModeTransitionPhase(row.run_id, 'cutover');
      this.event('transition_cutover', row, { phase: 'cutover', reason: null });
      return null;
    }
    if (this.attempt?.runId === row.run_id) return this.attempt;
    let writtenAt;
    try {
      if (mode === row.source_mode) await this.writeMode(row.target_mode);
      if (modeOf(await this.readMode()) !== row.target_mode) throw failure('CONFIG_UNREADABLE', 'Mode cutover readback mismatch');
      writtenAt = this.now();
    } catch (error) { await this.block(row, `config_write_failed:${error.code ?? 'UNKNOWN'}`); return null; }
    this.attempt = { runId: row.run_id, writtenAt, confirmed: false };
    return this.attempt;
  }

  async gate(row, mode) {
    await this.db.setDrainFence('*');
    const configuration = { ...await this.readConfiguration(), mode };
    const context = { configuration, transition: row, fences: await this.db.listDrainFences(), restartRequests: [], scenes: await this.observe({ configuration }) };
    if (context.scenes.some(scene => scene.observationError)) throw failure('INVALID_OBSERVATION', 'Source runtime observation is unknown');
    if (mode === 'single') {
      const scene = context.scenes.find(scene => scene.present && (scene.sessionGroup === 'origin' || scene.sessionGroup === null));
      if (scene?.ready && scene.runId) await this.lifecycle.advanceReclaim({ sessionGroup: null, reason: 'mode_switch', runId: scene.runId }, context, { unfenced: true });
    } else {
      for (const scene of context.scenes) {
        if (!scene.present || !scene.ready || !scene.runId || context.fences.some(fence => fence.sessionGroup === scene.sessionGroup)) continue;
        await this.db.setDrainFence(scene.sessionGroup, { reason: 'mode_switch', runId: scene.runId });
      }
      context.fences = await this.db.listDrainFences();
      // Lifecycle reconciliation owns stale-control cleanup and reclaim.
      // Fences created for other reasons remain owned by their producers.
      for (const fence of context.fences) if (fence.sessionGroup !== '*') await this.lifecycle.advanceReclaim(fence, context);
    }
    const missingDeadlines = [];
    for (const scope of ['machine', 'allSessionGroups']) {
      missingDeadlines.push([scope, await this.db.listRunningControlsWithoutDeadline({ [scope]: true })]);
    }
    for (const [scope, ids] of missingDeadlines) {
      if (ids.length) {
        await this.block(row, `running_control_without_deadline:${scope}:${ids.join(',')}`); return;
      }
    }
    const fences = await this.db.listDrainFences(), extra = fences.filter(fence => fence.sessionGroup !== '*');
    if (extra.length) {
      if (extra.some(fence => this.now() - fence.createdAt * 1000 > 3600000)) await this.block(row, `reclaim_waiting:${extra.map(fence => fence.sessionGroup).sort(groupSort).join(',')}`);
      else await this.unblock(row);
      return;
    }
    await this.unblock(row);
    const scenes = await this.observe({ configuration });
    if (scenes.some(scene => scene.observationError)) throw failure('INVALID_OBSERVATION', 'Source runtime observation is unknown');
    const conversations = await this.db.countGlobalRunningConversations();
    if (scenes.some(scene => scene.present) || conversations) return;
    for (const scope of ['machine', 'allSessionGroups']) {
      if ((await this.db.countNonTerminalControls({ [scope]: true })).running) return;
    }
    const result = await this.db.absorbForTransition(row.run_id);
    this.event('absorb', row, { phase: 'converting', reason: null, cutoff: result.cutoff, count: result.absorbedIds.length });
  }
}
