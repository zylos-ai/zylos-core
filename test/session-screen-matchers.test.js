import test from 'node:test';
import assert from 'node:assert/strict';
import { matchClaudeScreen } from '../cli/lib/heartbeat/claude-probe.js';
import { matchCodexScreen } from '../cli/lib/heartbeat/codex-probe.js';

test('Claude reports simultaneous independent screen facts without recovery choice',()=> {
  const result=matchClaudeScreen('usage limit reached\nauthentication_error\nAPI Error: 500');
  assert.equal(result.rateLimit.detected,true);
  assert.equal(result.authFailure.detected,true);
  assert.equal(result.apiError.detected,true);
  assert.deepEqual(Object.keys(result),['rateLimit','authFailure','apiError']);
});
test('Codex preserves baseline no-screen-rate inference and detects auth/API facts',()=> {
  const result=matchCodexScreen('Not logged in\nAPI Error: 400\nusage limit reached');
  assert.equal(result.rateLimit.detected,false);
  assert.equal(result.authFailure.detected,true);
  assert.equal(result.apiError.detected,true);
});
test('empty or non-string pane input has no detected facts',()=> {
  for(const match of [matchClaudeScreen,matchCodexScreen]) for(const value of ['',null,undefined,{}]) {
    assert.deepEqual(match(value),{rateLimit:{detected:false},authFailure:{detected:false},apiError:{detected:false}});
  }
});
