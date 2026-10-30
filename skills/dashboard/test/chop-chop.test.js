import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleAction } from '../src/lib/actions.js';

function fixture(t, failContent = null, failureReply = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-chop-chop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const log = path.join(root, 'controls.jsonl');
  fs.writeFileSync(path.join(scripts, 'c4-control.js'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const content = args[args.indexOf('--content') + 1];
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, content, time: Date.now() }) + '\\n');
    if (content === ${JSON.stringify(failContent)}) {
      if (${JSON.stringify(failureReply)}) console.log(${JSON.stringify(failureReply)});
      else { process.stderr.write('fixture queue failure'); process.exitCode = 1; }
    } else console.log(JSON.stringify({ok:true,data:{id:1}}));
  `);
  return {
    config: { zylosDir: root }, body: { request: crypto.randomUUID(), runId: 'confirmed-run', sessionId: 'confirmed-session' },
    records: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  };
}

test('chop-chop queues Escape then exact continue at least 500ms later', async t => {
  const f = fixture(t);
  const result = await handleAction('chop-chop', f.body, f.config);
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].submission, 'submitted');
  assert.equal(result.steps[1].submission, 'submitted');
  const records = f.records();
  assert.deepEqual(records.map(r => r.content), ['[KEYSTROKE]Escape', 'continue']);
  assert.ok(records[1].time - records[0].time >= 500);
  for (const record of records) {
    assert.deepEqual(record.args, ['enqueue', '--content', record.content, '--priority', '0', '--bypass-state', '--no-ack-suffix', '--target-run', 'confirmed-run', '--json', '--expected-session', 'confirmed-session']);
  }
});

test('Escape failure prevents continue and reports no successful enqueue', async t => {
  const f = fixture(t, '[KEYSTROKE]Escape');
  const result = await handleAction('chop-chop', f.body, f.config);
  assert.equal(result.ok, false);
  assert.equal(result.submission, 'unknown');
  assert.equal(result.steps.length, 1);
  assert.deepEqual(f.records().map(r => r.content), ['[KEYSTROKE]Escape']);
});

test('continue failure reports partial execution instead of success', async t => {
  const f = fixture(t, 'continue');
  const result = await handleAction('chop-chop', f.body, f.config);
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].submission, 'submitted');
  assert.equal(result.steps[1].submission, 'unknown');
  assert.equal(result.messageKey, 'result.control_unknown');
  assert.deepEqual(f.records().map(r => r.content), ['[KEYSTROKE]Escape', 'continue']);
});

test('target rejection reports only a current run supplied by the backend', async t => {
  const missing = fixture(t, 'continue', JSON.stringify({ ok: false, error: { code: 'TARGET_NOT_RUNNING' } }));
  const noCurrent = await handleAction('chop-chop', missing.body, missing.config);
  assert.equal(noCurrent.messageParams.runId, 'unknown');

  const changed = fixture(t, 'continue', JSON.stringify({ ok: false, error: { code: 'TARGET_MISMATCH', runId: 'replacement-run' } }));
  const current = await handleAction('chop-chop', changed.body, changed.config);
  assert.equal(current.messageParams.runId, 'replacement-run');
});

test('identical concurrent chop-chop calls queue only one control pair', async t => {
  const f = fixture(t);
  const first = handleAction('chop-chop', f.body, f.config);
  const duplicate = await handleAction('chop-chop', f.body, f.config);
  assert.equal(duplicate.error, 'duplicate_request');
  assert.equal((await first).ok, true);
  assert.equal(f.records().length, 2);
});

test('legacy interrupt remains a single Escape control', async t => {
  const f = fixture(t);
  const result = await handleAction('interrupt', f.body, f.config);
  assert.equal(result.ok, true);
  assert.equal(result.submission, 'submitted');
  assert.deepEqual(f.records().map(r => r.content), ['[KEYSTROKE]Escape']);
});
