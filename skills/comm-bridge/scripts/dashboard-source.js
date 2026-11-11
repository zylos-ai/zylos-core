import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './c4-config.js';
import { parseAttachmentAnnotation } from './attachment-annotations.js';

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

export function dashboardSource(content, ownerName = readOwnerName()) {
  const lines = content.split('\n');
  let tail = lines.length;
  // Generated annotations form a suffix; angle-bearing lookalikes stay escaped.
  while (tail > 0 && !/[<>]/.test(lines[tail - 1]) && parseAttachmentAnnotation(lines[tail - 1])) {
    tail--;
  }
  const body = lines.slice(0, tail), annotations = lines.slice(tail);
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const message = `[Dashboard]\n<current-message>\n${escape(ownerName)} said: ${escape(body.join('\n'))}\n</current-message>`;
  return message + (annotations.length ? '\n' + annotations.join('\n') : '');
}
