import { dataError, parseSessionGroup, requireGroup } from './c4-session-group.js';

export function hostFunctions({ read, write, snapshot, get, all, run, seconds, knownGroup, internalTarget, readSessionMode }) {
  const enabled = () => {
    try { return readSessionMode?.().mode === 'multi'; }
    catch { return false; }
  };
  const hostOf = (c, group) => get(c, 'SELECT target_group FROM session_hosts WHERE source_group=?', group)?.target_group ?? null;
  const effectiveGroup = (c, group) => group !== 'origin' && enabled() ? hostOf(c, group) ?? group : group;

  return {
    effectiveGroup,
    api: {
      getSessionHost: group => group !== 'origin' && enabled() ? read(c => hostOf(c, group)) : null,
      attachSessionHost: (source, destination, requester) => write(c => {
        if (!enabled()) throw dataError('HOST_REQUIRES_MULTI', 'Session hosting requires multi-session mode.');
        if (source === 'origin') throw dataError('HOST_ORIGIN', 'Origin cannot be hosted by another session group.');
        knownGroup(c, requester);
        internalTarget(c, source);
        internalTarget(c, destination);
        const target = hostOf(c, destination) ?? destination;
        if (source === target) throw dataError('HOST_CYCLE', 'Hosting would create a cycle. Detach the existing relationship first.');

        const moved = all(c, 'SELECT source_group FROM session_hosts WHERE target_group=? ORDER BY source_group', source)
          .map(row => row.source_group);
        const at = seconds();
        const update = c.prepare(`
          INSERT INTO session_hosts(source_group,target_group,attached_by,attached_at) VALUES(?,?,?,?)
          ON CONFLICT(source_group) DO UPDATE SET target_group=excluded.target_group,
            attached_by=excluded.attached_by,attached_at=excluded.attached_at
        `);
        for (const group of [source, ...moved]) update.run(group, target, requester, at);
        const { namespace } = parseSessionGroup(source);
        const channel = get(c, 'SELECT component_name FROM channel_namespaces WHERE namespace=?', namespace).component_name;
        const notify = !get(c, 'SELECT 1 FROM session_host_allowlist WHERE channel=?', channel);
        return { source, target, moved, requester, notify };
      }),
      detachSessionHost: source => write(c => {
        requireGroup(source);
        return run(c, 'DELETE FROM session_hosts WHERE source_group=?', source).changes > 0;
      }),
      listSessionHostChannels: () => read(c =>
        all(c, 'SELECT DISTINCT component_name FROM channel_namespaces ORDER BY component_name').map(row => row.component_name)),
      listSessionHosts: () => snapshot(c => ({
        relationships: all(c, 'SELECT * FROM session_hosts ORDER BY source_group'),
        allowlist: all(c, 'SELECT channel FROM session_host_allowlist ORDER BY channel').map(row => row.channel),
      })),
      setSessionHostAllowlist: (channel, allowed) => write(c => {
        if (typeof channel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(channel) || channel.includes('..')) {
          throw dataError('INVALID_ARGS', 'Expected a channel name.');
        }
        const result = allowed
          ? run(c, 'INSERT OR IGNORE INTO session_host_allowlist(channel) VALUES(?)', channel)
          : run(c, 'DELETE FROM session_host_allowlist WHERE channel=?', channel);
        return result.changes > 0;
      }),
    },
  };
}
