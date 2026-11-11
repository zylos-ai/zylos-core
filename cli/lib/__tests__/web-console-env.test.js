import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planWebConsoleEnvCleanup, cleanupWebConsoleEnv, atomicReplace } from '../web-console-env.js';

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-env-'));
  const file = path.join(root, '.env');
  fs.writeFileSync(file, content, {mode:0o640});
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {root, file};
}

test('dotenv cleanup removes password assignments and renames only the last upload assignment', t => {
  const input = '# ZYLOS_WEB_PASSWORD=comment\r\nZYLOS_WEB_PASSWORD=secret-a\r\n export WEB_CONSOLE_PASSWORD = "secret-b"\r\nWEB_CONSOLE_MAX_UPLOAD_MB=first\r\n  export WEB_CONSOLE_MAX_UPLOAD_MB = \'last\' # keep\r\nWEB_CONSOLE_BIND=local\r\nOTHER=no-final-newline';
  const expected = '# ZYLOS_WEB_PASSWORD=comment\r\n  export DASHBOARD_MAX_UPLOAD_MB = \'last\' # keep\r\nWEB_CONSOLE_BIND=local\r\nOTHER=no-final-newline';
  const f = fixture(t, input), before = fs.statSync(f.file);
  const result = cleanupWebConsoleEnv(f.root);
  assert.equal(result.state, 'changed');
  assert.equal(fs.readFileSync(f.file, 'utf8'), expected);
  const after = fs.statSync(f.file);
  assert.equal(after.mode, before.mode);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.doesNotMatch(JSON.stringify(result), /secret-a|secret-b|first|last|local/);
  const inode = after.ino;
  assert.equal(cleanupWebConsoleEnv(f.root).state, 'skipped');
  assert.equal(fs.statSync(f.file).ino, inode);
});

test('existing new upload assignments retain every byte and old assignments disappear', () => {
  const input = 'DASHBOARD_MAX_UPLOAD_MB="keep" # one\nWEB_CONSOLE_MAX_UPLOAD_MB=old\nexport DASHBOARD_MAX_UPLOAD_MB = second\nWEB_CONSOLE_MAX_UPLOAD_MB=older';
  const plan = planWebConsoleEnvCleanup(input);
  assert.equal(plan.content, 'DASHBOARD_MAX_UPLOAD_MB="keep" # one\nexport DASHBOARD_MAX_UPLOAD_MB = second\n');
  assert.match(plan.messages.join(' '), /removed WEB_CONSOLE_MAX_UPLOAD_MB \(2 lines\)/);
  assert.doesNotMatch(plan.messages.join(' '), /older|second|"keep"/);
});

for (const key of ['ZYLOS_WEB_PASSWORD', 'WEB_CONSOLE_PASSWORD', 'WEB_CONSOLE_MAX_UPLOAD_MB', 'DASHBOARD_MAX_UPLOAD_MB']) {
  for (const quote of ['"', "'", '`']) test(`multiline ${key} with ${quote} leaves the whole file intact`, t => {
    const input = `ZYLOS_WEB_PASSWORD=remove-only-if-safe\n${key}=${quote}first\nlast${quote}\n`;
    const f = fixture(t, input);
    assert.equal(cleanupWebConsoleEnv(f.root).state, 'manual');
    assert.equal(fs.readFileSync(f.file, 'utf8'), input);
  });
}

test('assignments inside unrelated multiline values are preserved', () => {
  const input = 'OTHER="start\nZYLOS_WEB_PASSWORD=inside\nend"\nWEB_CONSOLE_MAX_UPLOAD_MB=one\n';
  assert.equal(planWebConsoleEnvCleanup(input).content, input.replace('WEB_CONSOLE_MAX_UPLOAD_MB', 'DASHBOARD_MAX_UPLOAD_MB'));
});

for (const quote of ['"', "'", '`']) test(`unclosed unrelated ${quote} value requires manual cleanup`, t => {
  const input = `OTHER=${quote}unfinished\nZYLOS_WEB_PASSWORD=synthetic-password\nWEB_CONSOLE_MAX_UPLOAD_MB=synthetic-limit\n`;
  const f = fixture(t, input);
  const before = fs.statSync(f.file);
  const result = cleanupWebConsoleEnv(f.root);
  assert.equal(result.state, 'manual');
  assert.equal(fs.readFileSync(f.file, 'utf8'), input);
  assert.equal(fs.statSync(f.file).ino, before.ino);
  assert.doesNotMatch(JSON.stringify(result), /unfinished|synthetic-password|synthetic-limit/);
});

test('symlink dotenv is refused without changing its target', t => {
  const f = fixture(t, 'ZYLOS_WEB_PASSWORD=secret\n');
  const target = path.join(f.root, 'original');
  fs.renameSync(f.file, target);
  fs.symlinkSync(target, f.file);
  const result = cleanupWebConsoleEnv(f.root);
  assert.equal(result.state, 'manual');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ZYLOS_WEB_PASSWORD=secret\n');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('failed atomic publication preserves the original and removes its temporary file', t => {
  const f = fixture(t, 'original');
  assert.throws(() => atomicReplace(f.file, 'replacement', {beforeRename:() => {throw Error('injected publication failure');}}), /publication failure/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.root), ['.env']);
});

test('absent dotenv and files without effective legacy assignments are skipped', t => {
  const f = fixture(t, '# WEB_CONSOLE_MAX_UPLOAD_MB=comment\nOTHER=value');
  assert.equal(cleanupWebConsoleEnv(f.root).state, 'skipped');
  fs.unlinkSync(f.file);
  assert.equal(cleanupWebConsoleEnv(f.root).state, 'skipped');
});
