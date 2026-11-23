import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { measureMemoryText, STARTUP_MEMORY_LIMIT } from '../skills/zylos-memory/scripts/memory-budget.js';
import { composeShardOutput, shardHeader } from '../skills/activity-monitor/scripts/session-start-orchestrator.js';
import { DEFAULT_SHARD_BUDGET, withinBudget } from '../skills/activity-monitor/scripts/shard-registry.js';

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
