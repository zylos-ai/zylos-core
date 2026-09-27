/**
 * Web Console Caddy route: forward the /console mount prefix.
 *
 * Web Console scopes its session cookie to the path Caddy forwards in
 * X-Forwarded-Prefix. `zylos init` writes the /console route once, so existing
 * instances are migrated here during `zylos upgrade --self`:
 *
 *   - the route already forwards the prefix  → silent, nothing to do
 *   - exactly one init-generated route       → rewrite it (validate, reload,
 *                                              roll back on failure)
 *   - anything else                          → leave the Caddyfile untouched
 *                                              and return instructions an
 *                                              agent can act on
 *
 * Detection is by current state, so once the route is fixed (automatically or
 * by hand) every later upgrade is silent. Until then Web Console keeps
 * Path=/ for its cookie, so no outcome here locks anyone out.
 */

import fs from 'node:fs';
import { CADDYFILE, CADDY_BIN, getZylosConfig } from './config.js';
import { validateAndDeploy } from './caddy.js';

export const WEB_CONSOLE_PREFIX = '/console';
export const WEB_CONSOLE_TARGET = 'localhost:3456';
export const WEB_CONSOLE_BEGIN = '# BEGIN zylos-core:web-console';
export const WEB_CONSOLE_END = '# END zylos-core:web-console';

const HANDLE_RE = /^[ \t]*handle[ \t]+\/console\/\*[ \t]*\{[ \t]*$/;
const PREFIX_HEADER_RE = /^[ \t]*header_up[ \t]+X-Forwarded-Prefix[ \t]+"?\/console"?[ \t]*$/i;

// The block `zylos init` has written since Web Console moved behind Caddy.
// Whitespace-tolerant; the comment and redir lines are optional.
const STOCK_BLOCK_RE = new RegExp([
  '((?:^[ \\t]*# Web Console \\(core built-in\\)[ \\t]*\\n)?',
  '(?:^[ \\t]*redir[ \\t]+/console[ \\t]+/console/[ \\t]+permanent[ \\t]*\\n)?',
  '^([ \\t]*)handle[ \\t]+/console/\\*[ \\t]*\\{[ \\t]*\\n',
  '[ \\t]*uri[ \\t]+strip_prefix[ \\t]+/console[ \\t]*\\n)',
  '[ \\t]*reverse_proxy[ \\t]+([^\\s{}#]+)[ \\t]*\\n',
  '([ \\t]*\\}[ \\t]*)$',
].join(''), 'gm');

/** The marked /console route that `zylos init` writes (indented for a site block). */
export function generateWebConsoleBlock(target = WEB_CONSOLE_TARGET, indent = '    ', { redir = true } = {}) {
  return [
    WEB_CONSOLE_BEGIN,
    '# Web Console (core built-in)',
    ...(redir ? ['redir /console /console/ permanent'] : []),
    'handle /console/* {',
    '    uri strip_prefix /console',
    `    reverse_proxy ${target} {`,
    `        header_up X-Forwarded-Prefix ${WEB_CONSOLE_PREFIX}`,
    '    }',
    '}',
    WEB_CONSOLE_END,
  ].map((line) => `${indent}${line}`).join('\n');
}

/**
 * Find every `handle /console/* {` block with its 1-based line range and body.
 * Comment lines never match, so commented-out routes are ignored.
 */
function findConsoleHandles(lines) {
  const handles = [];
  for (let i = 0; i < lines.length; i++) {
    if (!HANDLE_RE.test(lines[i])) continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < lines.length; j++) {
      const code = lines[j].replace(/#.*$/, '');
      for (const ch of code) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0) { end = j; break; }
    }
    const body = end === -1 ? lines.slice(i) : lines.slice(i, end + 1);
    handles.push({ startLine: i + 1, endLine: end === -1 ? lines.length : end + 1, body });
  }
  return handles;
}

/**
 * Classify the Caddyfile's /console route.
 *
 * @returns {{ state: 'prefixed' | 'stock' | 'unexpected', reason?: string,
 *   handles: Array<{ startLine: number, endLine: number }>, target?: string }}
 */
