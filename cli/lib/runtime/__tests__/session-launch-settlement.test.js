import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LAUNCH_TIMEOUT_MS } from '../launch-flow.js';
import { setupLaunch, assertGone } from './launch-tmux-fixture.js';

test('shell wrapper execs runtime and settles within the confirmation budget', async t => {
  const f = await setupLaunch(t);
  const wrapper = path.join(f.dir, 'runtime-wrapper');
  await fs.writeFile(wrapper, '#!/bin/sh\nexec /bin/sleep 30\n', {mode:0o700});
  const client = await f.clientWrapper();
  const start = performance.now();
  const result = await f.launch({command:wrapper, args:[], tmuxBinary:client.file});
  const elapsed = performance.now()-start;
  assert.equal(result.tmuxName, 'target');
  assert.ok(elapsed < LAUNCH_TIMEOUT_MS);
  assert.equal(f.tmux('list-panes', '-t', '=target', '-F', '#{pane_current_command}').trim(), 'sleep');
  assertGone(assert, Number(await fs.readFile(client.pidFile, 'utf8')));
  t.diagnostic(JSON.stringify({wrapperSuccessMs:Math.round(elapsed)}));
});

test('immediate runtime exit fails and removes its retained dead session', async t => {
  const f=await setupLaunch(t);
  f.tmux('set-option','-g','remain-on-exit','on');
  const wrapper=await f.clientWrapper();
  await assert.rejects(f.launch({command:'/bin/false',args:[],tmuxBinary:wrapper.file}),{code:'LAUNCH_FAILED'});
  assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper');
  assertGone(assert,Number(await fs.readFile(wrapper.pidFile,'utf8')));
});

test('duplicate session is NAME_CONFLICT and retains the original pane', async t => {
  const f=await setupLaunch(t);
  const original=f.tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim();
  await assert.rejects(f.launch({tmuxName:'keeper'}),{code:'NAME_CONFLICT'});
  assert.equal(f.tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim(),original);
});
