import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recoveryCommand} from '../../commands/recovery.js';

test('recovery CLI retires supervisor configuration and verification without creating files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const sub of ['configure', 'verify']) {
    await assert.rejects(recoveryCommand([sub, '--write'], {root}), /supervisor configuration and verification have been removed/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('status and resume on an ordinary deployment do not require stable deployment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-idle-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const sub of ['status', 'resume']) await assert.doesNotReject(recoveryCommand([sub], {root}));
  assert.deepEqual(fs.readdirSync(root), []);
});


test('CLI status uses file status and resume enters the same trusted bootstrap once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-active-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(stable, 'active.json'), '{}', {mode: 0o600});
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), '// fixture', {mode: 0o600});
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `exports.bootstrap = (root, options = {}) => {
    require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(options) + '\\n');
    return {active: true, blocked: true, prompt: 'recovery task'};
  };`, {mode: 0o600});
  await recoveryCommand(['status'], {root});
  await recoveryCommand(['resume'], {root});
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [{}, {status: true, once: false}, {}, {status: false, once: true}]);
});
