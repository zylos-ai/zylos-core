import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTmuxEnvironment } from '../tmux-protocol.js';

test('unusual variable names preserve values without injecting a later run identity', () => {
  const text = 'ZYLOS_RUN_ID="real"; export ZYLOS_RUN_ID;\nz-x="before\nZYLOS_RUN_ID=injected"; export z-x;\n';
  assert.deepEqual(parseTmuxEnvironment(text), {ZYLOS_RUN_ID:'real', 'z-x':'before\nZYLOS_RUN_ID=injected'});
  for (const name of ['z-x', 'A B', 'q"x']) {
    assert.deepEqual(parseTmuxEnvironment(`${name}="v1"; export ${name};`), {[name]:'v1'});
  }
});
