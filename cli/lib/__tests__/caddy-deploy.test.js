import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyCaddyRoutes, removeCaddyRoutes, switchProtocol, validateAndDeploy } from '../caddy.js';
import { generateWebConsoleRoute } from '../web-console-route.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const caddyfile = path.join(root, 'Caddyfile');
  const original = Buffer.from('# original\r\nhttp://localhost:8080 {\n respond 200\n}\n');
  fs.writeFileSync(caddyfile, original);
  return { caddyfile, original, tmpDir: root, caddyBin: '/isolated/caddy' };
}
const candidate = 'http://localhost:8080 {\n respond 201\n}\n';

function assertCandidatesRemoved({ tmpDir }) {
  const remaining = fs.readdirSync(tmpDir).filter(name => name.startsWith('zylos-caddy-'));
  assert.equal(remaining.length, 0, 'deployment candidate directories must be removed');
}

test('successful deployment removes its candidate directory', t => {
  const f = fixture(t);
  const calls = [];
  const result = validateAndDeploy(candidate, f.original, { ...f, execFileSync: (command, args) => {
    calls.push(command);
    if (command === f.caddyBin) assert.equal(fs.readFileSync(args[2], 'utf8'), candidate);
    else {
      assert.equal(command, 'pm2');
      assert.deepEqual(args, ['reload', 'caddy']);
    }
  } });
  assertCandidatesRemoved(f);
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(f.caddyfile, 'utf8'), candidate);
  assert.deepEqual(calls, [f.caddyBin, 'pm2']);
});

test('candidate validation failure preserves original bytes and never reloads', t => {
  const f = fixture(t);
  const calls = [];
  const result = validateAndDeploy(candidate, f.original, { ...f, execFileSync: (command, args) => {
    calls.push([command, args]);
    assert.equal(command, f.caddyBin);
    assert.equal(fs.readFileSync(args[2], 'utf8'), candidate);
    throw new Error('bad candidate');
  } });
  assertCandidatesRemoved(f);
  assert.equal(result.success, false);
  assert.match(result.error, /validation failed/);
  assert.equal(fs.readFileSync(f.caddyfile).equals(f.original), true);
  assert.equal(calls.length, 1);
});

test('partial deployment write failure restores and verifies original bytes', t => {
  const f = fixture(t);
  let failed = false;
  const result = validateAndDeploy(candidate, f.original, { ...f, execFileSync: () => {},
    writeFileSync: (filename, content) => {
      if (filename === f.caddyfile && !failed) {
        failed = true;
        fs.writeFileSync(filename, 'partial');
        throw new Error('disk error');
      }
      fs.writeFileSync(filename, content);
    },
  });
  assertCandidatesRemoved(f);
  assert.equal(result.success, false);
  assert.match(result.error, /original Caddyfile restored/);
  assert.equal(fs.readFileSync(f.caddyfile).equals(f.original), true);
});

test('reload failure restores original bytes and reloads the restored file', t => {
  const f = fixture(t);
  let reloads = 0;
  const result = validateAndDeploy(candidate, f.original, { ...f, execFileSync: command => {
    if (command !== 'pm2') return;
    reloads++;
    if (reloads === 1) throw new Error('reload rejected');
    assert.equal(fs.readFileSync(f.caddyfile).equals(f.original), true);
  } });
  assertCandidatesRemoved(f);
  assert.equal(result.success, false);
  assert.equal(reloads, 2);
  assert.match(result.error, /restored and reloaded/);
});

test('failed restore write, mismatched bytes or recovery reload are reported truthfully', t => {
  for (const failure of ['write', 'bytes', 'reload']) {
    const f = fixture(t);
    let reloads = 0;
    const result = validateAndDeploy(candidate, f.original, { ...f,
      execFileSync: command => { if (command === 'pm2') { reloads++; throw new Error('reload denied'); } },
      writeFileSync: (filename, content) => {
        if (filename === f.caddyfile && Buffer.from(content).equals(f.original) && failure === 'write') throw new Error('restore denied');
        fs.writeFileSync(filename, content);
      },
      readFileSync: filename => failure === 'bytes' ? Buffer.from('wrong bytes') : fs.readFileSync(filename),
    });
    assertCandidatesRemoved(f);
    assert.equal(result.success, false);
    assert.match(result.error, /recovery failed/);
    assert.match(result.error, /Manually restore.*Caddyfile/);
    assert.doesNotMatch(result.error, /rolled back/);
    assert.equal(reloads, failure === 'reload' ? 2 : 1);
  }
});

