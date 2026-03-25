import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-setup-test-'));
const fakeHome = path.join(tmpRoot, 'home');
const fakeZylosDir = path.join(tmpRoot, 'zylos');

const originalHome = process.env.HOME;
const originalZylosDir = process.env.ZYLOS_DIR;

process.env.HOME = fakeHome;
process.env.ZYLOS_DIR = fakeZylosDir;

fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(fakeZylosDir, { recursive: true });

const { writeCodexConfig } = await import('../runtime-setup.js');

before(() => {
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
  else process.env.ZYLOS_DIR = originalZylosDir;

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeCodexConfig', () => {
  it('writes multi_agent feature and preserves unrelated trusted projects', () => {
    const codexDir = path.join(fakeHome, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const projectDir = path.join(fakeZylosDir, 'workspace', 'project-a');
    const otherProjectDir = path.join(tmpRoot, 'other-project');

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(otherProjectDir, { recursive: true });

    fs.writeFileSync(
      configPath,
      [
        '[projects."/tmp/old-project"]',
        'trust_level = "trusted"',
        '',
        `[projects."${otherProjectDir}"]`,
        'trust_level = "trusted"',
        '',
        `[projects."${path.resolve(projectDir)}"]`,
        'trust_level = "untrusted"',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.equal(writeCodexConfig(projectDir), true);

    const content = fs.readFileSync(configPath, 'utf8');
    assert.match(content, /\[features\]\nmulti_agent = true\n/);
    assert.match(content, /\[notice\]/);
    assert.match(
      content,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "trusted"`)
    );
    assert.match(
      content,
      new RegExp(`\\[projects\\."${escapeRegExp(otherProjectDir)}"\\]\\ntrust_level = "trusted"`)
    );
    assert.doesNotMatch(
      content,
      new RegExp(`\\[projects\\."${escapeRegExp(path.resolve(projectDir))}"\\]\\ntrust_level = "untrusted"`)
    );
  });
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
