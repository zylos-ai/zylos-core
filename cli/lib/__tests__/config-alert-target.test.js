import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(import.meta.dirname, '../../..');
const cli = path.join(rootDir, 'cli/zylos.js');
const worker = path.join(import.meta.dirname, 'helpers/config-command-worker.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-alert-target-'));
  const file = path.join(root, '.zylos/config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = Buffer.from('{\n\t"custom": "preserved", "session_mode": "multi"\n}\n');
  fs.writeFileSync(file, original);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, file, original,
    run(args, api = false) {
      return spawnSync(process.execPath, api ? [worker, JSON.stringify(args)] : [cli, 'config', ...args], {
        env: { ...process.env, HOME: root, ZYLOS_DIR: root }, encoding: 'utf8',
      });
    },
  };
}

for (const value of [
  'telegram:8101553026',
  'lark:oc_x|type:p2p',
  'web-console:console',
  'telegram:8101553026|msg:9216',
  'lark:oc_x|type:p2p|root:om_1',
  'mychannel:room/42?x=1',
]) {
  test(`config accepts alert target ${value} without channel-specific checks`, t => {
    const f = fixture(t);
    const result = f.run(['set', 'alert_target', value]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(f.root, '.claude/skills')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), {
      custom: 'preserved', session_mode: 'multi', alert_target: value,
    });
  });
}

for (const [label, value] of [
  ['no colon', 'telegram'],
  ['empty channel', ':room'],
  ['blank channel', '  :room'],
  ['empty endpoint', 'telegram:'],
  ['blank endpoint', 'telegram:  '],
  ['empty value', ''],
  ['newline', 'telegram:room\nother'],
  ['carriage return', 'telegram:room\rother'],
  ['NUL', 'telegram:room\0other'],
]) {
  test(`config rejects alert target with ${label} before changing config bytes`, t => {
    const f = fixture(t);
    const result = f.run(['set', 'alert_target', value], label === 'NUL');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CONFIG_VALUE_INVALID/);
    assert.deepEqual(fs.readFileSync(f.file), f.original);
    assert.equal(fs.existsSync(`${f.file}.lock`), false);
  });
}

test('config keeps arbitrary other keys and reserves session_mode', t => {
  const f = fixture(t);
  const custom = f.run(['set', 'custom', 'not:a:target\nvalue']);
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).custom, 'not:a:target\nvalue');
  const beforeReserved = fs.readFileSync(f.file);
  const reserved = f.run(['set', 'session_mode', 'single']);
  assert.equal(reserved.status, 1, reserved.stderr);
  assert.match(reserved.stderr, /CONFIG_KEY_RESERVED/);
  assert.deepEqual(fs.readFileSync(f.file), beforeReserved);
});
