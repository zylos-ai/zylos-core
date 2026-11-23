import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CORE_SHARDS,
  DEFAULT_SHARD_BUDGET,
  buildChain,
  loadComponentShardDeclarations,
} from '../shard-registry.js';
import {
  runSessionStartShard,
} from '../session-start-orchestrator.js';
import { writeFlag } from '../shard-sequencer.js';

const tmpDirs = [];

function makeTmpdir(prefix = 'shard-mode-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempStdout() {
  const tmpDir = makeTmpdir('shard-stdout-');
  const filePath = path.join(tmpDir, 'stdout.txt');
  const fd = fs.openSync(filePath, 'w+');
  return {
    stdout: { fd },
    read() {
      return fs.readFileSync(filePath, 'utf8');
    },
  };
}

function writeDeclaration(zylosDir, fileName, declaration) {
  const dir = path.join(zylosDir, '.zylos', 'shards.d');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(declaration, null, 2));
}

function fakeChain(entries) {
  return entries.map((entry, index) => ({
    budget: { ...DEFAULT_SHARD_BUDGET },
    chainIndex: index,
    ...entry,
  }));
}

function fakeResolver(chain) {
  return (name) => {
    if (name === 'fg' || name === 'start-prompt') {
      return { kind: 'side-effect', name, chain, warnings: [] };
    }
    const shard = chain.find(s => s.name === name);
    return shard ? { kind: 'content', shard, chain, warnings: [] } : null;
  };
}

describe('shard-registry chain', () => {
  it('builds the five core shards in the agreed order', () => {
    const { chain } = buildChain({ zylosDir: makeTmpdir() });
    assert.deepEqual(
      chain.map(s => [s.name, s.chainIndex]),
      [
        ['identity', 0],
        ['custom', 1],
        ['references', 2],
        ['c4-conversations', 3],
        ['onboarding', 4],
      ]
    );
    assert.ok(chain.every(s => s.budget.maxChars === DEFAULT_SHARD_BUDGET.maxChars));
  });

  it('rejects invalid declarations without breaking the chain', () => {
    const zylosDir = makeTmpdir();
    writeDeclaration(zylosDir, 'reserved.json', { name: 'identity', order: 10, emitter: 'skills/x/e.js' });
    writeDeclaration(zylosDir, 'low-order.json', { name: 'too-early', order: 2, emitter: 'skills/x/e.js' });
    writeDeclaration(zylosDir, 'escape.json', { name: 'escape', order: 11, emitter: '/etc/evil.js' });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'shards.d', 'garbage.json'), '{nope');

    const { declarations, warnings } = loadComponentShardDeclarations({ zylosDir });

    assert.deepEqual(declarations, []);
    assert.equal(warnings.length, 4);
    const { chain } = buildChain({ zylosDir });
    assert.equal(chain.length, CORE_SHARDS.length);
  });

});

describe('runSessionStartShard (content shards)', () => {
  const basePayload = { session_id: 'sess-1', source: 'startup' };

  it('waits for the predecessor flag before emitting', async () => {
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    const chain = fakeChain([
      { name: 'identity', emit: async () => 'A' },
      { name: 'references', emit: async () => 'B' },
    ]);
    setTimeout(() => writeFlag('sess-1', 'identity', { tmpdir }), 50);
    const startMs = Date.now();

    await runSessionStartShard('references', basePayload, {
      stdout: out.stdout,
      tmpdir,
      linkMs: 2000,
      resolveShardImpl: fakeResolver(chain),
    });

    assert.ok(Date.now() - startMs >= 40, 'must have actually waited for the predecessor');
    assert.equal(out.read(), '=== ZYLOS STARTUP CONTEXT [2/2] references ===\nB\n');
  });

  it('fails open at the ladder deadline when the predecessor crashed, and says so in the header', async () => {
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    const chain = fakeChain([
      { name: 'identity', emit: async () => 'A' },
      { name: 'references', emit: async () => 'B' },
    ]);

    await runSessionStartShard('references', basePayload, {
      stdout: out.stdout,
      tmpdir,
      linkMs: 80,
      resolveShardImpl: fakeResolver(chain),
    });

    const text = out.read();
    assert.match(text, /^=== ZYLOS STARTUP CONTEXT \[2\/2\] references \(predecessor "identity" not ready after \d+ms, continued\) ===\n/);
    assert.match(text, /\nB\n$/);
  });

  it('spills the full body and inlines a trimmed copy when over budget', async () => {
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    const chain = fakeChain([
      { name: 'identity', emit: async () => 'y'.repeat(15000) },
    ]);

    await runSessionStartShard('identity', basePayload, {
      stdout: out.stdout,
      tmpdir,
      resolveShardImpl: fakeResolver(chain),
    });

    const text = out.read();
    assert.ok(text.length <= DEFAULT_SHARD_BUDGET.maxChars);
    const spillPath = text.match(/Read the full copy first: (\S+)\]/)?.[1];
    assert.ok(spillPath, 'truncation notice must name the spill file');
    assert.equal(fs.readFileSync(spillPath, 'utf8'), 'y'.repeat(15000));
    // Spill root is per-user for the same multi-user /tmp reason as flags.
    assert.match(spillPath, new RegExp(`^${tmpdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/zylos-shard-spill-[^/]+/`));
  });

});

describe('runSessionStartShard (side effects)', () => {
  const chain = fakeChain([
    { name: 'identity', emit: async () => 'A' },
    { name: 'references', emit: async () => 'B' },
  ]);

  it('start-prompt waits for the chain tail flag before enqueueing', async () => {
    const tmpdir = makeTmpdir();
    const calls = [];
    setTimeout(() => writeFlag('sess-1', 'references', { tmpdir }), 50);
    const startMs = Date.now();

    await runSessionStartShard('start-prompt', { session_id: 'sess-1', source: 'startup' }, {
      stdout: tempStdout().stdout,
      tmpdir,
      linkMs: 2000,
      resolveShardImpl: fakeResolver(chain),
      actions: {
        foreground: async () => calls.push('foreground'),
        startupPrompt: async () => calls.push(['prompt', Date.now() - startMs]),
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'prompt');
    assert.ok(calls[0][1] >= 40, 'prompt must not fire before the chain tail flag');
  });

});

