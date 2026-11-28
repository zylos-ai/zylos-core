import { fleetMood } from '../../public/js/fleet-status.js';

const names = new Intl.Collator('en');

// The binary tie-breaker keeps distinct names unique even if they collate alike.
export function compareFleetNames(a, b) {
  return names.compare(a, b) || Number(a > b) - Number(a < b);
}

export function pageFleetRows(rows, query, position, compare) {
  const ordered = rows.map(row => ({ row, key: position(row) })).sort((a, b) => compare(a.key, b.key));
  const matching = query.after === null ? ordered : ordered.filter(({ key }) => compare(key, query.after) > 0);
  const page = matching.slice(0, query.limit);
  return {
    items: page.map(({ row }) => row),
    nextCursor: matching.length > query.limit ? query.nextCursor(page.at(-1).key) : null,
    ...(query.include.has('total') ? { total: rows.length } : {}),
  };
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
  const rows = payload.agents.filter(agent => (name === undefined || agent.name === name) &&
    (!term || agent.name.toLowerCase().includes(term)));
  const page = pageFleetRows(rows, query, agent => [Number(agent.self !== true), agent.name],
    (a, b) => a[0] - b[0] || compareFleetNames(a[1], b[1]));
  return {
    ...page,
    items: page.items.map(({ latency, ...agent }) => showChat ? agent : omitFleetChat(agent)),
    summary: fleetSummary(payload.agents),
    updated_at: payload.updated_at,
  };
}
