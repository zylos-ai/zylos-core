import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLifecycleProviders } from '../router/lifecycle.js';
import { groupRunDir, legacyRunDir, tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';

function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail('isolated target did not reach the expected state');
}

function tmuxFixture(t) {
  const f = isolatedTmux(t, { prefix: 'router-legacy-', env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'en_US.UTF-8' } });
  const env = { ZYLOS_DIR: f.dir, HOME: f.dir };
  const diagnostics = [], options = { env, tmux: { socketPath: f.socketPath, binary: f.binary },
    diagnostic: (event, fields) => diagnostics.push({ event, ...fields }) };
  // A recorder process with the observed runtime name, not an authenticated CLI.
  const source = path.join(f.dir, 'recorder.c'), executables = {};
  write(source, '#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){FILE *out=fopen(argv[1],"w");FILE *ready=fopen(argv[2],"w");fputs("ready",ready);fclose(ready);char line[1024];while(fgets(line,sizeof line,stdin)){fputs(line,out);fflush(out);if(!strcmp(line,"/exit\\n")){fclose(out);return 0;}}return 0;}\n');
  const executable = runtime => {
    if (!executables[runtime]) {
      executables[runtime] = path.join(f.dir, `bin-${runtime}`, runtime);
      fs.mkdirSync(path.dirname(executables[runtime]));
      execFileSync('cc', [source, '-o', executables[runtime]], { timeout: 20000 });
    }
    return executables[runtime];
  };
  f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '/bin/sleep', '120');
  let sequence = 0;
  const start = async (name = 'claude-main', runtime = 'codex') => {
    const record = path.join(f.dir, `input-${sequence}`), ready = path.join(f.dir, `ready-${sequence++}`);
    f.tmux('new-session', '-d', '-s', name, executable(runtime), record, ready);
    await until(() => fs.existsSync(ready));
    return record;
  };
  const setStatus = (state, idle_seconds) => write(path.join(legacyRunDir(env), 'agent-status.json'), { state, idle_seconds });
  return { ...f, env, options, diagnostics, start, setStatus };
}

test('legacy migration observes actual runtime without runId, waits for legacy idle and confirms exit', async t => {
  const f = tmuxFixture(t), input = await f.start();
  const originInput = await f.start(tmuxNameForGroup('origin'));
  write(path.join(groupRunDir('origin', f.env), 'agent-status.json'), { state: 'idle', idle_seconds: 100 });
  f.setStatus('busy', 100);
  const providers = createLifecycleProviders(f.options), entries = await providers.findLegacySessions();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].live.runtime, 'codex'); // Name is claude-main; never guess from it.
  assert.equal(entries[0].live.runId, null);
  await providers.advanceLegacy(entries);
  assert.equal(fs.readFileSync(input, 'utf8'), '');
  f.setStatus('idle', 2); await providers.advanceLegacy(entries);
  assert.equal(fs.readFileSync(input, 'utf8'), '');
  f.setStatus('idle', 3); await providers.advanceLegacy(entries);
  await until(() => fs.readFileSync(input, 'utf8') === '/exit\n');
  await until(async () => { await providers.advanceLegacy(entries); return entries[0].stopped; });
  assert.deepEqual(f.diagnostics.filter(x => x.event === 'legacy_tmux_stopped'), [{ event: 'legacy_tmux_stopped', tmuxName: 'claude-main', reason: 'exited' }]);
  assert.equal(fs.readFileSync(originInput, 'utf8'), '');
  assert.deepEqual(await providers.findLegacySessions(), []);
});

// Upgrade-complete close path, on a private tmux socket and temporary ZYLOS_DIR
// (no live instance is touched). Upgrade records are written by the upgrade's
// own marker/journal writers in terminal cleanup order: complete journal,
// cleanup done, marker removed. Run these when the legacy close path, the
// lifecycle record readers, or the upgrade marker/journal format change; they
// can be skipped for router changes outside legacy migration. They do not
// cover a real 0.9.x Claude or Codex CLI, which needs a real upgrade.
