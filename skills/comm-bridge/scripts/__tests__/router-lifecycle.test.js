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

// P04 T01/T03, M1 §6 and DM F3/F6: resetting origin must not erase legacy
// upgrade progress, another group's state, or current-session/event history.
test('single preparation cleans origin samples/caches, preserves history and legacy files, and builds real instructions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: dir }, origin = groupRunDir('origin', env), legacy = legacyRunDir(env), other = groupRunDir('telegram:other', env);
  const cleared = ['agent-status.json', 'statusline.json', 'tool-event-stream-state.json', 'session-tool-state.json', 'foreground-session.json'];
  const retained = ['current-session.json', 'events.jsonl', 'events.123.jsonl', 'events.jsonl.old'];
  for (const base of [origin, legacy, other]) for (const name of [...cleared, ...retained]) write(path.join(base, name), `${base}/${name}`);
  write(path.join(dir, '.zylos/instructions/meta.json'), {});
  write(path.join(dir, '.zylos/instructions/codex-system.md'), 'System instructions');
  write(path.join(dir, 'ZYLOS.md'), 'Owner instructions');
  const providers = createLifecycleProviders({ env, checkMaintenance: async () => null });
  await providers.prepareSingle('codex');
  for (const name of cleared) assert.equal(fs.existsSync(path.join(origin, name)), false);
  for (const base of [legacy, other]) for (const name of [...cleared, ...retained]) assert.equal(fs.readFileSync(path.join(base, name), 'utf8'), `${base}/${name}`);
  for (const name of retained) assert.equal(fs.readFileSync(path.join(origin, name), 'utf8'), `${origin}/${name}`);
  const instructions = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /System instructions/); assert.match(instructions, /Owner instructions/);
  assert.equal(fs.existsSync(path.join(origin, 'api-activity.json')), false);
  assert.equal(fs.existsSync(path.join(origin, 'hook-state.json')), false);
});

function tmuxFixture(t) {
  const f = isolatedTmux(t, { prefix: 'router-legacy-', env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'en_US.UTF-8' } });
  const env = { ZYLOS_DIR: f.dir, HOME: f.dir };
  const diagnostics = [], options = { env, tmux: { socketPath: f.socketPath, binary: f.binary }, checkMaintenance: async () => null,
    diagnostic: (event, fields) => diagnostics.push({ event, ...fields }) };
  // A recorder process with the observed runtime name, not an authenticated CLI.
  const source = path.join(f.dir, 'recorder.c'), executable = path.join(f.dir, 'codex');
  write(source, '#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){FILE *out=fopen(argv[1],"w");FILE *ready=fopen(argv[2],"w");fputs("ready",ready);fclose(ready);char line[1024];while(fgets(line,sizeof line,stdin)){fputs(line,out);fflush(out);if(!strcmp(line,"/exit\\n")){fclose(out);return 0;}}return 0;}\n');
  execFileSync('cc', [source, '-o', executable], { timeout: 20000 });
  f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '/bin/sleep', '120');
  let sequence = 0;
  const start = async (name = 'claude-main') => {
    const record = path.join(f.dir, `input-${sequence}`), ready = path.join(f.dir, `ready-${sequence++}`);
    f.tmux('new-session', '-d', '-s', name, executable, record, ready);
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

test('busy legacy session survives until 300 seconds, then actual adapter stop confirms removal', async t => {
  const f = tmuxFixture(t), input = await f.start(); f.setStatus('busy', 1000);
  let now = 0;
  const providers = createLifecycleProviders({ ...f.options, now: () => now }), entries = await providers.findLegacySessions();
  now = 299999; await providers.advanceLegacy(entries); assert.equal(entries[0].stopped, false);
  assert.equal(f.tmux('has-session', '-t', '=claude-main'), '');
  now = 300000; await providers.advanceLegacy(entries);
  assert.equal(entries[0].stopped, true); assert.equal(fs.readFileSync(input, 'utf8'), '');
  assert.throws(() => f.tmux('has-session', '-t', '=claude-main'));
  assert.equal(f.diagnostics.at(-1).reason, 'forced');
});

test('replacement between idle observation and exit gets no text on the new object', async t => {
  const f = tmuxFixture(t); await f.start();
  let replacementInput, replace = true;
  const providers = createLifecycleProviders({ ...f.options, readLegacyStatus: async () => {
    if (replace) {
      replace = false; f.tmux('kill-session', '-t', '=claude-main'); replacementInput = await f.start();
    }
    return { state: 'idle', idle_seconds: 10 };
  } });
  const entries = await providers.findLegacySessions(); await providers.advanceLegacy(entries);
  assert.equal(fs.readFileSync(replacementInput, 'utf8'), '');
  assert.equal(entries[0].exitSent, false); assert.equal(entries[0].stopped, false);
  assert.equal(f.diagnostics.at(-1).reason, 'TARGET_GONE');
});

test('unknown actual runtime is never inferred from a legacy name or origin READY', async t => {
  const f = tmuxFixture(t);
  f.tmux('new-session', '-d', '-s', 'claude-main', '/bin/sleep', '120');
  f.setStatus('idle', 10);
  write(path.join(groupRunDir('origin', f.env), 'current-session.json'), { runId: 'new', sessionId: 'new', ts: 1, startupControlIds: [] });
  let now = 0;
  const providers = createLifecycleProviders({ ...f.options, now: () => now, adapter: () => assert.fail('unknown runtime must not select an adapter') });
  const entries = await providers.findLegacySessions();
  assert.equal(entries[0].live.runtime, 'unknown'); assert.equal(entries[0].live.ready, false);
  await providers.advanceLegacy(entries); now = 300000; await providers.advanceLegacy(entries);
  assert.equal(entries[0].stopped, false); assert.equal(f.tmux('has-session', '-t', '=claude-main'), '');
});

// IB-29: an old idle sample cannot authorize graceful legacy exit.
test('legacy idle sample must be fresh; malformed and stale samples leave the session running', async t => {
  const f = tmuxFixture(t), input = await f.start();
  let clock = Date.now();
  const providers = createLifecycleProviders({ ...f.options, now: () => clock });
  const entries = await providers.findLegacySessions();
  const file = path.join(legacyRunDir(f.env), 'agent-status.json');
  f.setStatus('idle', 100);
  fs.utimesSync(file, new Date(clock - 6000), new Date(clock - 6000));
  await providers.advanceLegacy(entries);
  assert.equal(fs.readFileSync(input, 'utf8'), '');
  assert.equal(entries[0].exitSent, false);
  write(file, '{broken');
  await providers.advanceLegacy(entries);
  assert.equal(fs.readFileSync(input, 'utf8'), '');
  f.setStatus('idle', 100);
  clock = fs.statSync(file).mtimeMs + 5000;
  await providers.advanceLegacy(entries);
  await until(() => fs.readFileSync(input, 'utf8') === '/exit\n');
  assert.equal(entries[0].exitSent, true);
});
