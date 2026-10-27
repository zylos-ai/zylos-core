import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { openTmuxConnection } from '../tmux-connection.js';
import { observeSessionTarget } from '../session-target.js';
import { parseTmuxEnvironment } from '../tmux-protocol.js';

test('shell environment parser preserves literal backslashes and rejects malformed records', () => {
  assert.deepEqual(parseTmuxEnvironment('VALUE="a\\\\n\\$HOME"; export VALUE;'), {VALUE:'a\\n$HOME'});
  assert.deepEqual(parseTmuxEnvironment('VALUE="a\\\\n\\\\$HOME"; export VALUE;'), {VALUE:'a\\n$HOME'});
  assert.throws(() => parseTmuxEnvironment('VALUE="unterminated'), {code:'TMUX_RESPONSE_INVALID'});
  assert.throws(() => parseTmuxEnvironment('VALUE="x"; export OTHER;'), {code:'TMUX_RESPONSE_INVALID'});
});

test('shell environment parser accepts quoted assignments and unset records only', () => {
  assert.deepEqual(parseTmuxEnvironment('VALUE="first\nsecond"; export VALUE;\nunset REMOVED;\nEMPTY=""; export EMPTY;\n'),
    {VALUE:'first\nsecond', EMPTY:''});
  assert.deepEqual(parseTmuxEnvironment('z-x="v"; export z-x;\nunset z-x;'), {});
  for (const text of ['VALUE=plain', 'unset VALUE', 'VALUE="x"; export VALUE; injected']) {
    assert.throws(() => parseTmuxEnvironment(text), {code:'TMUX_RESPONSE_INVALID'}, text);
  }
});

test('unusual variable names preserve values without injecting a later run identity', () => {
  const text = 'ZYLOS_RUN_ID="real"; export ZYLOS_RUN_ID;\nz-x="before\nZYLOS_RUN_ID=injected"; export z-x;\n';
  assert.deepEqual(parseTmuxEnvironment(text), {ZYLOS_RUN_ID:'real', 'z-x':'before\nZYLOS_RUN_ID=injected'});
  for (const name of ['z-x', 'A B', 'q"x']) {
    assert.deepEqual(parseTmuxEnvironment(`${name}="v1"; export ${name};`), {[name]:'v1'});
  }
});

test('variable names containing newlines are rejected', () => {
  for (const text of ['n\nZYLOS_RUN_ID="injected"; export n\nZYLOS_RUN_ID;', 'unset n\nZYLOS_RUN_ID;']) {
    assert.throws(() => parseTmuxEnvironment(text), {code:'TMUX_RESPONSE_INVALID'});
  }
});

test('real F2 environment preserves dollars, slash runs and control characters', async t => {
  const f = isolatedTmux(t, {prefix:'environment-readback-'});
  f.tmux('-f','/dev/null','new-session','-d','-s','fixture','sleep 120');
  const values = ['$HOME', '${HOME}', '$_x', '$0', '$', 'a\\$name', 'a\\\\$name',
    'a\\n', 'a\\\\n', 'a\nb', 'a\rb', '\x01\x07\x08\x0b\x0c\x1b\x7f',
    'quotes"`\'=#{};\\', '中文$NAME', 'a=b\tlast'];
  const config = {runtime:'claude',mode:'override',model:'model$HOME\\$NAME',effort:'high'};
  f.tmux('set-environment','-t','fixture','ZYLOS_MODEL_CONFIG',JSON.stringify(config));
  f.tmux('set-environment','-t','fixture','ZYLOS_RUN_ID','run$HOME\\$NAME');
  for (const name of ['z-x', 'A B', 'q"x']) f.tmux('set-environment','-t','fixture',name,'before\nZYLOS_RUN_ID=injected');
  for (let i=0;i<values.length;i++) f.tmux('set-environment','-t','fixture',`TEST_VALUE_${i}`,values[i]);
  const connection = await openTmuxConnection({binary:f.binary,socketPath:f.socketPath});
  t.after(() => connection.close());
  const target = await observeSessionTarget({connection,tmuxName:'fixture',readReady:async()=>null});
  assert.deepEqual(target.launchConfig, config);
  assert.equal(target.runId,'run$HOME\\$NAME');
  assert.equal(target.present,true);
  for (const name of ['z-x', 'A B', 'q"x']) assert.equal(target.rawF2[name],'before\nZYLOS_RUN_ID=injected');
  for (let i=0;i<values.length;i++) assert.equal(target.rawF2[`TEST_VALUE_${i}`],values[i],`value ${i}`);
});
