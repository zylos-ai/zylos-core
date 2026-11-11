import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverChannels, webConsoleRemovalWarnings } from '../../commands/doctor.js';

test('doctor omits removed Web Console even when its old process is online', () => {
  const environment = new Map([['DOMAIN', 'agent.test'], ['WEB_CONSOLE_PASSWORD', 'private-password']]);
  const processes = [{ name: 'web-console', pm2_env: { status: 'online' } }];
  assert.deepEqual(discoverChannels(processes, environment, false, {}), []);
  assert.equal(discoverChannels(processes, environment, true, {})[0].name, 'tmux');
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
