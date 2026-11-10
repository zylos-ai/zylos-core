import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR } from './config.js';
import { readConfigStrict } from './config-store.js';
import { validateAndDeploy } from './caddy.js';

const BEGIN = '# BEGIN zylos-core:web-console';
const END = '# END zylos-core:web-console';

export function generateWebConsoleRoute() {
  return `    ${BEGIN}
    redir /console /console/ permanent
    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:3456 {
            header_up X-Forwarded-Prefix /console
        }
    }
    ${END}`;
}

// Read only unambiguous, line-oriented Caddy directives. Unknown syntax is
// preserved for manual review rather than treated as an absent console route.
function parseDirectives(content) {
  const root = { children: [] };
  const stack = [root];
  const lines = content.split('\n');
  for (let line = 0; line < lines.length; line++) {
    const tokens = lines[line].match(/"(?:\\.|[^"\\])*"|`[^`]*`|#[^\n]*|[^\s]+/g) || [];
    const words = [];
    for (const token of tokens) {
      if (token.startsWith('#')) break;
      words.push(token.startsWith('"') || token.startsWith('`') ? token.slice(1, -1) : token);
    }
    if (!words.length) continue;
    if (words.length === 1 && words[0] === '}') {
      if (stack.length === 1) throw new Error(`unmatched closing brace at line ${line + 1}`);
      stack.pop().end = line;
      continue;
    }
    const block = words.at(-1) === '{';
    if (block) words.pop();
    if (words.includes('{') || words.includes('}')) throw new Error(`unsupported inline block at line ${line + 1}`);
    const node = { words, start: line, end: line, children: [], parent: stack.at(-1) };
    node.parent.children.push(node);
    if (block) stack.push(node);
  }
  if (stack.length !== 1) throw new Error('incomplete Caddy block');
  return root;
}

export function inspectWebConsoleRoute(content) {
  const lines = content.split('\n');
  const markerLines = [];
  let markerStart;
  let markerEnd;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^#\s*(?:BEGIN|END)\s+zylos-core:web-console\b/.test(line)) continue;
    markerLines.push(i + 1);
    if (line === BEGIN && markerStart === undefined && markerEnd === undefined) markerStart = i;
    else if (line === END && markerStart !== undefined && markerEnd === undefined) markerEnd = i;
    else return { status: 'manual_required', reason: 'Malformed or duplicate Web Console route markers', lines: markerLines };
  }
  if (markerStart !== undefined && markerEnd === undefined) {
    return { status: 'manual_required', reason: 'Unpaired Web Console route markers', lines: markerLines };
  }
  let tree;
  try { tree = parseDirectives(content); }
  catch (error) { return { status: 'manual_required', reason: error.message, lines: markerLines }; }
  const routes = [];
  const ambiguousLines = [];
  const consolePath = word => word === '/console' || word.startsWith('/console/') || word.startsWith('/console*');
  // Other path handlers do not override the more specific console handler.
  function excludesConsole(node) {
    if (!['handle', 'handle_path', 'route'].includes(node.words?.[0])) return false;
    const matcher = node.words[1];
    return matcher?.startsWith('/') && !consolePath(matcher);
  }
  function collect(node) {
    if (excludesConsole(node)) return;
    if (['handle', 'handle_path', 'path'].includes(node.words?.[0]) && node.words.slice(1).some(consolePath)) routes.push(node);
    for (const child of node.children) collect(child);
  }
  collect(tree);
  const sites = new Set(routes.map(route => {
    let site = route;
    while (site.parent && site.parent !== tree) site = site.parent;
    return site;
  }));
  // Allow only the init template's header-only Markdown handler; arbitrary
  // named matcher handlers may shadow the console proxy.
  const nonConsoleMatchers = new Map();
  for (const site of sites) {
    const safe = new Set();
    const counts = new Map();
    for (const node of site.children) counts.set(node.words[0], (counts.get(node.words[0]) || 0) + 1);
    for (const node of site.children) {
      if (node.words[0]?.startsWith('@') && node.words[1] === 'path'
          && counts.get(node.words[0]) === 1 && node.children.length === 0
          && node.words.length > 2 && node.words.slice(2).every(value => value === '*.md')) {
        safe.add(node.words[0]);
      }
    }
    nonConsoleMatchers.set(site, safe);
  }
  let unknown = false;
  function visit(node) {
    if (excludesConsole(node)) return;
    if (node.words?.[0] === 'import') unknown = true;
    if (node.words) {
      let site = node;
      while (site.parent && site.parent !== tree) site = site.parent;
      const hasConsolePath = node.words.slice(1).some(consolePath);
      if (hasConsolePath && !['handle', 'handle_path', 'path', 'redir', 'uri', 'header_up'].includes(node.words[0])) ambiguousLines.push(node.start + 1);
      if (['handle', 'handle_path', 'route', 'reverse_proxy'].includes(node.words[0])
          && node.words.slice(1).some(word => word.startsWith('@') && !(
            nonConsoleMatchers.get(site)?.has(word) && node.parent === site
            && node.words.length === 2 && node.words[0] === 'handle'
            && node.children.length === 1 && node.children[0].children.length === 0
            && node.children[0].words.join(' ') === 'header Content-Type text/plain; charset=utf-8'
          ))) ambiguousLines.push(node.start + 1);
    }
    for (const child of node.children) visit(child);
  }
  for (const site of sites) visit(site);
  const locations = [...new Set([...markerLines, ...routes.map(route => route.start + 1), ...ambiguousLines])];
  const manual = reason => ({ status: 'manual_required', reason, lines: locations });
  if (unknown) return manual('Caddy imports make Web Console route uniqueness unverifiable');
  if (ambiguousLines.length) return manual('Alternate paths or named matchers make Web Console route uniqueness unverifiable');
  if (routes.length !== 1) return manual(`Expected one Web Console route; found ${routes.length}`);
  const route = routes[0];
  if (route.words.join(' ') !== 'handle /console/*') return manual('Web Console route has a custom matcher');
  if (route.parent.parent !== tree || !route.parent.words.length
      || /^[(@]/.test(route.parent.words[0]) || route.parent.words[0] === 'route') {
    return manual('Web Console route is not directly inside a site block');
  }
  if (markerStart !== undefined && !(markerStart < route.start && markerEnd > route.end)) {
    return manual('Web Console markers do not enclose the console route');
  }
  const proxies = route.children.filter(child => child.words[0] === 'reverse_proxy');
  const strips = route.children.filter(child => child.words[0] === 'uri');
  const proxy = proxies[0];
  const headers = proxy?.children.filter(child => child.words[0] === 'header_up'
    && child.words[1]?.replace(/^[+-]/, '').toLowerCase() === 'x-forwarded-prefix') || [];
  if (proxies.length === 1 && proxy.words.join(' ') === 'reverse_proxy localhost:3456'
      && strips.length === 1 && strips[0].words.join(' ') === 'uri strip_prefix /console'
      && headers.length === 1 && headers[0].words.length === 3
      && headers[0].words[1].toLowerCase() === 'x-forwarded-prefix' && headers[0].words[2] === '/console') {
    return { status: 'unchanged' };
  }
  const index = route.parent.children.indexOf(route);
  const redirect = route.parent.children[index - 1];
  const stock = redirect?.words.join(' ') === 'redir /console /console/ permanent'
    && route.children.length === 2 && strips.length === 1 && proxies.length === 1
    && strips[0] === route.children[0] && strips[0].words.join(' ') === 'uri strip_prefix /console'
    && proxy.words.join(' ') === 'reverse_proxy localhost:3456' && proxy.children.length === 0;
  if (!stock) return manual('Web Console route differs from the stock block and does not forward the required prefix');
  const start = markerStart ?? redirect.start;
  const end = markerEnd ?? route.end;
  const actual = lines.slice(start, end + 1).join('\n').replace(/\s+/g, ' ').trim();
  const expected = `${markerStart === undefined ? '' : `${BEGIN} `}redir /console /console/ permanent handle /console/* { uri strip_prefix /console reverse_proxy localhost:3456 }${markerEnd === undefined ? '' : ` ${END}`}`;
  if (actual !== expected) return manual('Web Console stock block contains custom content');
  return { status: 'ready', content: [...lines.slice(0, start), generateWebConsoleRoute(), ...lines.slice(end + 1)].join('\n'), lines: locations };
}

