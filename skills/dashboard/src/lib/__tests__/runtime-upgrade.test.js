import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAction } from '../actions.js';
import { jsonResponse } from '../http.js';

// Every executable comes from this test's private PATH; real CLIs cannot run.
test('CLI upgrades invoke only the instance default runtime and preserve existing results', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-upgrades-'));
  const calls = path.join(root, 'calls');
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });
  for (const runtime of ['agy', 'claude', 'codex']) fs.writeFileSync(path.join(root, runtime),
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({command:${JSON.stringify(runtime)}, args:process.argv.slice(2), auto:process.env.AGY_CLI_DISABLE_AUTO_UPDATE})+'\\n'); console.log('updated');`, { mode: 0o755 });
  process.env.PATH = root;
  for (const runtime of ['agy', 'claude', 'codex', 'future', 'toString']) {
    const result = await handleAction('upgrade-cc', { testRuntime: runtime, runtime: 'claude' }, { runtime, zylosDir: root });
    if (['future', 'toString'].includes(runtime)) {
      assert.equal(result.ok, false); assert.equal(result.error, 'runtime_unsupported');
      assert.equal(jsonResponse(200, result, { command: true }).status, 400);
    } else {
      assert.equal(result.ok, true); assert.equal(result.requires_restart, true);
      assert.equal(result.messageKey, `result.${{ agy: 'agy', claude: 'cc', codex: 'codex' }[runtime]}_updated`);
      if (runtime === 'agy') assert.match(result.message, /Antigravity/);
    }
  }
  const recorded = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.map(row => [row.command, row.args]), [['agy', ['update']], ['claude', ['update']], ['codex', ['update']]]);
  assert.equal(recorded[0].auto, 'true');
});

test('Antigravity nonzero exit is a named failure without success or restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-upgrade-failure-'));
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'agy'), `#!${process.execPath}\nconsole.error('download refused'); process.exit(1);`, { mode: 0o755 });
  process.env.PATH = root;
  const result = await handleAction('upgrade-cc', { case: 'failed' }, { runtime: 'agy', zylosDir: root });
  assert.equal(result.ok, false); assert.equal(result.error, 'upgrade_failed');
  assert.match(result.message, /Antigravity upgrade failed/); assert.equal(result.requires_restart, undefined);
});

test('lost Antigravity replies say result unknown while explicit timeout stays incomplete in both languages', async () => {
  const { actionFailureMessage, formatActionResult } = await import('../../../public/js/action-result.js');
  for (const [language, expected] of [['en', /result is unknown/], ['zh', /结果未知/]]) {
    const dictionary = JSON.parse(fs.readFileSync(new URL(`../../../public/i18n/${language}.json`, import.meta.url)));
    const t = (key, params = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params[name]);
    assert.match(actionFailureMessage('upgrade-cc', 'agy', new Error('connection lost'), t), expected);
    assert.equal(actionFailureMessage('upgrade-cc', 'claude', new Error('failed'), t), t('status.failed', { error: 'failed' }));
    assert.match(formatActionResult({ messageKey: 'result.agy_updated' }, t), /Antigravity/);
  }
});
