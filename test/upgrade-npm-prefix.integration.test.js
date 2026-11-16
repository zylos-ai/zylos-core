import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repository, 'test/helpers/run-upgrade-npm-prefix.mjs');
const npmCli = String(process.env.PATH || '').split(path.delimiter).flatMap(directory => {
  if (!path.isAbsolute(directory)) return [];
  try {
    const candidate = fs.realpathSync(path.join(directory, 'npm'));
    return path.basename(candidate) === 'npm-cli.js' && fs.statSync(candidate).isFile() ? [candidate] : [];
  } catch { return []; }
})[0];

function fixture(t, mode, temporaryDirectory = os.tmpdir()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryDirectory, 'unpr-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const home = path.join(root, 'h'), deployment = path.join(home, 'zylos');
  const prefix = path.join(root, 'prefix'), other = path.join(root, 'other');
  const installed = path.join(prefix, 'lib/node_modules/zylos'), target = path.join(root, 'target');
  const socket = path.join(root, 'tmux/private.sock');
  for (const directory of [home, deployment, installed, target, path.join(prefix, 'bin'),
    path.join(other, 'lib/node_modules'), path.join(root, 'pm2'), path.join(root, 't'),
    path.dirname(socket), path.join(root, 'tools'), path.join(root, 'cache')]) {
    fs.mkdirSync(directory, {recursive:true});
  }
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({
    type:'module', name:'zylos', version:'0.9.6', bin:{zylos:'cli/zylos.js'},
  }));
  fs.mkdirSync(path.join(installed, 'cli'));
  fs.writeFileSync(path.join(installed, 'cli/zylos.js'), '#!/usr/bin/env node\nconsole.log("0.9.6");\n');
  fs.symlinkSync('../lib/node_modules/zylos/cli/zylos.js', path.join(prefix, 'bin/zylos'));
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({type:'module', name:'zylos', version:'1.0.0'}));
  fs.symlinkSync(npmCli, path.join(root, 'tools/npm'));
  // A private socket is reserved even though this admission test must never
  // reach a service command. An accidental tmux invocation stays isolated.
  fs.writeFileSync(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec /usr/bin/tmux -S '${socket}' "$@"\n`, {mode:0o700});
  const env = {
    HOME:home, ZYLOS_DIR:deployment, PM2_HOME:path.join(root, 'pm2'), TMPDIR:path.join(root, 't'),
    TMUX_TMPDIR:path.dirname(socket), XDG_CONFIG_HOME:path.join(home, '.config'),
    CODEX_HOME:path.join(home, '.codex'), npm_config_cache:path.join(root, 'cache'),
    npm_config_globalconfig:path.join(root, 'global.npmrc'),
    npm_config_audit:'false', npm_config_fund:'false', npm_config_update_notifier:'false',
    PATH:[path.join(root, 'tools'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    TZ:'UTC',
  };
  fs.writeFileSync(env.npm_config_globalconfig, '');
  fs.writeFileSync(path.join(home, '.npmrc'), `prefix=${mode === 'npmrc-mismatch' ? other : prefix}\n`);
  if (mode === 'env-mismatch') env.npm_config_prefix = other;
  if (mode === 'env-overrides-npmrc') {
    fs.writeFileSync(path.join(home, '.npmrc'), `prefix=${other}\n`);
    env.npm_config_prefix = prefix;
  }
  if (mode === 'symlink-match') {
    fs.symlinkSync(prefix, path.join(root, 'alias'));
    env.npm_config_prefix = path.join(root, 'alias');
  }
  const expectedRoot = path.join(mode.endsWith('mismatch') ? other : env.npm_config_prefix || prefix, 'lib/node_modules');
  const input = {schemaVersion:1, fromVersion:'0.9.6', installedRoot:installed, tempDir:target, zylosDir:deployment};
  // Read back the exact child executable, arguments, environment and targets
  // before launch. This fixture never inherits live npm or process settings.
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.equal(fs.realpathSync(env[key]), env[key]);
    assert.ok(env[key].startsWith(root + path.sep));
  }
  assert.equal(fs.realpathSync(path.join(root, 'tools/npm')), npmCli);
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.ok(Buffer.byteLength(path.join(env.PM2_HOME, 'rpc.sock')) < 100);
  assert.equal(helper, path.join(repository, 'test/helpers/run-upgrade-npm-prefix.mjs'));
  assert.ok(fs.readFileSync(path.join(home, '.npmrc'), 'utf8').includes(root));
  t.diagnostic(JSON.stringify({cwd:root, command:process.execPath, args:[helper], env, tmuxSocket:socket,
    installedRoot:installed, expectedNpmRoot:expectedRoot}));
  return {root, env, input, expectedRoot, installed, other};
}

for (const mode of ['npmrc-mismatch', 'env-mismatch', 'plain-match', 'env-overrides-npmrc', 'symlink-match']) {
  // Covers real npm root -g, real layout/source inspection and admission order.
  // Run whenever npm prefix handling or runUpgradeEntry changes. Skip only if
  // a readable real npm-cli.js is unavailable. Later upgrade stages are spies:
  // this proves admission, not a package installation or a historical bridge.
  test(`upgrade npm prefix admission uses real npm (${mode})`, {skip:!npmCli && 'real npm-cli.js unavailable', timeout:30000}, t => {
    const f = fixture(t, mode);
    const packageFile = path.join(f.installed, 'package.json');
    const before = fs.readFileSync(packageFile, 'utf8');
    const bin = path.join(path.dirname(path.dirname(path.dirname(f.installed))), 'bin/zylos');
    const beforeBin = fs.readlinkSync(bin);
    const readback = spawnSync(process.execPath, [npmCli, 'root', '-g'], {
      cwd:f.root, env:f.env, encoding:'utf8', timeout:10000,
    });
    assert.ifError(readback.error);
    assert.equal(readback.status, 0, readback.stderr);
    assert.equal(readback.stdout.trim(), f.expectedRoot);
    const child = spawnSync(process.execPath, [helper], {
      cwd:f.root, env:f.env, input:JSON.stringify(f.input), encoding:'utf8', timeout:20000,
    });
    assert.ifError(child.error);
    const report = JSON.parse(child.stdout.trim());
    if (mode.endsWith('mismatch')) {
      assert.equal(child.status, 1, child.stderr + child.stdout);
      assert.equal(report.result.success, false);
      assert.equal(report.result.code, 'UNSUPPORTED_INSTALL_LAYOUT');
      assert.ok(report.result.error.includes(f.installed));
      assert.ok(report.result.error.includes(path.join(f.expectedRoot, 'zylos')));
      assert.doesNotMatch(report.result.error + child.stderr, /\n\s+at |Error:\n/);
      assert.equal(report.result.transactionDir, undefined);
      assert.equal(report.result.upgradeProtected, false);
      assert.equal(report.result.rollback.attempted, false);
      assert.equal(report.result.recovery_required, false);
      assert.deepEqual(report.calls, []);
    } else {
      assert.equal(child.status, 0, child.stderr + child.stdout);
      assert.equal(report.result.success, true);
      assert.deepEqual(report.calls, ['begin', 'savePackage', 'saveCode', 'prepare', 'install', 'finalize']);
    }
    assert.deepEqual(report.found.candidates, []);
    assert.deepEqual(report.found.diagnostics, []);
    assert.ok(!report.found.marker);
    assert.deepEqual(fs.readdirSync(f.env.ZYLOS_DIR), []);
    assert.equal(fs.readFileSync(packageFile, 'utf8'), before);
    assert.equal(fs.readlinkSync(bin), beforeBin);
    assert.equal(fs.existsSync(path.join(f.env.PM2_HOME, 'pm2.pid')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'tmux/private.sock')), false);
    assert.equal(fs.existsSync(path.join(f.other, 'lib/node_modules/zylos')), false);
  });
}

function treeHash(directory) {
  const hash = createHash('sha256');
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      hash.update(path.relative(directory, file) + '\0' + (stat.mode & 0o777) + '\0');
      if (stat.isDirectory()) visit(file);
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
      hash.update('\0');
    }
  }
  visit(directory);
  return hash.digest('hex');
}

// Covers the unmodified released 0.9.6 runDownloadedUpgrade bridge launching
// the actual entry from a current npm tarball, with real source/database/npm
// admission and no module mocks. Run for historical handoff or prefix changes.
// Opt in with ZYLOS_RUN_UPGRADE_NPM_PREFIX_BRIDGE=1; requires real npm,
// git with v0.9.6 and tar. No packages
// are installed, lifecycle scripts are disabled, and rejection must happen
// before transactions, service commands or package replacement can occur.
// On small tmpfs hosts set ZYLOS_NPM_PREFIX_ARCHIVE_TMPDIR to a disk-backed
// temporary directory; a fresh private fixture is created and cleaned there.
test('released 0.9.6 bridge rejects a mismatched prefix in the packed current target', {
  skip:process.env.ZYLOS_RUN_UPGRADE_NPM_PREFIX_BRIDGE !== '1'
    ? 'historical bridge requires explicit opt-in' : !npmCli && 'real npm-cli.js unavailable', timeout:120000,
}, t => {
  const f = fixture(t, 'npmrc-mismatch', process.env.ZYLOS_NPM_PREFIX_ARCHIVE_TMPDIR || os.tmpdir());
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd:f.root, env:f.env, encoding:'utf8', timeout:60000, maxBuffer:64 * 1024 * 1024, ...options,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  const archive = run('git', ['archive', 'v0.9.6'], {cwd:repository, encoding:null}).stdout;
  run('tar', ['-x', '-C', f.installed], {input:archive});
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.installed, 'package.json'))).version, '0.9.6');
  // The real database preflight loads the deployed native SQLite driver even
  // when databases are absent. Reuse installed test dependencies without
  // downloads, install scripts, mocks, or changes to either product source.
  const deployedBridge = path.join(f.env.ZYLOS_DIR, '.claude/skills/comm-bridge');
  fs.mkdirSync(path.join(deployedBridge, 'node_modules'), {recursive:true});
  fs.copyFileSync(path.join(f.installed, 'skills/comm-bridge/package.json'), path.join(deployedBridge, 'package.json'));
  for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
    fs.cpSync(path.join(repository, 'node_modules', name), path.join(deployedBridge, 'node_modules', name), {recursive:true});
  }
  const deploymentBefore = treeHash(f.env.ZYLOS_DIR);
  const packs = path.join(f.root, 'packs');
  fs.mkdirSync(packs);
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json',
    '--pack-destination', packs], {cwd:repository}).stdout);
  assert.equal(packed.length, 1);
  assert.equal(path.basename(packed[0].filename), packed[0].filename);
  assert.match(packed[0].filename, /^zylos-1\..*\.tgz$/);
  run('tar', ['-xzf', path.join(packs, packed[0].filename), '--strip-components=1', '-C', f.input.tempDir]);
  assert.equal(fs.existsSync(path.join(f.input.tempDir, 'test')), false);
  assert.equal(fs.existsSync(path.join(f.input.tempDir, 'node_modules')), false);
  const before = treeHash(f.installed);
  const bridgeHelper = path.join(repository, 'test/helpers/run-upgrade-historical-bridge.mjs');
  assert.equal(fs.existsSync(path.join(f.installed, 'cli/lib/upgrade-bridge.js')), true);
  t.diagnostic(JSON.stringify({command:process.execPath, args:[bridgeHelper], cwd:f.root, env:f.env,
    source:'git archive v0.9.6', targetTarball:path.join(packs, packed[0].filename), input:f.input}));
  const child = spawnSync(process.execPath, [bridgeHelper], {
    cwd:f.root, env:f.env, encoding:'utf8', input:JSON.stringify(f.input), timeout:30000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.success, false);
  assert.equal(result.code, 'UNSUPPORTED_INSTALL_LAYOUT', child.stdout + child.stderr);
  assert.ok(result.error.includes(f.installed));
  assert.ok(result.error.includes(path.join(f.expectedRoot, 'zylos')));
  assert.doesNotMatch(result.error + child.stderr, /\n\s+at |Error:\n/);
  assert.equal(result.transactionDir, undefined);
  assert.equal(result.upgradeProtected, false);
  assert.equal(result.rollback.attempted, false);
  assert.equal(result.recovery_required, false);
  assert.equal(treeHash(f.env.ZYLOS_DIR), deploymentBefore);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR, '.backup')), false);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR, '.zylos/upgrade')), false);
  assert.deepEqual(fs.readdirSync(f.env.PM2_HOME), []);
  assert.equal(fs.existsSync(path.join(f.root, 'tmux/private.sock')), false);
  assert.equal(fs.existsSync(path.join(f.other, 'lib/node_modules/zylos')), false);
  assert.equal(treeHash(f.installed), before);
});
