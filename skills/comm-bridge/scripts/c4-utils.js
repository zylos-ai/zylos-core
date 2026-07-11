import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  FILE_SIZE_THRESHOLD,
  ATTACHMENTS_DIR,
  CONTENT_PREVIEW_CHARS
} from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildReplyViaSuffix(channel, endpointId) {
  if (!channel || !endpointId) return '';
  return ` ---- reply via: node ${path.join(__dirname, 'c4-send.js')} "${channel}" "${endpointId}"`;
}

export function hasLegacyReplyViaSuffix(content = '') {
  return /---- reply via: node\b.*\bc4-send\.js\b/.test(content);
}

// Fallback counter for spills without a conversation id: two spills within
// the same millisecond (e.g. a renderer looping over several long messages)
// must never resolve to the same directory and silently overwrite each other.
let spillSeq = 0;

export function truncateForDelivery(content, replyViaSuffix = '', convId) {
  const fullMessage = content + replyViaSuffix;
  const byteLength = Buffer.byteLength(fullMessage, 'utf8');

  if (byteLength <= FILE_SIZE_THRESHOLD) {
    return fullMessage;
  }

  // Prefer the conversation id: globally unique (DB primary key), directly
  // traceable back to the row, and re-rendering the same message becomes an
  // idempotent overwrite of one directory instead of piling up copies.
  const msgId = (convId !== undefined && convId !== null)
    ? `conv-${convId}`
    : `${Date.now()}-${process.pid}-${spillSeq++}`;
  const messageDir = path.join(ATTACHMENTS_DIR, msgId);
  fs.mkdirSync(messageDir, { recursive: true });
  const filePath = path.join(messageDir, 'message.txt');
  fs.writeFileSync(filePath, fullMessage, 'utf8');

  const preview = content.substring(0, CONTENT_PREVIEW_CHARS);
  const ellipsis = preview.length < content.length ? '...' : '';
  const sizeKB = (byteLength / 1024).toFixed(1);
  return `${preview}${ellipsis}\n\n[C4] Full message (${sizeKB}KB) at: ${filePath}${replyViaSuffix}`;
}
