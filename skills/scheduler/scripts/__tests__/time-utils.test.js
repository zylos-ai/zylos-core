import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDuration } from '../time-utils.js';

describe('parseDuration', () => {

  it('parses natural language durations', () => {
    const result = parseDuration('30 minutes');
    assert.ok(result >= 1790 && result <= 1810, `expected ~1800, got ${result}`);
  });

});
