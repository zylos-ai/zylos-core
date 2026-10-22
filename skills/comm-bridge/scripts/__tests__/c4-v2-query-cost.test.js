import Database from 'better-sqlite3';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';

test('query work remains bounded when terminal history doubles; unfiltered negative control grows', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-query-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = path.join(dir, 'vmstats.' + (process.platform === 'darwin' ? 'dylib' : 'so'));
  const require = createRequire(import.meta.url);
  const include = path.join(path.dirname(require.resolve('better-sqlite3/package.json')), 'deps/sqlite3');
  try {
    execFileSync('cc', [
      ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
      '-I', include, '-o', library, new URL('./helpers/sqlite-vm-stats.c', import.meta.url).pathname,
    ], { stdio: 'pipe' });
  } catch (error) {
    t.skip('ENV: C compiler/SQLite extension headers unavailable: ' + error.message);
    return;
  }
  const db = new Database(':memory:');
  t.after(() => db.close());
  guardDatabase(db, owner);
  db.loadExtension(library);

  // Read the real driver's VM counter while each statement is still retained.
  // No second SQLite build, planner inference, wall-clock threshold or SQL rewrite.
  const stats = db.prepare('SELECT test_vm_steps(?) AS n');
  let trace = [];
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return sql => {
        const stmt = target.prepare(sql);
        return new Proxy(stmt, {
          get(statement, method) {
            if (['get', 'all', 'run'].includes(method)) return (...args) => {
              const result = statement[method](...args);
              trace.push({ sql, steps: stats.get(sql).n });
              return result;
            };
            const value = statement[method];
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createStore(proxy);
  const seed = db.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,'in','test','x',?,?)");
  const controls = db.prepare("INSERT INTO control_queue(raw_content,content,status,session_group,created_at,updated_at) VALUES('x','x',?,?,1,1)");
  function history(start, end, groups) {
    db.transaction(() => {
      for (let id = start; id <= end; id++) {
        seed.run(id, 'delivered', 'old' + id % groups);
        controls.run('done', 'old' + id % groups);
      }
    })();
  }
  history(1, 100000, 500);
  db.transaction(() => {
    for (let id = 1; id <= 20; id++) {
      seed.run(1000000 + id, id <= 10 ? 'pending' : 'delivered', id <= 10 ? 'pending' : 'active');
    }
    for (const group of [null, 'active', 'other']) {
      for (const status of ['pending', 'running']) controls.run(status, group);
    }
  })();
  db.prepare("INSERT INTO checkpoints(summary,end_conversation_id,session_group) VALUES('baseline',100000,'*')").run();
  function measure() {
    const out = {};
    const operations = {
      machine: () => store.countNonTerminalControls({ machine: true }),
      group: () => store.countNonTerminalControls({ sessionGroup: 'active' }),
      all: () => store.countNonTerminalControls({ allSessionGroups: true }),
      pending: () => store.listPendingSessionGroups(),
      tail: () => store.getGlobalDeliveredSince(100000, { limit: 5 }),
      range: () => store.getUnsummarizedRange('active'),
    };
    for (const [name, operation] of Object.entries(operations)) {
      trace = [];
      const result = operation();
      out[name] = { steps: trace.reduce((n, item) => n + item.steps, 0), result };
    }
    trace = [];
    proxy.prepare('SELECT session_group,count(*) FROM conversations GROUP BY session_group').all();
    out.negative = { steps: trace[0].steps };
    return out;
  }
  const first = measure();
  history(100001, 200000, 1000);
  const second = measure();
  for (const name of ['machine', 'group', 'all', 'pending', 'tail', 'range']) {
    assert.equal(second[name].steps, first[name].steps, name);
    assert.deepEqual(second[name].result, first[name].result, name);
  }
  assert.ok(second.negative.steps > first.negative.steps * 1.8);
  assert.deepEqual(first.tail.result.map(row => row.id), [1000016, 1000017, 1000018, 1000019, 1000020]);
  assert.equal(first.range.result.count, 10);
  for (const name of Object.keys(first)) {
    t.diagnostic(`${name}: ${first[name].steps} → ${second[name].steps} VM steps`);
  }
});
