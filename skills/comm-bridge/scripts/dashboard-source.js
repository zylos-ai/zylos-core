import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './c4-config.js';
import { parseAttachmentAnnotation, splitContentAndAttachments } from './attachment-annotations.js';
import { parseC4Content } from './c4-content-schema.js';
import { parseChatQuote, stripChatQuote } from './chat-quote.js';

// Owner identity already lives in Core memory; do not introduce a second record.
export function readOwnerName(file = path.join(DATA_DIR, '..', 'memory', 'references.md')) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const active = text.split(/^## Active IDs\s*$/m)[1]?.split(/^## /m)[0] ?? '';
    const record = active.match(/^- Owner: ([^\r\n]*)/m)?.[1] ?? '';
    const value = record.trim();
    return value.replace(/\s*[（(].*$/, '').trim() || 'the owner';
  } catch { return 'the owner'; }
}

export function resolveDashboardQuote(row, database) {
  const quote = parseChatQuote(row.content || '');
  if (!quote || !Number.isSafeInteger(row.id)
      || !row.session_group || ['origin', '*'].includes(row.session_group)) return null;
  return database.prepare(`SELECT * FROM conversations
    WHERE id=? AND session_group=? AND id<? AND direction IN ('in','out')`)
    .get(quote.id, row.session_group, row.id) ?? null;
}

function quotedText(row) {
  let content = stripChatQuote(row.content || '');
  const parsed = parseC4Content(content);
  const files = parsed.kind === 'envelope' ? (parsed.envelope.blocks ?? [])
    .filter(block => ['x-zylos.image', 'x-zylos.file'].includes(block.type))
    .map(block => block.data.nameSnapshot) : [];
  if (parsed.kind !== 'text') content = parsed.kind === 'envelope'
    ? parsed.envelope.fallbackText : parsed.fallbackText ?? '';
  if (row.channel === 'internal' && row.direction === 'in') {
    for (const prefix of [
      `[internal] Yourself, from your "${row.endpoint_id}" session group, said: `,
      `[internal] ${row.endpoint_id} said: `,
    ]) if (content.startsWith(prefix)) { content = content.slice(prefix.length); break; }
  }
  const split = splitContentAndAttachments(content);
  const text = [split.content, ...split.attachments.map(file => `（附件：${file.name}）`),
    ...files.map(name => `（附件：${name}）`)].filter(Boolean).join('\n');
  const chars = Array.from(text);
  return chars.length > 4000 ? chars.slice(0, 4000).join('') + `……（已截断，全文见 c4_id=${row.id}）` : text;
}

export function dashboardSource(content, ownerName = readOwnerName(), { row, lookupQuote } = {}) {
  const quote = parseChatQuote(content);
  const original = quote && row && lookupQuote?.(row);
  const valid = original && original.id === quote.id;
  if (valid) content = quote.content;
  const lines = content.split('\n');
  let tail = lines.length;
  // Generated annotations form a suffix; angle-bearing lookalikes stay escaped.
  while (tail > 0 && !/[<>]/.test(lines[tail - 1]) && parseAttachmentAnnotation(lines[tail - 1])) {
    tail--;
  }
  const body = lines.slice(0, tail), annotations = lines.slice(tail);
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const sender = valid && (original.direction === 'out' ? 'AI'
    : original.channel === 'internal' ? original.endpoint_id : ownerName);
  const replying = valid ? `\n<replying-to>\n[${escape(sender)}]: ${escape(quotedText(original))}\n</replying-to>\n` : '';
  const message = `[Dashboard]${replying}\n<current-message>\n${escape(ownerName)} said: ${escape(body.join('\n'))}\n</current-message>`;
  return message + (annotations.length ? '\n' + annotations.join('\n') : '');
}
