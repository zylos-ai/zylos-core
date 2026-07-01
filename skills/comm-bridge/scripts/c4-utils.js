import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildReplyViaSuffix(channel, endpointId) {
  if (!channel || !endpointId) return '';
  return ` ---- reply via: node ${path.join(__dirname, 'c4-send.js')} "${channel}" "${endpointId}"`;
}

export function hasLegacyReplyViaSuffix(content = '') {
  return /---- reply via: node\b.*\bc4-send\.js\b/.test(content);
}
