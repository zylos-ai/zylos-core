/**
 * Caddy route management for zylos components.
 *
 * Components declare `http_routes` in SKILL.md frontmatter.
 * This module manages marker-based route blocks in the Caddyfile:
 *   # BEGIN zylos-component:<name>
 *   ...routes...
 *   # END zylos-component:<name>
 *
 * Routes are inserted inside the existing domain { ... } block.
 * Uses `caddy validate` before reload; auto-rollback on failure.
 *
 * User-space Caddy:
 *   Binary:    ~/zylos/bin/caddy
 *   Caddyfile: ~/zylos/http/Caddyfile
 *   Managed by PM2 (no sudo needed for validate/reload)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { CADDYFILE, CADDY_BIN, getZylosConfig } from './config.js';

/**
 * Check if Caddy is available (binary + Caddyfile exist).
 */
export function isCaddyAvailable(zylosDir) {
  const caddyBin = zylosDir ? path.join(zylosDir, 'bin/caddy') : CADDY_BIN;
  const caddyfile = zylosDir ? path.join(zylosDir, 'http/Caddyfile') : CADDYFILE;
  return fs.existsSync(caddyBin) && fs.existsSync(caddyfile);
}

/**
 * Generate Caddy handle blocks from http_routes array.
 *
 * Supported route types:
 *   - reverse_proxy: proxies to a target, optionally stripping a prefix
 *
 * @param {Array} httpRoutes - Array of { path, type, target, strip_prefix? }
 * @returns {string} Caddy configuration block (indented for domain block)
 */
export function generateRouteBlocks(httpRoutes) {
  const lines = [];
  for (const route of httpRoutes) {
    if (route.type === 'reverse_proxy') {
      // For wildcard paths like /foo/*, redirect bare /foo to /foo/
      if (route.path.endsWith('/*')) {
        const basePath = route.path.slice(0, -2);
        lines.push(`    redir ${basePath} ${basePath}/ permanent`);
      }
      lines.push(`    handle ${route.path} {`);
      if (route.strip_prefix) {
        lines.push(`        uri strip_prefix ${route.strip_prefix}`);
      }
      if (route.strip_prefix) {
        lines.push(`        reverse_proxy ${route.target} {`);
        lines.push(`            header_up X-Forwarded-Prefix ${route.strip_prefix}`);
        lines.push('        }');
      } else {
        lines.push(`        reverse_proxy ${route.target}`);
      }
      lines.push(`    }`);
    }
  }
  return lines.join('\n');
}

/**
 * Generate a copyable Caddy snippet for manual component route setup.
 * The snippet is intended to be pasted inside an existing Caddy site block.
 *
 * @param {string} componentName
 * @param {Array} httpRoutes - Array of { path, type, target, strip_prefix? }
 * @returns {string} Caddy configuration snippet with zylos markers
 */
export function generateManualRouteSnippet(componentName, httpRoutes) {
  return [
    `    # BEGIN zylos-component:${componentName}`,
    generateRouteBlocks(httpRoutes),
    `    # END zylos-component:${componentName}`,
  ].join('\n');
}

/** Inspect exact marker lines before any operation can remove a route block. */
export function inspectCaddyRouteMarkers(content, componentName) {
  const begin = `# BEGIN zylos-component:${componentName}`;
  const end = `# END zylos-component:${componentName}`;
  const unpairedError = `Unpaired Caddy route markers for ${componentName}; repair the Caddyfile before continuing`;
  const lines = content.split('\n');
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].trim(); // Also accepts indentation, trailing spaces and CRLF.
    if (marker === begin) {
      if (start !== -1) return { success: false, error: unpairedError };
      start = i;
    } else if (marker === end) {
      if (start === -1) return { success: false, error: unpairedError };
      blocks.push({ start, end: i, lines: lines.slice(start + 1, i) });
      start = -1;
    }
  }
  if (start !== -1) return { success: false, error: unpairedError };
  return { success: true, blocks };
}

