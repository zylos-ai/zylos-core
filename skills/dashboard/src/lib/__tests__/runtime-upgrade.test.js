import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAction } from '../actions.js';
import { jsonResponse } from '../http.js';

// Every executable comes from this test's private PATH; real CLIs cannot run.
test('CLI upgrades invoke the requested runtime and preserve existing results', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-upgrades-'));
  const calls = path.join(root, 'calls');
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });
  for (const runtime of ['agy', 'claude', 'codex']) fs.writeFileSync(path.join(root, runtime),
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({command:${JSON.stringify(runtime)}, args:process.argv.slice(2), auto:process.env.AGY_CLI_DISABLE_AUTO_UPDATE})+'\\n'); console.log('updated');`, { mode: 0o755 });
  process.env.PATH = root;
  for (const runtime of ['agy', 'claude', 'codex', 'future', 'toString', undefined]) {
    const result = await handleAction('upgrade-cc', { runtime }, { runtime: 'claude', zylosDir: root });
    if (['future', 'toString', undefined].includes(runtime)) {
      assert.equal(result.ok, false); assert.equal(result.error, 'runtime_unsupported');
      assert.equal(jsonResponse(200, result, { command: true }).status, 400);
    } else {
      assert.equal(result.ok, true); assert.equal(result.requires_restart, true);
      const name = { agy: 'Antigravity', claude: 'Claude', codex: 'Codex' }[runtime];
      assert.equal(result.messageKey, 'result.runtime_updated');
      assert.deepEqual(result.messageParams, { runtime: name });
      assert.equal(result.message, `${name} updated. Restart session to apply.`);
    }
  }
  const recorded = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.map(row => [row.command, row.args]), [['agy', ['update']], ['claude', ['update']], ['codex', ['update']]]);
  assert.equal(recorded[0].auto, 'true');
});

test('Antigravity nonzero exit preserves the error without success or restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-upgrade-failure-'));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}\nconsole.error('download refused'); process.exit(1);`, { mode: 0o755 });
  process.env.PATH = root;
  const result = await handleAction('upgrade-cc', { runtime: 'agy', case: 'failed' }, { zylosDir: root });
  assert.equal(result.ok, false); assert.equal(result.error, 'upgrade_failed');
  assert.equal(result.message, 'download refused\n');
  assert.equal(result.messageKey, 'result.upgrade_failed');
  assert.equal(result.requires_restart, undefined);
});

test('lost upgrade replies identify the runtime in both languages', async () => {
  const { actionFailureMessage, formatActionResult } = await import('../../../public/js/action-result.js');
  for (const [language, expected] of [['en', /result is unknown/], ['zh', /结果未知/]]) {
    const dictionary = JSON.parse(fs.readFileSync(new URL(`../../../public/i18n/${language}.json`, import.meta.url)));
    const t = (key, params = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params[name]);
    for (const runtime of ['Antigravity', 'Claude', 'Codex']) {
      const message = actionFailureMessage('upgrade-cc', runtime, new Error('connection lost'), t);
      assert.match(message, expected);
      assert.match(message, new RegExp(runtime));
    }
    assert.match(formatActionResult({ messageKey: 'result.runtime_updated', messageParams: { runtime: 'Antigravity' } }, t), /Antigravity/);
  }
});

// Exercise the real action/upgrade path, with a private executable recording only
// the fixture proxy value. No network or live runtime is used.
test('Antigravity upgrade uses the session HTTPS_PROXY precedence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-upgrade-proxy-'));
  const calls = path.join(root, 'calls');
  const saved = { PATH: process.env.PATH, HTTPS_PROXY: process.env.HTTPS_PROXY };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2), hasProxy:Object.hasOwn(process.env,'HTTPS_PROXY'), proxy:process.env.HTTPS_PROXY})+'\\n'); console.log('updated');`, { mode: 0o755 });
  process.env.PATH = root;
  const cases = [
    { id: 'dotenv-only', dotenv: 'export HTTPS_PROXY="http://dotenv.invalid:8080" # fixture\n', expected: 'http://dotenv.invalid:8080' },
    { id: 'dotenv-wins', dotenv: 'HTTPS_PROXY=http://dotenv.invalid:8080\n', inherited: 'http://process.invalid:8081', expected: 'http://dotenv.invalid:8080' },
    { id: 'process-only', inherited: 'http://process.invalid:8081', expected: 'http://process.invalid:8081' },
    { id: 'neither' },
    { id: 'empty-dotenv', dotenv: 'HTTPS_PROXY=\n', inherited: 'http://process.invalid:8081' },
  ];
  for (const entry of cases) {
    if (entry.dotenv === undefined) fs.rmSync(path.join(root, '.env'), { force: true });
    else fs.writeFileSync(path.join(root, '.env'), entry.dotenv);
    if (entry.inherited === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = entry.inherited;
    const result = await handleAction('upgrade-cc', { runtime: 'agy', case: entry.id }, { zylosDir: root });
    assert.equal(result.ok, true, entry.id);
    const recorded = JSON.parse(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1));
    assert.deepEqual(recorded.args, ['update']);
    assert.equal(recorded.hasProxy, entry.expected !== undefined, entry.id);
    assert.equal(recorded.proxy, entry.expected, entry.id);
  }
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, cases.length);
});
