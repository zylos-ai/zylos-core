import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasStatusChanged } from '../status-utils.js';

describe('hasStatusChanged', () => {
  it('detects health-only changes', () => {
    assert.equal(
      hasStatusChanged(
        { state: 'idle', health: 'unavailable' },
        { state: 'idle', health: 'ok' }
      ),
      true
    );
  });

  it('detects reason and cooldown changes for the same state and health', () => {
    assert.equal(
      hasStatusChanged(
        { state: 'idle', health: 'unavailable', unavailable_reason: 'rate_limit' },
        { state: 'idle', health: 'unavailable', unavailable_reason: 'restart' }
      ),
      true
    );
    assert.equal(
      hasStatusChanged(
        { state: 'idle', health: 'rate_limited', cooldown_until: 200 },
        { state: 'idle', health: 'rate_limited', cooldown_until: 100 }
      ),
      true
    );
  });

  it('ignores unchanged status fields used by broadcast decisions', () => {
    assert.equal(
      hasStatusChanged(
        { state: 'busy', health: 'ok', idle_seconds: 10 },
        { state: 'busy', health: 'ok', idle_seconds: 5 }
      ),
      false
    );
  });
});
