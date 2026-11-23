import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL('../../commands/component.js', import.meta.url));

test('thin CLI forwards downloaded executable output and exit status without another restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cli-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'cli/lib'), {recursive:true});
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'cli/lib/upgrade-entry.js'), '');
  const result = { success: true, from: '0.9.0', to: '0.9.2', settingsChanged: true,
    completion: { install: 'done', dashboard: 'degraded', sessionRestart: 'manual_required', modeTransition: 'unknown' },
    sessionRestart: { ok: false, error: { code: 'SUBMISSION_FAILED', message: 'entry unavailable' } },
    publication: { warnings: [{ targetId: 't04', code: 'CONFIG_WARNING', error: 'global configuration not published' }] },
    next: 'Resolve the restart error.' };
  for (const json of [false, true]) {
    const script = `
      import { mock } from 'node:test';
      let restartCalls = 0;
      mock.module(${JSON.stringify(new URL('../self-upgrade.js', import.meta.url).href)}, {namedExports: {
        checkForCoreUpdates: () => ({success:true,hasUpdate:true,current:'0.9.3',latest:'0.9.4'}),
        checkCoreTargetVersion: () => { throw new Error('no explicit --version in this case'); },
        downloadCoreToTemp: () => ({success:true,tempDir:${JSON.stringify(root)}}),
        readChangelog: () => '', cleanupTemp() {},
        pendingDatabaseMigrations: () => { throw new Error('an available update needs no same-version database check'); },
        copyInstalledCoreToTemp: () => { throw new Error('an available update downloads its target'); }
      }});
      mock.module(${JSON.stringify(new URL('../request-runtime-restart.js', import.meta.url).href)}, {namedExports: {
        requestRuntimeRestart: () => { restartCalls++; return {ok:true}; }
      }});
      process.on('exit', () => process.stderr.write('restartCalls=' + restartCalls));
      const {upgradeSelfCore} = await import(${JSON.stringify(modulePath)});
      await upgradeSelfCore({skipConfirm:true,jsonOutput:${json}}, {
        recoverBeforeUpgrade() {}, cleanupCoreTemp() {},
        runDownloadedUpgrade(handoff) {
          if (handoff.fromVersion !== '0.9.3') throw Error('incorrect source handoff');
          process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')});
          process.stderr.write('downloaded diagnostic\\n');
          return 37;
        }
      });
    `;
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
      { encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: root } });
    assert.equal(child.status, 37, child.stderr);
    assert.match(child.stderr, /restartCalls=0/);
    assert.match(child.stderr, /downloaded diagnostic/);
    if (json) assert.equal(child.stdout, JSON.stringify(result) + '\n');
    else {
      assert.match(child.stdout, /^zylos-core: 0\.9\.3 .* 0\.9\.4\n/);
      assert.ok(child.stdout.endsWith(JSON.stringify(result) + '\n'));
    }
  }
});
