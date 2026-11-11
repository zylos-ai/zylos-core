import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as shared from '../shared.js';
import * as prompts from '../sync-prompts.js';

const indexes = ['reference/projects/INDEX.md', 'reference/decisions/INDEX.md'];
function fixture(t) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]);
    assert.equal(path.resolve(process.env[key]).startsWith(path.resolve(os.userInfo().homedir) + path.sep), false);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-status-'));
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME,
    TMPDIR: process.env.TMPDIR, tmux: 'unused', database: 'unused' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, bytes) => {
    const target = path.join(root, 'memory', name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  };
  write('identity.md', 'identity'); write('references.md', 'navigation');
  const status = () => execFileSync(process.execPath, [path.resolve(import.meta.dirname, '../memory-status.js')], {
    env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  return { root, write, status };
}

test('reference indexes have optional 32 KiB budgets and 16 KiB warnings', () => {
  for (const name of indexes) {
    assert.equal(shared.BUDGETS[name], 32 * 1024);
    assert.equal(shared.WARN_THRESHOLDS[name], 16 * 1024);
    assert.equal(shared.OPTIONAL_BUDGET_FILES.has(name), true);
    assert.equal(shared.REFERENCE_FILES.includes(name), true);
  }
  for (const name of ['reference/projects.md', 'reference/decisions.md']) {
    assert.equal(shared.BUDGETS[name], undefined);
    assert.equal(shared.REFERENCE_FILES.includes(name), false);
  }
});

test('missing optional indexes report not created yet while required files still affect health', t => {
  const f = fixture(t);
  const output = f.status();
  for (const name of indexes) assert.equal(output.includes(`${name}: not created yet`), true);
  assert.match(output, /Health: good/);
  assert.doesNotMatch(output, /attention needed|MISSING/);
  // A required startup file retains its original failure behavior.
  fs.unlinkSync(path.join(f.root, 'memory/identity.md'));
  const missing = f.status();
  assert.match(missing, /identity.md: MISSING/);
  assert.match(missing, /Health: attention needed \(1 missing\)/);
});

test('index sizes distinguish the warning threshold and hard budget', t => {
  const f = fixture(t);
  for (const [bytes, label] of [[16 * 1024, 'OK'], [16 * 1024 + 1, 'WARN'], [32 * 1024, 'WARN'], [32 * 1024 + 1, 'OVER']]) {
    for (const name of indexes) f.write(name, Buffer.alloc(bytes, 'x'));
    const output = f.status();
    for (const name of indexes) {
      const line = output.split('\n').find(value => value.startsWith(name + ':'));
      assert.ok(line?.includes(`[${label}]`), line);
    }
    if (label === 'OK') assert.match(output, /Health: good/);
    else assert.match(output, /Health: attention needed/);
  }
});

test('large old reference files do not contribute budget or missing-file issues', t => {
  const f = fixture(t);
  for (const name of ['reference/projects.md', 'reference/decisions.md']) f.write(name, Buffer.alloc(64 * 1024, 'x'));
  const output = f.status();
  assert.doesNotMatch(output, /^reference\/(projects|decisions)\.md:/m);
  assert.match(output, /Health: good/);
});

test('reorganization proposal exports the agreed owner consent and routing text', () => {
  const text = prompts.REFERENCE_REORG_PROMPT;
  assert.equal(typeof text, 'string');
  for (const sentence of [
    'Read the zylos-memory skill references/reference-reorg.md and follow it.',
    'the owner has already agreed: continue it without asking again.',
    'in their most recent private chat, covering only three points:',
    'you would like to reorganize the memory files; it will take some time;',
    'afterwards memory sync will be faster and less likely to miss or duplicate records.',
    'do not mention duration, cost, models, or file locations.',
    'Start only after explicit agreement.',
    'Origin does not ask or reorganize itself; it asks the thread that handles that chat.',
    'If the owner declines or does not reply, do nothing more;',
  ]) assert.ok(text.includes(sentence), sentence);
});
