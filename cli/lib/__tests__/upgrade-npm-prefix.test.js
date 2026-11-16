import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateUpgradeNpmPrefix, runUpgradeEntry} from '../upgrade-entry.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-prefix-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const coreDir = path.join(root, 'lib/node_modules/zylos');
  fs.mkdirSync(coreDir, {recursive:true});
  const protectedNpmCli = path.join(root, 'npm-cli.js');
  return {root, coreDir, protectedNpmCli, tempDir:root};
}

test('prefix precheck runs the selected npm CLI with the current Node and root -g', t => {
  const f = fixture(t), report = path.join(f.root, 'arguments.json');
  fs.writeFileSync(f.protectedNpmCli, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({exe:process.execPath,args:process.argv.slice(2),cwd:process.cwd()}));
    console.log(${JSON.stringify(path.dirname(f.coreDir))});
  `);
  validateUpgradeNpmPrefix(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(report)), {exe:process.execPath, args:['root','-g'], cwd:f.tempDir});
});

for (const linked of ['npm root', 'installed root']) test(`prefix precheck accepts an equivalent symlink for ${linked}`, t => {
  const f = fixture(t), alias = path.join(f.root, 'alias');
  fs.symlinkSync(linked === 'npm root' ? path.dirname(f.coreDir) : f.coreDir, alias, 'dir');
  fs.writeFileSync(f.protectedNpmCli, `console.log(${JSON.stringify(linked === 'npm root' ? alias : path.dirname(f.coreDir))});`);
  if (linked === 'installed root') f.coreDir = alias;
  assert.doesNotThrow(() => validateUpgradeNpmPrefix(f));
});

// File/subprocess-only admission cases. The official runner isolates host paths;
// no installation, service or tmux process runs. Rerun when npm admission changes.
for (const kind of ['different root', 'missing destination', 'nonzero exit', 'missing CLI', 'empty output', 'relative root', 'spawn output failure', 'npm timeout']) {
  test(`entry rejects ${kind} before opening a transaction`, {timeout:35000}, async t => {
    const f = fixture(t), other = path.join(f.root, 'other');
    if (kind === 'different root') fs.mkdirSync(path.join(other, 'zylos'), {recursive:true});
    if (kind !== 'missing CLI') {
      const script = kind === 'nonzero exit' ? 'console.log("private npm output");console.error("private npm error");process.exit(7);'
        : kind === 'npm timeout' ? 'setTimeout(() => {}, 45000);'
        : kind === 'empty output' ? ''
        : kind === 'relative root' ? "console.log('relative');"
        : kind === 'spawn output failure' ? "process.stdout.write('x'.repeat(2 * 1024 * 1024));"
        : `console.log(${JSON.stringify(other)});`;
      fs.writeFileSync(f.protectedNpmCli, script);
    }
    const input = {schemaVersion:1, fromVersion:'0.9.6', installedRoot:f.coreDir, tempDir:f.root, zylosDir:f.root};
    const never = () => assert.fail('mutating pipeline must not run');
    const result = await runUpgradeEntry(input, {
      maintenance:{discover:() => ({candidates:[], diagnostics:[], marker:null})},
      inspect:() => ({coreDir:f.coreDir, zylosDir:f.root, tempDir:f.root}), resolveNpm:() => f.protectedNpmCli,
      begin:never, savePackage:never, saveCode:never, prepare:never, install:never, finalize:never, recover:never,
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'UNSUPPORTED_INSTALL_LAYOUT');
    assert.match(result.error, /nothing was changed/);
    assert.ok(result.error.includes(f.coreDir));
    if (kind === 'different root' || kind === 'missing destination') {
      assert.ok(result.error.includes(path.join(other, 'zylos')));
      assert.match(result.error, /Check npm root -g: remove or align the prefix setting in ~\/.npmrc or the npm_config_prefix environment variable, then run the upgrade again\./);
    }
    if (kind === 'nonzero exit') assert.match(result.error, /npm exited with code 7/);
    if (kind === 'missing CLI') assert.match(result.error, /npm exited with code 1/);
    if (kind === 'empty output' || kind === 'relative root') assert.match(result.error, /npm returned an empty or non-absolute global directory/);
    if (kind === 'spawn output failure') assert.match(result.error, /npm execution failed \(ENOBUFS\)/);
    if (kind === 'npm timeout') assert.match(result.error, /npm timed out after 30 seconds/);
    assert.doesNotMatch(result.error, /private npm output|private npm error|\n\s+at /);
    assert.equal(result.transactionDir, undefined);
    assert.equal(result.rollback.attempted, false);
    assert.equal(result.recovery_required, false);
    assert.deepEqual(result.persisted, []);
    assert.equal('stack' in result, false);
    assert.equal(fs.existsSync(path.join(f.root, '.backup')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.zylos')), false);
  });
}
