import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Exercise the actual upgrade failure/rollback transaction in a fresh process.
// Network/npm are discriminating boundaries, not real installs or downloads.
test('real runUpgrade retains the operation profile through npm failure and dependency rollback', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upstream-rollback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lib = new URL('../', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { prepareUpstreams, withUpstreamSnapshot, getUpstreamSnapshot } from ${JSON.stringify(lib + 'upstreams.js')};
    import { fetchRawFile } from ${JSON.stringify(lib + 'github.js')};
    import { runUpgrade } from ${JSON.stringify(lib + 'upgrade.js')};
    import { generateManifest, saveMergeBaseline } from ${JSON.stringify(lib + 'manifest.js')};
    const root = process.env.ZYLOS_DIR;
    const name = 'snapshot-test';
    const skill = path.join(root, '.claude/skills', name), v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
    for (const [dest, version] of [[skill, '1.0.0'], [v1, '1.0.0'], [v2, '2.0.0']]) {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name, version }));
      fs.writeFileSync(path.join(dest, 'value.txt'), version);
    }
    saveMergeBaseline(skill, v1, generateManifest(v1));
    const profilePath = path.join(root, 'profile.json');
    const writeProfile = revision => fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, revision, providers: { github: { rawBase: 'https://' + revision + '.test/raw/' } } }));
    writeProfile('old');
    const prepared = await prepareUpstreams({ zylosDir: root, env: {}, source: { type: 'local', path: profilePath } });
    const requests = [], phases = [];
    const originalExec = childProcess.execSync, originalFile = childProcess.execFileSync;
    childProcess.execFileSync = (command, argv, options) => {
      if (command === 'curl') {
        const url = argv.at(-1);
        if (!url.startsWith('https://old.test/raw/')) throw new Error('Blocked unexpected upstream: ' + url);
        requests.push(url);
        return 'probe';
      }
      return originalFile(command, argv, options);
    };
    childProcess.execSync = (command, options) => {
      if (command === 'gh auth token') throw new Error('No test credentials');
      if (command === 'npm install --omit=dev') {
        phases.push({ revision: getUpstreamSnapshot().revision, cwd: options.cwd });
        // Simulate an operator changing the local source between forward and rollback.
        writeProfile('new');
        fetchRawFile('org/repo', 'probe.txt', 'main');
        if (phases.length === 1) throw new Error('Injected dependency-install failure');
        return '';
      }
      return originalExec(command, options);
    };
    syncBuiltinESMExports();
    const result = withUpstreamSnapshot(prepared, () => runUpgrade(name, { tempDir: v2, newVersion: '2.0.0', jsonOutput: true }));
    const next = await prepareUpstreams({ zylosDir: root, env: {}, source: { type: 'local', path: profilePath } });
    console.log(JSON.stringify({ result, phases, requests, next: next.snapshot.revision, value: fs.readFileSync(path.join(skill, 'value.txt'), 'utf8') }));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ZYLOS_DIR: dir, GITHUB_TOKEN: '', GH_TOKEN: '', ZYLOS_GH_RETRY_DELAY_MS: '' },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.result.success, false);
  assert.equal(result.result.failedStep, 4);
  assert.equal(result.result.rollback.performed, true);
  assert.equal(result.value, '1.0.0');
  assert.deepEqual(result.phases.map(phase => phase.revision), ['old', 'old']);
  assert.deepEqual(result.requests, Array(2).fill('https://old.test/raw/org/repo/main/probe.txt'));
  assert.equal(result.next, 'new');
});
