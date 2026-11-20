import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReceiveArgs } from '../../skills/scheduler/scripts/runtime.js';
import { getDb } from '../../skills/comm-bridge/scripts/c4-db.js';

const root = process.env.ZYLOS_DIR;
const config = path.join(root, '.zylos/config.json');
const notices = path.join(root, 'notices.jsonl');
const cli = fileURLToPath(new URL('../../cli/zylos.js', import.meta.url));
const receiver = fileURLToPath(new URL('../../skills/comm-bridge/scripts/c4-receive.js', import.meta.url));
const requester = 'telegram:team';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

for (const channel of ['telegram', 'multica', 'dashboard']) {
  const scripts = path.join(root, '.claude/skills', channel, 'scripts');
  write(path.join(scripts, 'session-group.js'), "process.stdout.write(process.argv[2]);\n");
  write(path.join(scripts, 'send.js'), `
    const [endpoint, text] = process.argv.slice(2);
    if (endpoint === 'unreachable') process.exit(1);
    if (Object.hasOwn(process.env, 'ZYLOS_SESSION_GROUP')) process.exit(2);
    require('node:fs').appendFileSync(${JSON.stringify(notices)}, JSON.stringify([ ${JSON.stringify(channel)}, endpoint, text ]) + '\\n');
  `);
}

function mode(session_mode, alert_target) {
  write(config, JSON.stringify({ runtime: 'codex', session_mode, alert_target }));
}

function run(file, args, env = {}) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 8000, maxBuffer: 32768,
  });
  assert.ifError(result.error);
  return result;
}

function host(args, expected = 0) {
  const result = run(cli, ['host', ...args], { ZYLOS_SESSION_GROUP: requester });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}

function inbound(group, content) {
  const result = run(receiver, ['--channel', 'telegram', '--endpoint', group,
    '--session-group', group, '--content', content, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).sessionGroup;
}

const captured = () => fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').trim().split('\n').map(JSON.parse) : [];
const db = getDb();
const current = source => db.prepare('SELECT * FROM session_hosts WHERE source_group=?').get(source);
try {
  mode('multi', 'telegram:owner');
  assert.equal(inbound('team', 'start session'), requester);
  assert.match(host(['attach', 'telegram:one', '--to', 'telegram:team']).stdout, /Hosting active/);
  assert.equal(current('telegram:one').attached_by, requester);
  assert.ok(current('telegram:one').attached_at > 0);
  assert.equal(inbound('one', 'hosted inbound'), requester);
  const [worker, ...schedulerArgs] = buildReceiveArgs('scheduled inbound',
    { sessionComponent: 'telegram', sessionGroupName: 'one' }, receiver);
  const scheduled = run(worker, schedulerArgs);
  assert.equal(scheduled.status, 0, scheduled.stdout + scheduled.stderr);
  assert.equal(JSON.parse(scheduled.stdout).sessionGroup, requester);
  assert.equal(captured().length, 1);
  let [channel, endpoint, text] = captured()[0];
  assert.equal(channel, 'telegram');
  assert.equal(endpoint, 'owner');
  for (const expected of ['telegram:one → telegram:team', '发起方：telegram:team', 'Started by telegram:team',
    'zylos host detach telegram:one', 'Dashboard']) assert.ok(text.includes(expected), expected);
  host(['detach', 'telegram:one']);
  assert.equal(inbound('one', 'after detach'), 'telegram:one');
  assert.equal(captured().length, 1);

  for (const [target, source] of [[undefined, 'unset'], ['default', 'default'], ['telegram:unreachable', 'fallback']]) {
    mode('multi', target);
    const before = captured().length;
    host(['attach', `telegram:${source}`, '--to', 'telegram:team']);
    assert.equal(captured().length, before + 1);
    [channel, endpoint] = captured().at(-1);
    assert.equal(channel, 'dashboard');
    assert.equal(endpoint, 'origin');
  }
  const recent = db.prepare("SELECT session_group,delivery_action FROM conversations WHERE direction='out' AND channel='dashboard' AND status='delivered' ORDER BY id DESC LIMIT 1").get();
  assert.equal(recent.session_group, 'origin');
  assert.equal(recent.delivery_action, 'system_notice');

  mode('multi', 'telegram:owner');
  let before = captured().length;
  host(['allow', 'multica']);
  assert.equal(captured().length, before + 1);
  assert.match(captured().at(-1)[2], /加入 multica.*multica was added/s);
  before = captured().length;
  host(['attach', 'multica:issue', '--to', 'telegram:middle']);
  assert.equal(current('multica:issue').target_group, 'telegram:middle');
  assert.equal(captured().length, before);
  host(['attach', 'telegram:middle', '--to', 'telegram:team']);
  assert.equal(current('multica:issue').target_group, requester);
  assert.equal(current('telegram:middle').target_group, requester);
  assert.equal(captured().length, before + 1, 'Flattening produces one notification');
  text = captured().at(-1)[2];
  assert.match(text, /Groups moved to telegram:team: multica:issue/);
  host(['disallow', 'multica']);
  assert.match(captured().at(-1)[2], /移除 multica.*multica was removed/s);
  assert.deepEqual(JSON.parse(host(['list']).stdout).allowlist, []);

  before = captured().length;
  assert.match(host(['attach', 'origin', '--to', requester], 1).stderr, /HOST_ORIGIN/);
  mode('single', 'telegram:owner');
  assert.match(host(['attach', 'telegram:new', '--to', requester], 1).stderr, /HOST_REQUIRES_MULTI/);
  assert.equal(captured().length, before);
} finally {
  db.close();
}
