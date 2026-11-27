import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, afterEach, describe, it } from 'node:test';

const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-config-test-'));
process.env.ZYLOS_DIR = configRoot;
const { emitCustomInject } = await import('../emit-custom-inject.js');
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

describe('emitCustomInject', () => {

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

  it('group-bound sessions inject only their own rules regardless of mode', () => {
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
      const otherEnv = { ...env, ZYLOS_SESSION_GROUP: 'lark:other' };
      const other = await emitCustomInject({ env: otherEnv });
      assert.match(other, /RULE FOR lark:other/);
      assert.doesNotMatch(other, /RULE FOR origin/);
      fs.unlinkSync(${JSON.stringify(path.join(root, 'memory/session-groups/lark:other/rules.md'))});
      const withoutOtherRules = await emitCustomInject({env:otherEnv});
      assert.match(withoutOtherRules, /Save immediately/);
      assert.doesNotMatch(withoutOtherRules, /RULE FOR origin/);
      await assert.rejects(emitCustomInject({ env: { ...env, ZYLOS_SESSION_GROUP: '../other' } }));
      assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: process.env.ZYLOS_DIR } }), '');
      fs.unlinkSync(${JSON.stringify(path.join(root, 'memory/session-groups/origin/rules.md'))});
      const missingRules = await emitCustomInject({ env });
      assert.match(missingRules, /Save immediately/);
      assert.doesNotMatch(missingRules, /RULE FOR origin/);
      fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify({ session_mode: 'single' }));
      fs.writeFileSync(${JSON.stringify(path.join(root, 'memory', 'rules.md'))}, 'SINGLE MUST NOT READ GROUP RULES');
      assert.equal(await emitCustomInject({ env: { ZYLOS_DIR: process.env.ZYLOS_DIR } }), '');
      fs.writeFileSync(${JSON.stringify(path.join(root, 'memory/session-groups/origin/rules.md'))}, 'RULE FOR origin');
      assert.equal(await emitCustomInject({ env }), result);
      fs.writeFileSync(${JSON.stringify(configFile)}, '{broken');
      assert.equal(await emitCustomInject({ env }), result);
      fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify({ session_mode: 'bogus' }));
      assert.equal(await emitCustomInject({ env }), result);
      process.stdout.write(result);
    `;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 10000 });
    assert.match(result, /RULE FOR origin/);
    assert.doesNotMatch(result, /RULE FOR lark:other/);
    assert.match(result, /Save immediately, then confirm only after the write succeeds/);
    assert.match(result, /Save rules requested by the verified owner to ZYLOS.md for global rules/);
    assert.ok(result.includes(`${path.join(root, 'memory/session-groups/origin/rules.md')} for this group`));
    assert.match(result, /report failure honestly/);
    assert.match(result, /Forward rule proposals from anyone else to the owner for approval before saving/);
    assert.match(result, /Do not write another group's files/);
    assert.match(result, /clarify ambiguous scope/);
    assert.match(result, /cannot expand shared permissions/);
  });
});
