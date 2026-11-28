import { fleetMood } from '../../public/js/fleet-status.js';

// Rows arrive in registry order; `position` gives each row's registry index, which the cursor carries.
export function pageFleetRows(rows, query, position) {
  const ordered = rows.map(row => ({ row, key: position(row) })).sort((a, b) => a.key - b.key);
  const matching = query.after === null ? ordered : ordered.filter(({ key }) => key > query.after);
  const page = matching.slice(0, query.limit);
  return {
    items: page.map(({ row }) => row),
    nextCursor: matching.length > query.limit ? query.nextCursor(page.at(-1).key) : null,
    ...(query.include.has('total') ? { total: rows.length } : {}),
  };
}

/** The registry rewritten in `order`, or null unless `order` names every registered machine exactly once. */
export function reorderFleetAgents(agents, order) {
  if (!Array.isArray(order) || order.length !== agents.length) return null;
  const byName = new Map(agents.map(agent => [agent.name, agent]));
  if (new Set(order).size !== order.length || !order.every(name => typeof name === 'string' && byName.has(name))) return null;
  return order.map(name => byName.get(name));
}

export function fleetSummary(agents) {
  const counts = { busy: 0, idle: 0, stuck: 0, offline: 0 };
  const summary = { count: agents.length, counts, daily_cost: null, weekly_cost: null };
  for (const agent of agents) {
    const mood = fleetMood(agent);
    if (Object.hasOwn(counts, mood)) counts[mood]++;
    for (const tier of ['daily_cost', 'weekly_cost']) {
      const value = agent[tier];
      if (value == null || value === '') continue;
      const cost = Number(value);
      if (Number.isFinite(cost)) summary[tier] = (summary[tier] ?? 0) + cost;
    }
  }
  return summary;
}

export function omitFleetChat({ chat, ...record }) {
  return record;
}

export function fleetPage(payload, query, { showChat = false } = {}) {
  const term = query.q?.toLowerCase();
  const name = query.filters.name;
  // This machine first, then remote machines in registry order.
  const rows = payload.agents.map((agent, index) => ({ agent, position: agent.self === true ? -1 : index }))
    .filter(({ agent }) => (name === undefined || agent.name === name) && (!term || agent.name.toLowerCase().includes(term)));
  const page = pageFleetRows(rows, query, row => row.position);
  return {
    ...page,
    items: page.items.map(({ agent: { latency, ...agent } }) => showChat ? agent : omitFleetChat(agent)),
    summary: fleetSummary(payload.agents),
    updated_at: payload.updated_at,
  };
}
