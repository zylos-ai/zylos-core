import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, afterEach, describe, it } from 'node:test';

const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-config-test-'));
process.env.ZYLOS_DIR = configRoot;
const { customInjectDir, emitCustomInject } = await import('../emit-custom-inject.js');
after(() => fs.rmSync(configRoot, { recursive: true, force: true }));

const tmpDirs = [];

function makeZylosDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-inject-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeCustomFile(zylosDir, name, content) {
  const dir = path.join(zylosDir, 'custom-hooks', 'session-start');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('customInjectDir', () => {
  it('resolves under ZYLOS_DIR when set, else under ~/zylos', () => {
    assert.equal(customInjectDir({ ZYLOS_DIR: '/opt/zy' }), path.join('/opt/zy', 'custom-hooks', 'session-start'));
    assert.equal(customInjectDir({}), path.join(os.homedir(), 'zylos', 'custom-hooks', 'session-start'));
  });
});

describe('emitCustomInject', () => {
  it('emits nothing when the directory does not exist (fresh install)', async () => {
    const zylosDir = makeZylosDir();
    assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), '');
  });

  it('emits nothing when the directory has no usable content', async () => {
    const zylosDir = makeZylosDir();
    fs.mkdirSync(path.join(zylosDir, 'custom-hooks', 'session-start'), { recursive: true });
    assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), '');

    // Whitespace-only and empty files count as no content.
    writeCustomFile(zylosDir, '10-empty.md', '');
    writeCustomFile(zylosDir, '20-blank.md', '  \n\n\t\n');
    assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), '');
  });

  it('concatenates .md files in lexicographic order (conf.d-style prefixes)', async () => {
    const zylosDir = makeZylosDir();
    // Written out of order on purpose — filename order must win.
    writeCustomFile(zylosDir, '20-platform.md', 'PLATFORM RULES');
    writeCustomFile(zylosDir, '10-rules.md', 'HOUSE RULES\n');

    assert.equal(
      await emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }),
      'HOUSE RULES\n\nPLATFORM RULES'
    );
  });

  it('ignores dotfiles and non-md entries', async () => {
    const zylosDir = makeZylosDir();
    writeCustomFile(zylosDir, '10-real.md', 'REAL');
    writeCustomFile(zylosDir, '.05-hidden.md', 'HIDDEN');
    writeCustomFile(zylosDir, 'notes.txt', 'TXT');
    writeCustomFile(zylosDir, 'script.js', 'console.log("nope")');
    fs.mkdirSync(path.join(zylosDir, 'custom-hooks', 'session-start', 'subdir.md'), { recursive: true });

    assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), 'REAL');
  });

  it('skips whitespace-only files but keeps the rest in order', async () => {
    const zylosDir = makeZylosDir();
    writeCustomFile(zylosDir, '10-a.md', 'A');
    writeCustomFile(zylosDir, '20-blank.md', '   \n');
    writeCustomFile(zylosDir, '30-c.md', '\nC\n');

    assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), 'A\n\nC');
  });

  it('M3 2.8: multi injects only own rules and guidance; single has neither', () => {
    const root = makeZylosDir();
    const configFile = path.join(root, '.zylos/config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    for (const group of ['origin', 'lark:other']) {
      const dir = path.join(root, 'memory/session-groups', group);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rules.md'), `RULE FOR ${group}`);
    }
    fs.writeFileSync(configFile, JSON.stringify({ session_mode: 'multi' }));
    // A fresh process resolves F1 within this fixture, never the runner's shared root.
    const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { emitCustomInject } from ${JSON.stringify(new URL('../emit-custom-inject.js', import.meta.url).href)};
      const env = { ...process.env, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'own-run' };
      const result = await emitCustomInject({ env });
      await assert.rejects(emitCustomInject({ env: { ...env, ZYLOS_SESSION_GROUP: '../other' } }));
      await assert.rejects(emitCustomInject({ env: { ZYLOS_DIR: process.env.ZYLOS_DIR } }), { code: 'SCOPE_INVALID' });
      fs.unlinkSync(${JSON.stringify(path.join(root, 'memory/session-groups/origin/rules.md'))});
      const missingRules = await emitCustomInject({ env });
      assert.match(missingRules, /Save immediately/);
      assert.doesNotMatch(missingRules, /RULE FOR origin/);
      fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify({ session_mode: 'single' }));
      fs.writeFileSync(${JSON.stringify(path.join(root, 'memory', 'rules.md'))}, 'SINGLE MUST NOT READ GROUP RULES');
      assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: process.env.ZYLOS_DIR } }), '');
      await assert.rejects(emitCustomInject({ env }), { code: 'SCOPE_INVALID' });
      fs.writeFileSync(${JSON.stringify(configFile)}, '{broken');
      await assert.rejects(emitCustomInject({ env: { ZYLOS_DIR: process.env.ZYLOS_DIR } }), { code: 'CONFIG_UNREADABLE' });
      process.stdout.write(result);
    `;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 10000 });
    assert.match(result, /RULE FOR origin/);
    assert.doesNotMatch(result, /RULE FOR lark:other/);
    assert.match(result, /Save immediately, then confirm only after the write succeeds/);
    assert.match(result, /Save global user rules to ZYLOS.md/);
    assert.ok(result.includes(`rules limited to this group to ${path.join(root, 'memory/session-groups/origin/rules.md')}`));
    assert.match(result, /report failure honestly/);
    assert.match(result, /Memory Sync does not maintain either rules file/);
    assert.match(result, /state\/inbox must not duplicate rule text/);
    assert.match(result, /Do not write another group's files/);
    assert.match(result, /clarify ambiguous scope/);
    assert.match(result, /cannot expand shared permissions/);
  });
});
