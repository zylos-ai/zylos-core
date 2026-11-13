import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const scripts = [
  ['zylos-memory', 'sync-lock', ['status', 'acquire', 'release']],
  ['zylos-memory', 'sync-files', ['list', 'cleanup', 'rotate', 'checkpoint', 'commit']],
  ['zylos-memory', 'origin-cursor', ['advance']],
  ['zylos-memory', 'reference-index', ['rebuild', 'check-navigation', 'create', 'move-old', 'archive', 'unarchive']],
  ['zylos-memory', 'memory-append', ['inbox', 'session']],
  ['zylos-memory', 'request-rotation', []],
  ['comm-bridge', 'c4-fetch', ['--unsummarized', '--checkpoints', '--origin-sync', '--absorbed']],
  ['comm-bridge', 'c4-db', ['unsummarized', 'groups', 'group-queues', 'origin-sync backlog']],
];

// Real CLI boundary: help must work with no runtime root, and must not read
// stdin/config/history or attempt a lock. The preload rejects runtime I/O,
// including swallowed errors, before comparing the untouched fixture tree.
test('Sync CLI help exits successfully without runtime reads, writes or locks', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-help-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(fixture, 'home'),
    ZYLOS_DIR: path.join(fixture, 'zylos'), PM2_HOME: path.join(fixture, 'pm2'),
    TMPDIR: path.join(fixture, 'tmp'), ZYLOS_PACKAGE_ROOT: packageRoot,
    ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'help-only' };
  const preload = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const root = ${JSON.stringify(fixture)};
    const touched = [];
    const methods = ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync',
      'mkdirSync', 'readdirSync', 'statSync', 'lstatSync', 'accessSync',
      'existsSync', 'realpathSync', 'renameSync', 'unlinkSync', 'rmSync'];
    for (const method of methods) {
      const original = fs[method];
      fs[method] = function(target, ...args) {
        const filename = target instanceof URL ? target.pathname : String(target);
        if (target === 0 || filename === root || filename.startsWith(root + path.sep)) {
          touched.push(method + ':' + filename);
          throw new Error('Help attempted runtime I/O: ' + method);
        }
        return original.call(this, target, ...args);
      };
    }
    syncBuiltinESMExports();
    process.on('exit', () => {
      if (touched.length) {
        process.stderr.write('Runtime I/O attempted: ' + touched.join(', ') + '\\n');
        process.exitCode = 99;
      }
    });
  `;
  for (const [skill, name, commands] of scripts) {
    for (const alias of ['--help', '-h']) {
      for (const command of ['', ...commands]) {
        const args = command ? [...command.split(' '), alias] : [alias];
        const result = spawnSync(process.execPath, [
          '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
          path.join(packageRoot, 'skills', skill, 'scripts', `${name}.js`), ...args,
        ], { env, cwd: packageRoot, encoding: 'utf8', timeout: 10000, input: '' });
        const label = `${name} ${args.join(' ')}`;
        assert.equal(result.error, undefined, label);
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        assert.equal(result.stderr, '', label);
        assert.match(result.stdout, new RegExp(`${name}\\.js`), label);
        if (name === 'c4-fetch') assert.match(result.stdout, /--unsummarized[^|]*\[--out FILE\]/, label);
        assert.deepEqual(fs.readdirSync(fixture), [], label);
      }
    }
  }
});

test('Sync CLI validates help-like option values instead of treating them as flags', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-help-values-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const [name, args] of [
    ['sync-lock', ['release', '--kind', '-h']],
    ['sync-files', ['checkpoint', '0', '--token', '-h']],
    ['sync-files', ['list', '--group', '-h']],
    ['sync-files', ['checkpoint', '0', '--token', 'test-token', '--batch', '-h']],
    ['origin-cursor', ['advance', '--group', '-h']],
    ['reference-index', ['archive', '--path', '-h']],
    ['memory-append', ['inbox', '--kind', '-h']],
    ['request-rotation', ['--reason', '-h']],
  ]) {
    const result = spawnSync(process.execPath,
      [path.join(packageRoot, 'skills/zylos-memory/scripts', `${name}.js`), ...args],
      { env: { ...process.env, HOME: path.join(fixture, 'home'),
        ZYLOS_DIR: path.join(fixture, 'zylos'), PM2_HOME: path.join(fixture, 'pm2'),
        ZYLOS_PACKAGE_ROOT: packageRoot, ZYLOS_SESSION_GROUP: 'origin' },
      encoding: 'utf8', timeout: 10000, input: '' });
    assert.equal(result.error, undefined, name);
    assert.notEqual(result.status, 0, `${name}: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /Usage:/, name);
    assert.match(result.stderr, /Error \[/, name);
  }
});
