#!/usr/bin/env node
/**
 * Standalone upgrade check — spawned by activity-monitor to avoid blocking
 * the main loop. Checks zylos-core and installed components for newer
 * versions on GitHub, then enqueues a C4 control notification if upgrades
 * are available.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const COMPONENTS_JSON = path.join(ZYLOS_DIR, '.zylos', 'components.json');

function resolveCommBridgeScript(fileName) {
  const prodPath = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', fileName);
  if (fs.existsSync(prodPath)) return prodPath;
  const devPath = path.join(import.meta.dirname, '..', '..', 'comm-bridge', 'scripts', fileName);
  if (fs.existsSync(devPath)) return devPath;
  return prodPath;
}

const C4_CONTROL_PATH = resolveCommBridgeScript('c4-control.js');

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* best effort */ }
}

function sanitizeVersion(v) {
  return String(v || '').replace(/[^a-zA-Z0-9._\-]/g, '').slice(0, 32);
}

function compareSemver(a, b) {
  const [aBase, aPre] = a.split(/-(.+)/);
  const [bBase, bPre] = b.split(/-(.+)/);
  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (bParts[i] || 0) - (aParts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (!aPre && bPre) return -1;
  if (aPre && !bPre) return 1;
  return 0;
}

function getLatestTag(repo) {
  let output;
  try {
    output = execFileSync('git', [
      'ls-remote', '--tags', `https://github.com/${repo}.git`
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 }).trim();
  } catch (err) {
    const msg = err.stderr ? String(err.stderr).trim() : err.message;
    return { version: null, error: msg };
  }
  if (!output) return { version: null, error: 'no tags' };
  const versions = output.split('\n')
    .map(line => line.replace(/.*refs\/tags\//, '').replace(/\^{}$/, ''))
    .filter(name => /^v?\d+\.\d+\.\d+/.test(name))
    .map(name => name.replace(/^v/, ''))
    .filter((v, i, arr) => arr.indexOf(v) === i)  // deduplicate (annotated tags have ^{})
    .sort(compareSemver);
  if (versions.length === 0) return { version: null, error: 'no semver tags' };
  return { version: versions[0], error: null };
}

function runC4Control(args) {
  try {
    const output = execFileSync('node', [C4_CONTROL_PATH, ...args], {
      encoding: 'utf8', stdio: 'pipe'
    }).trim();
    return { ok: true, output };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { ok: false, output: stdout || stderr || err.message };
  }
}

function main() {
  const upgrades = [];
  let failures = 0;

  // Check zylos-core
  try {
    const coreVersion = execFileSync('zylos', ['--version'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000
    }).trim();
    const result = getLatestTag('zylos-ai/zylos-core');
    if (result.error) {
      log(`Upgrade check: failed to fetch zylos-core tag (${result.error})`);
      failures++;
    } else if (result.version && compareSemver(coreVersion.replace(/^v/, ''), result.version) > 0) {
      upgrades.push(`zylos-core ${sanitizeVersion(coreVersion)} → ${sanitizeVersion(result.version)}`);
    }
  } catch (err) {
    log(`Upgrade check: failed to check core version (${err.message})`);
    failures++;
  }

  // Check installed components
  try {
    if (fs.existsSync(COMPONENTS_JSON)) {
      const components = JSON.parse(fs.readFileSync(COMPONENTS_JSON, 'utf8'));
      for (const [name, info] of Object.entries(components)) {
        if (!info.repo || !info.version) continue;
        const result = getLatestTag(info.repo);
        if (result.error) {
          log(`Upgrade check: failed to fetch ${name} tag (${result.error})`);
          failures++;
          continue;
        }
        if (result.version && compareSemver(String(info.version).replace(/^v/, ''), result.version) > 0) {
          upgrades.push(`${sanitizeVersion(name)} ${sanitizeVersion(info.version)} → ${sanitizeVersion(result.version)}`);
        }
      }
    }
  } catch (err) {
    log(`Upgrade check: failed to read components (${err.message})`);
    failures++;
  }

  if (upgrades.length === 0) {
    log(`Upgrade check: all components up to date${failures > 0 ? ` (${failures} check(s) failed)` : ''}`);
    return;
  }

  const content = `Component upgrades available: ${upgrades.join(', ')}. When the user next sends a message, mention these available upgrades and ask if they would like to upgrade.`;
  const result = runC4Control([
    'enqueue', '--content', content, '--priority', '3', '--ack-deadline', '600'
  ]);

  if (result.ok) {
    const match = result.output.match(/control\s+(\d+)/i);
    log(`Upgrade check: ${upgrades.length} upgrade(s) found, notified via control id=${match?.[1] ?? '?'} — ${upgrades.join(', ')}`);
  } else {
    log(`Upgrade check: notification enqueue failed: ${result.output}`);
  }
}

main();
