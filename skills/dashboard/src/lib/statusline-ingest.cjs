#!/usr/bin/env node
// StatusLine ingest script — configured as settings.json statusLine command.
// Reads StatusLine JSON from stdin, extracts metrics, POSTs to dashboard.
// Must use only Node built-ins. Must complete within 500ms.
'use strict';

setTimeout(() => process.exit(0), 500);

const fs = require('node:fs');
const path = require('node:path');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(require('node:os').homedir(), 'zylos');
const DATA_DIR = path.join(ZYLOS_DIR, 'components', 'dashboard');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const cfg = loadConfig();
const PORT = cfg.port || 3470;

async function main() {
  const stdin = await readStdin();
  if (!stdin) { outputStatus(null); process.exit(0); }

  let data;
  try { data = JSON.parse(stdin); } catch { outputStatus(null); process.exit(0); }

  outputStatus(data);

  const metrics = extractMetrics(data);
  if (metrics.length > 0) {
    await postMetrics(metrics);
  }

  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let timer = setTimeout(() => resolve(chunks.join('')), 200);
    process.stdin.on('data', (c) => {
      clearTimeout(timer);
      chunks.push(c.toString());
      timer = setTimeout(() => resolve(chunks.join('')), 50);
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(chunks.join('')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

function outputStatus(data) {
  if (!data) { process.stdout.write('--\n'); return; }
  const parts = [];
  const model = data.model?.display_name || data.model?.id || '';
  if (model) parts.push(model);
  const ctx = data.context_window?.used_percentage;
  if (ctx != null) parts.push(`${Math.round(ctx)}%`);
  const cost = data.cost?.total_cost_usd;
  if (cost != null) parts.push(`$${Number(cost).toFixed(4)}`);
  process.stdout.write((parts.join(' | ') || '--') + '\n');
}

function extractMetrics(data) {
  const now = new Date().toISOString();
  const session = data.session_id || null;
  const dimensions = {};

  if (data.context_window?.used_percentage != null) {
    dimensions.context_pct = data.context_window.used_percentage;
  }

  if (data.cost?.total_cost_usd != null) {
    dimensions.session_cost = data.cost.total_cost_usd;
  }

  if (data.rate_limits?.five_hour?.used_percentage != null) {
    dimensions.rate_limit = data.rate_limits.five_hour.used_percentage;
    if (data.rate_limits.five_hour.resets_at != null) dimensions.rate_limit_resets_at = data.rate_limits.five_hour.resets_at;
  }

  if (data.rate_limits?.seven_day?.used_percentage != null) {
    dimensions.rate_limit_7d = data.rate_limits.seven_day.used_percentage;
    if (data.rate_limits.seven_day.resets_at != null) dimensions.rate_limit_7d_resets_at = data.rate_limits.seven_day.resets_at;
  }

  const cw = data.context_window?.current_usage;
  if (cw && cw.cache_read_input_tokens != null) {
    const totalIn = (cw.input_tokens || 0) + (cw.cache_creation_input_tokens || 0) + (cw.cache_read_input_tokens || 0);
    if (totalIn > 0) {
      dimensions.cache_hit_rate = cw.cache_read_input_tokens / totalIn;
      dimensions.input = cw.input_tokens || 0;
      dimensions.cache_read = cw.cache_read_input_tokens || 0;
      dimensions.cache_creation = cw.cache_creation_input_tokens || 0;
    }
  }

  if (Object.keys(dimensions).length === 0) return [];
  return [{
    timestamp: now,
    session_id: session,
    metric_name: 'statusline_summary',
    metric_value: 0,
    dimensions,
    source: 'statusline',
    confidence: 'actual'
  }];
}

async function postMetrics(metrics) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 200);
    await fetch(`http://127.0.0.1:${PORT}/api/ingest/statusline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metrics }),
      signal: controller.signal
    });
    clearTimeout(timeout);
  } catch {
    // dashboard unavailable — metrics will be stale, acceptable
  }
}

try { main(); } catch { process.exit(0); }
