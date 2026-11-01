import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const versionFile = path.join(repoRoot, 'skills/comm-bridge/core-version');
const skillFile = path.join(repoRoot, 'skills/comm-bridge/SKILL.md');
const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cvf-')));
const env = {
  HOME: path.join(fixtureRoot, 'home'),
  ZYLOS_DIR: path.join(fixtureRoot, 'zylos'),
  PM2_HOME: path.join(fixtureRoot, 'pm2'),
  TMPDIR: path.join(fixtureRoot, 'tmp'),
  TMUX_TMPDIR: path.join(fixtureRoot, 'tmux'),
  PATH: path.join(fixtureRoot, 'bin'),
};
for (const value of Object.values(env)) fs.mkdirSync(value, { recursive: true });
env.TMUX = `${path.join(env.TMUX_TMPDIR, 'private.sock')},0,0`;
const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const incoming = path.join(fixtureRoot, 'incoming');
const source = path.join(incoming, 'skills/comm-bridge');
const destination = path.join(env.ZYLOS_DIR, '.claude/skills/comm-bridge');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(destination, { recursive: true });
const databases = ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db']
  .map(relative => path.join(env.ZYLOS_DIR, relative));
for (const file of databases) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'isolated file-sync database sentinel\n');
}
function readBackIsolation() {
  for (const [key, value] of Object.entries(env)) assert.equal(process.env[key], value);
  for (const dir of [...Object.values(env).filter(value => value !== env.TMUX), source, destination]) {
    assert.ok(fs.realpathSync(dir).startsWith(fixtureRoot + path.sep), dir);
  }
  for (const file of databases) assert.ok(fs.realpathSync(file).startsWith(fixtureRoot + path.sep));
  console.log('File-sync isolation:', JSON.stringify({ args: process.argv, env, versionFile, source, destination, databases }));
}
readBackIsolation();
after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
const { step5_syncCoreSkills } = await import('../self-upgrade.js');

test('comm-bridge version file exactly matches the Core package version and one newline', () => {
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const content = fs.readFileSync(versionFile, 'utf8');
  assert.equal(content, `${version}\n`);
  assert.equal(content.slice(0, -1), version);
});

// Boundary: the real skill-sync step installs the static package file into an
// existing skill without one. Run when this file or skill synchronization changes;
// skip for unrelated CLI changes. This does not cover installation or rollback.
test('Core skill sync installs the packaged version file and includes it in the pending baseline', () => {
  fs.copyFileSync(versionFile, path.join(source, 'core-version'));
  fs.copyFileSync(skillFile, path.join(source, 'SKILL.md'));
  fs.copyFileSync(skillFile, path.join(destination, 'SKILL.md'));
  readBackIsolation();
  const installedFile = path.join(destination, 'core-version');
  assert.equal(fs.existsSync(installedFile), false);
  const context = { tempDir: incoming, mode: 'merge' };
  const result = step5_syncCoreSkills(context);
  assert.equal(result.status, 'done', result.error);
  const content = fs.readFileSync(versionFile);
  assert.deepEqual(fs.readFileSync(installedFile), content);
  const baseline = context.pendingBaselines.find(entry => entry.destDir === destination);
  assert.ok(baseline, 'the existing comm-bridge skill must receive a pending baseline');
  assert.equal(baseline.srcDir, source);
  assert.equal(baseline.manifest.files['core-version'], createHash('sha256').update(content).digest('hex'));
  for (const file of databases) assert.equal(fs.readFileSync(file, 'utf8'), 'isolated file-sync database sentinel\n');
});
