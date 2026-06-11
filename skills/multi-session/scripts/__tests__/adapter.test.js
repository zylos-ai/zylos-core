import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addWorker, getWorker, MAX_ACTIVE_WORKERS } from '../registry.js';
import {
  delegatePrep,
  harvest,
  accept,
  fail,
  denyRules,
  writeGuardrails,
  checkGuardrails,
  settingsPathFor,
} from '../adapter.js';

let tmpDir;
let regPath;
let deliveriesDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msadapt-'));
  regPath = path.join(tmpDir, 'registry.json');
  deliveriesDir = path.join(tmpDir, 'deliveries');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function prep(slug, extra = {}) {
  return delegatePrep(slug, { registryPath: regPath, deliveriesDir, ...extra });
}

describe('delegate-prep', () => {
  it('creates delivery dir, registers a pending worker, and renders a prompt', () => {
    const { worker, prompt } = prep('Doc Cleanup!', { task: 'Clean up the docs' });
    assert.equal(worker.status, 'pending');
    assert.equal(worker.task, 'Clean up the docs');
    assert.ok(fs.existsSync(worker.deliveryDir));
    assert.match(path.basename(worker.deliveryDir), /^\d{4}-\d{2}-\d{2}-doc-cleanup$/);
    assert.ok(prompt.includes(worker.deliveryDir));
    assert.ok(prompt.includes('checkpoint'));
    assert.equal(getWorker(worker.id, regPath).id, worker.id);
  });

  it('refuses to prep when projectDir lacks guardrails, succeeds after write-guardrails', () => {
    const projectDir = path.join(tmpDir, 'guarded');
    assert.throws(() => prep('guarded-task', { projectDir, zylosDir: '/home/test/zylos' }), (err) => {
      assert.equal(err.code, 'GUARDRAILS_MISSING');
      return true;
    });
    writeGuardrails(projectDir, '/home/test/zylos');
    const { worker } = prep('guarded-task', { projectDir, zylosDir: '/home/test/zylos' });
    assert.equal(worker.status, 'pending');
  });

  it('rejects invalid slugs', () => {
    assert.throws(() => prep('!!!'), /Invalid task slug/);
  });

  it('enforces the hard cap of 2 active workers', () => {
    prep('one');
    prep('two');
    assert.throws(() => prep('three'), (err) => {
      assert.equal(err.code, 'CAP_REACHED');
      assert.match(err.message, /Concurrency cap reached \(2\/2/);
      return true;
    });
    assert.equal(MAX_ACTIVE_WORKERS, 2);
  });

  it('frees cap slots once workers are accepted', () => {
    const a = prep('one').worker;
    prep('two');
    fs.writeFileSync(path.join(a.deliveryDir, 'RESULT.md'), 'done');
    accept(a.id, {}, regPath);
    const third = prep('three').worker;
    assert.equal(third.status, 'pending');
  });
});

describe('harvest', () => {
  it('is clean with no in-flight workers', () => {
    const { clean, workers } = harvest(regPath);
    assert.equal(clean, true);
    assert.deepEqual(workers, []);
  });

  it('reports pending/running/done(unaccepted) as in-flight, not accepted/failed', () => {
    addWorker({ task: 'p', status: 'pending' }, regPath);
    addWorker({ task: 'r', status: 'running' }, regPath);
    addWorker({ task: 'd', status: 'done' }, regPath);
    addWorker({ task: 'a', status: 'accepted' }, regPath);
    addWorker({ task: 'f', status: 'failed' }, regPath);
    const { clean, workers } = harvest(regPath);
    assert.equal(clean, false);
    assert.deepEqual(workers.map((w) => w.task).sort(), ['d', 'p', 'r']);
  });
});

describe('accept / fail / reassign', () => {
  it('accept updates status and summary', () => {
    const w = prep('task-a').worker;
    const updated = accept(w.id, { resultSummary: 'shipped' }, regPath);
    assert.equal(updated.status, 'accepted');
    assert.equal(updated.resultSummary, 'shipped');
  });

  it('fail without reassign marks failed, no successor', () => {
    const w = prep('task-b').worker;
    const { failed, successor } = fail(w.id, {}, regPath);
    assert.equal(failed.status, 'failed');
    assert.equal(successor, null);
  });

  it('fail --reassign creates a successor on the same delivery dir', () => {
    const w = prep('task-c').worker;
    const { failed, successor } = fail(w.id, { reassign: true }, regPath);
    assert.equal(failed.status, 'reassigned');
    assert.equal(successor.status, 'pending');
    assert.equal(successor.deliveryDir, w.deliveryDir);
    assert.equal(successor.predecessorId, w.id);
    assert.equal(successor.task, w.task);
  });
});

describe('guardrails', () => {
  it('denyRules use the // prefix for absolute paths', () => {
    const rules = denyRules('/home/test/zylos');
    assert.ok(rules.includes('Write(//home/test/zylos/memory/**)'));
    assert.ok(rules.includes('Edit(//home/test/zylos/memory/**)'));
    assert.ok(rules.includes('Bash(*c4-send.js*)'));
    assert.ok(rules.includes('Bash(*c4-control.js*)'));
  });

  it('write-guardrails creates settings.json and check passes', () => {
    const projectDir = path.join(tmpDir, 'proj');
    const settingsPath = writeGuardrails(projectDir, '/home/test/zylos');
    assert.equal(settingsPath, settingsPathFor(projectDir));
    const { ok, problems } = checkGuardrails(projectDir, '/home/test/zylos');
    assert.deepEqual(problems, []);
    assert.equal(ok, true);
  });

  it('write-guardrails merges into existing settings without clobbering and is idempotent', () => {
    const projectDir = path.join(tmpDir, 'proj2');
    const settingsPath = settingsPathFor(projectDir);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ env: { FOO: 'bar' }, permissions: { allow: ['Bash(ls*)'], deny: ['WebSearch'] } })
    );
    writeGuardrails(projectDir, '/home/test/zylos');
    writeGuardrails(projectDir, '/home/test/zylos');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(settings.env.FOO, 'bar');
    assert.deepEqual(settings.permissions.allow, ['Bash(ls*)']);
    assert.ok(settings.permissions.deny.includes('WebSearch'));
    const denyCount = settings.permissions.deny.filter((r) => r === 'Edit(//home/test/zylos/memory/**)').length;
    assert.equal(denyCount, 1);
  });

  it('check fails when settings file is missing', () => {
    const { ok, problems } = checkGuardrails(path.join(tmpDir, 'nope'));
    assert.equal(ok, false);
    assert.match(problems[0], /not found/);
  });

  it('check fails on invalid JSON and missing deny array', () => {
    const projectDir = path.join(tmpDir, 'proj3');
    const settingsPath = settingsPathFor(projectDir);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{broken');
    assert.equal(checkGuardrails(projectDir).ok, false);
    fs.writeFileSync(settingsPath, '{}');
    const { ok, problems } = checkGuardrails(projectDir);
    assert.equal(ok, false);
    assert.match(problems[0], /No permissions.deny/);
  });

  it('check flags single-slash absolute paths (silently non-matching)', () => {
    const projectDir = path.join(tmpDir, 'proj4');
    writeGuardrails(projectDir, '/home/test/zylos');
    const settingsPath = settingsPathFor(projectDir);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.permissions.deny.push('Write(/home/test/other/**)');
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const { ok, problems } = checkGuardrails(projectDir, '/home/test/zylos');
    assert.equal(ok, false);
    assert.ok(problems.some((p) => p.includes('single-slash')));
  });
});
