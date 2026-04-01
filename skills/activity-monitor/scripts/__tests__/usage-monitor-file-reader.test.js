import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseClaudeStatuslineUsage,
  parseCodexUsageState,
  readUsageFromMonitorFile
} from '../usage-monitor-file-reader.js';

describe('usage-monitor-file-reader', () => {
  it('parses Claude statusline data for the active workspace', () => {
    const result = parseClaudeStatuslineUsage({
      cwd: '/tmp/zylos',
      workspace: { project_dir: '/tmp/zylos' },
      context_window: { used_percentage: 71 }
    }, { zylosDir: '/tmp/zylos' });

    assert.equal(result.usage.session, 71);
    assert.equal(result.statusShape, 'statusline');
    assert.equal(result.probeReason, 'monitor_file_statusline');
  });

  it('rejects Claude statusline data from a different workspace', () => {
    const result = parseClaudeStatuslineUsage({
      cwd: '/tmp/other',
      workspace: { project_dir: '/tmp/other' },
      context_window: { used_percentage: 71 }
    }, { zylosDir: '/tmp/zylos' });

    assert.equal(result, null);
  });

  it('parses Codex usage snapshot data', () => {
    const result = parseCodexUsageState({
      lastCheck: '2026-04-01T07:01:09.187Z',
      lastCheckEpoch: 1775026869,
      session: { percent: 1, resets: '17:48' },
      weeklyAll: { percent: 15, resets: '10:32 on Apr 3' },
      weeklySonnet: { percent: null, resets: null },
      fiveHour: { percent: 1, resets: '17:48' },
      statusShape: 'rollout'
    });

    assert.equal(result.usage.session, 1);
    assert.equal(result.usage.weeklyAll, 15);
    assert.equal(result.statusShape, 'rollout');
    assert.equal(result.probeReason, 'monitor_file_usage_codex');
  });

  it('reads a fresh Claude monitor file from disk', () => {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-file-reader-'));
    try {
      fs.writeFileSync(path.join(monitorDir, 'statusline.json'), JSON.stringify({
        cwd: '/tmp/zylos',
        workspace: { project_dir: '/tmp/zylos' },
        context_window: { used_percentage: 64 }
      }));

      const result = readUsageFromMonitorFile({
        runtimeId: 'claude',
        monitorDir,
        nowEpoch: Math.floor(Date.now() / 1000),
        maxAgeSeconds: 60,
        zylosDir: '/tmp/zylos'
      });

      assert.equal(result.usage.session, 64);
      assert.equal(result.probeReason, 'monitor_file_statusline');
    } finally {
      fs.rmSync(monitorDir, { recursive: true, force: true });
    }
  });

  it('returns null for stale monitor files', () => {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-file-reader-'));
    try {
      const filePath = path.join(monitorDir, 'usage-codex.json');
      fs.writeFileSync(filePath, JSON.stringify({
        session: { percent: 1, resets: '17:48' }
      }));

      const staleMs = Date.now() - 3600_000;
      fs.utimesSync(filePath, staleMs / 1000, staleMs / 1000);

      const result = readUsageFromMonitorFile({
        runtimeId: 'codex',
        monitorDir,
        nowEpoch: Math.floor(Date.now() / 1000),
        maxAgeSeconds: 60
      });

      assert.equal(result, null);
    } finally {
      fs.rmSync(monitorDir, { recursive: true, force: true });
    }
  });
});
