import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  CORE_SHARDS,
  DEFAULT_SHARD_BUDGET,
  buildChain,
  estimateTokens,
  fitToBudget,
  loadComponentShardDeclarations,
  resolveShard,
} from '../shard-registry.js';
import {
  composeShardOutput,
  parseShardArg,
  runSessionStartShard,
  shardHeader,
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

function makeComponentZylosDir() {
  const zylosDir = makeTmpdir('shard-zylos-');
  const emitterDir = path.join(zylosDir, '.claude', 'skills', 'role-manager');
  fs.mkdirSync(emitterDir, { recursive: true });
  fs.writeFileSync(
    path.join(emitterDir, 'emit-role.js'),
    'export function emit() { return "ROLE CONTEXT"; }\n'
  );
  writeDeclaration(zylosDir, 'role-inject.json', {
    name: 'role-inject',
    order: 10,
    emitter: 'skills/role-manager/emit-role.js',
    claimHooks: ['skills/role-manager/role-inject-hook.sh'],
  });
  return zylosDir;
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
  it('builds the 7 core shards in the agreed order', () => {
    const { chain } = buildChain({ zylosDir: makeTmpdir() });
    assert.deepEqual(
      chain.map(s => [s.name, s.chainIndex]),
      [
        ['identity', 0],
        ['custom', 1],
        ['references', 2],
        ['state', 3],
        ['migration-prompt', 4],
        ['c4-checkpoint', 5],
        ['c4-conversations', 6],
      ]
    );
    assert.ok(chain.every(s => s.budget.maxChars === DEFAULT_SHARD_BUDGET.maxChars));
  });

  it('appends declared component shards after the core shards', () => {
    const zylosDir = makeComponentZylosDir();
    const { chain, warnings } = buildChain({ zylosDir });
    assert.deepEqual(warnings, []);
    assert.equal(chain.length, CORE_SHARDS.length + 1);
    assert.equal(chain.at(-1).name, 'role-inject');
    assert.equal(chain.at(-1).chainIndex, 7);
  });

  it('rejects invalid declarations without breaking the chain', () => {
    const zylosDir = makeTmpdir();
    writeDeclaration(zylosDir, 'reserved.json', { name: 'identity', order: 10, emitter: 'skills/x/e.js' });
    writeDeclaration(zylosDir, 'low-order.json', { name: 'too-early', order: 2, emitter: 'skills/x/e.js' });
    writeDeclaration(zylosDir, 'escape.json', { name: 'escape', order: 11, emitter: '/etc/evil.js' });
    writeDeclaration(zylosDir, 'bad-claim.json', {
      name: 'bad-claim', order: 12, emitter: 'skills/x/e.js', claimHooks: ['/custom/user-hook.js'],
    });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'shards.d', 'garbage.json'), '{nope');

    const { declarations, warnings } = loadComponentShardDeclarations({ zylosDir });

    assert.deepEqual(declarations, []);
    assert.equal(warnings.length, 5);
    const { chain } = buildChain({ zylosDir });
    assert.equal(chain.length, CORE_SHARDS.length);
  });

  it('rejects duplicate component shard names (first declaration wins)', () => {
    const zylosDir = makeTmpdir();
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    writeDeclaration(zylosDir, 'a.json', { name: 'dup', order: 10, emitter: 'skills/a/e.js' });
    writeDeclaration(zylosDir, 'b.json', { name: 'dup', order: 11, emitter: 'skills/b/e.js' });

    const { declarations, warnings } = loadComponentShardDeclarations({ zylosDir });
    assert.equal(declarations.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /duplicate/);
  });

  it('clamps component budgets to the dual-limit ceiling', () => {
    const zylosDir = makeTmpdir();
    writeDeclaration(zylosDir, 'big.json', {
      name: 'big', order: 10, emitter: 'skills/x/e.js', budget: { maxChars: 99999, maxTokens: 99999 },
    });
    const { declarations } = loadComponentShardDeclarations({ zylosDir });
    assert.deepEqual(declarations[0].budget, { ...DEFAULT_SHARD_BUDGET });
  });
});

