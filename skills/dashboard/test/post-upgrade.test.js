import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'postupgrade-test-'));
}

test('post-upgrade — does not install runtime hooks', () => {
  const tmpDir=freshTmpDir();
  execFileSync(process.execPath,[new URL('../hooks/post-upgrade.js',import.meta.url).pathname],{env:{...process.env,HOME:tmpDir,ZYLOS_DIR:tmpDir},encoding:'utf8'});
  assert.equal(fs.existsSync(path.join(tmpDir,'.claude/settings.json')),false);
  assert.equal(fs.existsSync(path.join(tmpDir,'.codex/hooks.json')),false);
  fs.rmSync(tmpDir,{recursive:true,force:true});
});

test('post-upgrade — does not download, enable, or rewrite Observer state', () => {
  const tmpDir = freshTmpDir();
  const homeDir = path.join(tmpDir, 'home');
  const dashboardDir = path.join(tmpDir, 'components', 'dashboard');
  const configPath = path.join(dashboardDir, 'config.json');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(dashboardDir, { recursive: true });
  const existing = { observer: { enabled: false, generation: 12, installedVersion: '0.44.0' }, sentinel: true };
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);

  execFileSync('node', [new URL('../hooks/post-upgrade.js', import.meta.url).pathname], {
    env: { ...process.env, HOME: homeDir, ZYLOS_DIR: tmpDir, ZYLOS_RUNTIME: 'codex' },
    encoding: 'utf8'
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), existing);
  assert.equal(fs.existsSync(path.join(dashboardDir, 'observer')), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
