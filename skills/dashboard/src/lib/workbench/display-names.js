import { parseSessionGroup } from '../../../../comm-bridge/scripts/c4-session-group.js';
import { Sanitizer } from '../sanitizer.js';
import { createCoreCli } from './core-cli.js';

const error = (code, message) => Object.assign(new Error(message), { code });
const platforms = { telegram: 'Telegram', lark: 'Lark', feishu: '飞书', 'web-console': '网页控制台', openmax: 'OpenMax', wechat: '微信' };
const project = (key, row) => ({ sessionGroup: key, displayName: row?.display_name ?? null, source: row?.source ?? null });
// Naming reads the redacted preview text only; the unredacted current-message field and its source are not passed on.
const withoutMessage = ({ message, messageSource, ...preview }) => preview;

export function validKey(key) { return key !== 'origin' && parseSessionGroup(key) !== null; }
export function validName(name) {
  if (typeof name !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return null;
  const trimmed = name.trim(), length = Array.from(trimmed).length;
  return length >= 1 && length <= 40 ? trimmed : null;
}
export function fallbackName(key, componentName) {
  const parsed = parseSessionGroup(key);
  if (key === 'origin') return '系统助手';
  if (!parsed) return key;
  const component = componentName ?? parsed.namespace, platform = platforms[component] ?? component;
  return parsed.groupName === null ? platform : `${platform} · ${parsed.groupName}`;
}

export function createDisplayNames({ store, zylosDir, runC4Db = createCoreCli({ zylosDir }).runC4Db,
  sanitizer = new Sanitizer(zylosDir ?? ''), now = Date.now } = {}) {
  function requireKey(key) { if (!validKey(key)) throw error('KEY_INVALID', 'Invalid session group'); }
  function write(key, name, source, clear) {
    requireKey(key);
    const selected = clear ? null : validName(name);
    if (!clear && selected === null) throw error('NAME_INVALID', 'Name must contain 1 to 40 characters without control characters');
    if (!store.writeGroupDisplayName(key, selected, source, { clear })) throw error('NAME_SET_BY_HUMAN', 'A human-set name cannot be changed by an agent');
    return project(key, store.getGroupDisplayName(key));
  }
  return {
    setName: (key, name, source) => write(key, name, source, false),
    clearName: (key, source) => write(key, null, source, true),
    getName(key) { requireKey(key); return project(key, store.getGroupDisplayName(key)); },
    listAll: () => new Map(store.listGroupDisplayNames().map(row => [row.session_group, project(row.session_group, row)])),
    search: (q, limit = 50) => store.searchGroupDisplayNames(q, limit).map(row => project(row.session_group, row)),
    async listNames({ unnamed = false, activeSinceMs } = {}) {
      const args = activeSinceMs === undefined ? ['groups', '--json'] : ['groups', '--active-since', String(now() - activeSinceMs), '--json'];
      const result = await runC4Db(args);
      if (!result.ok) throw error('C4_GROUPS_FAILED', 'Cannot read session groups');
      const groups = activeSinceMs === undefined ? result.data : result.data?.groups;
      if (!Array.isArray(groups)) throw error('C4_GROUPS_FAILED', 'Cannot read session groups');
      return groups.filter(row => row.sessionGroup !== 'origin' && (!unnamed || !store.getGroupDisplayName(row.sessionGroup)))
        .map(row => ({ sessionGroup: row.sessionGroup, fallbackName: fallbackName(row.sessionGroup, row.componentName),
          lastActivityAt: row.lastActivityAt ?? null,
          preview: row.preview ? { ...withoutMessage(row.preview), text: sanitizer.safeSummary(row.preview.text, 80) } : null }));
    },
  };
}