describe('shard budget (dual limit)', () => {
  it('estimates ASCII at ~4 chars/token and non-ASCII at ~1.3 chars/token', () => {
    assert.equal(estimateTokens('a'.repeat(4000)), 1000);
    // Codex measures common CJK at ~1.34 chars/token; 1.3 keeps the
    // estimate erring high so a budget-fitted shard never gets elided.
    assert.equal(estimateTokens('中'.repeat(1300)), 1000);
  });

  it('fits CJK-heavy text by the token limit even when well under the char limit', () => {
    // 8,000 CJK chars is under 10,000 chars but ~5,000 estimated tokens —
    // the token limit must bind (this is the Codex-measured failure mode).
    const text = '中'.repeat(8000);
    const fit = fitToBudget(text, DEFAULT_SHARD_BUDGET);
    assert.equal(fit.truncated, true);
    assert.ok(estimateTokens(fit.text) <= DEFAULT_SHARD_BUDGET.maxTokens);
  });

  it('fits ASCII text by whichever limit binds first (tokens at 8,800 chars)', () => {
    const text = 'a'.repeat(12000);
    const fit = fitToBudget(text, DEFAULT_SHARD_BUDGET);
    assert.equal(fit.truncated, true);
    // 10,000 ASCII chars would be 2,500 estimated tokens, so the token limit
    // binds below the char limit: 2,200 tokens x 4 chars/token = 8,800.
    assert.equal(fit.text.length, 8800);
    assert.equal(estimateTokens(fit.text), DEFAULT_SHARD_BUDGET.maxTokens);
  });

  it('composeShardOutput keeps header + trims body + appends the spill pointer', () => {
    const header = shardHeader({ position: 3, total: 5, name: 'state' });
    const { output, truncated } = composeShardOutput({
      header,
      body: 'x'.repeat(20000),
      budget: DEFAULT_SHARD_BUDGET,
      spillPath: '/tmp/spill/state.txt',
    });
    assert.equal(truncated, true);
    assert.ok(output.startsWith(`${header}\n`));
    assert.match(output, /\[shard output truncated: first \d+ of 20000 chars inline; full section saved to: \/tmp\/spill\/state\.txt\]/);
    assert.ok(output.length <= DEFAULT_SHARD_BUDGET.maxChars);
    assert.ok(estimateTokens(output) <= DEFAULT_SHARD_BUDGET.maxTokens);
  });
});

