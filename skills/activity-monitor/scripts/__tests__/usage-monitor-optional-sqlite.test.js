import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const usageUrl = new URL('../usage-monitor.js', import.meta.url).href;

function runIsolated(t, source, loader) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-optional-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.zylos'));
  fs.writeFileSync(path.join(dir, '.zylos/config.json'), JSON.stringify({
    usage_monitor_enabled: false, usage_alert_enabled: false,
  }));
  const args = ['--input-type=module'];
  if (loader) args.push('--loader', `data:text/javascript,${encodeURIComponent(loader)}`);
  args.push('--eval', source);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: dir, ZYLOS_DIR: dir, TZ: 'UTC' },
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OPTIONAL_SQLITE_OK/);
}

const missingSqlite = `
  import Module from 'node:module';
  const originalLoad = Module._load;
  let sqliteLoads = 0;
  Module._load = function(request, ...args) {
    if (request === 'better-sqlite3') {
      sqliteLoads++;
      throw Object.assign(new Error('SQLite dependency unavailable'), { code: 'MODULE_NOT_FOUND' });
    }
    return originalLoad.call(this, request, ...args);
  };
`;

test('disabled usage module loads without SQLite; Supervisor database remains independently required', t => {
  runIsolated(t, `
    import assert from 'node:assert/strict';
    ${missingSqlite}
    const { UsageMonitor } = await import(${JSON.stringify(usageUrl)});
    const usage = new UsageMonitor({runtimeId:'codex'}, {monitorEnabled:false,alertEnabled:false});
    assert.equal(usage.isMonitorEnabled(),false);
    assert.equal(usage.isAlertEnabled(),false);
    assert.equal(sqliteLoads,0);
    await assert.rejects(import(${JSON.stringify(new URL('../supervisor-main.js', import.meta.url).href)}), /SQLite dependency unavailable/);
    console.log('OPTIONAL_SQLITE_OK');
  `, `export async function resolve(specifier,context,nextResolve) {
    if(specifier==='better-sqlite3')throw new Error('SQLite dependency unavailable');
    return nextResolve(specifier,context);
  }`);
});

test('eligible usage checks never load SQLite or inspect the C4 database', t => {
  runIsolated(t, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    ${missingSqlite}
    const { UsageMonitor } = await import(${JSON.stringify(usageUrl)});
    fs.mkdirSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge'));
    fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db'), 'placeholder');
    const monitor = new UsageMonitor({ runtimeId: 'codex' }, {
      zylosDir: process.env.ZYLOS_DIR, getLocalHour: () => 12,
      activeHoursStart: 8, activeHoursEnd: 23,
    });
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      assert.notEqual(String(file), path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db'));
      return originalRead.call(this, file, ...args);
    };
    assert.equal(monitor.canRunTask(), true);
    assert.equal(monitor.canRunTask({activeHoursOnly:true}), true);
    assert.equal(sqliteLoads, 0);
    console.log('OPTIONAL_SQLITE_OK');
  `);
});
