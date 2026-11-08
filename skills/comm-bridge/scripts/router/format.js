import path from 'node:path';
import { SKILLS_DIR } from '../c4-config.js';
import { replyVia, shellQuote } from '../c4-query-format.js';
import { truncateForDelivery } from '../c4-utils.js';
import { projectC4Content } from '../c4-content-projection.js';
import { splitContentAndAttachments } from '../attachment-annotations.js';

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

export function formatConversation(row, { scriptPath = sendPath } = {}) {
  const content = withoutLegacyRoute(projectC4Content(row.content || '', { c4Id: row.id }), row);
  const attachmentHint = row.channel === 'dashboard' && row.direction === 'in'
    && splitContentAndAttachments(content).attachments.length
    ? `\nAttachments: ${path.join(SKILLS_DIR, 'dashboard', 'SKILL.md')}\n`
    : '';
  const componentHint = row.channel === 'dashboard' && row.direction === 'in'
    ? `\nCharts/choices/forms when useful: node ${shellQuote(path.join(SKILLS_DIR, 'dashboard', 'scripts', 'components.js'))} list --json\n`
    : '';
  const suffix = componentHint + (row.endpoint_id ? `${attachmentHint} ${replyVia(row, scriptPath)}` : '');
  return truncateForDelivery(content, suffix, row.id);
}
