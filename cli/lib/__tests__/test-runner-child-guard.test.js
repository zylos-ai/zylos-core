import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

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

test('guard preserves callback, Promise and fork launch contracts for isolated children', async () => {
  const options = { env: { ...process.env }, encoding: 'utf8' };
  const code = 'process.stdout.write("safe")';
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
  assert.equal(childProcess.execSync(command, options), 'safe');
  assert.equal(childProcess.execFileSync(process.execPath, ['-e', code], options), 'safe');
  const callbackOutput = await new Promise((resolve, reject) => {
    childProcess.exec(command, null, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  assert.equal(callbackOutput, 'safe');
  assert.equal((await promisify(childProcess.exec)(command, options)).stdout, 'safe');
  assert.equal((await promisify(childProcess.execFile)(process.execPath, ['-e', code], options)).stdout, 'safe');
  assert.throws(() => promisify(childProcess.execFile)(process.execPath, ['-e', code], {
    env: { ...process.env, ZYLOS_DIR: live },
  }), guarded);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-guard-'));
  try {
    const script = path.join(directory, 'fork.mjs');
    fs.writeFileSync(script, code);
    const child = childProcess.fork(script, [], { silent: true });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(status, 0);
    assert.equal(Buffer.concat(chunks).toString(), 'safe');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official runner rejects live HOME fallback, relative paths and symlink descendants', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-guard-'));
  try {
    fs.symlinkSync(live, path.join(directory, 'alias'));
    const launch = env => childProcess.spawnSync(process.execPath, ['-e', 'process.exit(99)'], { env });
    assert.throws(() => launch({ ...process.env, HOME: os.userInfo().homedir, ZYLOS_DIR: '' }), guarded);
    assert.throws(() => launch({ ...process.env, ZYLOS_DIR: path.relative(process.cwd(), live) || '.' }), guarded);
    assert.throws(() => launch({ ...process.env, ZYLOS_DIR: path.join(directory, 'alias', 'not-created') }), guarded);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Node launched through a shell rejects inline live override before application code', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'child-guard-'));
  try {
    const marker = path.join(directory, 'executed');
    const result = childProcess.spawnSync('/bin/sh', ['-c', 'export ZYLOS_DIR="$1"; exec "$2" -e "$3"',
      'child-guard', live, process.execPath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, guarded);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
