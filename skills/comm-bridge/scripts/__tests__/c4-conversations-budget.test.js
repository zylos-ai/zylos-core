import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_SHARD_BUDGET, withinBudget } from '../../../activity-monitor/scripts/shard-registry.js';

const DATABASE_URL = new URL('../c4-db.js', import.meta.url).href;
const SESSION_INIT_URL = pathToFileURL(fileURLToPath(new URL('../c4-session-init.js', import.meta.url))).href;
const REGISTRY_URL = pathToFileURL(
  fileURLToPath(new URL('../../../activity-monitor/scripts/shard-registry.js', import.meta.url)),
).href;

// c4-config resolves ZYLOS_DIR at module load, so every emitter call runs in
// a fresh child process with the tmp dir in its environment.
function emitConversations(env, budget = null) {
  const script = `
    const mod = await import(${JSON.stringify(SESSION_INIT_URL)});
    const budget = process.env.TEST_BUDGET ? JSON.parse(process.env.TEST_BUDGET) : null;
    process.stdout.write(await mod.emitC4Conversations({}, budget));
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env, TEST_BUDGET: budget ? JSON.stringify(budget) : '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function emitViaRegistry(env) {
  const script = `
    const { CORE_SHARDS } = await import(${JSON.stringify(REGISTRY_URL)});
    const shard = CORE_SHARDS.find(s => s.name === 'c4-conversations');
    process.stdout.write(await shard.emit({}));
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function receive(content, env) {
  // Outbound rows are delivered immediately; c4-receive leaves inbound rows
  // pending until dispatch, so they cannot seed the delivered-tail contract.
  const script = `const db = await import(${JSON.stringify(DATABASE_URL)});
    db.insertConversation('out', 'system', null, ${JSON.stringify(content)}); db.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-conv-budget-'));
  const env = { ZYLOS_DIR: tmpDir };
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Session startup preserves full messages, independently of dispatch spill.
const marker = i => `UNIQ_MARK_${i}`;

describe('emitC4Conversations budget packing (message-boundary, newest-first)', () => {
  it('drops the oldest whole messages when the char budget overflows', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 6; i++) receive(`${marker(i)} ${'x'.repeat(1800)}`, env);

      // ~11K chars total against a 5K char budget (room for two whole
      // messages, not three); token limit kept out of the way so the char
      // dimension drives the packing.
      const out = emitConversations(env, { maxChars: 5000, maxTokens: 100000 });

      assert.ok(out.includes(marker(6)), 'newest message must survive');
      assert.ok(!out.includes(marker(1)), 'oldest message must be dropped whole');
      assert.ok(out.length <= 5000, `packed output must fit the char budget (got ${out.length})`);
      // Every kept message is complete: its marker implies its full body.
      for (let i = 1; i <= 6; i++) {
        if (out.includes(marker(i))) {
          assert.ok(out.includes(`${marker(i)} ${'x'.repeat(1800)}`), `message ${i} must be intact, not cut mid-message`);
        }
      }
      // Packing selects newest-first but must EMIT in chronological order —
      // the last message in the section must remain the newest one.
      const positions = [];
      for (let i = 1; i <= 6; i++) {
        const at = out.indexOf(marker(i));
        if (at !== -1) positions.push({ i, at });
      }
      assert.ok(positions.length >= 2, 'expected more than one surviving message');
      for (let k = 1; k < positions.length; k++) {
        assert.ok(
          positions[k].i > positions[k - 1].i && positions[k].at > positions[k - 1].at,
          'kept messages must appear oldest → newest',
        );
      }
    });
  });

  it('drops the oldest whole messages when the token budget overflows (CJK)', () => {
    withTmpDir(({ env }) => {
      // 650 CJK chars ≈ 500 estimated tokens per message, 1,950 bytes < the
      // per-message threshold. Six messages ≈ 3,000 tokens against a 1,500
      // token budget, while chars stay far under their limit — the token
      // dimension alone must drive the packing.
      for (let i = 1; i <= 6; i++) receive(`${marker(i)} ${'的'.repeat(650)}`, env);

      const out = emitConversations(env, { maxChars: 100000, maxTokens: 1500 });

      assert.ok(out.includes(marker(6)), 'newest message must survive');
      assert.ok(!out.includes(marker(1)), 'oldest message must be dropped whole');
    });
  });

  it('is byte-identical to the legacy path when everything fits', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 3; i++) receive(`${marker(i)} short`, env);

      const legacy = emitConversations(env, null);
      const shard = emitConversations(env, DEFAULT_SHARD_BUDGET);

      assert.equal(shard, legacy);
      assert.ok(!shard.includes('showing the newest'), 'no omission note when nothing was dropped');
      for (let i = 1; i <= 3; i++) assert.ok(shard.includes(marker(i)));
    });
  });

  it('M09: drops a single oversized message without creating a spill file', () => {
    withTmpDir(({ tmpDir, env }) => {
      receive(`${marker(1)} ${'x'.repeat(3000)}`, env);

      const out = emitConversations(env, { maxChars: 1200, maxTokens: 100000 });

      assert.ok(!out.includes(marker(1)), 'the newest message must be dropped whole');
      assert.ok(!out.includes('TRUNCATED'), 'startup must not create attachment previews');
      assert.ok(out.length <= 1200);
      assert.ok(!out.includes('x'.repeat(3000)), 'lone over-budget message must not be emitted in full');
      const attachmentsDir = path.join(tmpDir, 'comm-bridge', 'attachments');
      assert.ok(!fs.existsSync(attachmentsDir) || fs.readdirSync(attachmentsDir).length === 0);
    });
  });

  it('M09: also drops a single sub-threshold message when it exceeds the budget', () => {
    withTmpDir(({ env }) => {
      receive(`${marker(1)} ${'x'.repeat(700)}`, env);

      const out = emitConversations(env, { maxChars: 1200, maxTokens: 100000 });

      assert.ok(!out.includes(marker(1)), 'sub-threshold message is dropped whole');
      assert.ok(out.length <= 1200);
      assert.ok(!out.includes('[C4] ⚠️ TRUNCATED'));
    });
  });

  it('emits messages over the per-message delivery threshold in FULL when the shard budget fits them (#724)', () => {
    withTmpDir(({ tmpDir, env }) => {
      // 3,000 chars — well over the 2,048-byte dispatch spill threshold but
      // comfortably inside the default 10K-char shard budget.
      const body = `${marker(1)} ${'y'.repeat(3000)}`;
      receive(body, env);

      const out = emitConversations(env, DEFAULT_SHARD_BUDGET);

      assert.ok(out.includes(body), 'original content must be emitted inline, not a preview');
      assert.ok(!out.includes('[C4] ⚠️ TRUNCATED'), 'no attachment pointer when the budget fits the original');
      const attachmentsDir = path.join(tmpDir, 'comm-bridge', 'attachments');
      assert.ok(
        !fs.existsSync(attachmentsDir) || fs.readdirSync(attachmentsDir).length === 0,
        'no spill file must be written when the original is emitted inline',
      );
    });
  });

  it('packs whole original long messages newest-first when several exceed the dispatch threshold', () => {
    withTmpDir(({ env }) => {
      // Four ~3K messages ≈ 12K chars against the 10K-char default budget:
      // at least the newest must survive IN FULL, the oldest must drop whole.
      for (let i = 1; i <= 4; i++) receive(`${marker(i)} ${'z'.repeat(3000)}`, env);

      const out = emitConversations(env, { maxChars: 10000, maxTokens: 100000 });

      assert.ok(out.includes(`${marker(4)} ${'z'.repeat(3000)}`), 'newest long message must survive in full');
      assert.ok(!out.includes(marker(1)), 'oldest message must be dropped whole');
      assert.ok(!out.includes('[C4] ⚠️ TRUNCATED'), 'kept messages must be originals, not previews');
      assert.ok(out.length <= 10000, `packed output must fit the char budget (got ${out.length})`);
    });
  });

  it('preserves original bytes without spill on the no-budget path too', () => {
    withTmpDir(({ env }) => {
      const body = `${marker(1)} ${'w'.repeat(3000)}`;
      receive(body, env);

      const out = emitConversations(env, null);

      assert.ok(!out.includes('TRUNCATED'), 'startup never uses the preview + pointer form');
      assert.ok(out.includes(body), 'the full over-threshold message stays intact');
    });
  });

  it('reads the latest six delivered messages without obsolete sync instructions', () => {
    withTmpDir(({ env }) => {
      // Startup considers only the newest six delivered messages; the budget
      // squeezes that tail further without triggering memory synchronization.
      for (let i = 1; i <= 17; i++) receive(`${marker(i)} ${'x'.repeat(1200)}`, env);

      const out = emitConversations(env, { maxChars: 3000, maxTokens: 100000 });

      assert.doesNotMatch(out, /ACTION REQUIRED|unsummarized|Memory Sync/);
      assert.ok(out.includes(marker(17)), 'newest message must survive');
      assert.ok(!out.includes(marker(11)), 'older messages must not enter the six-message tail');
      assert.ok(out.length <= 3000);
    });
  });

  it('registry closure passes the shard budget: shard-mode output always fits inline', () => {
    withTmpDir(({ env }) => {
      // 650 CJK chars ≈ 500 estimated tokens per message. Six of them
      // ≈ 3,000 tokens blow the default 2,200-token shard budget, so the
      // whole-message packer must kick in.
      for (let i = 1; i <= 6; i++) receive(`${marker(i)} ${'守'.repeat(650)}`, env);

      const out = emitViaRegistry(env);

      assert.ok(
        withinBudget(out, DEFAULT_SHARD_BUDGET),
        'registry-driven emit must come back within the shard budget so composeShardOutput never truncates it',
      );
      assert.ok(out.includes(marker(6)), 'newest message must survive');
    });
  });
});
