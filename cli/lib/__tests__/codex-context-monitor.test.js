import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSqliteThreadRow } from '../runtime/codex-context-monitor.js';

describe('parseSqliteThreadRow', () => {
  it('parses sqlite3 -json output with rollout paths that contain separators', () => {
    const parsed = parseSqliteThreadRow(JSON.stringify([
      {
        id: '42',
        tokens_used: 1234,
        rollout_path: '/tmp/rollout|with|pipes.jsonl',
      },
    ]));

    assert.deepEqual(parsed, {
      threadIdRaw: '42',
      tokensUsed: 1234,
      rolloutPathRaw: '/tmp/rollout|with|pipes.jsonl',
    });
  });

  it('returns null for malformed sqlite payloads', () => {
    assert.equal(parseSqliteThreadRow('not-json'), null);
    assert.equal(parseSqliteThreadRow(JSON.stringify([{ id: '1', tokens_used: 'oops' }])), null);
  });
});