/** Check an existing Caddyfile even when the Caddy binary is unavailable. */
export function checkCaddyRouteMarkers(componentName, deps = {}) {
  const exists = deps.existsSync || fs.existsSync;
  const read = deps.readFileSync || fs.readFileSync;
  if (!exists(CADDYFILE)) return { success: true, blocks: [] };
  try {
    return inspectCaddyRouteMarkers(read(CADDYFILE, 'utf8'), componentName);
  } catch (err) {
    // An unreadable Caddyfile cannot be changed by the route step. Preserve
    // the existing non-fatal behavior; that step reports the read error.
    return { success: true, blocks: [], readError: err.message };
  }
}

function stripMarkerBlocks(content, blocks) {
  if (!blocks.length) return content;
  const lines = content.split('\n');
  const removed = new Set();
  for (const block of blocks) {
    for (let i = block.start; i <= block.end; i++) removed.add(i);
  }
  // Removing a block between other routes can leave an extra blank line on
  // every upgrade. Keep the original two-newline limit for stable output.
  return lines.filter((_, i) => !removed.has(i)).join('\n').replace(/\n{3,}/g, '\n\n');
}

function parseTargetPort(target) {
  const match = /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+):([0-9]+)$/.exec(target);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Read only the handle/reverse_proxy structure within this component's blocks. */
