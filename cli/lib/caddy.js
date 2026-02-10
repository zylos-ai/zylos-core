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
import { CADDYFILE, CADDY_BIN } from './config.js';

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
function generateRouteBlocks(httpRoutes) {
  const lines = [];
  for (const route of httpRoutes) {
    if (route.type === 'reverse_proxy') {
      lines.push(`    handle ${route.path} {`);
      if (route.strip_prefix) {
        lines.push(`        uri strip_prefix ${route.strip_prefix}`);
      }
      lines.push(`        reverse_proxy ${route.target}`);
      lines.push(`    }`);
    }
  }
  return lines.join('\n');
}

/**
 * Remove a marker block (BEGIN to END, inclusive) from content.
 * Handles leading whitespace on marker lines and cleans up blank lines.
 */
function stripMarkerBlock(content, beginMarker, endMarker) {
  const lines = content.split('\n');
  const result = [];
  let skipping = false;

  for (const line of lines) {
    if (line.includes(beginMarker)) {
      skipping = true;
      continue;
    }
    if (skipping && line.includes(endMarker)) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      result.push(line);
    }
  }

  // Clean up consecutive blank lines (max 2 newlines in a row)
  return result.join('\n').replace(/\n{3,}/g, '\n\n');
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
export function applyCaddyRoutes(componentName, httpRoutes) {
  if (!isCaddyAvailable()) {
    return { success: false, action: 'skipped', error: 'caddy_not_available' };
  }

  if (!httpRoutes || !Array.isArray(httpRoutes) || httpRoutes.length === 0) {
    return { success: true, action: 'skipped' };
  }

  const beginMarker = `# BEGIN zylos-component:${componentName}`;
  const endMarker = `# END zylos-component:${componentName}`;

  let original;
  try {
    original = fs.readFileSync(CADDYFILE, 'utf8');
  } catch (err) {
    return { success: false, action: 'skipped', error: `Cannot read Caddyfile: ${err.message}` };
  }

  // Remove existing marker block for this component (if any)
  let content = original;
  const isUpdate = content.includes(beginMarker);
  if (isUpdate) {
    content = stripMarkerBlock(content, beginMarker, endMarker);
  }

  // Generate new route block
  const routeBlock = generateRouteBlocks(httpRoutes);
  const markedBlock = [
    `    ${beginMarker}`,
    routeBlock,
    `    ${endMarker}`,
  ].join('\n');

  // Find the last closing `}` in the file (end of domain block)
  const lastBrace = content.lastIndexOf('}');
  if (lastBrace === -1) {
    return { success: false, action: 'skipped', error: 'Cannot find domain block in Caddyfile' };
  }

  // Insert marked block before the closing brace, with proper spacing
  const before = content.slice(0, lastBrace).trimEnd();
  const after = content.slice(lastBrace);
  const newContent = `${before}\n\n${markedBlock}\n${after}`;

  // Write to temp file, validate, then deploy
  const result = validateAndDeploy(newContent, original);
  if (!result.success) {
    return { success: false, action: isUpdate ? 'updated' : 'added', error: result.error };
  }

  return { success: true, action: isUpdate ? 'updated' : 'added' };
}

/**
 * Remove Caddy routes for a component.
 *
 * @param {string} componentName
 * @returns {{ success: boolean, action: string, error?: string }}
 */
export function removeCaddyRoutes(componentName) {
  if (!isCaddyAvailable()) {
    return { success: true, action: 'not_found' };
  }

  const beginMarker = `# BEGIN zylos-component:${componentName}`;
  const endMarker = `# END zylos-component:${componentName}`;

  let original;
  try {
    original = fs.readFileSync(CADDYFILE, 'utf8');
  } catch (err) {
    return { success: false, action: 'not_found', error: `Cannot read Caddyfile: ${err.message}` };
  }

  if (!original.includes(beginMarker)) {
    return { success: true, action: 'not_found' };
  }

  // Remove the marker block
  const newContent = stripMarkerBlock(original, beginMarker, endMarker);

  const result = validateAndDeploy(newContent, original);
  if (!result.success) {
    return { success: false, action: 'removed', error: result.error };
  }

  return { success: true, action: 'removed' };
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
