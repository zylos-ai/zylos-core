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
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
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
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
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
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-conv-budget-'));
  const env = { HOME: path.join(tmpDir, 'home'), ZYLOS_DIR: tmpDir,
    PM2_HOME: path.join(tmpDir, 'pm2'), TMPDIR: path.join(tmpDir, 'tmp') };
  for (const key of ['HOME', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key]);
  assert.ok(tmpDir.startsWith(process.env.TMPDIR));
  assert.notEqual(env.ZYLOS_DIR, process.env.ZYLOS_DIR);
  // Keep the mandatory status instructions short so these cases isolate
  // conversation-tail packing, including their deliberately small budgets.
  fs.mkdirSync(path.join(tmpDir, '.zylos'));
  fs.writeFileSync(path.join(tmpDir, '.zylos/config.json'), JSON.stringify({ alert_target: 'telegram:1' }));
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Session startup preserves full messages, independently of dispatch spill.
const marker = i => `UNIQ_MARK_${i}`;

describe('emitC4Conversations budget packing (message-boundary, newest-first)', () => {
  it('drops the oldest whole messages after the handoff when the char budget overflows', () => {
    withTmpDir(({ tmpDir, env }) => {
      const handoff = path.join(tmpDir, 'memory/handoff.md');
      fs.mkdirSync(path.dirname(handoff), { recursive: true });
      fs.writeFileSync(handoff, 'previous work');
      fs.utimesSync(handoff, 0, 0);
      for (let i = 1; i <= 6; i++) receive(`${marker(i)} ${'x'.repeat(1800)}`, env);

      // ~11K chars total against a 5K char budget (room for two whole
      // messages, not three); token limit kept out of the way so the char
      // dimension drives the packing.
      const out = emitConversations(env, { maxChars: 5000, maxTokens: 100000 });

      assert.ok(out.includes(marker(6)), 'newest message must survive');
      assert.ok(!out.includes(marker(1)), 'oldest message must be dropped whole');
      assert.doesNotMatch(out, /unsummarized|omitted middle/i);
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
