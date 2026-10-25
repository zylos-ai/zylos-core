import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
export function fixture(t, dependencies = {}, file = false, databaseOptions = {}) {
  const dir = file === true ? mkdtempSync(path.join(tmpdir(), 'c4-v2-')) : null;
  const filename = typeof file === 'string' ? file : dir ? path.join(dir, 'c4.db') : ':memory:';
  const db = new Database(filename, databaseOptions);
  guardDatabase(db, owner);
  if (file === true) db.pragma('journal_mode=WAL');
  const deps = { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true, ...dependencies };
  const store = createStore(db, deps);
  t.after(() => { if (db.open) db.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { db, store, filename, dependencies: deps };
}

export async function modifiedStore(moduleName, before, after) {
  const moduleURL = new URL(`../${moduleName}`, import.meta.url);
  const absoluteImports = (source, base) => source.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, base).href}'`);
  const source = readFileSync(moduleURL, 'utf8');
  assert.ok(source.includes(before), 'mutation anchor must exist');
  const mutated = absoluteImports(source.replace(before, after), moduleURL);
  const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const storeURL = new URL('../c4-v2-store.js', import.meta.url);
  const storeSource = moduleName === 'c4-v2-store.js' ? mutated
    : absoluteImports(readFileSync(storeURL, 'utf8'), storeURL).replace(moduleURL.href, uri(mutated));
  return (await import(uri(storeSource))).createStore;
}

export function startHeldWriter(filename, sql) {
  const source = `import Database from ${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))};
    const db = new Database(process.argv[1]);
    db.exec(${JSON.stringify('BEGIN IMMEDIATE; ' + sql)});
    process.send({ mode: db.pragma('locking_mode', { simple: true }), journal: db.pragma('journal_mode', { simple: true }), inTransaction: db.inTransaction });
    process.on('message', () => { db.exec('COMMIT'); db.close(); process.exit(0); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  const held = Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`writer exited before barrier: ${stderr}`); })]);
  return { child, exited, held, stderr: () => stderr };
}
