import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeWebConsoleRemoval, webConsoleProcesses } from '../web-console-finalize.js';
import { step11_startCoreServices, step12_verifyServices } from '../self-upgrade.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-finalize-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}

test('PM2 selection requires this instance, the reserved name, an absolute script and numeric id', t => {
  const root = fixture(t), skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(skills, 'web-console/scripts'), {recursive:true});
  fs.writeFileSync(path.join(skills, 'web-console/scripts/server.js'), '');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(skills, alias);
  const row = (pm_id, name, script) => ({pm_id, name, pm2_env:{pm_exec_path:script}});
  const output = 'PM2 startup banner\n' + JSON.stringify([
    row(1, 'web-console', path.join(skills, 'web-console/scripts/server.js')),
    row(2, 'web-console', path.join(alias, 'web-console/scripts/server.js')),
    row(3, 'web-console', path.join(root, 'other/web-console/scripts/server.js')),
    row(4, 'another-name', path.join(skills, 'web-console/scripts/server.js')),
    row(5, 'web-console', 'web-console/scripts/server.js'),
    row(6, 'web-console', path.join(skills, 'web-console-copy/server.js')),
    row('7', 'web-console', path.join(skills, 'web-console/scripts/server.js')),
  ]);
  assert.deepEqual(webConsoleProcesses(output, skills).map(row => row.pm_id), [1, 2]);
});

test('finalizer backs up complete customized code, preserves data, deletes by id and is reentrant', async t => {
  const root = fixture(t), code = path.join(root, '.claude/skills/web-console');
  fs.mkdirSync(path.join(code, 'node_modules'), {recursive:true});
  fs.mkdirSync(path.join(root, 'web-console'));
  fs.writeFileSync(path.join(code, 'custom.js'), 'owner modification');
  fs.writeFileSync(path.join(code, 'node_modules/keep'), 'dependency');
  fs.writeFileSync(path.join(root, 'web-console/history'), 'historical data');
  fs.writeFileSync(path.join(root, '.env'), 'WEB_CONSOLE_PASSWORD=private-value\nWEB_CONSOLE_MAX_UPLOAD_MB=upload-value\n');
  let listed = true;
  const calls = [];
  const deps = {
    run(command, args) {
      calls.push([command, ...args]);
      if (args[0] === 'jlist') return JSON.stringify(listed ? [{pm_id:17, name:'web-console', pm2_env:{pm_exec_path:path.join(code, 'scripts/server.js')}}] : []);
      assert.deepEqual(args, ['delete', '17']); listed = false;
    },
    removeRoute:() => { calls.push(['caddy']); return {warnings:['Caddy route removed.']}; },
    inspectTasks:() => { calls.push(['tasks']); return ['session-only']; },
  };
  const first = await finalizeWebConsoleRemoval({zylosDir:root}, deps);
  assert.equal(first.pm2Changed, true);
  assert.deepEqual(calls.map(call => call[1] || call[0]), ['jlist', 'delete', 'caddy', 'tasks']);
  const backup = fs.readdirSync(path.join(root, '.backup'));
  assert.equal(backup.length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.backup', backup[0], 'custom.js'), 'utf8'), 'owner modification');
  assert.equal(fs.readFileSync(path.join(root, '.backup', backup[0], 'node_modules/keep'), 'utf8'), 'dependency');
  assert.equal(fs.readFileSync(path.join(root, 'web-console/history'), 'utf8'), 'historical data');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'DASHBOARD_MAX_UPLOAD_MB=upload-value\n');
  assert.match(first.warnings.join(' '), /session-only/);
  assert.doesNotMatch(JSON.stringify(first), /private-value|upload-value/);
  const second = await finalizeWebConsoleRemoval({zylosDir:root}, deps);
  assert.equal(second.pm2Changed, false);
  assert.equal(fs.readdirSync(path.join(root, '.backup')).length, 1);
});
