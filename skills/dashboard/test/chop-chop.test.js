import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { handleAction } from '../src/lib/actions.js';

function fixture(t, failContent = null) {
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
      process.stderr.write('fixture queue failure');
      process.exitCode = 1;
    } else console.log('OK: enqueued control 1');
  `);
  return {
    config: { zylosDir: root }, body: { request: crypto.randomUUID() },
    records: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  };
}

test('chop-chop queues Escape then exact continue at least 500ms later', async t => {
  const f = fixture(t);
  const result = await handleAction('chop-chop', f.body, f.config);
  assert.equal(result.ok, true);
  assert.equal(result.escape_enqueued, true);
  assert.equal(result.continue_enqueued, true);
  const records = f.records();
  assert.deepEqual(records.map(r => r.content), ['[KEYSTROKE]Escape', 'continue']);
  assert.ok(records[1].time - records[0].time >= 500);
  for (const record of records) {
    assert.deepEqual(record.args, ['enqueue', '--content', record.content, '--priority', '0', '--bypass-state', '--no-ack-suffix']);
  }
});

test('Escape failure prevents continue and reports no successful enqueue', async t => {
  const f = fixture(t, '[KEYSTROKE]Escape');
  const result = await handleAction('chop-chop', f.body, f.config);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chop_chop_escape_failed');
  assert.equal(result.escape_enqueued, false);
  assert.equal(result.continue_enqueued, false);
  assert.deepEqual(f.records().map(r => r.content), ['[KEYSTROKE]Escape']);
});

test('continue failure reports partial execution instead of success', async t => {
  const f = fixture(t, 'continue');
  const result = await handleAction('chop-chop', f.body, f.config);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chop_chop_continue_failed');
  assert.equal(result.escape_enqueued, true);
  assert.equal(result.continue_enqueued, false);
  assert.match(result.message, /Escape queued/);
  assert.deepEqual(f.records().map(r => r.content), ['[KEYSTROKE]Escape', 'continue']);
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
  assert.equal(result.messageKey, 'result.interrupt_ok');
  assert.deepEqual(f.records().map(r => r.content), ['[KEYSTROKE]Escape']);
});
