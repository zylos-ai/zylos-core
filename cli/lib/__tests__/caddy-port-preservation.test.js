import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  applyCaddyRoutes, generateManualRouteSnippet, inspectCaddyRouteMarkers,
  removeCaddyRoutes,
} from '../caddy.js';
import { generateManifest, saveMergeBaseline } from '../manifest.js';

const route = (path, port, extra = {}) => ({
  path, type: 'reverse_proxy', target: `127.0.0.1:${port}`, ...extra,
});
const site = (...blocks) => `example.com {\n    respond /health 200\n${blocks.join('\n')}\n}\n`;
const block = (name, routes) => generateManualRouteSnippet(name, routes);
const parsed = (name, content) => inspectCaddyRouteMarkers(content, name).blocks;

test('upgrade keeps a deployed port while regenerating all other route settings', () => {
  const old = site(block('dashboard', [route('/dashboard/*', 3471, { strip_prefix: '/dashboard' })]));
  const next = [route('/dashboard/*', 3470, { target: 'localhost:3470', strip_prefix: '/new-prefix' })];
  let deployed;
  const result = applyCaddyRoutes('dashboard', next, {
    isCaddyAvailable: () => true,
    readFileSync: () => old,
    validateAndDeploy: content => { deployed = content; return { success: true }; },
  });
  assert.equal(result.success, true);
  assert.equal(result.portSource, 'caddy');
  assert.match(deployed, /reverse_proxy localhost:3471/);
  assert.match(deployed, /uri strip_prefix \/new-prefix/);
  assert.doesNotMatch(deployed, /uri strip_prefix \/dashboard\n/);
  assert.match(deployed, /respond \/health 200/);
});

test('upgrade rejects malformed markers before stopping the service or changing files', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-805-preflight-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const skillDir = path.join(home, '.claude/skills/example');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'http'));
  const skill = '---\nname: example\nversion: 1.0.0\n---\n';
  const caddy = site('    # BEGIN zylos-component:example\n    handle /example/* {\n        reverse_proxy 127.0.0.1:3471\n    }');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill);
  fs.writeFileSync(path.join(home, 'http/Caddyfile'), caddy);
  const source = new URL('../upgrade.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { runUpgrade } from ${JSON.stringify(source)};
    process.stdout.write(JSON.stringify(runUpgrade('example', { tempDir: '/unused' })));
  `], { env: { ...process.env, ZYLOS_DIR: home }, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.success, false);
  assert.equal(result.failedStep, 0);
  assert.deepEqual(result.steps, []);
  assert.equal(result.rollback.performed, false);
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), skill);
  assert.equal(fs.readFileSync(path.join(home, 'http/Caddyfile'), 'utf8'), caddy);
});

test('install and uninstall reject malformed markers before changing component files', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-805-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'http'));
  fs.mkdirSync(path.join(home, '.zylos'));
  const caddy = site('    # BEGIN zylos-component:example');
  fs.writeFileSync(path.join(home, 'http/Caddyfile'), caddy);
  const source = path.join(home, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: example\nversion: 1.0.0\n---\n');
  const cli = new URL('../../zylos.js', import.meta.url);
  const run = args => spawnSync(process.execPath, [cli.pathname, ...args], {
    env: { ...process.env, ZYLOS_DIR: home }, encoding: 'utf8', timeout: 10000,
  });

  const add = run(['add', source, '--yes', '--json']);
  assert.equal(add.status, 1, add.stderr);
  assert.match(add.stdout, /invalid_caddy_markers/);
  assert.equal(fs.existsSync(path.join(home, '.claude/skills/example')), false);
  assert.equal(fs.readFileSync(path.join(home, 'http/Caddyfile'), 'utf8'), caddy);

  const skillDir = path.join(home, '.claude/skills/example');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(path.join(source, 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
  fs.writeFileSync(path.join(home, '.zylos/components.json'), JSON.stringify({ example: { version: '1.0.0' } }));
  const remove = run(['uninstall', 'example', '--yes', '--json']);
  assert.equal(remove.status, 1, remove.stderr);
  assert.match(remove.stdout, /Unpaired Caddy route markers/);
  assert.equal(fs.existsSync(skillDir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.zylos/components.json'), 'utf8')), { example: { version: '1.0.0' } });
  assert.equal(fs.readFileSync(path.join(home, 'http/Caddyfile'), 'utf8'), caddy);
});

test('paired duplicate blocks merge, conflicting ports fall back, removal clears only the target', () => {
  const old = site(block('dash', [route('/dash/*', 3471)]), block('dashboard', [route('/dashboard/*', 3472)]), block('dash', [route('/dash/*', 3490)]));
  let deployed;
  const deps = {
    isCaddyAvailable: () => true,
    readFileSync: () => old,
    validateAndDeploy: content => { deployed = content; return { success: true }; },
  };
  const result = applyCaddyRoutes('dash', [route('/dash/*', 3480)], deps);
  assert.equal(result.success, true);
  assert.equal(result.portSource, 'default');
  assert.match(result.notice, /Duplicate route blocks found; merged into one/);
  assert.equal(parsed('dash', deployed).length, 1);
  assert.equal(parsed('dashboard', deployed).length, 1);
  assert.match(deployed, /reverse_proxy 127\.0\.0\.1:3480/);

  const removal = removeCaddyRoutes('dash', deps);
  assert.equal(removal.success, true);
  assert.equal(parsed('dash', deployed).length, 0);
  assert.equal(parsed('dashboard', deployed).length, 1);
  assert.match(removal.notice, /Duplicate route blocks found/);
});

test('a route generation error does not leave a running service stopped after upgrade', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-805-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const installed = path.join(home, '.claude/skills/example');
  const oldSource = path.join(root, 'old');
  const nextSource = path.join(root, 'next');
  const bin = path.join(root, 'bin');
  for (const dir of [installed, oldSource, nextSource, bin]) fs.mkdirSync(dir, { recursive: true });
  const oldSkill = '---\nname: example\nversion: 1.0.0\nlifecycle:\n  service:\n    name: zylos-example\n---\n';
  const nextSkill = '---\nname: example\nversion: 2.0.0\nlifecycle:\n  service:\n    name: zylos-example\nhttp_routes:\n  - type: reverse_proxy\n    target: 127.0.0.1:3470\n---\n';
  fs.writeFileSync(path.join(installed, 'SKILL.md'), oldSkill);
  fs.writeFileSync(path.join(oldSource, 'SKILL.md'), oldSkill);
  fs.writeFileSync(path.join(nextSource, 'SKILL.md'), nextSkill);
  saveMergeBaseline(installed, oldSource, generateManifest(oldSource));
  const log = path.join(root, 'pm2.log');
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$ZYLOS_TEST_PM2_LOG"\nif [ "$1" = jlist ]; then printf '[{"name":"zylos-example","pm2_env":{"status":"online"}}]\\n'; fi\n`, { mode: 0o755 });
  const driver = new URL('../../../test/helpers/run-upgrade-driver.mjs', import.meta.url);
  const child = spawnSync(process.execPath, [driver.pathname, 'example', nextSource, '2.0.0'], {
    env: { ...process.env, ZYLOS_DIR: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ZYLOS_TEST_PM2_LOG: log },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.steps.find(s => s.name === 'caddy_routes').status, 'skipped');
  assert.equal(result.steps.find(s => s.name === 'start_service').status, 'done');
  assert.match(fs.readFileSync(log, 'utf8'), /stop zylos-example/);
  assert.match(fs.readFileSync(log, 'utf8'), /restart zylos-example/);
});
