// Recording fixture for the agent procedure. This is deliberately not a runtime
// executor: its evidence covers command ordering and failure exits, not whether
// a real model follows the skill or chooses a correct summary/follow-up list.
export async function runWorkingSync(call, { kind = 'group' } = {}) {
  const log = [], warnings = [];
  let token, outcome = 'success';
  const step = async (name, args = {}) => { log.push(name); return call(name, { kind, token, ...args }); };
  try {
    try { token = await step('acquire'); }
    catch (error) { return { outcome: error.code === 'SYNC_BUSY' ? 'busy' : 'failed', error, log, warnings }; }
    const range = await step('range');
    if (range.count) {
      const batch = await step('fetch', { upTo: range.safeEnd });
      await step('cleanup');
      await step('rotate');
      const memory = await step('readMemory');
      await step('differences', { after: memory.coverage ?? 0 });
      const draft = await step('prepare', { batch, memory });
      if (kind === 'global') {
        await step('selfWrite', { draft });
        if (draft.identityChanged) {
          try { await step('requestRotation'); } catch (error) { warnings.push(error); }
        }
      }
      await step('checkpoint', { end: batch.end, summary: draft.summary });
      await step('editMemory', { text: draft.state });
      await step('commit', { followedUpIds: draft.followedUpIds });
    } else outcome = 'empty';
  } catch (error) {
    if (error.code === 'TOKEN_MISMATCH') return { outcome: 'takenOver', error, log, warnings };
    outcome = 'failed';
    warnings.push(error);
  }
  try { await step('release'); } catch (error) { warnings.push(error); }
  return { outcome, log, warnings };
}

export async function runOriginSync(call, { budget = 50 } = {}) {
  const log = [], failures = [], prepared = [];
  let token, identityChanged = false;
  const step = async (name, args = {}) => { log.push({ name, ...args }); return call(name, { token, ...args }); };
  try {
    try { token = await step('acquire'); }
    catch (error) { return { outcome: error.code === 'SYNC_BUSY' ? 'busy' : 'failed', error, log }; }
    const backlog = await step('backlog');
    for (const group of [...backlog].sort((a,b) => a.cursorUpdatedAt - b.cursorUpdatedAt || a.sessionGroup.localeCompare(b.sessionGroup))) {
      try {
        const summary = await step('summaries', { group: group.sessionGroup });
        let synced = Math.max(group.cursorFrom, Math.min(summary.coverageEnd, group.upTo));
        if (budget > 0) {
          const raw = await step('raw', { group: group.sessionGroup, after: summary.coverageEnd, limit: budget });
          budget -= raw.rows.length;
          synced = raw.truncated ? raw.rows.at(-1).id : group.upTo;
        } else if (!summary.summaries.length) continue;
        await step('sessions', { group: group.sessionGroup });
        const edited = await step('selfWrite', { group: group.sessionGroup });
        identityChanged ||= Boolean(edited.identityChanged);
        prepared.push({ group: group.sessionGroup, synced, checkpoint: summary.checkpointId });
      } catch (error) {
        if (error.code === 'TOKEN_MISMATCH') throw error;
        failures.push({ group: group.sessionGroup, error });
      }
    }
    if (identityChanged) {
      try { await step('requestRotation'); } catch (error) { failures.push({ rotation: true, error }); }
    }
    for (const args of prepared) {
      try { await step('advance', args); }
      catch (error) {
        if (error.code === 'TOKEN_MISMATCH') throw error;
        failures.push({ group: args.group, error });
      }
    }
  } catch (error) {
    if (error.code === 'TOKEN_MISMATCH') return { outcome: 'takenOver', log, error, failures };
    failures.push({ error });
  }
  try { await step('release'); } catch (error) { failures.push({ release: true, error }); }
  return { outcome: failures.length ? 'partial' : 'success', log, failures, remaining: budget };
}
