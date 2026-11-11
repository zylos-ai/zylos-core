import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverChannels, webConsoleRemovalWarnings } from '../../commands/doctor.js';

test('doctor shows Dashboard routing and status without Web Console credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components/dashboard/config.json'), '{"port":4870}');
  const processes = [{ name: 'zylos-dashboard', pm2_env: { status: 'online' } }, { name: 'web-console', pm2_env: { status: 'online' } }];
  const environment = new Map([['DOMAIN', 'agent.test'], ['PROTOCOL', 'https']]);
  assert.equal(discoverChannels(processes, environment, false, {}, root)[0].action, 'http://localhost:4870/');
  const routed = discoverChannels([...processes, { name: 'caddy', pm2_env: { status: 'online' } }], environment, false, {}, root);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].name, 'Dashboard');
  assert.equal(routed[0].action, 'https://agent.test/dashboard/');
  assert.equal(routed[0].online, true);
  processes[0].pm2_env.status = 'stopped';
  assert.equal(discoverChannels(processes, environment, false, {}, root)[0].online, false);
});

test('doctor warns about leftover code and old upload key without exposing values', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-removal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(webConsoleRemovalWarnings({ skillsDir: root, env: new Map() }), []);
  fs.mkdirSync(path.join(root, 'web-console'));
  const warnings = webConsoleRemovalWarnings({ skillsDir: root, env: new Map([['WEB_CONSOLE_MAX_UPLOAD_MB', 'private-limit']]) });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Old Web Console code remains/);
  assert.match(warnings[1], /WEB_CONSOLE_MAX_UPLOAD_MB/);
  assert.equal(warnings.join('\n').includes('private-limit'), false);
});
