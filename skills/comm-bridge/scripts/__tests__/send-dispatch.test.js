import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('..', import.meta.url));
const packageRoot = path.resolve(scripts, '../../..');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const installed = path.join(dir, '.claude/skills/comm-bridge');
  fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(scripts, '../package.json'), path.join(installed, 'package.json'));
  fs.copyFileSync(path.join(scripts, '../init-db.sql'), path.join(installed, 'init-db.sql'));
  fs.symlinkSync(path.resolve(scripts, '../node_modules'), path.join(installed, 'node_modules'));
  for (const file of fs.readdirSync(scripts).filter(name => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(scripts, file), path.join(installed, 'scripts', file));
  }
  return { dir, installed, cli: path.join(installed, 'scripts/c4-send.js'),
    env: { ...process.env, ZYLOS_DIR: dir, ZYLOS_PACKAGE_ROOT: packageRoot, ZYLOS_SESSION_GROUP: 'origin' } };
}

function runDatabase(fixture, body) {
  const module = pathToFileURL(path.join(fixture.installed, 'scripts/c4-db.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as db from ${JSON.stringify(module)};
try { ${body} } finally { db.close(); }
`], { env: fixture.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

function internalRows(fixture) {
  return runDatabase(fixture, `console.log(JSON.stringify(db.getDb().prepare("SELECT * FROM conversations WHERE channel='internal' ORDER BY id").all()));`);
}

async function runOpenStdin(t, fixture, args) {
  const child = spawn(process.execPath, [fixture.cli, ...args], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  return await new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('dispatch waited for open stdin'));
      else resolve({ status, stdout, stderr });
    });
  });
}

test('invalid internal arguments reject before waiting on stdin with exact error format', async t => {
  const fixture = setup(t);
  for (const args of [['internal'], ['internal', '--group'], ['internal', 'target', 'extra']]) {
    const result = await runOpenStdin(t, fixture, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Error: INVALID_ARGS: Expected internal <target-group> with the message on stdin\n');
  }
});

test('valid internal dispatch uses the real module and preserves empty-body errors', t => {
  const fixture = setup(t);
  fs.mkdirSync(path.join(fixture.dir, '.claude/skills/demo/scripts'), { recursive: true });
  runDatabase(fixture, "db.insertConversation('in','demo','room','seed',{groupName:'room'});");
  const invoke = input => spawnSync(process.execPath, [fixture.cli, 'internal', 'demo:room'],
    { env: fixture.env, input, encoding: 'utf8', timeout: 3000 });
  const result = invoke('message\n\n');
  assert.equal(result.status, 0, result.stderr);
  const rows = internalRows(fixture);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.direction, row.endpoint_id, row.session_group, row.content, row.status]), [
    ['out', 'demo:room', 'origin', 'message', 'delivered'],
    ['in', 'origin', 'demo:room', '[internal] origin said: message', 'pending'],
  ]);
  assert.equal(result.stdout, `[C4] internal message queued for demo:room (id ${rows[1].id})\n`);
  const empty = invoke('  \n');
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr, 'Error: EMPTY_CONTENT: Message content is empty\n');
  assert.deepEqual(internalRows(fixture), rows);
});

test('installed external and void commands dispatch through installed component scripts', t => {
  const fixture = setup(t);
  const component = path.join(fixture.dir, '.claude/skills/demo/scripts');
  fs.mkdirSync(component, { recursive: true });
  const output = path.join(fixture.dir, 'argv.json');
  fs.writeFileSync(path.join(component, 'send.js'), `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)))`);
  const invoke = args => spawnSync(process.execPath, [fixture.cli, ...args],
    { env: fixture.env, input: 'body\n', encoding: 'utf8', timeout: 3000 });
  const external = invoke(['demo', 'a\'"$`\\\nroute', '--stdin']);
  assert.equal(external.status, 0, external.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), ['a\'"$`\\\nroute', 'body']);
  assert.equal(invoke(['void', 'handoff', '--stdin']).status, 0);
});

test('#6b installed CLI reads original absorbed route and queues internal targets through the real module', t => {
  const fixture = setup(t);
  const component = path.join(fixture.dir, '.claude/skills/demo/scripts');
  fs.mkdirSync(component, { recursive: true });
  runDatabase(fixture, "db.insertConversation('in','demo','target','seed',{groupName:'target'});");
  const database = pathToFileURL(path.join(fixture.installed, 'scripts/c4-db.js')).href;
  const create = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as db from ${JSON.stringify(database)};
const row = db.insertConversation('in', 'demo', 'a\\\'"$\x60\\\\\\nroute', 'original', {groupName:'room'});
const {runId} = db.beginModeTransition('single','multi');
db.setDrainFence('*'); db.absorbForTransition(runId);
console.log(JSON.stringify({id:String(row.id),runId})); db.close();
`], { env: fixture.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(create.status, 0, create.stderr);
  const { id, runId } = JSON.parse(create.stdout.trim().split('\n').at(-1));
  const output = path.join(fixture.dir, 'absorbed.json');
  fs.writeFileSync(path.join(component, 'send.js'), `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)))`);
  const invoke = () => spawnSync(process.execPath, [fixture.cli, '--absorbed-reply', runId, id],
    { env: fixture.env, input: 'reply\n', encoding: 'utf8', timeout: 3000 });
  const external = invoke();
  assert.equal(external.status, 0, external.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), ['a\'"$`\\\nroute', 'reply']);
  const update = spawnSync(process.execPath, ['--input-type=module', '-e', `
import * as db from ${JSON.stringify(database)};
db.getDb().prepare("UPDATE conversations SET channel='internal',endpoint_id='demo:target' WHERE id=?").run(${JSON.stringify(id)});
db.close();
`], { env: fixture.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(update.status, 0, update.stderr);
  const before = internalRows(fixture);
  const internal = invoke();
  assert.equal(internal.status, 0, internal.stderr);
  const after = internalRows(fixture);
  assert.deepEqual(after.slice(0, before.length), before);
  const rows = after.slice(before.length);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.direction, row.endpoint_id, row.session_group, row.content]), [
    ['out', 'demo:target', 'origin', 'reply'],
    ['in', 'origin', 'demo:target', '[internal] origin said: reply'],
  ]);
  assert.equal(internal.stdout, `[C4] internal message queued for demo:target (id ${rows[1].id})\n`);
});
