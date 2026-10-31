import assert from 'node:assert/strict';
import test from 'node:test';

import { applyVersionUpdateFields } from '../src/lib/runtime-info.js';

test('runtime info exposes Codex latest and update when latest is newer than installed', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_running: '0.129.0', codex_installed: '0.130.0' },
    { codex: '0.137.0' },
    { codexInstalledVersion: '0.130.0' }
  );

  assert.equal(info.codex_running, '0.129.0');
  assert.equal(info.codex_latest, '0.137.0');
  assert.equal(info.codex_update, '0.137.0');
});

test('runtime info compares Codex latest against installed, not running', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_running: '0.129.0', codex_installed: '0.137.0' },
    { codex: '0.137.0' },
    { codexInstalledVersion: '0.137.0' }
  );

  assert.equal(info.codex_running, '0.129.0');
  assert.equal(info.codex_latest, '0.137.0');
  assert.equal(info.codex_update, undefined);
});

test('runtime info exposes Codex latest without update when installed is current', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_installed: '0.137.0' },
    { codex: '0.137.0' },
    { codexInstalledVersion: '0.137.0' }
  );

  assert.equal(info.codex_latest, '0.137.0');
  assert.equal(info.codex_update, undefined);
});

test('runtime info omits Codex latest and update when latest check is unavailable', () => {
  const info = applyVersionUpdateFields(
    { runtime: 'codex', codex_installed: '0.130.0' },
    { codex: null },
    { codexInstalledVersion: '0.130.0' }
  );

  assert.equal(info.codex_latest, undefined);
  assert.equal(info.codex_update, undefined);
});