test('component apply, remove and protocol callers retain shared deployment outcomes', () => {
  const original = 'http://example.com {\n# BEGIN zylos-component:demo\nhandle /demo/* {\n reverse_proxy localhost:5000\n}\n# END zylos-component:demo\n}\n';
  for (const success of [true, false]) {
    let calls = 0;
    const deps = { isCaddyAvailable: () => true, readFileSync: () => original,
      validateAndDeploy: (next, previous) => {
        calls++;
        assert.equal(previous, original);
        assert.notEqual(next, original);
        return success ? { success: true } : { success: false, error: 'recovery failed: denied' };
      } };
    for (const result of [
      applyCaddyRoutes('demo', [{ path: '/demo/*', type: 'reverse_proxy', target: 'localhost:6000', strip_prefix: '/demo' }], deps),
      removeCaddyRoutes('demo', deps),
      switchProtocol('example.com', 'https', deps),
    ]) {
      assert.equal(result.success, success);
      if (!success) assert.equal(result.error, 'recovery failed: denied');
    }
    assert.equal(calls, 3);
  }
});

// Integration boundary: real Caddy parses isolated candidate files; PM2 is an
// injected recorder. Run when validation/deployment changes; otherwise skippable.
test('real Caddy validates good candidates and rejects invalid candidates before deployment', {
  skip: !process.env.TEST_CADDY_BIN,
}, t => {
  const f = fixture(t);
  const binary = fs.realpathSync(process.env.TEST_CADDY_BIN);
  assert.ok(process.env.HOME.startsWith('/dev/shm/'));
  assert.ok(process.env.ZYLOS_DIR.startsWith('/dev/shm/'));
  assert.ok(process.env.PM2_HOME.startsWith('/dev/shm/'));
  assert.ok(f.caddyfile.startsWith(process.env.TMPDIR));
  const commands = [];
  const execute = (command, args, options) => {
    commands.push(command === binary ? 'caddy validate' : 'pm2 reload');
    if (command === 'pm2') return;
    assert.equal(command, binary);
    assert.ok(args[2].startsWith(f.tmpDir));
    return execFileSync(binary, args, options);
  };
  console.log(JSON.stringify({ integration: 'caddy-validation', HOME: process.env.HOME,
    ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH, caddyfile: f.caddyfile, binary, executor: 'real-caddy; injected-pm2; no-daemons' }));
  const generated = `http://localhost:8080 {\n${generateWebConsoleRoute()}\n}\n`;
  const good = validateAndDeploy(generated, f.original, { ...f, caddyBin: binary, execFileSync: execute });
  assertCandidatesRemoved(f);
  assert.equal(good.success, true, good.error);
  assert.equal(fs.readFileSync(f.caddyfile, 'utf8'), generated);
  const bad = validateAndDeploy('http://localhost:8080 {\n unknown_zylos_directive\n}\n', generated,
    { ...f, caddyBin: binary, execFileSync: execute });
  assertCandidatesRemoved(f);
  assert.equal(bad.success, false);
  assert.match(bad.error, /validation failed/);
  assert.equal(fs.readFileSync(f.caddyfile, 'utf8'), generated);
  assert.deepEqual(commands, ['caddy validate', 'pm2 reload', 'caddy validate']);
  let reloads = 0;
  const failedReload = validateAndDeploy(candidate, generated, { ...f, caddyBin: binary,
    execFileSync: (command, args, options) => {
      if (command !== 'pm2') return execute(command, args, options);
      if (++reloads === 1) throw new Error('isolated reload rejected');
    },
  });
  assertCandidatesRemoved(f);
  assert.equal(failedReload.success, false);
  assert.match(failedReload.error, /restored and reloaded/);
  assert.equal(fs.readFileSync(f.caddyfile, 'utf8'), generated);
  assert.equal(reloads, 2);
  const failedRecovery = validateAndDeploy(candidate, generated, { ...f, caddyBin: binary,
    execFileSync: (command, args, options) => {
      if (command !== 'pm2') return execute(command, args, options);
      throw new Error('isolated reload rejected');
    },
    writeFileSync: (filename, content) => {
      if (filename === f.caddyfile && Buffer.from(content).equals(Buffer.from(generated))) {
        throw new Error('isolated restoration denied');
      }
      fs.writeFileSync(filename, content);
    },
  });
  assertCandidatesRemoved(f);
  assert.equal(failedRecovery.success, false);
  assert.match(failedRecovery.error, /recovery failed: isolated restoration denied/);
  assert.match(failedRecovery.error, /Manually restore/);
  assert.equal(fs.readFileSync(f.caddyfile, 'utf8'), candidate);
});
