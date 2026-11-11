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
  'default',
  'dashboard:origin',
  'default:x',
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
  ['a capitalised keyword', 'Default'],
]) {
  test(`config rejects alert target with ${label} before changing config bytes`, t => {
    const f = fixture(t);
    const result = f.run(['set', 'alert_target', value], label === 'NUL');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CONFIG_VALUE_INVALID/);
    // The API worker prints only the code; the CLI prints the message too.
    if (label !== 'NUL') assert.ok(result.stderr.includes('alert_target must be channel:endpoint (non-empty parts, no newline or NUL) or the word default'), result.stderr);
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

test('config unset alert_target removes only that key, succeeds when it is absent and refuses other keys', t => {
  const f = fixture(t);
  assert.equal(f.run(['set', 'alert_target', 'telegram:8101553026']).status, 0);
  const removed = f.run(['unset', 'alert_target']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /alert_target removed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { custom: 'preserved', session_mode: 'multi' });
  const afterRemove = fs.readFileSync(f.file);
  const again = f.run(['unset', 'alert_target']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /alert_target is not set/);
  assert.deepEqual(fs.readFileSync(f.file), afterRemove, 'an absent key leaves the file untouched');
  for (const key of ['session_mode', 'custom', 'protocol']) {
    const refused = f.run(['unset', key]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /CONFIG_KEY_RESERVED/);
    assert.deepEqual(fs.readFileSync(f.file), afterRemove);
  }
  for (const args of [['unset'], ['unset', 'alert_target', 'extra']]) {
    const usage = f.run(args);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage: zylos config unset alert_target/);
  }
});

test('config unset alert_target on an instance without a config file succeeds without creating one', t => {
  const f = fixture(t);
  fs.rmSync(f.file);
  const result = f.run(['unset', 'alert_target']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.file), false);
});
