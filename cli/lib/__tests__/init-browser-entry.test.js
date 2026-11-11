import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseInitFlags, resolveFromEnv, startServicesWithDashboard, printInitHelp } from '../../commands/init.js';

test('init rejects the removed browser password option before setup', () => {
  assert.throws(() => parseInitFlags(['--web-password', 'fixture']), /Unknown init option: --web-password/);
  const child = spawnSync(process.execPath, [path.resolve('cli/zylos.js'), 'init', '--web-password', 'fixture'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    env: { ...process.env, PATH: '' },
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stdout + child.stderr, /Unknown init option: --web-password/);
});

test('init ignores former password environment inputs and removes them from help', t => {
  const previous = { ZYLOS_WEB_PASSWORD: process.env.ZYLOS_WEB_PASSWORD, WEB_CONSOLE_PASSWORD: process.env.WEB_CONSOLE_PASSWORD };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.ZYLOS_WEB_PASSWORD = 'fixture-new-password';
  process.env.WEB_CONSOLE_PASSWORD = 'fixture-old-password';
  const opts = parseInitFlags([]);
  resolveFromEnv(opts, { authenticated: () => true });
  assert.equal(Object.hasOwn(opts, 'webPassword'), false);
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  printInitHelp();
  assert.doesNotMatch(lines.join('\n'), /web-password|ZYLOS_WEB_PASSWORD|WEB_CONSOLE_PASSWORD/);
});

test('init service orchestration passes only Dashboard access context', async () => {
  const { dashboardAccess, servicesStarted } = await startServicesWithDashboard({ caddy: false, quiet: true }, async (...args) => {
    assert.equal(args.length, 1);
    assert.equal(args[0].noCaddy, true);
    assert.equal(args[0].quiet, true);
    args[0].password = 'fixture-dashboard';
    return 3;
  }, {finalizeWebConsoleRemoval:async()=>({warnings:[]}), savePm2ProcessList:()=>true});
  assert.equal(servicesStarted, 3);
  assert.equal(dashboardAccess.password, 'fixture-dashboard');
});

// Coverage: real template/Caddy generators in a synthetic install, no init,
// runtime, PM2, tmux, database or network. Run for browser-entry/template changes;
// skip otherwise. Official runner isolates all instance roots before import;
// this child further isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and is bounded.
test('new installation templates generate Dashboard-only browser configuration', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-entry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'zylos');
  fs.mkdirSync(root);
  const init = new URL('../../commands/init.js', import.meta.url).href;
  const script = `import fs from 'node:fs'; import path from 'node:path';
    import { deployTemplates, generateCaddyfile } from ${JSON.stringify(init)};
    deployTemplates({ freshInstall: true });
    generateCaddyfile('fixture.invalid', 'http', 8080);
    const root = process.env.ZYLOS_DIR;
    console.log(JSON.stringify({ env: fs.readFileSync(path.join(root,'.env'),'utf8'),
      caddy: fs.readFileSync(path.join(root,'http/Caddyfile'),'utf8') }));`;
  const env = { ...process.env, HOME: home, ZYLOS_DIR: root, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: home, PATH: '', ZYLOS_WEB_PASSWORD: 'fixture-ignored-password' };
  console.log('Synthetic install paths', JSON.stringify({ HOME: home, ZYLOS_DIR: root, PM2_HOME: env.PM2_HOME, TMPDIR: home,
    tmux: 'not used', database: 'not used' }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env, encoding: 'utf8', timeout: 15000, maxBuffer: 262144,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.doesNotMatch(result.env, /ZYLOS_WEB_PASSWORD|WEB_CONSOLE_PASSWORD/);
  assert.doesNotMatch(result.caddy, /\/console|3456|Web Console/);
  assert.match(result.caddy, /handle \/health/);
  assert.match(result.caddy, /file_server/);
  assert.doesNotMatch(child.stdout + child.stderr, /fixture-ignored-password/);
});
