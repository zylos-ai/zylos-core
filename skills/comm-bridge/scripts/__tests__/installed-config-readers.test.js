import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(import.meta.dirname, '../../../..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-f1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const skills = path.join(data, '.claude/skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(data, 'package.json'), '{"type":"module"}');
  for (const name of ['comm-bridge', 'activity-monitor', 'http']) {
    fs.cpSync(path.join(packageRoot, 'skills', name, 'scripts'), path.join(skills, name, 'scripts'), {
      recursive: true, filter: source => path.basename(source) !== '__tests__',
    });
  }
  const scripts = path.join(skills, 'comm-bridge/scripts');
  // Any accidental Core loader import must fail even when npm is present.
  fs.writeFileSync(path.join(scripts, 'core-config-loader.js'), 'throw new Error("Read-only consumer loaded Core");');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const count = path.join(root, 'npm-count');
  fs.writeFileSync(count, '');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "call\\n" >> "$NPM_COUNT"\nexit 99\n', { mode: 0o755 });
  const flag = path.join(root, 'enqueue.json');
  fs.writeFileSync(path.join(scripts, 'c4-control.js'),
    'import fs from "node:fs";fs.writeFileSync(process.env.ENQUEUE_FLAG, JSON.stringify(process.argv.slice(2)));');
  const env = { ...process.env, HOME: root, ZYLOS_DIR: data, PATH: bin, TMPDIR: root,
    NPM_COUNT: count, ENQUEUE_FLAG: flag };
  delete env.ZYLOS_PACKAGE_ROOT;
  delete env.ZYLOS_RUNTIME;
  fs.mkdirSync(path.join(data, '.zylos'), { recursive: true });
  const file = path.join(data, '.zylos/config.json');
  return { root, data, scripts, skills, bin, count, flag, file, env };
}

function evaluate(fx, source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: fx.env, encoding: 'utf8', timeout: 10000,
  });
}

test('installed read-only consumers work without Core, never invoke npm, and retain strict action boundaries', t => {
  const fx = fixture(t);
  const urls = Object.fromEntries(['c4-config', 'runtime-delivery', 'status-notice-templates']
    .map(name => [name, pathToFileURL(path.join(fx.scripts, name + '.js')).href]));
  const source = [
    'const c = await import(' + JSON.stringify(urls['c4-config']) + ');',
    'const d = await import(' + JSON.stringify(urls['runtime-delivery']) + ');',
    'const s = await import(' + JSON.stringify(urls['status-notice-templates']) + ');',
    'console.log(JSON.stringify(await c.getRuntimeIdentity()));',
    'd.readDeliveryIdentity();',
    'console.log(s.messageForStatus({health:"auth_failed"}));',
  ].join('\n');
  for (const npmAvailable of [true, false]) {
    if (!npmAvailable) fs.unlinkSync(path.join(fx.bin, 'npm'));
    fs.writeFileSync(fx.file, '{"runtime":"codex","statusNotices":{"brand":"Product"}}');
    const valid = evaluate(fx, source);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /codex-main/);
    assert.match(valid.stdout, /\[Product\]/);
    fs.unlinkSync(fx.file);
    const missing = evaluate(fx, source);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /claude-main/);
    fs.writeFileSync(fx.file, '{ broken');
    for (const [name, action] of [
      ['c4-config', 'await m.getRuntimeIdentity()'],
      ['runtime-delivery', 'm.readDeliveryIdentity()'],
      ['status-notice-templates', 'm.messageForStatus({health:"auth_failed"})'],
    ]) {
      const imported = evaluate(fx, 'await import(' + JSON.stringify(urls[name]) + ');');
      assert.equal(imported.status, 0, imported.stderr);
      const result = evaluate(fx, 'const m=await import(' + JSON.stringify(urls[name]) + ');' + action);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CONFIG_UNREADABLE/);
    }
    assert.equal(fs.readFileSync(fx.count, 'utf8'), '');
  }
});

