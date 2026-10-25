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

// This models the reviewed P08 callback contract, not the unmerged P08 data path.
function installInternalContract(installed) {
  fs.writeFileSync(path.join(installed, 'scripts/c4-send-internal.js'), `
export async function sendInternal(args, readBody) {
  if (args.length !== 2 || args[0] !== 'internal' || args[1].startsWith('--')) {
    throw Object.assign(new Error('Expected internal <target-group> with the message on stdin'), {code:'INVALID_ARGS'});
  }
  const content = (await readBody()).trimEnd();
  if (!content) throw Object.assign(new Error('Message content is empty'), {code:'EMPTY_CONTENT'});
  return JSON.stringify({args, content});
}
`);
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

test('IB-55 invalid internal arguments reject before waiting on stdin with exact error format', async t => {
  const fixture = setup(t);
  installInternalContract(fixture.installed);
  for (const args of [['internal'], ['internal', '--group'], ['internal', 'target', 'extra']]) {
    const result = await runOpenStdin(t, fixture, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Error: INVALID_ARGS: Expected internal <target-group> with the message on stdin\n');
  }
});

test('IB-55 valid internal dispatch passes the lazy body callback and preserves empty-body errors', t => {
  const fixture = setup(t);
  installInternalContract(fixture.installed);
  const invoke = input => spawnSync(process.execPath, [fixture.cli, 'internal', 'demo:room'],
    { env: fixture.env, input, encoding: 'utf8', timeout: 3000 });
  const result = invoke('message\n\n');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['internal', 'demo:room'], content: 'message' });
  const empty = invoke('  \n');
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr, 'Error: EMPTY_CONTENT: Message content is empty\n');
});

test('installed external and void commands work without the unmerged internal helper', async t => {
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
  const missing = await runOpenStdin(t, fixture, ['internal', 'demo:room']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^Error: ERR_MODULE_NOT_FOUND:/);
  assert.equal(missing.stdout, '');
});

test('IB-55 open-stdin control detects the eager-read regression', async t => {
  const fixture = setup(t);
  installInternalContract(fixture.installed);
  const source = fs.readFileSync(fixture.cli, 'utf8');
  const mutant = source.replace('sendInternal(args, readStdin)', 'sendInternal(args, async () => body)');
  assert.notEqual(mutant, source);
  fs.writeFileSync(fixture.cli, mutant.replace('if (internal) {', 'if (internal) { const body = await readStdin();'));
  await assert.rejects(runOpenStdin(t, fixture, ['internal']), /dispatch waited for open stdin/);
});

test('#6b installed CLI reads original absorbed route and delegates internal targets through the same callback contract', t => {
  const fixture = setup(t);
  installInternalContract(fixture.installed);
  const component = path.join(fixture.dir, '.claude/skills/demo/scripts');
  fs.mkdirSync(component, { recursive: true });
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
  const internal = invoke();
  assert.equal(internal.status, 0, internal.stderr);
  assert.deepEqual(JSON.parse(internal.stdout), {args:['internal','demo:target'],content:'reply'});
});
