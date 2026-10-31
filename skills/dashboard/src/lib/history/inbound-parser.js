import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const PREFIXES = [
  [/^\[TG (?:DM|GROUP)[^\]]*\]/i, 'telegram', false],
  [/^\[OPENMAX (?:DM|GROUP)[^\]]*\]/i, 'openmax', false],
  [/^\[(?:Scheduled Task|Control)[^\]]*\]/i, 'scheduler', true],
  [/^(?:Meanwhile, Heartbeat|\[Heartbeat|\[Context|System startup trigger)/i, 'system', true]
];
export function parseInbound(body) {
  body = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const prefix = PREFIXES.find(([expression]) => expression.test(body));
  const sender = body.match(/(?:from|sender)[:= ]+([^\]\n(]+)/i)?.[1]?.trim() || null;
  const fullPath = body.match(/(?:complete message file:|full message[^:\n]*:|完整消息文件[：:]?)\s*([^\s\])]+message\.txt)/i)?.[1] || null;
  return { kind: 'inbound', channel: prefix?.[1] || null, sender, system: prefix?.[2] || false,
    fields: { body }, fullPath };
}

/** Parse command text only. Never execute shell or JavaScript from a transcript. */
export function parseOutbound(command) {
  if (typeof command !== 'string' || !command.includes('c4-send.js')) return null;
  // Codex exec wraps shell command strings in JavaScript. Decode JSON strings,
  // not eval(), to recover the heredoc's real newlines.
  const wrapped = [...command.matchAll(/(?:"?cmd"?|"?command"?)\s*:\s*("(?:[^"\\]|\\.)*")/g)].find(match => match[1].includes('c4-send.js'));
  if (wrapped) { try { command = JSON.parse(wrapped[1]); } catch { /* retain original */ } }
  const header = command.split('\n').find(line => line.includes('c4-send.js')) || '';
  const after = header.slice(header.indexOf('c4-send.js') + 'c4-send.js'.length).replace(/^["']/, '').trim();
  const tokens = [...after.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s]+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  const positional = tokens.filter(token => !token.startsWith('--') && !token.startsWith('<<'));
  const channel = positional[0] || null;
  const target = positional[1] || null;
  const delimiter = header.match(/<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/);
  let body = '';
  if (delimiter) {
    const lines = command.split('\n');
    const start = lines.indexOf(header) + 1;
    const end = lines.findIndex((line, i) => i >= start && line.trim() === delimiter[1]);
    body = lines.slice(start, end < 0 ? undefined : end).join('\n');
  } else if (positional.length > 2) body = positional.slice(2).join(' ');
  return { kind: channel === 'void' ? 'internal' : 'outbound', channel, target,
    label: channel === 'void' ? 'Internal handoff' : undefined, fields: { body } };
}

export async function safeFullText(candidate, { zylosDir, toolRoot } = {}) {
  try {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) {
      return { unavailable: 'Full content unavailable: disallowed path' };
    }
    const normalized = path.normalize(candidate);
    let allowedRoot;
    if (toolRoot && path.dirname(normalized) === path.resolve(toolRoot) && /^[^/\\]+\.txt$/.test(path.basename(normalized))) {
      allowedRoot = path.resolve(toolRoot);
    } else if (zylosDir) {
      const root = path.resolve(zylosDir, 'comm-bridge', 'attachments');
      const relative = path.relative(root, normalized);
      if (/^conv-\d+[/\\]message\.txt$/.test(relative)) allowedRoot = root;
    }
    if (!allowedRoot) return { unavailable: 'Full content unavailable: disallowed path' };
    // Reject any symlink escape, including a symlink replacing an allowed root.
    const realRoot = await fs.realpath(allowedRoot);
    if (realRoot !== allowedRoot) return { unavailable: 'Full content unavailable: disallowed symlink' };
    const real = await fs.realpath(normalized);
    if (real !== normalized || !real.startsWith(realRoot + path.sep)) return { unavailable: 'Full content unavailable: disallowed symlink' };
    const file = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [stat, named] = await Promise.all([file.stat(), fs.lstat(real)]);
      if (stat.ino !== named.ino || stat.dev !== named.dev || await fs.realpath(real) !== real) return { unavailable: 'Full content unavailable: path changed' };
      if (!stat.isFile()) return { unavailable: 'Full content unavailable: not a regular file' };
      return { text: await file.readFile('utf8') };
    } finally { await file.close(); }
  } catch (error) {
    return { unavailable: error.code === 'ENOENT'
      ? `Full content file no longer exists: ${path.basename(candidate || '')}` : 'Full content unavailable: unreadable file' };
  }
}

export async function recoverInbound(entry, options) {
  const { fullPath, ...result } = entry;
  if (fullPath) {
    const recovered = await safeFullText(fullPath, options);
    result.fields.body = recovered.text ?? `${result.fields.body}\n\n${recovered.unavailable}`;
  }
  return result;
}

export function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}
export function textContent(content) {
  return contentBlocks(content).filter(block => typeof block.text === 'string').map(block => block.text).join('\n');
}
export function binaryBlock(block) {
  const source = block.source;
  if (source?.type === 'base64' && typeof source.data === 'string') {
    return { data: Buffer.from(source.data, 'base64'), mimeType: source.media_type || 'application/octet-stream',
      name: block.type === 'document' ? 'document.pdf' : 'image' };
  }
  const url = block.image_url?.url || block.image_url;
  if (typeof url === 'string') {
    const match = url.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (match) return { data: Buffer.from(match[2], 'base64'), mimeType: match[1], name: 'image' };
  }
  return null;
}