export function manualWebConsoleRouteResult({ zylosDir = ZYLOS_DIR, reason, lines = [] } = {}) {
  const caddyfile = path.join(zylosDir, 'http/Caddyfile');
  const caddyBin = path.join(zylosDir, 'bin/caddy');
  return {
    status: 'manual_required', caddyfile, reason, lines,
    instructions: [
      `Inspect ${caddyfile}${lines.length ? ` at lines ${lines.join(', ')}` : ''}; preserve custom routes and leave exactly one /console/* route to localhost:3456.`,
      'Inside that route, retain uri strip_prefix /console and put header_up X-Forwarded-Prefix /console inside reverse_proxy localhost:3456 { ... } (not a comment or another upstream).',
      `Validate with ${caddyBin} validate --config ${caddyfile} --adapter caddyfile before running pm2 reload caddy.`,
      'Log in again, verify wc_session Path=/console and that /pages and /dashboard requests omit it, then verify logout clears it.',
    ],
  };
}

export function migrateWebConsoleRoute({ zylosDir = ZYLOS_DIR, ...deps } = {}) {
  const caddyfile = path.join(zylosDir, 'http/Caddyfile');
  const caddyBin = path.join(zylosDir, 'bin/caddy');
  const configFile = path.join(zylosDir, '.zylos/config.json');
  const read = deps.readFileSync || fs.readFileSync;
  const manual = (reason, lines = []) => manualWebConsoleRouteResult({ zylosDir, reason, lines });
  try {
    const config = readConfigStrict(configFile, { readFileSync: read });
    if (config.state === 'error') return manual(`Cannot read ${configFile}: ${config.error.message}`);
    let original;
    try {
      const bytes = read(caddyfile);
      original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
    }
    catch (error) {
      if (error.code === 'ENOENT' && !config.config?.domain) {
        return { status: 'not_applicable' };
      }
      return manual(`Cannot read Caddyfile: ${error.message}`);
    }
    const inspected = inspectWebConsoleRoute(original);
    if (inspected.status === 'unchanged') return { status: 'unchanged' };
    if (inspected.status !== 'ready') return manual(inspected.reason, inspected.lines);
    const deployed = (deps.validateAndDeploy || validateAndDeploy)(inspected.content, original, { ...deps, caddyfile, caddyBin });
    return deployed.success ? { status: 'updated', caddyfile } : manual(deployed.error, inspected.lines);
  } catch (error) {
    return manual(error.message);
  }
}
