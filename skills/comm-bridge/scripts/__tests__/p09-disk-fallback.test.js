import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { isolatedTmux, tmuxClientEnv } from '../../../../test/helpers/isolated-tmux.js';
import { fixture } from './c4-v2-test-helpers.js';

const cli = new URL('../c4-receive.js', import.meta.url);
const record = (runtime, health) => ({ v: 1, runtime, health, reason: health === 'ok' ? '' : health,
  updatedAt: 1, hook: {}, unavailableSince: 0, cooldownUntil: 0, recoveringStartedAt: 0,
  lastUserMessageRecoveryAt: 0, restartFailureCount: 0, lastRecoveryAt: 0, lastDownCheckAt: 0, rateLimitResetTime: '' });

function diskFixture(t, runtime, health) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p09-f10-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const healthDir = path.join(root, 'activity-monitor', 'runtime-health');
  fs.mkdirSync(healthDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ runtime, session_mode: 'single' }));
  const target = path.join(healthDir, runtime + '.json');
  if (health === 'unreadable') fs.writeFileSync(target, '{bad JSON');
  else if (health !== 'missing') fs.writeFileSync(target, JSON.stringify(record(runtime, health)));
  const opposite = runtime === 'claude' ? 'codex' : 'claude';
  const oppositeHealth = ['auth_failed', 'unavailable'].includes(health) ? 'ok' : 'auth_failed';
  fs.writeFileSync(path.join(healthDir, opposite + '.json'), JSON.stringify(record(opposite, oppositeHealth)));
  fs.writeFileSync(path.join(root, 'activity-monitor', 'agent-status.json'), JSON.stringify({ health: oppositeHealth, status: 'unavailable' }));
  const component = path.join(root, '.claude', 'skills', 'chat', 'scripts');
  fs.mkdirSync(component, { recursive: true });
  fs.writeFileSync(path.join(component, 'send.js'), `import fs from 'node:fs'; fs.appendFileSync(process.env.ZYLOS_DIR+'/receipts.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');`);
  const preload = path.join(root, 'observe.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs'; import path from 'node:path';
    const read=fs.readFileSync, append=fs.appendFileSync;
    const root=process.env.ZYLOS_DIR, target=${JSON.stringify(target)}, opposite=${JSON.stringify(path.join(healthDir, opposite + '.json'))};
    fs.readFileSync=function(file,...args){
      const name=String(file);
      if(name.includes('/runtime-health/') || name===root+'/activity-monitor/agent-status.json') append(root+'/reads.jsonl',JSON.stringify(name)+'\\n');
      if(process.env.TEST_FORCE_OTHER_RUNTIME==='1' && name===target){
        append(root+'/reads.jsonl',JSON.stringify(opposite)+'\\n');
        const value=JSON.parse(read.call(this,opposite,'utf8')); value.runtime=${JSON.stringify(runtime)};
        return JSON.stringify(value);
      }
      return read.call(this,file,...args);
    };
    for(const method of ['writeFileSync','appendFileSync','renameSync','unlinkSync','truncateSync']){
      const original=fs[method]; fs[method]=function(file,...args){
        if(String(file).includes('/runtime-health/')) throw Error('F10/F11 write forbidden');
        return original.call(this,file,...args);
      };
    }`);
  return { root, target, opposite, preload };
}

function receiveCLI(f, env, args = [], mutant = false) {
  const result = spawnSync(process.execPath, ['--import', f.preload, cli.pathname,
    '--channel', 'chat', '--endpoint', 'room', '--content', 'isolated input', '--json', ...args], {
    env: { ...env, ZYLOS_DIR: f.root, TEST_FORCE_OTHER_RUNTIME: mutant ? '1' : '0' }, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reply = JSON.parse(result.stdout.trim());
  const db = new Database(path.join(f.root, 'comm-bridge', 'c4.db'), { readonly: true });
  const rows = db.prepare("SELECT status,delivery_action,endpoint_id,session_group FROM conversations WHERE direction='in'").all();
  const cooldowns = db.prepare('SELECT count(*) AS n FROM status_notice_cooldowns').get().n;
  db.close();
  return { reply, row: rows.at(-1), rows, cooldowns, stderr: result.stderr };
}

test('IF-04 actual CLI missing socket reads only selected on-disk F10 across external/Core/noReply cases', { timeout: 60000 }, t => {
  const env = tmuxClientEnv(isolatedTmux(t));
  for (const runtime of ['claude', 'codex']) {
    for (const health of ['missing', 'unreadable', 'ok', 'rate_limited', 'auth_failed', 'unavailable']) {
      for (const core of [false, true]) {
        for (const noReply of [false, true]) {
          const f = diskFixture(t, runtime, health);
          const result = receiveCLI(f, env, [...(core ? ['--core-source', 'scheduler'] : []), ...(noReply ? ['--no-reply'] : [])]);
          const rejected = health === 'unavailable' || (health === 'auth_failed' && !core);
          const label = `${runtime}/${health}/core=${core}/noReply=${noReply}`;
          assert.equal(result.reply.runtime, runtime, label);
          assert.equal(result.row.status, rejected ? 'failed' : 'pending', label);
          assert.equal(result.row.delivery_action, health === 'auth_failed' && !core ? 'auth_rejected' : null, label);
          assert.equal(result.row.endpoint_id, noReply ? null : 'room', label);
          assert.equal(result.row.session_group, 'chat', label);
          assert.equal(result.cooldowns, rejected && !noReply ? 1 : 0, label);
          assert.equal(fs.existsSync(path.join(f.root, 'receipts.jsonl')), rejected && !noReply, label);
          assert.equal(result.reply.action, rejected ? health === 'auth_failed' && !core ? 'auth_rejected' : 'delivered' : 'queued', label);
          const reads = fs.readFileSync(path.join(f.root, 'reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
          assert.deepEqual(reads, [f.target], label + ' must not consult other runtime/whole-agent health');
          assert.equal(fs.existsSync(path.join(f.root, 'activity-monitor', 'am.sock')), false);
          if (health === 'auth_failed' && !core) {
            assert.equal(result.reply.reasonLogged, false, 'Base lacks P04 append module; do not claim an event was written');
          }
        }
      }
    }
  }
});

test('IF-04 negative control: other-runtime-read mutation fails the real CLI terminal-state oracle', { timeout: 10000 }, t => {
  const env = tmuxClientEnv(isolatedTmux(t));
  const f = diskFixture(t, 'claude', 'auth_failed');
  const result = receiveCLI(f, env, ['--no-reply'], true);
  assert.equal(result.reply.runtime, 'claude');
  assert.throws(() => assert.equal(result.row.status, 'failed'), { code: 'ERR_ASSERTION' });
  assert.equal(result.row.status, 'pending');
  const reads = fs.readFileSync(path.join(f.root, 'reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(reads.some(file => file.endsWith('/codex.json')), true);
});

test('DM-51 negative control detects false reasonLogged when the postcommit F14 append fails', async t => {
  const url = new URL('../c4-receive.js', import.meta.url), source = fs.readFileSync(url, 'utf8');
  const anchor = 'result.reasonLogged = await append({';
  assert.ok(source.includes(anchor));
  // Preserve the actual append operation while making its reported result unconditionally true.
  const ending = 'detail: route.auth.detail });';
  assert.ok(source.includes(ending));
  const mutated = source.replace(anchor, 'result.reasonLogged = (await append({')
    .replace(ending, 'detail: route.auth.detail })) || true;')
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, url).href}'`);
  const { receive } = await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'));
  const f = fixture(t, {}, true);
  let appends = 0;
  const reply = await receive(['--channel', 'chat', '--content', 'auth', '--no-reply'], {
    db: f.store, validateChannel: () => true, queryRoute: async () => ({ decision: 'auth_rejected', recovered: false,
      runtime: 'claude', health: 'auth_failed', auth: { result: 'failed', detail: 'past' } }), appendEntryEvent: async () => { appends++; return false; },
  });
  assert.equal(appends, 1);
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').get(reply.id).status, 'failed');
  assert.throws(() => assert.equal(reply.reasonLogged, false), { code: 'ERR_ASSERTION' });
});
