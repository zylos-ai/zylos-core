import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const live = path.join(os.userInfo().homedir, 'zylos');
const guarded = /Test child ZYLOS_DIR points at the live instance/;

test('official runner rejects live paths before every child launch API executes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-guard-'));
  try {
    const marker = path.join(directory, 'executed');
    const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`;
    const options = { env: { ...process.env, ZYLOS_DIR: live, NODE_OPTIONS: '' } };
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
    const calls = [
      () => childProcess.spawn(process.execPath, ['-e', code], options),
      () => childProcess.spawnSync(process.execPath, ['-e', code], options),
      () => childProcess.exec(command, options, () => {}),
      () => childProcess.execSync(command, options),
      () => childProcess.execFile(process.execPath, ['-e', code], options, () => {}),
      () => childProcess.execFileSync(process.execPath, ['-e', code], options),
      () => childProcess.fork(marker, [], options),
    ];
    for (const launch of calls) assert.throws(launch, guarded);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official runner allows fixture overrides and propagates guard with replacement NODE_OPTIONS', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-guard-'));
  try {
    const result = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.ZYLOS_DIR)'], {
      encoding: 'utf8',
      env: { ...process.env, ZYLOS_DIR: directory, NODE_OPTIONS: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, directory);
    const nested = childProcess.spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { spawnSync } = require('node:child_process');
      assert.throws(() => spawnSync(process.execPath, ['-e', 'process.exit(99)'], {
        env: { ...process.env, ZYLOS_DIR: ${JSON.stringify(live)}, NODE_OPTIONS: '' }
      }), /Test child ZYLOS_DIR points at the live instance/);
      process.stdout.write('nested guarded');
    `], { encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: directory, NODE_OPTIONS: '' } });
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(nested.stdout, 'nested guarded');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
