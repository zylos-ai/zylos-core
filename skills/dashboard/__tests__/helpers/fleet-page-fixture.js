import { fleetPage } from '../../src/lib/fleet-list.js';
import { parseListQuery } from '../../src/lib/list-query.js';

export function fleetPageFixture(payload, search = '') {
  return fleetPage(payload, parseListQuery('fleet', new URLSearchParams(search), {
    filters: { name: value => value || undefined }, q: true, include: ['total'],
  }));
}
