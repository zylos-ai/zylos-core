import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = path.resolve(scripts, '../../..');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['home', 'tmp', 'bin', '.zylos']) fs.mkdirSync(path.join(dir, name));
  fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'node'));
  fs.writeFileSync(path.join(dir, '.zylos', 'config.json'), '{"runtime":"claude","session_mode":"multi"}');
  const installed = path.join(dir, '.claude/skills/comm-bridge');
  fs.mkdirSync(path.join(installed, 'scripts/router'), { recursive: true });
  fs.copyFileSync(path.join(scripts, '../package.json'), path.join(installed, 'package.json'));
  fs.copyFileSync(path.join(scripts, '../init-db.sql'), path.join(installed, 'init-db.sql'));
  fs.symlinkSync(path.resolve(scripts, '../node_modules'), path.join(installed, 'node_modules'));
  for (const file of fs.readdirSync(scripts).filter(name => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(scripts, file), path.join(installed, 'scripts', file));
  }
  fs.copyFileSync(path.join(scripts, 'router/core-modules.js'), path.join(installed, 'scripts/router/core-modules.js'));
  fs.copyFileSync(path.join(scripts, 'router/wake-socket.js'), path.join(installed, 'scripts/router/wake-socket.js'));
  return { dir, installed, cli: path.join(installed, 'scripts/c4-send.js'),
    env: { HOME: path.join(dir, 'home'), ZYLOS_DIR: dir, PM2_HOME: path.join(dir, 'pm2'),
      TMPDIR: path.join(dir, 'tmp'), TMUX_TMPDIR: path.join(dir, 'tmp'), PATH: path.join(dir, 'bin'),
      ZYLOS_PACKAGE_ROOT: packageRoot, ZYLOS_SESSION_GROUP: 'origin' } };
}

function runDatabase(fixture, body) {
  const module = pathToFileURL(path.join(fixture.installed, 'scripts/c4-db.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as db from ${JSON.stringify(module)};
try { ${body} } finally { db.close(); }
`], { env: fixture.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

test('installed external and void commands dispatch through installed component scripts', t => {
  const fixture = setup(t);
  const component = path.join(fixture.dir, '.claude/skills/demo/scripts');
  fs.mkdirSync(component, { recursive: true });
  const output = path.join(fixture.dir, 'argv.json');
  fs.writeFileSync(path.join(component, 'send.js'), `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)))`);
  const externalEnv = { ...fixture.env };
  delete externalEnv.ZYLOS_SESSION_GROUP;
  const invoke = (args, env = fixture.env) => spawnSync(process.execPath, [fixture.cli, ...args],
    { env, input: 'body\n', encoding: 'utf8', timeout: 3000 });
  const external = invoke(['demo', 'a\'"$`\\\nroute', '--stdin'], externalEnv);
  assert.equal(external.status, 0, external.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), ['a\'"$`\\\nroute', 'body']);
  assert.equal(invoke(['void', 'handoff', '--stdin']).status, 0);
  const rows = runDatabase(fixture, `console.log(JSON.stringify(db.getDb().prepare("SELECT channel,session_group FROM conversations ORDER BY id").all()));`);
  assert.deepEqual(rows, [{ channel: 'demo', session_group: 'demo' }, { channel: 'void', session_group: 'origin' }]);
});
