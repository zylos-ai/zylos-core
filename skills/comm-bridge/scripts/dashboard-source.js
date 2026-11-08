import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './c4-config.js';
import { parseAttachmentAnnotation } from './attachment-annotations.js';

// Owner identity already lives in Core memory; do not introduce a second record.
export function readOwnerName(file = path.join(DATA_DIR, '..', 'memory', 'references.md')) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const active = text.split(/^## Active IDs\s*$/m)[1]?.split(/^## /m)[0] ?? '';
    const record = active.match(/^[-*] Owner:[ \t]*([^\r\n]*)/m)?.[1] ?? '';
    const name = record.replace(/\s*[（(].*$/, '').trim();
    return !name || /^(?:none|unknown|not (?:yet established|set)|未(?:建立|确定|设置))$/i.test(name) ? 'the owner' : name;
  } catch { return 'the owner'; }
}

export function dashboardSource(content, ownerName = readOwnerName()) {
  const separator = parseAttachmentAnnotation(content.split('\n')[0]) ? '\n' : ' ';
  return `[Dashboard] ${ownerName} said:${separator}${content}`;
}
