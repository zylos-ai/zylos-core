import assert from 'node:assert/strict';
import test from 'node:test';
import { agentColor, fnv1a32 } from '../src/lib/agent-color.js';

test('agent color is deterministic and order independent', () => {
  const names = ['Jinglever', 'zylos01', 'zylos0t'];
  const first = new Map(names.map(name => [name, agentColor(name)]));
  const second = new Map([...names].reverse().map(name => [name, agentColor(name)]));

  for (const name of names) {
    assert.deepEqual(first.get(name), second.get(name));
  }
  assert.deepEqual(agentColor('Jinglever'), agentColor('jinglever'));
  assert.equal(typeof fnv1a32('Jinglever'), 'number');
});

