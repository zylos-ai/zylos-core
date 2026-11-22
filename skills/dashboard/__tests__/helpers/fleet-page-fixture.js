import { compareFleetNames, fleetPage, pageFleetRows } from '../../src/lib/fleet-list.js';
import { parseListQuery } from '../../src/lib/list-query.js';

export function fleetPageFixture(payload, search = '') {
  return fleetPage(payload, parseListQuery('fleet', new URLSearchParams(search), {
    filters: { name: value => value || undefined }, q: true, include: ['total'],
  }));
}

export function fleetSettingsPageFixture(agents, search, name) {
  const query = parseListQuery('fleet-agents', new URLSearchParams(search), { q: true, include: ['total'] });
  const term = query.q?.toLowerCase();
  const rows = agents.filter(agent => !term || agent.name.toLowerCase().includes(term));
  return { ...pageFleetRows(rows, query, agent => agent.name, compareFleetNames), self: { name } };
}
