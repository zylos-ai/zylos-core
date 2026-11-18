import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeMemory } from '../skills/zylos-memory/scripts/memory-write.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { measureMemoryText, STARTUP_MEMORY_LIMIT } from '../skills/zylos-memory/scripts/memory-budget.js';
import { worstCaseShardHeader } from '../skills/activity-monitor/scripts/shard-format.js';
import { composeShardOutput, shardHeader } from '../skills/activity-monitor/scripts/session-start-orchestrator.js';
import { DEFAULT_SHARD_BUDGET, estimateTokens, withinBudget } from '../skills/activity-monitor/scripts/shard-registry.js';
import { formatSection } from '../skills/comm-bridge/scripts/session-format.js';
import { createMemoryBacklog } from '../skills/dashboard/src/lib/workbench/memory-backlog.js';
import { memoryBudgetRows } from '../skills/dashboard/public/js/wb/memory-scope.js';

const scripts = path.resolve('skills/zylos-memory/scripts');
function isolation(t, { createMemory = true } = {}) {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(path.isAbsolute(process.env[key]));
    assert.ok(!path.resolve(process.env[key]).startsWith(realHome + path.sep));
  }
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_DIR: root };
  const memory = path.join(root, 'memory');
  if (createMemory) fs.mkdirSync(memory, { recursive: true });
  t.diagnostic(JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
    PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, tmux: 'unused', database: 'unused' }));
  const cli = name => execFileSync(process.execPath, [path.join(scripts, name)], {
    env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  // shared.js captures paths at import time. Load the real emitter in a child
  // whose environment already points to this case, never the runner's instance.
  const emitMemoryPart = part => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { emitMemoryPart } from ${JSON.stringify(pathToFileURL(path.join(scripts, 'session-start-inject.js')).href)}; process.stdout.write(emitMemoryPart(${JSON.stringify(part)}));`], {
    env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  return { memory, env, cli, emitMemoryPart };
}
function composed(text, header = worstCaseShardHeader(), label = 'BOT IDENTITY') {
  return composeShardOutput({ header, body: formatSection(label, text),
    budget: DEFAULT_SHARD_BUDGET, spillPath: '/tmp/private/full-memory.txt' });
}
function lastPassing(predicate, sample) {
  let low = 0, high = 20_000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (predicate(sample.repeat(mid))) low = mid;
    else high = mid - 1;
  }
  return low;
}

// Boundary: file -> real memory emitter + startup composer, status CLI used by the Sync audit and standalone consolidation CLI.
// Run for startup framing, estimator, budget or report changes; unrelated changes may skip.
// Each case owns ZYLOS_DIR; runner owns isolated HOME/PM2_HOME/short TMPDIR; no tmux, DB or external sends.
test('startup files report ok, warning and over while writes remain allowed', t => {
  const { memory, env, cli, emitMemoryPart } = isolation(t);
  assert.throws(() => measureMemoryText('constructor', ''), /No memory budget/);
  fs.writeFileSync(path.join(memory, 'references.md'), 'navigation');
  const examples = [['a'.repeat(6000), 'ok'], ['a'.repeat(8000), 'warning'],
    ['a'.repeat(Math.floor(STARTUP_MEMORY_LIMIT.maxTokens * 0.85) * 4), 'warning'],
    ['a'.repeat(16 * 1024), 'over'], ['中'.repeat(3000), 'over']];
  for (const [text, expected] of examples) {
    fs.writeFileSync(path.join(memory, 'identity.md'), text);
    assert.equal(fs.readFileSync(path.join(memory, 'identity.md'), 'utf8'), text);
    const check = measureMemoryText('identity.md', text);
    assert.equal(check.status, expected);
    assert.match(cli('memory-status.js'), new RegExp(`identity.md:.*\\[${{ ok: 'OK', warning: 'WARN', over: 'OVER' }[expected]}\\]`));
    const report = JSON.parse(cli('consolidate.js'));
    const row = report.budgets.checks.find(row => row.file === 'identity.md');
    assert.equal(row.status, expected);
    assert.equal(report.budgets.overBudget.includes('identity.md'), expected === 'over');
    assert.equal(report.budgets.nearBudget.includes('identity.md'), expected === 'warning');
    const realOutput = execFileSync(process.execPath, [path.resolve('skills/activity-monitor/scripts/session-start-orchestrator.js'), '--shard', 'identity'], {
      input: JSON.stringify({ source: 'startup', session_id: 'budget-' + text.length }),
      env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (expected === 'over') {
      const notice = realOutput.split('\n')[1];
      assert.match(notice, /^\[shard output truncated:/);
      const spill = notice.match(/Read the full copy first: (.+)\]$/)[1];
      assert.ok(spill.startsWith(process.env.TMPDIR + path.sep));
      assert.ok(fs.readFileSync(spill, 'utf8').includes(text));
    } else assert.equal(realOutput.includes(text), true);
    const body = emitMemoryPart('identity');
    const output = composeShardOutput({ header: shardHeader({ position: 1, total: 4, name: 'identity' }), body,
      budget: DEFAULT_SHARD_BUDGET, spillPath: path.join(memory, 'full.txt') });
    assert.equal(output.truncated, expected === 'over');
    if (expected === 'over') {
      assert.match(output.output.split('\n')[1], /^\[shard output truncated:.*showing \d+ of \d+ chars.*Read the full copy first:/);
      assert.equal(output.fullBody, body);
      assert.equal(withinBudget(output.output), true);
    } else assert.equal(output.output.includes(text), true);
    assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db')), false, 'no notification database created');
  }
});

// Boundary: same real emitter/composer formatting at checking and startup edges.
// Run for startup wrapper, budget or estimator changes; otherwise may skip. No resources opened.
test('conservative checking and actual startup boundaries preserve every passing candidate', t => {
  const { memory, emitMemoryPart } = isolation(t);
  for (const sample of ['a', '中', 'a中']) {
    const checkEdge = lastPassing(text => measureMemoryText('identity.md', text).status !== 'over', sample);
    const startupEdge = lastPassing(text => !composed(text).truncated, sample);
    assert.ok(startupEdge >= checkEdge);
    assert.ok(estimateTokens(sample.repeat(startupEdge)) - STARTUP_MEMORY_LIMIT.maxTokens <= 1);
    for (const delta of [-1, 0, 1]) {
      const candidate = sample.repeat(checkEdge + delta);
      assert.equal(measureMemoryText('identity.md', candidate).status === 'over', delta === 1);
      for (const part of ['identity', 'references']) {
        fs.writeFileSync(path.join(memory, part + '.md'), candidate);
        const body = emitMemoryPart(part);
        for (const header of [worstCaseShardHeader(), shardHeader({ position: 1, total: 4, name: part })]) {
          const result = composeShardOutput({ header, body, budget: DEFAULT_SHARD_BUDGET, spillPath: '/tmp/private/full.txt' });
          if (delta <= 0) assert.equal(result.truncated, false);
        }
      }
      assert.equal(composed(sample.repeat(startupEdge + delta)).truncated, delta === 1);
    }
    t.diagnostic(JSON.stringify({ sample, checkEdge, startupEdge, gapChars: (startupEdge - checkEdge) * sample.length }));
  }
  const output = composeShardOutput({ header: 'header', body: '中'.repeat(8000), budget: { maxChars: 500, maxTokens: 100 }, spillPath: '/tmp/private/custom.txt' });
  assert.equal(output.truncated, true, 'generic truncation also applies to component shards');
  assert.equal(withinBudget(output.output, { maxChars: 500, maxTokens: 100 }), true);
});

// Boundary: an external working directory imports the documented API with candidate text only.
// Run when the public module contract changes; otherwise may skip. Child is bounded and uses private env.
test('external components can measure candidate text without an on-disk memory file', t => {
  const { env } = isolation(t, { createMemory: false });
  const root = env.ZYLOS_DIR;
  const code = `import {measureMemoryText} from ${JSON.stringify(pathToFileURL(path.join(scripts, 'memory-budget.js')).href)}; console.log(JSON.stringify(measureMemoryText('references.md', '中'.repeat(3000))));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, env, encoding: 'utf8', timeout: 5000,
  });
  assert.deepEqual(JSON.parse(output), measureMemoryText('references.md', '中'.repeat(3000)));
  assert.equal(fs.existsSync(path.join(root, 'memory')), false);
});

