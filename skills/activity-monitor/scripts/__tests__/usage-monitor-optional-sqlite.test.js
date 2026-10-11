import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const usageUrl = new URL('../usage-monitor.js', import.meta.url).href;
const entryUrl = new URL('../activity-monitor.js', import.meta.url).href;

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

test('disabled usage allows the real monitor entry to load without SQLite', t => {
  // Stop at the orchestration boundary, before starting guardians, timers,
  // sockets or subprocesses; all real entrypoint imports still evaluate.
  const loader = `
    export async function load(url, context, nextLoad) {
      if (url.endsWith('/monitor-orchestrator.js')) return {
        format: 'module', shortCircuit: true,
        source: ${JSON.stringify(`
          import assert from 'node:assert/strict';
          export class MonitorOrchestrator {
            constructor(deps) { this.deps = deps; }
            start() {
              const usage = this.deps.createUsageMonitor({ runtimeId: 'codex' });
              assert.equal(usage.isMonitorEnabled(), false);
              assert.equal(usage.isAlertEnabled(), false);
              globalThis.entryLoadedWithoutServices = true;
              throw new Error('TEST_STOP_BEFORE_SERVICES');
            }
          }
        `)}
      };
      return nextLoad(url, context);
    }
  `;
  runIsolated(t, `
    import assert from 'node:assert/strict';
    ${missingSqlite}
    process.exit = () => { throw new Error('TEST_ENTRY_STOP'); };
    await assert.rejects(import(${JSON.stringify(entryUrl)}), /TEST_ENTRY_STOP/);
    assert.equal(globalThis.entryLoadedWithoutServices, true);
    assert.equal(sqliteLoads, 0);
    console.log('OPTIONAL_SQLITE_OK');
  `, loader);
});

test('missing SQLite skips an eligible usage check without throwing', t => {
  runIsolated(t, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    ${missingSqlite}
    const { UsageMonitor } = await import(${JSON.stringify(usageUrl)});
    fs.mkdirSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge'));
    fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db'), 'placeholder');
    const logs = [];
    const monitor = new UsageMonitor({ runtimeId: 'codex' }, {
      zylosDir: process.env.ZYLOS_DIR, getLocalHour: () => 12,
      checkIntervalSec: 1, idleGateSec: 1, log: message => logs.push(message),
    });
    assert.equal(monitor.canRunTask({ claudeState: 'idle', idleSeconds: 100, currentTime: 1000 }), false);
    assert.equal(sqliteLoads, 1);
    assert.ok(logs.some(message => message.includes('SQLite dependency unavailable')));
    console.log('OPTIONAL_SQLITE_OK');
  `);
});

test('database read failure skips the usage check and closes the handle', t => {
  runIsolated(t, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import Module from 'node:module';
    const originalLoad = Module._load;
    let closed = false;
    Module._load = function(request, ...args) {
      if (request === 'better-sqlite3') return class {
        pragma() { throw new Error('database read failed'); }
        prepare() { throw new Error('database read failed'); }
        close() { closed = true; }
      };
      return originalLoad.call(this, request, ...args);
    };
    const { UsageMonitor } = await import(${JSON.stringify(usageUrl)});
    fs.mkdirSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge'));
    fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'comm-bridge/c4.db'), 'placeholder');
    const logs = [];
    const monitor = new UsageMonitor({ runtimeId: 'codex' }, {
      zylosDir: process.env.ZYLOS_DIR, log: message => logs.push(message),
    });
    assert.equal(monitor.getPendingWorkCount(), Infinity);
    assert.equal(closed, true);
    assert.ok(logs.some(message => message.includes('database read failed')));
    console.log('OPTIONAL_SQLITE_OK');
  `);
});