export function analyzeWebConsoleRoute(content) {
  const lines = content.split('\n');
  const handles = findConsoleHandles(lines);
  const ranges = handles.map(({ startLine, endLine }) => ({ startLine, endLine }));
  const target = handles
    .flatMap((h) => h.body)
    .map((line) => line.match(/^[ \t]*reverse_proxy[ \t]+([^\s{}#]+)/))
    .find(Boolean)?.[1];

  if (handles.length === 0) {
    return { state: 'unexpected', reason: 'no `handle /console/* {` route found', handles: ranges };
  }
  if (handles.every((h) => h.body.some((line) => PREFIX_HEADER_RE.test(line)))) {
    return { state: 'prefixed', handles: ranges, target };
  }
  if (handles.length > 1) {
    return { state: 'unexpected', reason: `${handles.length} \`handle /console/*\` routes found`, handles: ranges, target };
  }

  const matches = [...content.matchAll(STOCK_BLOCK_RE)];
  if (matches.length !== 1) {
    return { state: 'unexpected', reason: 'the /console route differs from the one `zylos init` generates', handles: ranges, target };
  }
  return { state: 'stock', handles: ranges, target: matches[0][3] };
}

/**
 * Rewrite the single stock block into the marked, prefix-forwarding block.
 * A redir that sits apart from the block stays where it is, so it is not
 * duplicated.
 */
export function migrateStockBlock(content) {
  return content.replace(STOCK_BLOCK_RE, (_match, head, indent, target) => (
    generateWebConsoleBlock(target, indent, { redir: /^[ \t]*redir\b/m.test(head) })
  ));
}

function manualInstructions({ caddyfile, caddyBin, found, target }) {
  const proxyTarget = target || WEB_CONSOLE_TARGET;
  return [
    'Web Console can scope its login cookie to /console once Caddy forwards the mount prefix.',
    `Found: ${found}`,
    `Caddyfile: ${caddyfile} (left unchanged)`,
    'Fix: inside the `handle /console/* { ... }` block of the zylos site, give reverse_proxy this header:',
    `        reverse_proxy ${proxyTarget} {`,
    `            header_up X-Forwarded-Prefix ${WEB_CONSOLE_PREFIX}`,
    '        }',
    `Verify: "${caddyBin}" validate --config "${caddyfile}" --adapter caddyfile && pm2 reload caddy,`,
    'then log in via /console/ and check that the wc_session cookie has Path=/console.',
    'Until then Web Console keeps working with a Path=/ cookie. Once the header is in place, later upgrades skip this check silently.',
  ].join('\n');
}

function describeHandles(analysis) {
  const where = analysis.handles.map((h) => `lines ${h.startLine}-${h.endLine}`).join(', ');
  return where ? `${analysis.reason} (${where})` : analysis.reason;
}

/**
 * Check the /console route and migrate it when it is the stock block.
 *
 * @param {object} [deps] - Test seam
 * @returns {{ status: 'skipped' | 'done' | 'warning', message: string }}
 */
export function ensureWebConsolePrefix(deps = {}) {
  const fsApi = deps.fs || fs;
  const caddyfile = deps.caddyfile || CADDYFILE;
  const caddyBin = deps.caddyBin || CADDY_BIN;
  const config = (deps.getZylosConfig || getZylosConfig)();
  const deploy = deps.validateAndDeploy
    || ((next, original) => validateAndDeploy(next, original, { caddyfile, caddyBin }));

  const hasCaddyfile = fsApi.existsSync(caddyfile);
  if (!config?.domain || (!hasCaddyfile && !fsApi.existsSync(caddyBin))) {
    return { status: 'skipped', message: 'Caddy not set up' };
  }
  if (!hasCaddyfile) {
    return {
      status: 'warning',
      message: [
        `Caddy is configured for ${config.domain} but ${caddyfile} does not exist, so Web Console is not reachable via /console.`,
        'Fix: run `zylos init`; it regenerates the Caddyfile with a /console route that forwards X-Forwarded-Prefix /console.',
        'Later upgrades skip this check silently once that route is in place.',
      ].join('\n'),
    };
  }

  const original = fsApi.readFileSync(caddyfile, 'utf8');
  const analysis = analyzeWebConsoleRoute(original);
  if (analysis.state === 'prefixed') {
    return { status: 'skipped', message: 'already forwards /console' };
  }
  if (analysis.state === 'unexpected') {
    return {
      status: 'warning',
      message: manualInstructions({ caddyfile, caddyBin, found: describeHandles(analysis), target: analysis.target }),
    };
  }

  const result = deploy(migrateStockBlock(original), original);
  if (!result.success) {
    return {
      status: 'warning',
      message: manualInstructions({
        caddyfile,
        caddyBin,
        found: `the stock /console route could not be updated automatically: ${result.error}`,
        target: analysis.target,
      }),
    };
  }
  return { status: 'done', message: 'Caddy now forwards /console to Web Console' };
}
