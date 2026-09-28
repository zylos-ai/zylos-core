import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('periodic recovery defaults on while explicit opt-out and capture defaults remain intact', async t => {
  const keys = ['C4_PERIODIC_ENTER_ENABLED', 'C4_ENTER_CAPTURE_ENABLED'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  delete process.env.C4_ENTER_CAPTURE_ENABLED;
  for (const [index, [value, enabled]] of [
    [undefined, true], ['1', true], ['0', false], ['', false], ['false', false], ['invalid', false]
  ].entries()) {
    if (value === undefined) delete process.env.C4_PERIODIC_ENTER_ENABLED;
    else process.env.C4_PERIODIC_ENTER_ENABLED = value;
    const config = await import(new URL(`../c4-config.js?default=${index}-${Date.now()}`, import.meta.url));
    assert.equal(config.PERIODIC_ENTER_ENABLED, enabled);
    assert.equal(config.ENTER_CAPTURE_ENABLED, false);
  }
});

test('actual config module uses the same missing/malformed fallback at startup and on live reads', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-runtime-config-'));
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const configDir = path.join(dir, '.zylos');
  fs.mkdirSync(configDir);
  const configFile = path.join(configDir, 'config.json');
  for (const [name, content, expected] of [
    ['missing', undefined, 'claude'],
    ['malformed', '{bad json', 'claude'],
    ['unset', '{}', 'claude'],
    ['unknown', '{"runtime":"other"}', 'claude'],
    ['claude', '{"runtime":"claude"}', 'claude'],
    ['codex', '{"runtime":"codex"}', 'codex']
  ]) {
    if (content === undefined) fs.rmSync(configFile, { force: true });
    else fs.writeFileSync(configFile, content);
    const config = await import(new URL(`../c4-config.js?case=${name}-${Date.now()}`, import.meta.url));
    assert.equal(config.ACTIVE_RUNTIME, expected, `${name} startup`);
    assert.equal(config.readActiveRuntime(), expected, `${name} live`);
    assert.equal(config.TMUX_SESSION, `${expected}-main`);
    // Same imported module must see valid switches immediately; startup remains fixed.
    fs.writeFileSync(configFile, '{"runtime":"codex"}');
    assert.equal(config.readActiveRuntime(), 'codex');
    fs.writeFileSync(configFile, '{"runtime":"claude"}');
    assert.equal(config.readActiveRuntime(), 'claude');
    fs.writeFileSync(configFile, '{malformed');
    assert.equal(config.readActiveRuntime(), 'claude');
    fs.rmSync(configFile);
    assert.equal(config.readActiveRuntime(), 'claude');
    assert.equal(config.ACTIVE_RUNTIME, expected);
  }

  const config = await import(new URL(`../c4-config.js?errors=${Date.now()}`, import.meta.url));
  const originalRead = fs.readFileSync;
  try {
    for (const code of ['EACCES', 'EIO']) {
      fs.readFileSync = (file, ...args) => {
        if (file === configFile) throw Object.assign(new Error('config unavailable'), { code });
        return originalRead(file, ...args);
      };
      assert.throws(() => config.readActiveRuntime(), error => error.code === code, code);
    }
  } finally {
    fs.readFileSync = originalRead;
  }
  // A real non-file path supplies an OS read error without privilege assumptions.
  fs.mkdirSync(configFile);
  assert.throws(() => config.readActiveRuntime(), error => error.code === 'EISDIR');
});
