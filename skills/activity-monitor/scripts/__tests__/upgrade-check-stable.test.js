import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SCRIPT = path.resolve('skills/activity-monitor/scripts/upgrade-check.js');

function runCheck(t, tags, current = '0.9.2', components = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-check-stable-')));
  const bin = path.join(root, 'bin'), capture = path.join(root, 'control.json');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  fs.mkdirSync(path.join(root, '.zylos'), {recursive:true});
  fs.writeFileSync(path.join(root, '.zylos/components.json'), JSON.stringify(components));
  fs.writeFileSync(path.join(bin, 'zylos'), `#!/bin/sh\nprintf '%s\\n' '${current}'\n`, {mode:0o755});
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' ${tags.map(tag => JSON.stringify(`x\\trefs/tags/${tag}`)).join(' ')}\n`, {mode:0o755});
  const bridge = path.join(root, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(bridge, {recursive:true});
  fs.writeFileSync(path.join(bridge, 'c4-control.js'), `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.UPGRADE_CHECK_CAPTURE, JSON.stringify(process.argv.slice(2)));
    process.stdout.write('control 12\\n');
  `);
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.mkdirSync(path.join(root, 'pm2'));
  console.log(JSON.stringify({ HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), tmux: 'unused', databases: 'unused; C4 fixture captures arguments only' }));
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding:'utf8',
    env:{
      ...process.env,
      HOME:root,
      PM2_HOME:path.join(root, 'pm2'),
      TMPDIR:path.join(root, 'tmp'),
      ZYLOS_DIR:root,
      PATH:`${bin}:${process.env.PATH}`,
      UPGRADE_CHECK_CAPTURE:capture,
    },
  });
  return {root, capture, result};
}

// Boundary: real monitor with fixture git/zylos/C4. Run for monitor tag selection
// or notification changes; skip for unrelated installer internals.
test('daily upgrade availability chooses the newest stable tag', t => {
  const f = runCheck(t, ['v0.9.4-beta.2', 'v0.9.3', 'v0.9.3^{}']);
  assert.equal(f.result.status, 0, f.result.stderr);
  const args = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  const content = args[args.indexOf('--content') + 1];
  assert.match(content, /zylos-core 0\.9\.2 .* 0\.9\.3/);
  assert.doesNotMatch(content, /beta/);
});

// Boundary: real monitor with fixture git/zylos/C4. Run for monitor tag selection
// or notification changes; skip for unrelated installer internals.
test('daily upgrade availability does not notify for prerelease-only updates', t => {
  const f = runCheck(t, ['v0.9.3-beta.1', 'v0.9.2']);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(fs.existsSync(f.capture), false);
});

// Boundary: real monitor core notification. Run for major filtering changes;
// skip for unrelated archive download or installation changes.
for (const [current, versions, expected] of [
  ['0.9.3', ['v1.0.0', 'v0.9.4'], '0.9.4'],
  ['0.9.3', ['v1.0.0'], null],
  ['0.9.3', ['v1.0.0', 'v0.9.3'], null],
  ['1.2.0', ['v2.0.0', 'v1.3.0'], '1.3.0'],
]) test(`daily core availability within major ${current}: ${expected || 'up to date'}`, t => {
  const f = runCheck(t, versions, current);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(fs.existsSync(f.capture), expected !== null);
  if (expected) assert.ok(fs.readFileSync(f.capture, 'utf8').includes(expected));
});

// Boundary: component notifications stay unscoped. Run when shared monitor
// selection changes; skip for unrelated core archive acquisition changes.
test('daily component availability still includes a new major', t => {
  const f = runCheck(t, ['v1.0.0'], '0.9.3', { example: { repo: 'org/example', version: '0.9.3' } });
  assert.equal(f.result.status, 0, f.result.stderr);
  const content = fs.readFileSync(f.capture, 'utf8');
  assert.match(content, /example 0.9.3 .* 1.0.0/);
  assert.doesNotMatch(content, /zylos-core/);
});