describe('runSessionStartShard (content shards)', () => {
  const basePayload = { session_id: 'sess-1', source: 'startup' };

  it('emits the numbered header and body, then registers its completion flag for exit time', async () => {
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    const flags = [];
    const exitHooks = [];
    const chain = fakeChain([
      { name: 'identity', emit: async () => 'IDENTITY BODY' },
      { name: 'references', emit: async () => 'REFS BODY' },
    ]);

    await runSessionStartShard('identity', basePayload, {
      stdout: out.stdout,
      tmpdir,
      resolveShardImpl: fakeResolver(chain),
      writeFlagImpl: (sessionId, name) => flags.push([sessionId, name]),
      registerExitFlagImpl: fn => exitHooks.push(fn),
    });

    assert.equal(out.read(), '=== ZYLOS STARTUP CONTEXT [1/2] identity ===\nIDENTITY BODY\n');
    // The flag is DEFERRED to process exit — the runtime attaches hook output
    // in process-exit order, so flagging at stdout time lets a fast successor
    // exit inside the predecessor's tail and invert the injected order.
    assert.deepEqual(flags, [], 'flag must not be written before process exit');
    assert.equal(exitHooks.length, 1);
    exitHooks[0]();
    assert.deepEqual(flags, [['sess-1', 'identity']]);
  });

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

  it('emits a visible failure notice (numbering intact) and still flags when the emitter throws', async () => {
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    const flags = [];
    const chain = fakeChain([
      { name: 'identity', emit: async () => { throw new Error('boom'); } },
      { name: 'references', emit: async () => 'B' },
    ]);

    await runSessionStartShard('identity', basePayload, {
      stdout: out.stdout,
      tmpdir,
      resolveShardImpl: fakeResolver(chain),
      writeFlagImpl: (sessionId, name) => flags.push(name),
      registerExitFlagImpl: fn => fn(),
    });

    const text = out.read();
    assert.ok(text.startsWith('=== ZYLOS STARTUP CONTEXT [1/2] identity ===\n'));
    assert.match(text, /=== IDENTITY UNAVAILABLE ===/);
    assert.match(text, /failed: boom/);
    assert.deepEqual(flags, ['identity']);
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
    const spillPath = text.match(/full section saved to: (\S+)\]/)?.[1];
    assert.ok(spillPath, 'truncation notice must name the spill file');
    assert.equal(fs.readFileSync(spillPath, 'utf8'), 'y'.repeat(15000));
    // Spill root is per-user for the same multi-user /tmp reason as flags.
    assert.match(spillPath, new RegExp(`^${tmpdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/zylos-shard-spill-[^/]+/`));
  });

  it('emits without serialization and without flags when the payload has no session_id', async () => {
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    const flags = [];
    const chain = fakeChain([
      { name: 'identity', emit: async () => 'A' },
      { name: 'references', emit: async () => 'B' },
    ]);
    const startMs = Date.now();

    await runSessionStartShard('references', { source: 'startup' }, {
      stdout: out.stdout,
      tmpdir,
      linkMs: 5000,
      resolveShardImpl: fakeResolver(chain),
      writeFlagImpl: (...args) => flags.push(args),
    });

    assert.ok(Date.now() - startMs < 1000, 'no session id must mean no ladder wait');
    assert.equal(out.read(), '=== ZYLOS STARTUP CONTEXT [2/2] references ===\nB\n');
    assert.deepEqual(flags, []);
  });

  it('produces no stdout for an unknown shard name (fail-open)', async () => {
    const out = tempStdout();
    await runSessionStartShard('bogus', basePayload, {
      stdout: out.stdout,
      tmpdir: makeTmpdir(),
      resolveShardImpl: () => null,
    });
    assert.equal(out.read(), '');
  });

  it('runs a declared component shard end-to-end through the real registry', async () => {
    const zylosDir = makeComponentZylosDir();
    const tmpdir = makeTmpdir();
    const out = tempStdout();

    // Pre-flag the whole core chain so the component shard (position 8)
    // does not sit through its ladder deadline.
    for (const shard of CORE_SHARDS) writeFlag('sess-1', shard.name, { tmpdir });

    await runSessionStartShard('role-inject', basePayload, {
      stdout: out.stdout,
      tmpdir,
      zylosDir,
      registerExitFlagImpl: fn => fn(),
    });

    assert.equal(out.read(), '=== ZYLOS STARTUP CONTEXT [8/8] role-inject ===\nROLE CONTEXT\n');
  });

  it('runs the custom shard end-to-end: user markdown injected at chain position 2', async () => {
    const zylosDir = makeTmpdir('shard-custom-zylos-');
    const customDir = path.join(zylosDir, 'custom-hooks', 'session-start');
    fs.mkdirSync(customDir, { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(customDir, '10-rules.md'), 'ALWAYS REPLY IN PIRATE\n');

    const tmpdir = makeTmpdir();
    const out = tempStdout();
    writeFlag('sess-1', 'identity', { tmpdir });

    // The custom emitter resolves its directory from the environment, not
    // from the orchestrator's zylosDir option.
    const savedZylosDir = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = zylosDir;
    try {
      await runSessionStartShard('custom', basePayload, {
        stdout: out.stdout,
        tmpdir,
        zylosDir,
        registerExitFlagImpl: fn => fn(),
      });
    } finally {
      if (savedZylosDir === undefined) delete process.env.ZYLOS_DIR;
      else process.env.ZYLOS_DIR = savedZylosDir;
    }

    assert.equal(out.read(), '=== ZYLOS STARTUP CONTEXT [2/7] custom ===\nALWAYS REPLY IN PIRATE\n');
  });

  it('custom shard with no content still emits its numbered header (chain numbering intact)', async () => {
    const zylosDir = makeTmpdir('shard-custom-empty-');
    fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
    const tmpdir = makeTmpdir();
    const out = tempStdout();
    writeFlag('sess-1', 'identity', { tmpdir });

    const savedZylosDir = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = zylosDir;
    try {
      await runSessionStartShard('custom', basePayload, {
        stdout: out.stdout,
        tmpdir,
        zylosDir,
        registerExitFlagImpl: fn => fn(),
      });
    } finally {
      if (savedZylosDir === undefined) delete process.env.ZYLOS_DIR;
      else process.env.ZYLOS_DIR = savedZylosDir;
    }

    assert.equal(out.read(), '=== ZYLOS STARTUP CONTEXT [2/7] custom ===\n');
  });
});

