import path from 'node:path';
import { PENDING_MAX_AGE_SECONDS, SKILLS_DIR } from '../c4-config.js';
import { parseC4Timestamp, replyVia, shellQuote } from '../c4-query-format.js';
import { truncateForDelivery } from '../c4-utils.js';
import { projectC4Content } from '../c4-content-projection.js';
import { splitContentAndAttachments } from '../attachment-annotations.js';
import { dashboardSource, readOwnerName } from '../dashboard-source.js';

const sendPath = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-send.js');

// Only remove a complete trailing legacy command. An embedded example followed
// by prose is message content. Multiline routes require exact original D1 args.
function withoutLegacyRoute(content, row) {
  const offset = content.lastIndexOf('---- reply via: node');
  if (offset < 0) return content;
  const suffix = content.slice(offset);
  const prefix = /^---- reply via: node [^\r\n]*\bc4-send\.js /;
  const match = suffix.match(prefix);
  if (!match) return content;
  const args = suffix.slice(match[0].length);
  const originalArgs = `"${row.channel}" "${row.endpoint_id}"`;
  if (args !== originalArgs && !/^"[^"\r\n]*" "[^"\r\n]*"$/.test(args)) return content;
  return content.slice(0, offset).trimEnd();
}

function queueNotice(row, now) {
  if (row.direction !== 'in' || typeof row.timestamp !== 'string') return '';
  const received = parseC4Timestamp(row.timestamp);
  const elapsed = now - received.getTime();
  if (!Number.isFinite(elapsed) || elapsed <= PENDING_MAX_AGE_SECONDS * 1000) return '';

  let minutes = Math.floor(elapsed / 60000);
  const duration = [];
  for (const [size, unit] of [[1440, 'd'], [60, 'h'], [1, 'm']]) {
    const count = Math.floor(minutes / size);
    if (count > 0) duration.push(`${count}${unit}`);
    if (duration.length === 2) break;
    minutes %= size;
  }

  const formatter = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const { timeZone } = formatter.resolvedOptions();
  const { year, month, day, hour, minute } = Object.fromEntries(
    formatter.formatToParts(received).map(({ type, value }) => [type, value]),
  );
  return `[C4] This message waited in the queue for ${duration.join(' ') || '<1m'} (received ${year}-${month}-${day} ${hour}:${minute} ${timeZone}). Check whether it still applies before acting on it.\n`;
}

export function formatConversation(row, { scriptPath = sendPath, ownerName = readOwnerName, lookupQuote, pasteCharThreshold, now = Date.now() } = {}) {
  const projected = withoutLegacyRoute(projectC4Content(row.content || '', { c4Id: row.id }), row);
  const content = row.channel === 'dashboard' && row.direction === 'in' ? dashboardSource(projected, ownerName(), { row, lookupQuote }) : projected;
  const attachmentHint = row.channel === 'dashboard' && row.direction === 'in'
    && splitContentAndAttachments(projected).attachments.length
    ? `\nAttachments: ${path.join(SKILLS_DIR, 'dashboard', 'SKILL.md')}\n`
    : '';
  const componentHint = row.channel === 'dashboard' && row.direction === 'in'
    ? `\nCharts/choices/forms when useful: node ${shellQuote(path.join(SKILLS_DIR, 'dashboard', 'scripts', 'components.js'))} list --json\n`
    : '';
  const suffix = componentHint + (row.endpoint_id ? `${attachmentHint} ${replyVia(row, scriptPath)}` : '');
  return truncateForDelivery(content, suffix, row.id, pasteCharThreshold, queueNotice(row, now));
}