// Boundary: Dashboard's real backlog measurement -> browser row model; INDEX byte budgets unchanged.
// Run for budget payload or memory presentation changes; otherwise may skip. No HTTP, DB or runtime starts.
test('Dashboard measures both startup dimensions and preserves reference INDEX byte limits', async t => {
  const { memory, env } = isolation(t);
  fs.writeFileSync(path.join(memory, 'identity.md'), '中'.repeat(3000));
  fs.writeFileSync(path.join(memory, 'references.md'), 'a'.repeat(6000));
  const get = createMemoryBacklog({ zylosDir: env.ZYLOS_DIR, readConfig: async () => ({}), env: {},
    getSnapshot: async () => ({ rows: [], hasOlder: false }), groupBacklog: async () => ({}) });
  const { budgets } = await get();
  assert.equal(budgets.checks['identity.md'].status, 'over');
  assert.equal(budgets.checks['references.md'].status, 'ok');
  assert.equal(budgets.limits['reference/projects/INDEX.md'], 32768);
  assert.equal(budgets.warnings['reference/projects/INDEX.md'], 16384);
  const rows = memoryBudgetRows({ root: { children: ['identity.md', 'references.md', 'state.md'].map(file => ({ path: file, type: 'file', size_bytes: fs.existsSync(path.join(memory, file)) ? fs.statSync(path.join(memory, file)).size : 123 })) } }, budgets);
  assert.ok(rows[0].over > 0); assert.equal(rows[1].warned, false);
  assert.equal(rows[2].limit, null);
});

// Boundary: real Core lock/hash/atomic publication accepts an over-limit startup file.
// Run when budget reporting or memory-write admission changes; unrelated changes may skip.
// Private runner paths only; process observation returns no active run, so no tmux/PM2/DB is used.
test('Core atomic writes accept an over-limit startup file', async t => {
  const { memory, env } = isolation(t);
  const target = path.join(memory, 'identity.md');
  fs.writeFileSync(target, 'old identity');
  const text = 'a'.repeat(16384);
  assert.equal(measureMemoryText('identity.md', text).status, 'over');
  await writeMemory({ path: 'identity.md', sha256: createHash('sha256').update('old identity').digest('hex'),
    content: text, env }, { currentRunId: async () => null });
  assert.equal(fs.readFileSync(target, 'utf8'), text);
});