describe('runSessionStartShard (side effects)', () => {
  const chain = fakeChain([
    { name: 'identity', emit: async () => 'A' },
    { name: 'references', emit: async () => 'B' },
  ]);

  it('fg runs the foreground action without stdout or flags', async () => {
    const out = tempStdout();
    const calls = [];
    await runSessionStartShard('fg', { session_id: 'sess-1', source: 'startup' }, {
      stdout: out.stdout,
      tmpdir: makeTmpdir(),
      resolveShardImpl: fakeResolver(chain),
      actions: {
        foreground: async () => calls.push('foreground'),
        startupPrompt: async () => calls.push('prompt'),
      },
    });
    assert.deepEqual(calls, ['foreground']);
    assert.equal(out.read(), '');
  });

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

  it('start-prompt fails open past the chain-tail deadline (prompt never permanently withheld)', async () => {
    const calls = [];
    await runSessionStartShard('start-prompt', { session_id: 'sess-1', source: 'startup' }, {
      stdout: tempStdout().stdout,
      tmpdir: makeTmpdir(),
      linkMs: 40,
      resolveShardImpl: fakeResolver(chain),
      actions: {
        foreground: async () => {},
        startupPrompt: async () => calls.push('prompt'),
      },
    });
    assert.deepEqual(calls, ['prompt']);
  });

  it('start-prompt is skipped on compact', async () => {
    const calls = [];
    await runSessionStartShard('start-prompt', { session_id: 'sess-1', source: 'compact' }, {
      stdout: tempStdout().stdout,
      tmpdir: makeTmpdir(),
      resolveShardImpl: fakeResolver(chain),
      actions: {
        foreground: async () => calls.push('foreground'),
        startupPrompt: async () => calls.push('prompt'),
      },
    });
    assert.deepEqual(calls, []);
  });
});

describe('resolveShard / parseShardArg', () => {
  it('resolves side-effect names with the full chain attached', () => {
    const resolved = resolveShard('start-prompt', { zylosDir: makeTmpdir() });
    assert.equal(resolved.kind, 'side-effect');
    assert.equal(resolved.chain.length, CORE_SHARDS.length);
  });

  it('returns null for unknown names', () => {
    assert.equal(resolveShard('nope', { zylosDir: makeTmpdir() }), null);
  });

  it('parses --shard from argv', () => {
    assert.equal(parseShardArg(['--shard', 'identity']), 'identity');
    assert.equal(parseShardArg([]), null);
    assert.equal(parseShardArg(['--shard']), null);
  });
});