test('installed auth hook honors runtime and approval switch without Core or npm', t => {
  const fx = fixture(t);
  fs.unlinkSync(path.join(fx.bin, 'npm'));
  const hook = path.join(fx.skills, 'activity-monitor/scripts/hook-auth-prompt.js');
  const run = () => spawnSync(process.execPath, [hook], {
    env: fx.env, encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'true' } }),
  });
  for (const [config, shouldEnqueue] of [
    [{}, true], [{ runtime: 'codex' }, false], [{ auto_approve_permission: false }, false],
  ]) {
    fs.rmSync(fx.flag, { force: true });
    fs.writeFileSync(fx.file, JSON.stringify(config));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fx.flag), shouldEnqueue);
    if (shouldEnqueue) assert.ok(JSON.parse(fs.readFileSync(fx.flag, 'utf8')).includes('[KEYSTROKE]Enter'));
  }
  fs.rmSync(fx.flag, { force: true });
  fs.writeFileSync(fx.file, '{');
  const bad = run();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /CONFIG_UNREADABLE/);
  assert.equal(fs.existsSync(fx.flag), false);
  assert.equal(fs.readFileSync(fx.count, 'utf8'), '');
});

test('Docker F1 fallback executes local reader without Core or npm and preserves environment priority', t => {
  const fx = fixture(t);
  fs.unlinkSync(path.join(fx.bin, 'npm'));
  const source = fs.readFileSync(path.join(packageRoot, 'docker/entrypoint.sh'), 'utf8');
  const branch = source.match(/if \[ -z "\$\{ZYLOS_RUNTIME:-\}" \]; then\n  export ZYLOS_DIR\n[\s\S]*?\nfi/);
  assert.ok(branch, 'actual runtime fallback branch must be present');
  const run = env => spawnSync('/bin/bash', ['-c', 'set -e\n' + branch[0] + '\nprintf "%s" "$ZYLOS_RUNTIME"'], {
    env: { ...fx.env, ...env }, encoding: 'utf8', timeout: 10000,
  });
  for (const [config, runtime] of [[null, 'claude'], [{}, 'claude'], [{ runtime: 'codex' }, 'codex']]) {
    fs.rmSync(fx.file, { force: true });
    if (config !== null) fs.writeFileSync(fx.file, JSON.stringify(config));
    const result = run({});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, runtime);
  }
  fs.writeFileSync(fx.file, '{');
  const bad = run({});
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /CONFIG_UNREADABLE/);
  const override = run({ ZYLOS_RUNTIME: 'codex' });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(override.stdout, 'codex');
  assert.equal(fs.readFileSync(fx.count, 'utf8'), '');
});

test('installed setup-caddy requires real Core and rejects missing modules and missing exports', t => {
  const fx = fixture(t);
  fs.copyFileSync(path.join(packageRoot, 'skills/comm-bridge/scripts/core-config-loader.js'),
    path.join(fx.scripts, 'core-config-loader.js'));
  fs.unlinkSync(path.join(fx.bin, 'npm'));
  const setup = path.join(fx.skills, 'http/scripts/setup-caddy.js');
  const run = core => spawnSync(process.execPath, [setup], {
    env: { ...fx.env, ZYLOS_PACKAGE_ROOT: core }, encoding: 'utf8', timeout: 10000,
  });
  const absent = run(path.join(fx.root, 'absent'));
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /Cannot locate/);
  const core = path.join(fx.root, 'core');
  fs.mkdirSync(path.join(core, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(core, 'package.json'), '{"type":"module","name":"zylos"}');
  fs.writeFileSync(path.join(core, 'cli/lib/config.js'), 'export const readZylosConfigStrict = () => ({});');
  const invalid = run(core);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /missing readZylosConfigOrThrow/);
  for (const file of ['config.js', 'config-store.js', 'config-lock.js']) {
    fs.copyFileSync(path.join(packageRoot, 'cli/lib', file), path.join(core, 'cli/lib', file));
  }
  fs.mkdirSync(path.join(fx.data, 'bin'));
  fs.writeFileSync(path.join(fx.data, 'bin/caddy'), '');
  fs.writeFileSync(fx.file, '{');
  const real = run(core);
  assert.notEqual(real.status, 0);
  assert.match(real.stderr, /configuration is unreadable/);
  assert.equal(fs.existsSync(path.join(fx.data, 'http/Caddyfile')), false);
  assert.equal(fs.readFileSync(fx.count, 'utf8'), '');
});
