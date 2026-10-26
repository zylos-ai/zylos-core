import path from 'node:path';
import { SKILLS_DIR } from '../c4-config.js';
import { replyVia } from '../c4-query-format.js';
import { truncateForDelivery } from '../c4-utils.js';

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
  const content = withoutLegacyRoute(row.content || '', row);
  const suffix = row.endpoint_id ? ` ${replyVia(row, scriptPath)}` : '';
  return truncateForDelivery(content, suffix, row.id);
}
