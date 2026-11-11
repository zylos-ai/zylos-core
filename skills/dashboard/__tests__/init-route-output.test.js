import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Init orchestration integration. Run for Dashboard route reporting/provisioning
// changes; skip unrelated UI. Each worker uses private HOME/ZYLOS_DIR/PM2_HOME,
// short temp/tmux location and DB paths. PM2/install commands are intercepted;
// real hook + route owner run. Bounded synchronous worker is reaped on timeout.
for (const mode of ['absent', 'failed', 'explicit-skip', 'hook-failed', 'provision-failed', 'quiet']) {
  const invalidPort = mode === 'failed', noCaddy = mode === 'explicit-skip';
  const provisionFailed = mode === 'provision-failed';
  const quiet = mode === 'quiet';
  test(`init Dashboard route output ${quiet ? 'suppresses the generated password in quiet mode and preserves it on repeat init' : provisionFailed ? `reports ${mode} without claiming a configured password` : mode === 'hook-failed' ? 'retains the confirmed password when the later hook fails' : invalidPort ? 'reports an actual failure reason' : noCaddy ? 'respects no-caddy with existing Caddy files' : 'does not warn when Caddy is absent'}`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-route-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
      PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp') };
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
    const data = path.join(env.ZYLOS_DIR, 'components/dashboard');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'config.json'), provisionFailed ? '{' : JSON.stringify({ port: invalidPort ? 'invalid' : 3491 }));
    const skills = path.join(env.ZYLOS_DIR, '.claude/skills'); fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(fileURLToPath(new URL('../', import.meta.url)), path.join(skills, 'dashboard'));
    const pm2 = path.join(env.ZYLOS_DIR, 'pm2'); fs.mkdirSync(pm2);
    fs.writeFileSync(path.join(pm2, 'ecosystem.config.cjs'), 'module.exports={apps:[{name:"scheduler"}]}');
    fs.writeFileSync(path.join(env.ZYLOS_DIR, '.env'), 'ZYLOS_WEB_PASSWORD=fixture\n');
    if (noCaddy) {
      fs.mkdirSync(path.join(env.ZYLOS_DIR, 'bin'));
      fs.mkdirSync(path.join(env.ZYLOS_DIR, 'http'));
      fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
      fs.writeFileSync(path.join(env.ZYLOS_DIR, 'bin/caddy'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
      fs.writeFileSync(path.join(env.ZYLOS_DIR, 'http/Caddyfile'), 'invalid fixture');
      fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ domain: 'public.example.test', protocol: 'https' }));
    } else {
      assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, 'bin/caddy')), false);
      assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, 'http/Caddyfile')), false);
    }
    console.log('Init route targets:', JSON.stringify({ ...Object.fromEntries(
      ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, env[key]])),
      tmuxSocket: path.join(env.TMUX_TMPDIR, 'default'), db: path.join(data, 'dashboard.db') }));
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
      fileURLToPath(new URL('./fixtures/init-dashboard-route.js', import.meta.url)), ...(noCaddy ? ['--no-caddy'] : []), ...(provisionFailed || mode === 'hook-failed' ? [mode] : []), ...(quiet ? ['--quiet'] : [])], {
      env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Init route worker isolation:/);
    assert.doesNotMatch(result.stdout + result.stderr, /requires attention: undefined/);
    if (invalidPort) assert.match(result.stdout, /Dashboard route requires attention: Invalid Dashboard port/);
    else if (!provisionFailed) {
      assert.doesNotMatch(result.stdout, /Dashboard route requires attention/);
      assert.match(result.stdout, /http:\/\/127\.0\.0\.1:3491\//);
      assert.match(result.stdout, /Local access only through this port; no public route/);
    }
    if (provisionFailed) {
      assert.match(result.stdout, /Dashboard configuration failed:/);
      assert.match(result.stdout, /password setup could not be confirmed/);
      assert.match(result.stdout, /zylos dashboard reset-password/);
      assert.doesNotMatch(result.stdout, /Password already configured|Password:/);
      assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), '{');
      return;
    }
    if (quiet) {
      assert.doesNotMatch(result.stdout + result.stderr, /Password:|[a-f0-9]{32}/);
      assert.match(result.stdout, /Dashboard password generated/);
      assert.match(result.stdout, /zylos dashboard reset-password/);
      assert.match(result.stdout, /generate and display a new random password/);
      assert.doesNotMatch(result.stdout, /set your own password/);
      assert.match(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).auth.password, /^scrypt:/);
      return;
    }
    if (mode === 'hook-failed') assert.match(result.stdout, /Dashboard configuration failed: fixture hook failure/);
    const generated = result.stdout.match(/Password: ([a-f0-9]{32})/);
    assert.ok(generated, 'init should display the generated password');
    assert.equal(result.stdout.split(generated[1]).length - 1, 1);
    assert.ok(result.stdout.indexOf('Init service phase finished.') < result.stdout.indexOf('Password:'));
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.match(config.auth.password, /^scrypt:/);
    assert.equal(config.port, invalidPort ? 'invalid' : 3491);
    if (noCaddy) assert.equal(fs.readFileSync(path.join(env.ZYLOS_DIR, 'http/Caddyfile'), 'utf8'), 'invalid fixture');
  });
}
