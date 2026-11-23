import assert from 'node:assert/strict';
import test from 'node:test';

import { Sanitizer } from '../src/lib/sanitizer.js';

test('Stop assistant_summary is redacted and truncated', () => {
  const sanitizer = new Sanitizer('/tmp/zylos-test');
  const longMsg = 'Fixed the config. Key was sk-abcdefghijklmnopqrstuvwx. ' + 'x'.repeat(300);
  const result = sanitizer.sanitizeHookPayload('Stop', {
    session_id: 'sess-1',
    hook_event_name: 'Stop',
    last_assistant_message: longMsg
  });

  assert.ok(result.metadata.assistant_summary, 'should have assistant_summary');
  assert.ok(result.metadata.assistant_summary.length <= 200, 'should be truncated to 200 chars');
  assert.ok(!result.metadata.assistant_summary.includes('sk-abcdefgh'), 'API key should be redacted');
});

// --- Issue #182: phantom running tool from out-of-order pre/post ingestion ---

// Origin's run directory is read in every mode; the root file only when Origin
// has none. A confirmed absent Origin (reclaimed when idle) makes a silent
// heartbeat idle instead of stale; an instance without the mode key keeps stale.
