import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SCRIPT = path.resolve('skills/activity-monitor/scripts/upgrade-check.js');

function runCheck(t, tags) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-check-stable-')));
  const bin = path.join(root, 'bin'), capture = path.join(root, 'control.json');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  fs.mkdirSync(path.join(root, '.zylos'), {recursive:true});
  fs.writeFileSync(path.join(root, '.zylos/components.json'), '{}');
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({session_mode:'single'}));
  fs.writeFileSync(path.join(bin, 'zylos'), '#!/bin/sh\nprintf "0.9.2\\n"\n', {mode:0o755});
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' ${tags.map(tag => JSON.stringify(`x\\trefs/tags/${tag}`)).join(' ')}\n`, {mode:0o755});
  const bridge = path.join(root, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(bridge, {recursive:true});
  fs.writeFileSync(path.join(bridge, 'c4-control.js'), `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.UPGRADE_CHECK_CAPTURE, JSON.stringify(process.argv.slice(2)));
    process.stdout.write('control 12\\n');
  `);
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
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

test('daily upgrade availability chooses the newest stable tag', t => {
  const f = runCheck(t, ['v0.9.4-beta.2', 'v0.9.3', 'v0.9.3^{}']);
  assert.equal(f.result.status, 0, f.result.stderr);
  const args = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  const content = args[args.indexOf('--content') + 1];
  assert.match(content, /zylos-core 0\.9\.2 .* 0\.9\.3/);
  assert.doesNotMatch(content, /beta/);
});

test('daily upgrade availability does not notify for prerelease-only updates', t => {
  const f = runCheck(t, ['v0.9.3-beta.1', 'v0.9.2']);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(fs.existsSync(f.capture), false);
});
