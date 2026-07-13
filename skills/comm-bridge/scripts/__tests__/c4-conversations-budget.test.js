import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_SHARD_BUDGET, withinBudget } from '../../../activity-monitor/scripts/shard-registry.js';

const RECEIVE_PATH = fileURLToPath(new URL('../c4-receive.js', import.meta.url));
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
  const result = spawnSync('node', [RECEIVE_PATH, '--channel', 'system', '--no-reply', '--content', content], {
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

// Most packing tests keep messages under the 2,048-byte dispatch spill
// threshold so sizes stay exact on every path (the budgeted shard path emits
// originals regardless — #724 — but the legacy no-budget path still spills).
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
      assert.match(out, /showing the newest \d+ of 6 unsummarized messages/);
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
      assert.match(out, /showing the newest \d+ of 6 unsummarized messages/);
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

  it('never drops below one message — the newest stays even if it alone overflows', () => {
    withTmpDir(({ env }) => {
      // Over the 2,048-byte dispatch spill threshold so the lone-message
      // fallback has a pointer form to reach for.
      receive(`${marker(1)} ${'x'.repeat(3000)}`, env);
      receive(`${marker(2)} ${'x'.repeat(3000)}`, env);

      // Budget smaller than a single message: packing keeps the newest one,
      // which falls back to its preview + pointer form (#724) instead of
      // handing the orchestrator an over-budget body to tail-trim blindly.
      const out = emitConversations(env, { maxChars: 600, maxTokens: 200 });

      assert.ok(out.includes(marker(2)), 'the newest message is always kept');
      assert.ok(!out.includes(marker(1)));
      assert.ok(out.includes('[C4] Full message'), 'lone over-budget message must use the pointer form');
      assert.ok(!out.includes('x'.repeat(3000)), 'lone over-budget message must not be emitted in full');
    });
  });

  it('emits a sub-threshold message in full even when it alone overflows a tiny budget', () => {
    withTmpDir(({ env }) => {
      // Under the 2,048-byte spill threshold there is no pointer form to
      // fall back to; the emitter keeps the original and the orchestrator's
      // generic trim stays the last resort. Unreachable with the real shard
      // budget (a sub-threshold message can never exceed 10K chars) — this
      // pins the synthetic edge so the fallback never mangles small messages.
      receive(`${marker(1)} ${'x'.repeat(1800)}`, env);

      const out = emitConversations(env, { maxChars: 300, maxTokens: 50 });

      assert.ok(out.includes(`${marker(1)} ${'x'.repeat(1800)}`), 'sub-threshold message stays original');
      assert.ok(!out.includes('[C4] Full message'));
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
      assert.ok(!out.includes('[C4] Full message'), 'no attachment pointer when the budget fits the original');
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
      assert.ok(!out.includes('[C4] Full message'), 'kept messages must be originals, not previews');
      assert.match(out, /showing the newest \d+ of 4 unsummarized messages/);
      assert.ok(out.length <= 10000, `packed output must fit the char budget (got ${out.length})`);
    });
  });

  it('keeps the legacy no-budget path byte-identical: per-message spill still applies', () => {
    withTmpDir(({ env }) => {
      const body = `${marker(1)} ${'w'.repeat(3000)}`;
      receive(body, env);

      const out = emitConversations(env, null);

      assert.ok(out.includes('[C4] Full message'), 'legacy path must keep the preview + pointer form');
      assert.ok(!out.includes(body), 'legacy path must not emit the full over-threshold message');
      assert.ok(out.includes(marker(1)), 'preview must still lead with the message head');
    });
  });

  it('keeps the ACTION REQUIRED sync instruction while packing above the threshold', () => {
    withTmpDir(({ env }) => {
      // 17 messages > CHECKPOINT_THRESHOLD (15); session-init then considers
      // only the newest 6, and the budget squeezes those further.
      for (let i = 1; i <= 17; i++) receive(`${marker(i)} ${'x'.repeat(1200)}`, env);

      const out = emitConversations(env, { maxChars: 3000, maxTokens: 100000 });

      assert.ok(out.includes('=== ACTION REQUIRED ==='), 'sync instruction must survive packing');
      assert.ok(out.includes('There are 17 unsummarized conversations'));
      assert.ok(out.includes(marker(17)), 'newest message must survive');
      assert.match(out, /showing the newest \d+ of 17 unsummarized messages/);
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
      assert.match(out, /showing the newest \d+ of 6 unsummarized messages/);
    });
  });
});
