// The permissions a custom API key can hold, grouped by the asset they cover. The server checks requests against
// these names (src/lib/api-key-scope.js) and the settings page draws its checkboxes from the same list.
// Labels live in i18n under wb.settings.keys.perm.<name> and wb.settings.keys.permGroup.<group>.
export const API_KEY_PERMISSION_GROUPS = Object.freeze([
  { group: 'instance', permissions: ['instance.read', 'instance.settings', 'instance.ops'] },
  { group: 'groups', permissions: ['groups.read', 'groups.control', 'groups.settings'] },
  { group: 'usage', permissions: ['usage.read'] },
  { group: 'memory', permissions: ['memory.list', 'memory.read', 'memory.write'] },
  { group: 'schedules', permissions: ['schedules.read', 'schedules.write'] },
  { group: 'conversations', permissions: ['conversations.read', 'conversations.write'] },
  { group: 'terminal', permissions: ['terminal.read', 'terminal.control'] },
  { group: 'fleet', permissions: ['fleet.read'] },
].map(entry => Object.freeze({ ...entry, permissions: Object.freeze(entry.permissions) })));

export const API_KEY_PERMISSIONS = Object.freeze(API_KEY_PERMISSION_GROUPS.flatMap(entry => entry.permissions));

const KNOWN = new Set(API_KEY_PERMISSIONS);

/**
 * The stored form of a key scope: "read", "admin", or the permission names deduplicated, sorted and joined with
 * commas. Returns null for anything else (empty, unknown names, wrong type).
 */
export function normalizeApiKeyScope(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === 'read' || text === 'admin') return text;
  const names = text.split(',').map(name => name.trim());
  if (!text || names.some(name => !KNOWN.has(name))) return null;
  return [...new Set(names)].sort().join(',');
}

/** The permission names of a stored custom scope; empty for "read", "admin" and unreadable values. */
export function customScopePermissions(scope) {
  if (typeof scope !== 'string' || scope === 'read' || scope === 'admin') return [];
  const names = scope.split(',');
  return names.every(name => KNOWN.has(name)) ? names : [];
}
