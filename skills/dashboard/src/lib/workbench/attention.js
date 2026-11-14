export function createChannelDownCounter() {
  const counts = new Map();
  return {
    update(data) {
      const statuses = new Map(data.processes.map(process => [process.name, process.pm2_env?.status]));
      for (const name of new Set([...counts.keys(), ...statuses.keys()])) counts.set(name, statuses.get(name) === 'online' ? 0 : (counts.get(name) ?? 0) + 1);
    },
    get(service) { return counts.get(service) ?? 0; },
  };
}

export function buildAttention(snapshot, { channelDownCounter, pm2Data } = {}) {
  const problems = [], reminders = [], rows = snapshot.rows;
  if (snapshot.instance.supervisorPaused === true) reminders.push({ kind: 'supervisor_paused' });
  const health = snapshot.instance.runtimeHealth ?? {};
  for (const runtime of ['claude', 'codex']) {
    const record = health[runtime];
    if (record?.health === 'auth_failed') {
      const affected = rows.filter(row => row.target.runtime === runtime &&
        (['running', 'starting'].includes(row.presence) || row.queue.known !== false && row.queue.pending.count > 0));
      const extraUnknown = rows.filter(row => !affected.includes(row) &&
        (row.target.runtime == null && (['running', 'starting'].includes(row.presence) || row.queue.known === false || row.queue.pending.count > 0) ||
        row.target.runtime === runtime && row.presence === 'not_running' && row.queue.known === false)).length;
      problems.push({ kind: 'auth_failed', runtime, groups: affected.map(row => row.sessionGroup), extraUnknown });
    }
    if (['rate_limited', 'recovering'].includes(record?.health)) reminders.push({ kind: 'rate_limited', runtime, until: record.cooldownUntil });
  }
  for (const row of rows) if (row.wait?.kind === 'start_failed') problems.push({ kind: 'start_failed', group: row.sessionGroup,
    count30m: row.wait.count30m, lastAt: row.wait.lastAt });
  const pool = snapshot.instance.pool, waiting = rows.filter(row => row.wait?.kind === 'pool_wait').length;
  if (pool?.used != null && pool.capacity != null && pool.used >= pool.capacity && waiting > 0) {
    reminders.push({ kind: 'pool_full', waiting });
  }
  const services = new Set(rows.flatMap(row => row.c4?.componentName ? ['zylos-' + row.c4.componentName] : []));
  for (const service of services) if ((channelDownCounter?.get(service) ?? 0) >= 2) problems.push({ kind: 'channel_down', service,
    pm2Status: pm2Data?.processes.find(process => process.name === service)?.pm2_env?.status ?? null });
  for (const source of ['status', 'c4', 'q', 'ov']) if (snapshot.sources[source]?.ok === false) problems.push({ kind: 'data_unreadable', source: snapshot.sources[source].reason });
  return { ok: problems.length === 0 && reminders.length === 0, problems, reminders };
}
