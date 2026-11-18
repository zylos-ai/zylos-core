import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from './helpers/ready-tmux-target.js';

// Boundary: real delivery, runtime adapters, identity guards and control ledger,
// with a terminal recorder that exits on /exit (no authenticated model). Run for
// lifecycle delivery/settlement changes; unrelated changes may skip. The runner
// isolates HOME, ZYLOS_DIR, PM2_HOME and TMPDIR. The fixture owns a private socket
// and database, bounds replay attempts, and kills its server on failure/timeout.
// Upgrade cases use the real queue producers; the check answer and package
// installer are boundaries, so real account/install success
// remains a review acceptance check. Single cases retain the pre-migration
// unscoped /exit chain; configured native single upgrades use Supervisor restart
// admission instead. Multi Origin/group exercise shared delivery.
test('exit controls settle after pane removal and do not reach replacement runs', { timeout: 60000 }, async t => {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !path.resolve(process.env[key]).startsWith(realHome + path.sep), `${key} must be isolated`);
  }
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const f = readyTmuxTarget(t, { prefix: 'exit-control-', packageRoot: repository });
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, f.env);
  for (const key of ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID']) delete process.env[key];
  const db = await import('../skills/comm-bridge/scripts/c4-db.js');
  t.after(() => db.close());
  const { DB_PATH } = await import('../skills/comm-bridge/scripts/c4-config.js');
  assert.equal(DB_PATH, path.join(f.root, 'comm-bridge/c4.db'));
  console.log('Exit isolation:', JSON.stringify({ root: f.root, database: DB_PATH, socket: f.socketPath,
    env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX'].map(key => [key, process.env[key]])) }));
  const { createDelivery } = await import('../skills/comm-bridge/scripts/router/delivery.js');
  const { resolveSessionTarget } = await import('../cli/lib/runtime/session-target.js');
  const { getSessionAdapter } = await import('../cli/lib/runtime/index.js');
  const { tmuxNameForGroup } = await import('../cli/lib/session-group-paths.js');
  const tmux = { socketPath: f.socketPath, binary: f.binary, configFile: '/dev/null' };
  // Keep the server alive when the runtime pane exits, as the managed host does.
  f.tmux('new-session', '-d', '-s', 'keeper', 'sleep', '120');
  f.tmux('kill-session', '-t', 'zylos-group-origin');
  f.tmux('set-option', '-g', 'remain-on-exit', 'off');
  const recorder = path.join(f.root, 'runtime.mjs'), output = path.join(f.root, 'exits.jsonl');
  fs.writeFileSync(recorder, `import fs from 'node:fs';let input='';process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
const prompt=()=>process.stdout.write('\\x1b[2J\\x1b[H❯ ');prompt();process.stdin.on('data',s=>{input+=s.replace(/\\x1b\\[20[01]~/g,'');let n;while((n=input.indexOf('\\r'))>=0){const line=input.slice(0,n);input=input.slice(n+1);if(line==='/exit'){fs.appendFileSync(${JSON.stringify(output)},JSON.stringify({run:process.env.ZYLOS_RUN_ID,at:new Date().toISOString()})+'\\n');process.exit(0);}prompt();}});`);
  fs.mkdirSync(path.join(f.root, '.claude/skills'), { recursive: true });
  for (const skill of ['comm-bridge', 'activity-monitor', 'scheduler']) {
    fs.symlinkSync(path.join(repository, 'skills', skill), path.join(f.root, '.claude/skills', skill));
  }
  const { requestRuntimeRestart } = await import('../cli/lib/request-runtime-restart.js');
  const { upgradeRuntime } = await import('../skills/upgrade-claude/scripts/upgrade.js');
  const cases = ['claude', 'codex'].flatMap(runtime => ['single', 'origin', 'group'].map(scope => ({ runtime, scope, source: 'direct' })));
  cases.push({ runtime: 'claude', scope: 'single', source: 'runtime-upgrade' }, { runtime: 'claude', scope: 'single', source: 'core-restart' });
  for (const { runtime, scope, source } of cases) {
    await t.test(`${runtime} ${scope === 'single' ? 'legacy single' : scope} ${source}`, async t => {
      const mode = scope === 'single' ? 'single' : 'multi';
      const group = scope === 'group' ? 'telegram-exit-test' : 'origin';
      fs.writeFileSync(path.join(f.root, '.zylos/config.json'), JSON.stringify({ runtime, ...(mode === 'multi' ? { session_mode: mode } : {}) }));
      const name = tmuxNameForGroup(group);
      t.after(() => { try { f.tmux('kill-session', '-t', name); } catch {} });
      let run = 0, identity;
      const start = async () => {
        identity = { runId: `${runtime}-${scope}-${source}-${++run}`, sessionId: `session-${runtime}-${run}`, ts: 1, startupControlIds: [] };
        f.tmux('new-session', '-d', '-s', name, '-e', `ZYLOS_RUN_ID=${identity.runId}`,
          '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify({ runtime, mode: 'default' })}`,
          ...(mode === 'multi' ? ['-e', `ZYLOS_SESSION_GROUP=${group}`] : []), process.execPath, recorder);
        for (let n = 0; n < 100; n++) {
          if (f.tmux('capture-pane', '-p', '-t', name).includes('❯')) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('recorder did not become ready');
      };
      await start();
      const diagnostics = [];
      const delivery = createDelivery({ db, getSessionMode: () => mode,
        resolveSessionTarget: args => { assert.equal(args.sessionGroup, mode === 'single' ? null : group); return resolveSessionTarget({ ...args, readReady: async () => identity }); },
        readSessionState: async () => ({ identity: { ...identity, runtime, ready: true }, status: { valid: true, value: { state: 'idle', idle_seconds: 10, proc: { alive: true }, health: 'ok' } } }),
        readRuntimeHealth: () => ({ health: 'ok' }), getSessionAdapter: r => getSessionAdapter(r, { tmux }),
        notifyDelivered() {}, diagnostic: (event, fields) => { if (event === 'delivery_failed') diagnostics.push(fields.reason); },
      }, { tmux, periodicEnabled: false, captureEnabled: false, verifyWaitMs: 50 });
      t.after(() => delivery.stop());
      let row;
      const transitions = [];
      const count = () => fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.run.startsWith(`${runtime}-${scope}-${source}-`)) : [];
      const deliverExit = async () => {
        assert.equal(db.claimControl(row.id), true);
        await delivery.deliverControl(db.getControlById(row.id));
        transitions.push(db.getControlById(row.id).status);
      };
      const acknowledgeCheck = controls => {
        const check = db.getControlById(controls.checkControlId);
        row = db.getControlById(controls.exitControlId);
        assert.ok(check.id < row.id);
        assert.equal(row.content, '/exit');
        // Check ordering/pasting has separate integration coverage. Model its answer here.
        assert.equal(db.claimControl(check.id), true);
        assert.equal(db.ackControl(check.id).status, 'done');
      };
      if (source === 'runtime-upgrade') {
        let installed = false;
        const order = [];
        const result = await upgradeRuntime({
          install: () => {
            assert.equal(db.getDb().prepare("SELECT COUNT(*) AS count FROM control_queue WHERE status='pending'").get().count, 0);
            assert.equal(count().length, 0, 'the old runtime is still running during installation');
            installed = true;
            order.push('install');
          },
          requestRestart: async () => {
            assert.equal(installed, true);
            order.push('restart');
            return requestRuntimeRestart();
          },
        });
        assert.equal(result.ok, true); assert.equal(installed, true);
        assert.equal(result.data.result, 'exit_enqueued');
        assert.deepEqual(order, ['install', 'restart']);
        acknowledgeCheck(result.data);
        await deliverExit();
        assert.equal(count().length, 1, 'exit settles against the old run before replacement startup');
        await start();
      } else if (source === 'core-restart') {
        const result = await requestRuntimeRestart({ afterServiceRestart: true });
        assert.equal(result.ok, true); assert.equal(result.data.result, 'exit_enqueued');
        acknowledgeCheck(result.data); await deliverExit(); await start();
      } else {
        row = db.insertControl('/exit', { appendAckSuffix: false, ...(mode === 'multi' ? { sessionGroup: group } : {}) });
        // Bounded at two exits so the baseline bug yields finite diagnostic evidence.
        for (let attempt = 0; attempt < 2; attempt++) {
          await deliverExit(); await start();
          if (transitions.at(-1) === 'done') break;
        }
      }
      const exits = count();
      const claimReplacement = db.claimControl(row.id);
      console.log('Exit outcome:', JSON.stringify({ runtime, scope, source, transitions, exits, failures: diagnostics, claimReplacement }));
      assert.equal(claimReplacement, false, 'completed control cannot be claimed by a replacement run');
      assert.equal(exits.length, 1, 'only the original run exits');
      assert.equal(db.getControlById(row.id).status, 'done');
      assert.equal(f.tmux('capture-pane', '-p', '-t', name).includes('❯'), true);
      f.tmux('kill-session', '-t', name);
    });
  }
});
