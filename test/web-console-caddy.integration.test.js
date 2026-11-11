import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { removeWebConsoleRoute } from '../cli/lib/web-console-route.js';
import { validateAndDeploy } from '../cli/lib/caddy.js';

// Covers native Caddy validation, successful reload and failed-reload rollback.
// Run for route recognition/deployment changes. Skip without an explicitly
// selected native binary or when isolation cannot be proved. Every case uses
// isolated HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR, a private tmux socket path,
// synthetic database paths, and a private Caddy admin socket. No real upgrade
// or instance data is used. The native child is stopped/reaped even on failure.
test('native Caddy removes generated routes and protects rejected deployments', {
  skip:process.env.RUN_WEB_CONSOLE_NATIVE !== '1' || !process.env.TEST_CADDY_BIN,
  timeout:40000,
}, async t => {
  const binary = fs.realpathSync(process.env.TEST_CADDY_BIN);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-caddy-')));
  const root = path.join(base, 'zylos');
  const env = {...process.env, HOME:path.join(base, 'home'), ZYLOS_DIR:root,
    PM2_HOME:path.join(base, 'pm2'), TMPDIR:path.join(base, 'tmp'), TMUX:'',
    XDG_DATA_HOME:path.join(base, 'data'), XDG_CONFIG_HOME:path.join(base, 'config')};
  const adminSocket = path.join(base, 'admin.sock');
  assert.ok(Buffer.byteLength(adminSocket) < 100, 'private Caddy socket must fit native path limit');
  for (const directory of [env.HOME, root, env.PM2_HOME, env.TMPDIR, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME,
    path.join(root, 'bin'), path.join(root, 'http/public'), path.join(root, 'scheduler')]) {
    fs.mkdirSync(directory, {recursive:true});
    assert.ok(fs.realpathSync(directory).startsWith(base + path.sep));
  }
  fs.symlinkSync(binary, path.join(root, 'bin/caddy'));
  const syntheticDatabase = path.join(root, 'scheduler/scheduler.db');
  fs.writeFileSync(syntheticDatabase, 'synthetic fixture, never queried');
  console.log(JSON.stringify({isolation:{HOME:env.HOME, ZYLOS_DIR:env.ZYLOS_DIR, PM2_HOME:env.PM2_HOME,
    TMPDIR:env.TMPDIR, tmuxSocket:path.join(base, 'private-tmux'), database:syntheticDatabase,
    caddyBinary:binary, caddyAdminSocket:adminSocket}}));
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const caddyfile = path.join(root, 'http/Caddyfile');
  const header = `{\n    admin unix/${adminSocket}\n    auto_https off\n}\nhttp://127.0.0.1:${port} {\n    root * ${path.join(root, 'http/public')}\n    respond /health ready\n`;
  const route = `\n    # Web Console (core built-in)\n    redir /console /console/ permanent\n    handle /console/* {\n        uri strip_prefix /console\n        reverse_proxy localhost:3456\n    }\n`;
  const footer = '\n    file_server\n}\n';
  const original = header + route + footer;
  fs.writeFileSync(caddyfile, original, {mode:0o640});
  let child;
  let output = '';
  let childError;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      let timer;
      try {
        await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); })]);
        if (child.exitCode === null && child.signalCode === null) await exited;
      } finally { clearTimeout(timer); }
    }
    fs.rmSync(base, {recursive:true, force:true});
  };
  t.after(stop);
  child = spawn(binary, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {env, cwd:base, stdio:['ignore', 'pipe', 'pipe']});
  child.on('error', error => { childError = error; });
  const capture = chunk => {
    output += chunk.toString();
    if (output.length > 32768) { child.kill('SIGTERM'); output = output.slice(-32768); }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const request = pathname => fetch(`http://127.0.0.1:${port}${pathname}`, {signal:AbortSignal.timeout(1000)});
  let ready = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (childError) throw childError;
    assert.equal(child.exitCode, null, output);
    try { const response = await request('/health'); ready = response.status === 200 && await response.text() === 'ready'; }
    catch { /* Wait only for this isolated native child. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const native = (args) => execFileSync(binary, args, {env, cwd:base, stdio:'pipe', timeout:10000});
  const validate = candidate => native(['validate', '--config', candidate, '--adapter', 'caddyfile']);
  const reload = () => native(['reload', '--config', caddyfile, '--adapter', 'caddyfile', '--address', `unix/${adminSocket}`]);

  await t.test('successful native reload serves no console route', async () => {
    const result = removeWebConsoleRoute({zylosDir:root, deploy:(next, old, options) => validateAndDeploy(next, old, {...options, validate, reload})});
    assert.equal(result.changed, true, result.warnings.join('\n'));
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), header + footer);
    assert.equal((await request('/console/')).status, 404);
    assert.equal((await request('/health')).status, 200);
    assert.equal(fs.statSync(caddyfile).mode & 0o777, 0o640);
  });

  await t.test('native validation rejects malformed candidate without modifying original bytes', () => {
    const malformed = original.replace('    file_server', '    synthetic_invalid_directive');
    fs.writeFileSync(caddyfile, malformed);
    const inode = fs.statSync(caddyfile).ino;
    const result = removeWebConsoleRoute({zylosDir:root, deploy:(next, old, options) => validateAndDeploy(next, old, {
      ...options, validate, reload:() => assert.fail('invalid candidate must not reload'),
    })});
    assert.equal(result.changed, false);
    assert.match(result.warnings.join('\n'), /validation failed/);
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), malformed);
    assert.equal(fs.statSync(caddyfile).ino, inode);
  });

  await t.test('native reload command failure restores original configuration', () => {
    fs.writeFileSync(caddyfile, original);
    let reloadAttempts = 0;
    const result = removeWebConsoleRoute({zylosDir:root, deploy:(next, old, options) => validateAndDeploy(next, old, {
      ...options, validate,
      reload:() => {
        reloadAttempts++;
        native(['reload', '--config', caddyfile, '--adapter', 'caddyfile', '--address', `unix/${path.join(base, 'missing.sock')}`]);
      },
    })});
    assert.equal(result.changed, false);
    assert.equal(reloadAttempts, 2);
    assert.match(result.warnings.join('\n'), /original Caddyfile restored/);
    assert.equal(fs.readFileSync(caddyfile, 'utf8'), original);
    assert.equal(fs.statSync(caddyfile).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(path.dirname(caddyfile)).sort(), ['Caddyfile', 'public']);
  });
});
