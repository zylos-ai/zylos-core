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
import { execSync } from 'node:child_process';
import { CADDYFILE, CADDY_BIN, getZylosConfig } from './config.js';

/**
 * Check if Caddy is available (binary + Caddyfile exist).
 */
export function isCaddyAvailable() {
  return fs.existsSync(CADDY_BIN) && fs.existsSync(CADDYFILE);
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
  const lines = content.split('\n');
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].trim(); // Also accepts indentation, trailing spaces and CRLF.
    if (marker === begin) {
      if (start !== -1) return { success: false, error: `Caddyfile 中 ${componentName} 的路由标记不成对，请先修复` };
      start = i;
    } else if (marker === end) {
      if (start === -1) return { success: false, error: `Caddyfile 中 ${componentName} 的路由标记不成对，请先修复` };
      blocks.push({ start, end: i, lines: lines.slice(start + 1, i) });
      start = -1;
    }
  }
  if (start !== -1) return { success: false, error: `Caddyfile 中 ${componentName} 的路由标记不成对，请先修复` };
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
  return lines.filter((_, i) => !removed.has(i)).join('\n');
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
          reasons.set(current.path, '路径重复');
        } else if (previous === undefined) {
          paths.set(current.path, port);
          if (port === null) reasons.set(current.path, current.targets.length === 1 ? '目标不是有效的主机:端口' : 'reverse_proxy 目标数量不是 1');
        } else if (previous !== port) {
          paths.set(current.path, null);
          reasons.set(current.path, '重复路由块的端口不一致或格式无法识别');
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
  const globalReason = malformed ? 'handle 结构不完整'
    : ports.length === 0 ? '没有可识别的 handle 路由'
      : new Set(ports.filter(port => port !== null)).size > 1 ? '旧块存在多个不同端口'
        : '旧块的端口无法唯一确定';
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
      fallbackReasons.push(`${route.path || '(unknown path)'}：${target ? reason : '新版目标格式无法安全替换端口'}`);
    }
  }
  const notices = [];
  if (blocks.length > 1) notices.push('发现重复的路由块');
  if (fallbackReasons.length) {
    notices.push(`未能确定 ${componentName} 现有路由的端口（${fallbackReasons.join('；')}），已按新版默认目标生成。如果此前按部署环境调整过端口，请重新设置。`);
  }
  return { routes, portSource: usedCaddy && !fallbackReasons.length ? 'caddy' : 'default', notice: notices.join('；') || undefined, duplicateBlocks: blocks.length > 1 };
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
      notice: `未能确定 ${componentName} 现有路由的端口（原因：${err.message}），已按新版默认目标生成。`,
    };
  }
  if (readError && !isAvailable()) {
    resolved.notice = `未能读取 Caddyfile（${readError.message}），已按新版默认目标生成。`;
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
  const detail = outcome === 'merged' ? '已合并为一个' : outcome === 'manual' ? '手动片段已按一块生成' : '未完成合并';
  return resolved.notice.replace('发现重复的路由块', `发现重复的路由块，${detail}`);
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

  return { success: true, action: 'removed', notice: inspection.blocks.length > 1 ? '发现重复的路由块，已全部清理' : undefined };
}

/**
 * Validate new Caddyfile content, then write directly to the Caddyfile
 * and reload Caddy via PM2. No sudo needed (user-space Caddy).
 * On validation failure, does not modify the Caddyfile.
 *
 * @param {string} newContent - New Caddyfile content
 * @param {string} originalContent - Original content for rollback
 * @returns {{ success: boolean, error?: string }}
 */
function validateAndDeploy(newContent, originalContent) {
  const tmpFile = `/tmp/Caddyfile.zylos-${Date.now()}`;

  try {
    fs.writeFileSync(tmpFile, newContent);

    // Validate using our own caddy binary
    try {
      execSync(`"${CADDY_BIN}" validate --config "${tmpFile}" --adapter caddyfile`, {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch (err) {
      // Validation failed — clean up temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      const stderr = err.stderr?.toString().trim() || err.message;
      return { success: false, error: `Caddy validation failed: ${stderr}` };
    }

    // Deploy: write directly (user-space, no sudo)
    try {
      fs.writeFileSync(CADDYFILE, newContent);
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      return { success: false, error: `Failed to write Caddyfile: ${err.message}` };
    }

    // Reload Caddy via PM2
    try {
      execSync('pm2 reload caddy', {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch (err) {
      // Reload failed — rollback
      try {
        fs.writeFileSync(CADDYFILE, originalContent);
        execSync('pm2 reload caddy', { stdio: 'pipe', timeout: 10000 });
      } catch { /* rollback best-effort */ }
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      return { success: false, error: `Caddy reload failed (rolled back): ${err.message}` };
    }

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return { success: true };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return { success: false, error: err.message };
  }
}
