import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const Database = createRequire(new URL('../../../comm-bridge/package.json', import.meta.url))('better-sqlite3');
import { enqueueMachineControl } from '../machine-control.js';
import { SupervisorMachineTasks } from '../supervisor-machine-tasks.js';
import { UsageMonitor } from '../usage-monitor.js';
const cli = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-control.js', import.meta.url));
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function fixture(t, mode, mutation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-producers-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true }); fs.mkdirSync(path.join(root, 'activity-monitor'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ session_mode: mode, runtime: 'claude' }));
  const calls = [];
  const run = args => {
    let changed = [...args];
    if (mutation === 'drop-origin') { const i = changed.indexOf('--group'); if (i >= 0) changed.splice(i, 2); }
    if (mutation === 'ack-without-deadline') changed = changed.filter(arg => arg !== '--no-ack-suffix');
    calls.push(changed);
    const result = spawnSync(process.execPath, [cli, ...changed], { env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8' });
    return { ok: result.status === 0, output: result.stdout || result.stderr };
  };
  const enqueue = (args, options = {}) => enqueueMachineControl(args, { ...options, readMode: () => ({ mode }), run });
  return { root, mode, run, enqueue, calls };
}
async function upgradeCheck(t, f) {
  const key = `notices_${randomUUID()}`; globalThis[key] = f; t.after(() => { delete globalThis[key]; });
  const ref = `globalThis[${JSON.stringify(key)}]`;
  const processModule = data(`export const execFileSync=(command,args)=>{
    if(command==='zylos')return '1.0.0';
    if(command==='git')return 'abcdef refs/tags/v1.0.1';
    if(command==='node') {const result=${ref}.run(args.slice(1));if(!result.ok)throw Object.assign(new Error(result.output),{stdout:result.output});return result.output;}
    throw new Error('Unexpected external process '+command);
  };`);
  const machineModule = data(`export const enqueueMachineControl=(args,options)=>${ref}.enqueue(args,options);`);
  const file = new URL('../upgrade-check.js', import.meta.url);
  let source = fs.readFileSync(file, 'utf8').replace("from 'child_process'", `from '${processModule}'`)
    .replace("from './machine-control.js'", `from '${machineModule}'`)
    .replace("process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos')", JSON.stringify(f.root))
    .replaceAll('import.meta.dirname', JSON.stringify(path.dirname(fileURLToPath(file))))
    .replace(/from '(\.[^']+)'/g, (_, relative) => `from '${new URL(relative, file).href}'`);
  const module = await import(data(source)); await module.main();
}
async function produce(t, mode, mutation) {
  const f = fixture(t, mode, mutation); const now = new Date(2026, 9, 25, 5).getTime();
  const tasks = new SupervisorMachineTasks({ zylosDir: f.root, now: () => now, readMode: () => ({ mode }),
    readConfig: () => ({ daily_upgrade_enabled: true, health_check_enabled: true, usage_monitor_enabled: false, usage_alert_enabled: false }),
    readOriginState: () => ({ runtime: 'claude', present: true, ready: true, state: 'idle' }), readHealth: () => ({ health: 'ok' }), enqueue: f.enqueue,
    execute: () => { throw new Error('No maintenance child expected'); } });
  await tasks.tick(); await tasks.stop();
  await upgradeCheck(t, f);
  const usage = new UsageMonitor({ runtimeId: 'codex' }, { zylosDir: f.root, usageAlertStateFile: path.join(f.root, 'alert.json'),
    readMode: () => ({ mode }), alertEnabled: true, warnThreshold: 80, highThreshold: 90, criticalThreshold: 95, notifyCooldownSec: 14400,
    readAccountUsage: async () => ({ sevenDay: { usedPercentage: 96 } }), runC4Control: f.run, log: () => {} });
  await usage.runAlert({ currentTime: Math.floor(now / 1000) });
  assert.equal(f.calls.length, 4, 'health, daily upgrade, upgrade check and usage each submit once');
  const db = new Database(path.join(f.root, 'comm-bridge/c4.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM control_queue ORDER BY id').all(); assert.equal(rows.length, 4);
    for (const row of rows) { assert.equal(row.session_group, mode === 'multi' ? 'origin' : null); assert.equal(row.content, row.raw_content); assert.doesNotMatch(row.content, / ---- ack via:/); assert.equal(row.ack_deadline_at, null);  }
    assert.deepEqual(rows.map(row => row.priority), [3, 3, 3, 1]);
    assert.match(rows[0].content, /Daily upgrade/); assert.match(rows[1].content, /System health check/);
    assert.match(rows[2].content, /Component upgrades available/); assert.match(rows[3].content, /Usage Critical/);
  } finally { db.close(); }
  for (const args of f.calls) assert.equal(args.includes('--no-ack-suffix'), true);
}
test('IF-17 actual machine notice producers commit Origin/NULL D3 with preserved options', async t => {
  for (const mode of ['multi', 'single']) await produce(t, mode);
});
test('IF-17 bad Origin removal and ack-without-deadline producers are rejected by the same assertions', async t => {
  await assert.rejects(produce(t, 'multi', 'drop-origin'), { code: 'ERR_ASSERTION' });
  await assert.rejects(produce(t, 'multi', 'ack-without-deadline'), { code: 'ERR_ASSERTION' });
});
