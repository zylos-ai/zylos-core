import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-session-handoff-test-'));
const fakeZylosDir = path.join(tmpRoot, 'zylos');
const argvPath = path.join(tmpRoot, 'argv.json');

const originalZylosDir = process.env.ZYLOS_DIR;
const originalArgvPath = process.env.SESSION_HANDOFF_TEST_ARGV_PATH;

process.env.ZYLOS_DIR = fakeZylosDir;
process.env.SESSION_HANDOFF_TEST_ARGV_PATH = argvPath;

const c4ControlDir = path.join(fakeZylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
fs.mkdirSync(c4ControlDir, { recursive: true });
fs.writeFileSync(
  path.join(c4ControlDir, 'c4-control.js'),
  [
    'import fs from "node:fs";',
    'fs.writeFileSync(process.env.SESSION_HANDOFF_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)), "utf8");',
  ].join('\n'),
  'utf8'
);

const { enqueueNewSession } = await import('../runtime/session-handoff.js');

before(() => {
  fs.rmSync(argvPath, { force: true });
});

after(() => {
  if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
  else process.env.ZYLOS_DIR = originalZylosDir;

  if (originalArgvPath === undefined) delete process.env.SESSION_HANDOFF_TEST_ARGV_PATH;
  else process.env.SESSION_HANDOFF_TEST_ARGV_PATH = originalArgvPath;

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('enqueueNewSession', () => {
  it('tells Codex to send handoff summaries to the internal web console', () => {
    const result = enqueueNewSession({
      ratio: 0.75,
      used: 75_000,
      ceiling: 100_000,
      runtime: 'codex',
      maxRetries: 1,
    });

    assert.equal(result, true);

    const args = JSON.parse(fs.readFileSync(argvPath, 'utf8'));
    const content = args[args.indexOf('--content') + 1];

    assert.match(content, /do not skip checklist steps/);
    assert.match(content, /internal web-console channel/);
    assert.match(content, /do not post it to the active external user channel/);
  });
});
