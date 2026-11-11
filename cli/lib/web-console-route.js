import fs from 'node:fs';
import path from 'node:path';
import { validateAndDeploy } from './caddy.js';

const marker = '# Web Console (core built-in)';
const generated = [
  marker,
  'handle /console/* {',
  'uri strip_prefix /console',
  'reverse_proxy localhost:3456',
  '}',
];

// Track strings and comments so braces in quoted Caddy values cannot select
// a different site. Only a direct child of the first site can be generated.
function primarySite(content) {
  let depth = 0, quote = null, comment = false, start = -1, primary = null;
  const depths = new Map();
  let lineStart = 0;
  for (let i = 0; i < content.length; i++) {
    if (i === lineStart) depths.set(i, depth);
    const char = content[i];
    if (char === '\n') { comment = false; lineStart = i + 1; }
    if (comment) continue;
    if (quote) {
      if (char === '\\' && quote !== '`') { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '#') { comment = true; continue; }
    if (char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') {
      if (depth === 0) {
        const label = content.slice(lineStart, i).trim();
        start = label && !label.startsWith('(') && primary === null ? i : -1;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth < 0) return null;
      if (depth === 0 && start >= 0) { primary = {start, end:i}; start = -1; }
    }
  }
  return depth === 0 && !quote && primary ? {...primary, depths} : null;
}

export function inspectWebConsoleRoute(content) {
  const lines = [];
  const matcher = /[^\n]*(?:\n|$)/g;
  for (const match of content.matchAll(matcher)) {
    if (!match[0]) continue;
    lines.push({raw:match[0], text:match[0].trim(), offset:match.index});
  }
  const related = lines.filter(line => /\/console|:3456/.test(line.raw));
  const markers = lines.map((line, index) => line.text === marker ? index : -1).filter(index => index >= 0);
  if (!related.length && !markers.length) return {state:'absent', related:[]};
  const refusal = {state:'manual', related:related.map(line => line.raw.replace(/\r?\n$/, ''))};
  if (markers.length !== 1) return refusal;
  const first = markers[0];
  const expected = [...generated];
  if (lines[first + 1]?.text === 'redir /console /console/ permanent') expected.splice(1, 0, 'redir /console /console/ permanent');
  if (!expected.every((text, index) => lines[first + index]?.text === text)) return refusal;
  const last = first + expected.length - 1;
  const site = primarySite(content);
  if (!site || lines[first].offset < site.start || lines[last].offset > site.end || site.depths.get(lines[first].offset) !== 1) return refusal;
  if (related.some(line => line.offset < lines[first].offset || line.offset > lines[last].offset)) return refusal;
  const start = first > 0 && lines[first - 1].text === '' ? first - 1 : first;
  const begin = lines[start].offset;
  const end = lines[last].offset + lines[last].raw.length;
  return {state:'generated', content:content.slice(0, begin) + content.slice(end), related:refusal.related};
}

/** Warning-only cleanup. The caller runs this after Core service verification. */
export function removeWebConsoleRoute({zylosDir, noCaddy = false, deploy = validateAndDeploy} = {}) {
  const caddyfile = path.join(zylosDir, 'http/Caddyfile');
  const caddyBin = path.join(zylosDir, 'bin/caddy');
  if (noCaddy || !fs.existsSync(caddyfile) || !fs.existsSync(caddyBin)) return {changed:false, warnings:[]};
  const manual = related => `Web Console has been removed. Remove the obsolete lines from ${caddyfile}${related.length ? ':\n' + related.join('\n') : '.'}\nReload with: pm2 reload caddy`;
  try {
    const original = fs.readFileSync(caddyfile, 'utf8');
    const inspection = inspectWebConsoleRoute(original);
    if (inspection.state === 'absent') return {changed:false, warnings:[]};
    if (inspection.state === 'manual') return {changed:false, warnings:[manual(inspection.related)]};
    const result = deploy(inspection.content, original, {caddyfile, caddyBin});
    if (!result.success) return {changed:false, warnings:[result.error, manual(inspection.related)]};
    return {changed:true, warnings:[`Removed the generated Web Console route from ${caddyfile}.`]};
  } catch {
    return {changed:false, warnings:[`Could not inspect ${caddyfile}. Web Console has been removed; inspect its obsolete routes manually. Reload with: pm2 reload caddy`]};
  }
}
