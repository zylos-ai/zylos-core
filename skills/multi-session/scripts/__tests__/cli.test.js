import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

let zylosDir;

beforeEach(() => {
  zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mscli-'));
});

afterEach(() => {
  fs.rmSync(zylosDir, { recursive: true, force: true });
});

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    encoding: 'utf8',
  });
  return result;
}

describe('cli exit codes', () => {
  it('harvest exits 0 when clean', () => {
    const r = run('harvest');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Safe to molt/);
  });

  it('harvest exits 1 with in-flight workers', () => {
    assert.equal(run('add', 'investigate flaky test').status, 0);
    const r = run('harvest');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /in-flight worker/);
  });

  it('delegate-prep exits 2 at the cap', () => {
    assert.equal(run('delegate-prep', 'one').status, 0);
    assert.equal(run('delegate-prep', 'two').status, 0);
    const r = run('delegate-prep', 'three');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Concurrency cap reached/);
  });

  it('delegate-prep prints the teammate prompt block', () => {
    const r = run('delegate-prep', 'docs', '--task', 'Write the docs');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /TEAMMATE TASK PROMPT/);
    assert.match(r.stdout, /Write the docs/);
  });

  it('full lifecycle: prep -> running -> done -> accept -> harvest clean', () => {
    const prepOut = run('delegate-prep', 'lifecycle').stdout;
    const id = /Registered (worker-[a-z0-9-]+)/.exec(prepOut)[1];
    assert.equal(run('update', id, '--status', 'running', '--teammate', 'tm1').status, 0);
    assert.equal(run('done', id, '--summary', 'all good').status, 0);
    assert.equal(run('harvest').status, 1);
    assert.equal(run('accept', id).status, 0);
    assert.equal(run('harvest').status, 0);
    const got = JSON.parse(run('get', id).stdout);
    assert.equal(got.status, 'accepted');
    assert.equal(got.resultSummary, 'all good');
  });

  it('check-guardrails fails then passes after write-guardrails', () => {
    const projectDir = path.join(zylosDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    assert.equal(run('check-guardrails', '--project-dir', projectDir).status, 1);
    assert.equal(run('write-guardrails', '--project-dir', projectDir).status, 0);
    assert.equal(run('check-guardrails', '--project-dir', projectDir).status, 0);
  });

  it('unknown command exits 1', () => {
    assert.equal(run('bogus').status, 1);
  });
});