function readBlockPorts(blocks) {
  const paths = new Map();
  const reasons = new Map();
  let malformed = false;
  for (const block of blocks) {
    const seenInBlock = new Set();
    let current = null;
    let depth = 0;
    for (const line of block.lines) {
      const text = line.trim();
      if (text.startsWith('#')) continue;
      if (!current) {
        const match = /^handle\s+(\S+)\s*\{$/.exec(text);
        if (!match) continue;
        current = { path: match[1], targets: [] };
        depth = 1;
        continue;
      }
      const proxy = /^reverse_proxy\s+(\S+)(?:\s*\{)?$/.exec(text);
      if (proxy) current.targets.push(proxy[1]);
      depth += (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
      if (depth === 0) {
        const port = current.targets.length === 1 ? parseTargetPort(current.targets[0]) : null;
        const previous = paths.get(current.path);
        if (seenInBlock.has(current.path)) {
          paths.set(current.path, null);
          reasons.set(current.path, 'duplicate path');
        } else if (previous === undefined) {
          paths.set(current.path, port);
          if (port === null) reasons.set(current.path, current.targets.length === 1 ? 'target is not a valid host:port' : 'reverse_proxy target count is not 1');
        } else if (previous !== port) {
          paths.set(current.path, null);
          reasons.set(current.path, 'duplicate blocks have different ports or an unrecognized format');
        }
        seenInBlock.add(current.path);
        current = null;
      }
    }
    if (current) malformed = true;
  }
  const ports = [...paths.values()];
  const singlePort = !malformed && ports.length > 0 && ports.every(port => port !== null && port === ports[0])
    ? ports[0] : null;
  const globalReason = malformed ? 'incomplete handle block'
    : ports.length === 0 ? 'no recognizable handle routes'
      : new Set(ports.filter(port => port !== null)).size > 1 ? 'existing blocks use different ports'
        : 'existing port cannot be determined uniquely';
  return { paths, reasons, singlePort, globalReason };
}

/** Generate routes from the new manifest, substituting only known old ports. */
export function resolveCaddyRoutePorts(componentName, httpRoutes, blocks) {
  if (!blocks.length) return { routes: httpRoutes, portSource: 'default' };
  const old = readBlockPorts(blocks);
  const routes = [];
  const fallbackReasons = [];
  let usedCaddy = false;
  for (const route of httpRoutes) {
    if (route.type !== 'reverse_proxy') { routes.push(route); continue; }
    const matched = old.paths.has(route.path);
    const port = matched ? old.paths.get(route.path) : old.singlePort;
    const target = typeof route.target === 'string' ? /^(.*):([0-9]+)$/.exec(route.target) : null;
    if (port !== null && port !== undefined && target) {
      routes.push({ ...route, target: `${target[1]}:${port}` });
      usedCaddy = true;
    } else {
      routes.push(route);
      const reason = matched ? old.reasons.get(route.path) || old.globalReason : old.globalReason;
      fallbackReasons.push(`${route.path || '(unknown path)'}: ${target ? reason : 'new target format does not allow safe port replacement'}`);
    }
  }
  const notices = [];
  if (blocks.length > 1) notices.push('Duplicate route blocks found');
  if (fallbackReasons.length) {
    notices.push(`Could not determine the existing port for ${componentName} (${fallbackReasons.join('; ')}); used the new default target. If the port was customized for this deployment, set it again.`);
  }
  return { routes, portSource: usedCaddy && !fallbackReasons.length ? 'caddy' : 'default', notice: notices.join('; ') || undefined, duplicateBlocks: blocks.length > 1 };
}

/**
 * Switch the protocol in an existing Caddyfile (http ↔ https).
 * Preserves all component routes. Validates and reloads.
 *
 * @param {string} domain - The domain name
 * @param {string} protocol - 'https' or 'http'
 * @returns {{ success: boolean, error?: string }}
 */
export function switchProtocol(domain, protocol) {
  if (!isCaddyAvailable()) {
    return { success: false, error: 'caddy_not_available' };
  }

  let original;
  try {
    original = fs.readFileSync(CADDYFILE, 'utf8');
  } catch (err) {
    return { success: false, error: `Cannot read Caddyfile: ${err.message}` };
  }

  // Read port from config if set (local address mode)
  const cfg = getZylosConfig();
  const configPort = cfg.port;

  let newAddress;
  if (configPort != null) {
    // Local address mode: port overrides protocol (always HTTP on explicit port)
    newAddress = `http://${domain}:${configPort}`;
  } else {
    newAddress = protocol === 'http' ? `http://${domain}` : domain;
  }

  // Replace the site address line: matches bare domain or http://domain
  // The site address is the first non-comment, non-empty line ending with {
  const lines = original.split('\n');
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    if (trimmed.endsWith('{')) {
      lines[i] = `${newAddress} {`;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    return { success: false, error: 'Cannot find site address in Caddyfile' };
  }

  // Update or add the protocol comment
  let newContent = lines.join('\n');
  if (/^# Protocol: .+$/m.test(newContent)) {
    newContent = newContent.replace(/^# Protocol: .+$/m, `# Protocol: ${protocol}`);
  } else {
    // Insert after the Domain comment for old Caddyfiles
    newContent = newContent.replace(/^(# Domain: .+)$/m, `$1\n# Protocol: ${protocol}`);
  }

  const result = validateAndDeploy(newContent, original);
  if (!result.success) return result;

  return { success: true };
}

/**
 * Find the closing `}` of the first (primary) server block in a Caddyfile.
 * Tracks brace depth starting from the first `{` to find its matching `}`.
 * Skips comment lines and Caddy global options blocks (label-less `{` at top).
 * Returns the character index of the closing brace, or -1 if not found.
 */
function findPrimaryBlockEnd(content) {
  let depth = 0;
  let inBlock = false;
  let skippingGlobal = false;

  for (let i = 0; i < content.length; i++) {
    // Skip comment lines (# to end of line)
    if (content[i] === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }

    if (content[i] === '{') {
      depth++;
      if (!inBlock && !skippingGlobal) {
        // Check if this is a global options block: no site address before {
        const lineStart = content.lastIndexOf('\n', i) + 1;
        const before = content.slice(lineStart, i).trim();
        if (before === '' && depth === 1) {
          skippingGlobal = true;
        } else {
          inBlock = true;
        }
      }
    } else if (content[i] === '}') {
      depth--;
      if (skippingGlobal && depth === 0) {
        skippingGlobal = false;
      } else if (inBlock && depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Apply Caddy routes for a component.
 * Reads Caddyfile, removes existing markers for this component (if any),
 * generates new route blocks, inserts before closing `}` of the domain block,
 * validates, and reloads.
 *
 * @param {string} componentName
 * @param {Array} httpRoutes - Array of { path, type, target, strip_prefix? }
 * @returns {{ success: boolean, action: string, error?: string }}
 */
export function applyCaddyRoutes(componentName, httpRoutes, deps = {}) {
  if (!httpRoutes || !Array.isArray(httpRoutes) || httpRoutes.length === 0) {
    return { success: true, action: 'skipped' };
  }

  const isAvailable = deps.isCaddyAvailable || isCaddyAvailable;
  let original;
  let readError;
  try {
    original = (deps.readFileSync || fs.readFileSync)(CADDYFILE, 'utf8');
  } catch (err) {
    readError = err;
  }

  const inspection = original === undefined
    ? { success: true, blocks: [] }
    : inspectCaddyRouteMarkers(original, componentName);
  if (!inspection.success) return { success: false, action: 'skipped', error: inspection.error };

  let resolved;
  try {
    resolved = resolveCaddyRoutePorts(componentName, httpRoutes, inspection.blocks);
  } catch (err) {
    resolved = {
      routes: httpRoutes,
      portSource: 'default',
      notice: `Could not determine the existing port for ${componentName} (${err.message}); used the new default target.`,
    };
  }
  if (readError && readError.code !== 'ENOENT' && !isAvailable()) {
    resolved.notice = `Could not read Caddyfile (${readError.message}); used the new default target.`;
  }

  try {
    if (!isAvailable()) {
      return {
        success: false,
        action: 'manual_required',
        error: 'caddy_not_available',
        caddyfile: CADDYFILE,
        caddyBin: CADDY_BIN,
        manualConfig: generateManualRouteSnippet(componentName, resolved.routes),
        manualConfigPlacement: 'inside_primary_site_block',
        message: 'Zylos-managed Caddy is not available. HTTP routes were not configured automatically.',
        notice: routeNotice(resolved, 'manual'),
        portSource: resolved.portSource,
      };
    }
    if (readError) {
      return { success: false, action: 'skipped', error: `Cannot read Caddyfile: ${readError.message}` };
    }

    // All ranges are known before removal; malformed markers can never remove
    // content through EOF or touch another component's marker prefix.
    const content = stripMarkerBlocks(original, inspection.blocks);
    const isUpdate = inspection.blocks.length > 0;
    const markedBlock = generateManualRouteSnippet(componentName, resolved.routes);

    // Insert into the first (Zylos-managed) site block.
    const primaryBrace = findPrimaryBlockEnd(content);
    if (primaryBrace === -1) {
      return { success: false, action: 'skipped', error: 'Cannot find domain block in Caddyfile' };
    }

    const before = content.slice(0, primaryBrace).trimEnd();
    const after = content.slice(primaryBrace);
    const newContent = `${before}\n\n${markedBlock}\n${after}`;
    const result = (deps.validateAndDeploy || validateAndDeploy)(newContent, original);
    if (!result.success) {
      return { success: false, action: isUpdate ? 'updated' : 'added', error: result.error, ...resolvedMetadata(resolved, 'unmerged') };
    }

    return { success: true, action: isUpdate ? 'updated' : 'added', ...resolvedMetadata(resolved, 'merged') };
  } catch (err) {
    return { success: false, action: 'skipped', error: `Caddy route generation failed: ${err.message}`, ...resolvedMetadata(resolved, 'unmerged') };
  }
}

function routeNotice(resolved, outcome) {
  if (!resolved.duplicateBlocks) return resolved.notice;
  const detail = outcome === 'merged' ? 'merged into one' : outcome === 'manual' ? 'manual snippet generated as one block' : 'not merged';
  return resolved.notice.replace('Duplicate route blocks found', `Duplicate route blocks found; ${detail}`);
}

function resolvedMetadata(resolved, outcome) {
  return { notice: routeNotice(resolved, outcome), portSource: resolved.portSource };
}

/**
 * Remove Caddy routes for a component.
 *
 * @param {string} componentName
 * @returns {{ success: boolean, action: string, error?: string }}
 */
export function removeCaddyRoutes(componentName, deps = {}) {
  if (!(deps.isCaddyAvailable || isCaddyAvailable)()) {
    return { success: true, action: 'not_found' };
  }

  let original;
  try {
    original = (deps.readFileSync || fs.readFileSync)(CADDYFILE, 'utf8');
  } catch (err) {
    return { success: false, action: 'not_found', error: `Cannot read Caddyfile: ${err.message}` };
  }

  const inspection = inspectCaddyRouteMarkers(original, componentName);
  if (!inspection.success) return { success: false, action: 'skipped', error: inspection.error };
  if (!inspection.blocks.length) {
    return { success: true, action: 'not_found' };
  }

  const newContent = stripMarkerBlocks(original, inspection.blocks);

  const result = (deps.validateAndDeploy || validateAndDeploy)(newContent, original);
  if (!result.success) {
    return { success: false, action: 'removed', error: result.error };
  }

  return { success: true, action: 'removed', notice: inspection.blocks.length > 1 ? 'Duplicate route blocks found; removed all of them' : undefined };
}

/**
 * Validate new Caddyfile content, then atomically replace the Caddyfile
 * and reload Caddy via PM2. No sudo needed (user-space Caddy).
 * On validation failure, does not modify the Caddyfile.
 *
 * @param {string} newContent - New Caddyfile content
 * @param {string} originalContent - Original content for rollback
 * @returns {{ success: boolean, error?: string }}
 */
export function validateAndDeploy(newContent, originalContent, {
  caddyfile = CADDYFILE,
  caddyBin = CADDY_BIN,
  validate = file => execFileSync(caddyBin, ['validate', '--config', file, '--adapter', 'caddyfile'], {stdio:'pipe', timeout:10000}),
  reload = () => execFileSync('pm2', ['reload', 'caddy'], {stdio:'pipe', timeout:10000}),
} = {}) {
  let temporary;
  let replaced = false;
  let originalStat;
  let target;
  const syncDirectory = () => {
    const fd = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const stage = (content, stat) => {
    temporary = path.join(path.dirname(target), `.Caddyfile.zylos-${crypto.randomUUID()}`);
    const fd = fs.openSync(temporary, 'wx', stat.mode & 0o7777);
    try {
      fs.fchownSync(fd, stat.uid, stat.gid);
      fs.fchmodSync(fd, stat.mode & 0o7777);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  const deploy = () => {
    fs.renameSync(temporary, target);
    temporary = null;
    replaced = true;
    syncDirectory();
  };
  try {
    // Replace the resolved file, retaining symlinks used by existing installs.
    target = fs.realpathSync(caddyfile);
    const stat = fs.lstatSync(target);
    originalStat = stat;
    if (!stat.isFile() || stat.isSymbolicLink()) return {success:false, error:'Caddyfile must be a regular file; unchanged.'};
    stage(newContent, stat);
    try { validate(temporary); }
    catch (error) {
      const detail = error.stderr?.toString().trim();
      return {success:false, error:`Caddy validation failed; Caddyfile unchanged.${detail ? ` ${detail}` : ''}`};
    }
    // Do not overwrite an edit made while validation was running.
    const current = fs.lstatSync(target);
    if (fs.realpathSync(caddyfile) !== target || current.ino !== stat.ino || current.dev !== stat.dev || !fs.readFileSync(target).equals(Buffer.from(originalContent))) {
      return {success:false, error:'Caddyfile changed during validation; unchanged.'};
    }
    deploy();
    try { reload(); }
    catch {
      try {
        stage(originalContent, stat);
        deploy();
        replaced = false;
      } catch { return {success:false, error:'Caddy reload failed and restoring the Caddyfile failed; manual recovery required.'}; }
      try { reload(); } catch { /* The original bytes are restored even if Caddy remains unavailable. */ }
      return {success:false, error:'Caddy reload failed; original Caddyfile restored.'};
    }
    return {success:true};
  } catch {
    if (replaced && originalStat) {
      try {
        if (temporary) fs.unlinkSync(temporary);
        stage(originalContent, originalStat);
        deploy();
        return {success:false, error:'Caddyfile atomic deployment failed; original Caddyfile restored.'};
      } catch { return {success:false, error:'Caddyfile atomic deployment failed and restoration failed; manual recovery required.'}; }
    }
    return {success:false, error:'Caddyfile atomic deployment failed; inspect the Caddyfile before retrying.'};
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
  }
}
