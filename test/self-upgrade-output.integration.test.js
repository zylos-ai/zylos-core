import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Boundary: actual thin CLI -> downloaded executable -> result presenter/status.
// Run for handoff/output changes; skip for unrelated installer/finalizer changes.
// This is NOT an npm/global-install acceptance test. Success replaces only the
// target's installer/protection/DB boundaries via the native module-mock fixture;
// its fake npm answers only npm root -g for the installed package's parent.
// failure uses the real target's admission error. No service, tmux or DB starts.
// Rollback exercises presentation of a mocked completed compensation result;
// it does not establish real npm/package restoration.
for (const mode of ['human', 'json', 'legacy']) for (const outcome of ['success', 'failure', 'rollback']) {
  test(`self upgrade ${mode} ${outcome} preserves output and exit status`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-output-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fromVersion = mode === 'legacy' ? '0.9.6' : '1.0.0-beta.11';
    const target = path.join(root, 'target');
    const installed = path.join(root, 'prefix/lib/node_modules/zylos');
    for (const relative of ['home', 'tmp', 'deployment', 'prefix/bin', 'target', 'prefix/lib/node_modules/zylos/cli/lib']) {
      fs.mkdirSync(path.join(root, relative), { recursive: true });
    }
    for (const [directory, version] of [[target, '1.0.0'], [installed, fromVersion]]) {
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'zylos', type: 'module', version }));
    }
    for (const relative of ['cli/lib', 'skills/comm-bridge/scripts']) {
      fs.cpSync(path.resolve(relative), path.join(target, relative), { recursive: true,
        filter: file => !file.split(path.sep).some(part => ['__tests__', 'node_modules'].includes(part)) });
    }
    const expected = { action: 'self_upgrade', success: true, from: fromVersion, to: '1.0.0',
      warnings: [{ runtime: 'codex', code: 'RUNTIME_CLI_UNAVAILABLE', message: 'Optional CLI unavailable.' }] };
    fs.writeFileSync(path.join(installed, 'cli/lib/self-upgrade.js'), `export function runSelfUpgradeFinalize() { return ${JSON.stringify(expected)}; }\n`);
    const npmCli = path.join(root, 'npm-cli.js');
    fs.writeFileSync(npmCli, outcome !== 'failure'
      ? `import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['root', '-g']);
process.stdout.write(${JSON.stringify(path.dirname(installed))});\n`
      : 'throw Error("installer must stay inert");\n');
    fs.symlinkSync(npmCli, path.join(root, 'prefix/bin/npm'));
    if (outcome === 'failure') {
      // Real metadata mismatch rejects before any transaction or service action.
      fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'zylos', version: '0.9.5' }));
    }
    const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'deployment'),
      PM2_HOME: path.join(root, 'home/.pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'),
      PATH: path.join(root, 'prefix/bin'), UPGRADE_ENTRY_FIXTURE_ROOT: root };
    // Read back all effective paths before starting either product process.
    for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      assert.ok(env[name].startsWith(root + path.sep), `${name} escaped fixture: ${env[name]}`);
    }
    assert.ok(target.startsWith(root + path.sep));
    assert.ok(installed.startsWith(root + path.sep));
    t.diagnostic(JSON.stringify({ mode, outcome, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
      TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, target, installed }));
    const child = spawnSync(process.execPath, [path.resolve('test/helpers/run-upgrade-output.js'), mode, outcome], {
      env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, outcome === 'success' ? 0 : 1, child.stderr + child.stdout);
    if (mode !== 'human') {
      const result = JSON.parse(child.stdout);
      assert.equal(child.stdout, JSON.stringify(result) + '\n');
      if (outcome === 'success') assert.deepEqual(result, expected);
      else {
        assert.equal(result.success, false);
        if (outcome === 'rollback') {
          assert.equal(result.code, 'UPGRADE_FAILED');
          assert.equal(result.error, 'npm error Target installation failed.');
          assert.deepEqual(result.rollback, {attempted:true, completed:true, recovery_required:false, performed:true});
          assert.deepEqual(Object.keys(result).sort(), ['action', 'success', 'code', 'error', 'persisted', 'upgradeProtected', 'transactionDir', 'rollback', 'recovery_required'].sort());
          assert.equal(result.recovery_required, false);
        } else {
          assert.equal(result.code, 'INVALID_UPGRADE_HANDOFF');
          assert.equal(result.error, 'Installed source version does not match upgrade handoff.');
        }
      }
    } else {
      assert.match(child.stdout, /Release notes without trailing newline\n/);
      assert.doesNotMatch(child.stdout + child.stderr, /"success"|INVALID_UPGRADE_HANDOFF|RUNTIME_CLI_UNAVAILABLE|undefined|\n\s+at /);
      if (outcome === 'success') {
        assert.match(child.stdout, /\nzylos-core upgraded: 1\.0\.0-beta\.11 → 1\.0\.0\.\n$/);
        assert.match(child.stderr, /Runtime warning \(codex\): Optional CLI unavailable\./);
      } else if (outcome === 'rollback') {
        assert.ok(child.stderr.includes(`Rollback completed. zylos-core has been restored to ${fromVersion}.\n`));
        assert.match(child.stderr, /^Error: npm error Target installation failed\./m);
        assert.doesNotMatch(child.stderr, /npm warn deprecated old-package|recovery status/);
      } else assert.match(child.stderr, /^Error: Installed source version does not match upgrade handoff\.\n$/);
    }
    assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, '.backup')), false);
  });
}
