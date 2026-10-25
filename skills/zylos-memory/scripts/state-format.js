// Pure working-state format shared by readers, commit and mode conversion.
import { parseSessionGroup, requireGroup } from '../../comm-bridge/scripts/c4-session-group.js';
import { escapeText } from '../../comm-bridge/scripts/c4-query-format.js';

const invalidHeader = () => ({ valid: false, scope: null, coverage: null, inboxCommitted: [] });
const titles = ['# Working State', '## Headline', '## In Progress', '## Pending', '## Commitments'];
const zonedTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const segmentId = /^\d{8}T\d{9}Z(?:-[1-9]\d*)?$/;

export function parseStateHeader(text, { scope } = {}) {
  if (typeof text !== 'string') return invalidHeader();
  const first = text.split(/\r\n|\n|\r/, 1)[0];
  const match = /^<!-- zylos-state v1 \| (.*) -->$/.exec(first);
  if (!match) return invalidHeader();
  const fields = new Map();
  for (const field of match[1].split(' | ')) {
    const equal = field.indexOf('=');
    if (equal < 0 || fields.has(field.slice(0, equal))) return invalidHeader();
    fields.set(field.slice(0, equal), field.slice(equal + 1));
  }
  if (fields.size !== 4 || !['scope', 'synced_at', 'coverage', 'inbox_committed'].every(key => fields.has(key))) return invalidHeader();
  const actualScope = fields.get('scope'), syncedAt = fields.get('synced_at');
  if (actualScope !== scope || !(actualScope === '*' || parseSessionGroup(actualScope))) return invalidHeader();
  if (!zonedTime.test(syncedAt) || !Number.isFinite(Date.parse(syncedAt))) return invalidHeader();
  const rawCoverage = fields.get('coverage');
  if (rawCoverage !== '' && (!/^-?\d+$/.test(rawCoverage) || !Number.isSafeInteger(Number(rawCoverage)))) return invalidHeader();
  const inboxCommitted = fields.get('inbox_committed') === '' ? [] : fields.get('inbox_committed').split(',');
  if (inboxCommitted.some(id => !segmentId.test(id)) || new Set(inboxCommitted).size !== inboxCommitted.length) return invalidHeader();
  return { valid: true, scope: actualScope, coverage: rawCoverage === '' ? null : Number(rawCoverage), inboxCommitted };
}

// Readers need only the header; commit additionally checks the document shape.
export function validateStateDocument(text, options = {}) {
  const header = parseStateHeader(text, options);
  if (!header.valid) return false;
  const lines = new Set(text.split(/\r\n|\n|\r/));
  return titles.every(title => lines.has(title));
}

// Escape before counting bytes, and keep each escaped code point indivisible.
function displayText(value, limit, prefixLimit, suffix) {
  const escaped = escapeText(value);
  if (Buffer.byteLength(escaped) <= limit) return escaped;
  let prefix = '', bytes = 0;
  for (const character of String(value)) {
    const token = escapeText(character), size = Buffer.byteLength(token);
    if (bytes + size > prefixLimit) break;
    prefix += token;
    bytes += size;
  }
  return prefix + suffix;
}

function rowTime(timestamp) {
  const input = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ? timestamp : timestamp.replace(' ', 'T') + 'Z';
  return new Date(input).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function renderStateSkeleton({ scope, syncedAt, absorbed = null }) {
  requireGroup(scope, { global: true });
  const header = `<!-- zylos-state v1 | scope=${scope} | synced_at=${syncedAt} | coverage= | inbox_committed= -->`;
  if (!parseStateHeader(header, { scope }).valid) throw new TypeError('Invalid syncedAt');
  const rows = [...(absorbed?.rows ?? [])].sort((a, b) => a.id - b.id);
  let pending = '';
  if (rows.length) {
    const run = absorbed.runId;
    pending = `- [切换来信] run=${run} 共 ${rows.length} 条（#${rows[0].id}–#${rows.at(-1).id}）；回复：c4-send.js --absorbed-reply ${run} <id>；全文：c4-fetch.js --absorbed --run-id ${run} --id <id>\n`;
    pending += rows.map(row => {
      const route = `${scope === '*' && row.sessionGroup ? row.sessionGroup + ' ' : ''}${row.channel} ${row.endpointId ?? ''}`;
      const routeDisplay = displayText(route, 128, 125, '…');
      const body = displayText(row.content || '（无正文）', 512, 509, `…（截断，全文见 #${row.id}）`);
      return `- #${row.id} ${rowTime(row.timestamp)} [${routeDisplay}] ${body}`;
    }).join('\n') + '\n';
  }
  return `${header}\n\n# Working State\n\n## Headline\n\n## In Progress\n\n## Pending\n\n${pending}\n## Commitments\n`;
}
