import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
import { createStore } from '../c4-v2-store.js';
const scripts = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, config, suffix = '') {
  const parent = mkdtempSync(join(tmpdir(), 'c4-cutover-'));
  const root = join(parent, 'instance' + suffix);
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(join(root, 'comm-bridge')); mkdirSync(join(root, '.claude/skills/chat'), { recursive: true });
  mkdirSync(join(root, '.zylos'));
  if (config !== undefined) writeFileSync(join(root, '.zylos/config.json'), JSON.stringify(config));
  const database = new Database(join(root, 'comm-bridge/c4.db'));
  guardDatabase(database, schema); database.pragma('journal_mode=WAL');
  t.after(() => database.close());
  const store = createStore(database, { validateComponent: () => true });
  const env = { HOME: root, ZYLOS_DIR: root, PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  function cli(file, args, expected = 0) {
    const result = spawnSync(process.execPath, [join(scripts, file), ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, expected, `${file} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
    return result;
  }
  function data(file, args) { return JSON.parse(cli(file, [...args, '--json']).stdout).data; }
  return { database, store, cli, data, root };
}
test('scoped history and checkpoint queries use actual rows and fixed boundaries', t => {
  const { store, data, cli }=fixture(t);
  const a=store.insertConversation('in','chat','e','a',{groupName:'A'});
  store.claimConversation(a.id); store.markDelivered(a.id);
  store.createCheckpoint('chat:A',a.id,'A summary');
  const b=store.insertConversation('out','chat','e','b',{groupName:'A'});
  const c=store.insertConversation('out','chat','e','c',{groupName:'A'});
  store.insertConversation('in','chat','e','pending',{groupName:'A'});
  const other=store.insertConversation('in','chat','e','other',{groupName:'B'});
  store.claimConversation(other.id); store.markDelivered(other.id);
  const result=data('c4-fetch.js',['--unsummarized','--group','chat:A','--limit','1']);
  assert.deepEqual(result.rows.map(r=>r.id),[b.id]); assert.equal(result.upTo,b.id); assert.equal(result.safeEnd,c.id);
  assert.match(cli('c4-fetch.js',['--unsummarized','--group','chat:A','--limit','1']).stdout,new RegExp(`checkpointEnd=${a.id}.*\\n[\\s\\S]*upTo=${b.id}`));
  assert.equal(data('c4-fetch.js',['--checkpoints','--group','chat:A','--after','0'])[0].summary,'A summary');

});
