// One fresh process per preflight/sample: product modules cache HOME/ZYLOS_DIR.
// This file is launched only by the official Node test entry, not as a user CLI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { waitOwnedRuntime, verifyHomeAbsent } from './router-ready-process.js';
import { isolatedTmux, tmuxClientEnv } from '../../../../test/helpers/isolated-tmux.js';

const packageRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => ({ wall: Date.now(), mono: performance.now() });
const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => /^[a-zA-Z][a-zA-Z0-9_]+$/.test(error?.code || '') ? error.code : 'WORKER_OPERATION_FAILED';
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });

function installSkills(root, injection, config) {
  const destination = path.join(root, '.claude/skills');
  fs.mkdirSync(destination);
  for (const entry of fs.readdirSync(path.join(packageRoot, 'skills'))) {
    const source = path.join(packageRoot, 'skills', entry);
    const target = path.join(destination, entry);
    if (entry !== 'activity-monitor') fs.symlinkSync(source, target);
    else fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  }
  if (!['slow-hook', 'missing-session-id'].includes(injection)) return;
  // Keep the native command and all real M3 implementation intact. Only the
  // start-prompt shard's input/wait is injected in a private skill copy.
  const script = path.join(destination, 'activity-monitor/scripts/session-start-orchestrator.js');
  fs.renameSync(script, script.replace('.js', '.real.js'));
  fs.writeFileSync(script, `import fs from 'node:fs';\nimport path from 'node:path';\nimport {readStdinPayload,parseShardArg,runSessionStartShard,runSessionStartOrchestrator} from './session-start-orchestrator.real.js';\nconst payload=await readStdinPayload(); const shard=parseShardArg(process.argv.slice(2));\nif(shard==='start-prompt'){\nfs.writeFileSync(path.join(process.env.HOME,'injection-entered.json'),JSON.stringify({enteredAt:Date.now()}),{mode:0o600});\n${injection === 'missing-session-id' ? 'delete payload.session_id;' : `const until=Date.now()+${config.slowHookMs}; while(Date.now()<until && fs.existsSync(process.env.HOME) && !fs.existsSync(path.join(process.env.HOME,'injection-cancel')))await new Promise(r=>setTimeout(r,25)); if(!fs.existsSync(process.env.HOME)||fs.existsSync(path.join(process.env.HOME,'injection-cancel')))process.exit(0);`}\n}\nif(shard)await runSessionStartShard(shard,payload);else await runSessionStartOrchestrator(payload);\n`, { mode: 0o600 });
}

async function execute(request) {
  const { runtime, config } = request;
  const cleanup = [];
  const scope = { after: callback => cleanup.push(callback) };
  let router, home, root, tm, tmCleanup;
  const ownedRuns = new Map();
  let processCleanupConfirmed = true;
  const record = { schema: 1, type: request.type, runtime, case: request.case ?? null, condition: request.condition ?? null,
    index: request.index ?? null, ok: false, homeRemoved: false };
  try {
    tm = isolatedTmux({ after: callback => { tmCleanup = callback; } }, { prefix: 'ready-measure-', beforeCleanup: () => router?.stop() });
    home = fs.realpathSync(tm.dir); root = path.join(home, 'zylos');
    fs.mkdirSync(root);
    const inputs = { ...process.env };
    const env = tmuxClientEnv(tm, { PATH: process.env.PATH, HOME: home, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: packageRoot,
      LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: path.join(home, 'tmp') });
    fs.mkdirSync(env.TMPDIR);
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']) if (inputs[key]) env[key] = inputs[key];
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    // All product imports occur after isolated env is installed.
    const { setupAuth, preflightInputs } = await import('./router-ready-auth.js');
    const { assertOrder, timing, resolveBinary } = await import('./router-ready.measure.js');
    preflightInputs([runtime], inputs);
    for (const directory of ['.zylos','.claude','comm-bridge','memory']) fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime, session_mode: 'multi' }));
    fs.writeFileSync(path.join(root, '.zylos/runtime-env.manifest'), 'inherit TMUX\ninherit ZYLOS_PACKAGE_ROOT\ninherit TMPDIR\n');
    installSkills(root, request.case, config);
    fs.writeFileSync(path.join(root, 'memory/identity.md'), 'Isolated startup measurement. Do not call tools or send messages. Wait quietly.');
    // Resolve before product launch rebuilds PATH; pass the same executable to
    // auth, version and adapter even when installed in a custom host bin dir.
    const binary = resolveBinary(config.binaries[runtime], env, packageRoot);
    record.auth = await setupAuth({ runtime, home, root, env: { ...env,
      READY_MEASURE_CLAUDE_CREDENTIALS: inputs.READY_MEASURE_CLAUDE_CREDENTIALS,
      READY_MEASURE_CODEX_API_KEY: inputs.READY_MEASURE_CODEX_API_KEY }, binary });
    const version = spawnSync(binary, ['--version'], { env, cwd: root, encoding: 'utf8', timeout: 10000 });
    // Only a semver is retained; no arbitrary command output enters evidence.
    record.version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(version.stdout || '')?.[0] ?? null;
    if (version.error || version.status !== 0 || !record.version) throw fail('RUNTIME_VERSION_UNAVAILABLE');
    if (request.type === 'preflight') { record.ok = true; return record; }
    const [{ fixture }, { getSessionAdapter }, { createSessionReader }, { readReadyIdentity }, { listGroupTmuxSessions }, { createRouter }, c4] = await Promise.all([
      import('./c4-v2-test-helpers.js'), import('../../../../cli/lib/runtime/index.js'),
      import('../../../../cli/lib/session-state-reader-async.js'), import('../../../../cli/lib/runtime/session-target.js'),
      import('../../../../cli/lib/session-group-paths.js'), import('../router/scheduler.js'), import('../c4-db.js'),
    ]);
    const f = fixture(scope, { readConfig: () => ({ state: 'ok', config: { runtime, session_mode: 'multi' } }) }, path.join(root,'comm-bridge/c4.db'));
    scope.after(() => c4.close());
    const db = { ...f.store, getControlById: id => f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
      expireTimedOutControls: c4.expireTimedOutControls, cleanupControlQueue: c4.cleanupControlQueue };
    db.setDrainFence('origin', { reason: 'upgrade', runId: 'measurement' });
    const tmux = { binary: tm.binary, socketPath: tm.socketPath, configFile: '/dev/null' };
    const reader = createSessionReader({ env, connectionOptions: tmux });
    const launcher = path.join(home, 'runtime-launcher.mjs');
    fs.writeFileSync(launcher, `#!${process.execPath}\nimport path from 'node:path';\nimport {superviseRuntime} from ${JSON.stringify(new URL('./router-ready-process.js', import.meta.url).href)};\nawait superviseRuntime(${JSON.stringify(binary)}, process.argv.slice(2), path.join(process.env.HOME,'owned-runtime',String(process.env.ZYLOS_RUN_ID)+'.json'));\n`, { mode: 0o700 });
    const realAdapter = getSessionAdapter(runtime, { root, tmux, env, runtimeExecutable: () => launcher });
    const confirmOwnedExit = async runId => {
      const result = await waitOwnedRuntime(path.join(home, 'owned-runtime', `${runId}.json`), runId);
      ownedRuns.set(runId, result);
      processCleanupConfirmed &&= result.groupGone;
      return result;
    };

    async function runRound(kind) {
      const fault = kind !== 'normal';
      let logicalNow = Date.now(), launch, returned, actualReturned, observed, readyIdentity, runId;
      let launches = 0, stops = 0, boundaryReads = 0, boundaryGate = false, boundaryArmed = false;
      let releaseLaunch;
      const pendingGate = new Promise(resolve => { releaseLaunch = resolve; });
      const sequence = [], events = [], reads = new Set(), listings = new Set();
      const row = db.insertConversation('in', 'measure', 'fixture', 'Measurement marker; no external destination');
      const start = performance.now();
      const deadline = start + config.observationMs;
      const snapshot = async () => {
        let live;
        try { live = await reader.readLiveIdentity('measure'); }
        catch (error) {
          if (['TARGET_GONE','TMUX_NO_SERVER','RUNID_MISMATCH','GENERATION_CHANGED'].includes(error.code)) return null;
          throw error;
        }
        if (live.ready && live.runId === runId) {
          const f3 = await readReadyIdentity('measure');
          if (f3?.runId === runId && f3.sessionId === live.sessionId) {
            if (!observed) { observed = stamp(); readyIdentity = f3; }
            return live;
          }
        }
        return null;
      };
      const waitRealReady = async () => {
        while (!stopping && performance.now() < deadline) {
          if (await snapshot()) return;
          await sleep(config.pollMs);
        }
        throw fail('REAL_READY_NOT_OBSERVED');
      };
      const adapter = {
        launch: async input => {
          launches++; runId = input.runId; launch = stamp();
          ownedRuns.set(runId, null);
          boundaryGate = kind === 'boundary-ready';
          try {
            const value = await realAdapter.launch(input);
            actualReturned = stamp();
            if (kind === 'late-launch') { await waitRealReady(); await pendingGate; }
            if (kind === 'boundary-ready') {
              await waitRealReady();
              // The outer loop pauses ticks while boundaryGate is true. The
              // initial scene read has settled during the real launch/READY wait.
              await Promise.allSettled([...listings]);
              await Promise.allSettled([...reads]);
              logicalNow = router.state.activations.get('measure').startedAt + config.readyTimeoutMs;
              boundaryArmed = true;
            }
            return value;
          } finally { returned = stamp(); }
        },
        stop: async input => { stops++; return realAdapter.stop(input); },
      };
      let orderingError;
      const deps = {
        db, now: () => fault ? logicalNow : Date.now(), readSessionMode: () => ({ mode: 'multi', keyPresent: true }),
        readLiveIdentity: group => {
          const pending = reader.readLiveIdentity(group).then(live => {
            if (group === 'measure' && boundaryArmed) {
              boundaryReads++;
              if (boundaryReads === 1) return { ...live, ready: false, sessionId: null };
              boundaryArmed = false; boundaryGate = false;
            }
            return live;
          }).finally(() => reads.delete(pending));
          reads.add(pending); return pending;
        },
        readCurrentSession: readReadyIdentity, listGroupTmuxSessions: () => {
          const pending = listGroupTmuxSessions(tmux).finally(() => listings.delete(pending));
          listings.add(pending); return pending;
        },
        readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }), getSessionAdapter: () => adapter,
        submit: async () => { throw fail('UNEXPECTED_HEALTH_REQUEST'); },
        deliverControl: async (control, live) => {
          sequence.push({ kind: 'control', id: control.id, at: Date.now() });
          const ack = c4.ackControl(control.id);
          if (ack.status !== 'done') throw fail('CONTROL_NOT_SETTLED');
        },
        deliverConversation: async (message, live) => {
          sequence.push({ kind: 'business', id: message.id, at: Date.now() });
          const f3 = await readReadyIdentity('measure');
          try {
            if (f3?.runId !== live.runId || f3?.sessionId !== live.sessionId) throw fail('READY_IDENTITY_CHANGED');
            assertOrder(sequence, f3?.startupControlIds || [], message.id);
          }
          catch (error) { orderingError = safeCode(error); throw error; }
          if (!db.markDelivered(message.id, { sessionId: live.sessionId })) throw fail('BUSINESS_NOT_SETTLED');
        },
        handleExpired: async () => {}, prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
        diagnostic: (event, fields) => events.push({ event, reason: /^[a-zA-Z][a-zA-Z0-9_]+$/.test(fields.reason || '') ? fields.reason : null, at: Date.now(), logicalAt: fault ? logicalNow : null }),
        alert: () => {},
      };
      router = createRouter(deps, { poolSize: 1, readyTimeoutMs: config.readyTimeoutMs });
      await router.initialize();
      let ledger, logicalAdvanced = false, releaseAfterTick = false;
      try {
        while (!stopping && performance.now() < deadline) {
          if (!boundaryGate) router.tick();
          await sleep(config.pollMs);
          if (runId) await snapshot();
          const activation = router.state.activations.get('measure');
          if (fault && activation && !logicalAdvanced) {
            const hookEntered = ['slow-hook','missing-session-id'].includes(kind) && fs.existsSync(path.join(home,'injection-entered.json'));
            if (hookEntered || (kind === 'late-launch' && observed)) {
              logicalNow = activation.startedAt + config.readyTimeoutMs + 1;
              logicalAdvanced = true;
              if (kind === 'late-launch') releaseAfterTick = true;
            }
          }
          if (releaseAfterTick) {
            router.tick();
            // tick emits launch_pending synchronously while launch is held.
            releaseLaunch(); releaseAfterTick = false;
          }
          ledger = f.db.prepare('SELECT id,status,retry_count FROM conversations WHERE id=?').get(row.id);
          if (ledger.status === 'delivered' || ledger.retry_count > 0 || orderingError) break;
        }
      } finally {
        releaseLaunch();
        fs.writeFileSync(path.join(home, 'injection-cancel'), 'cancel');
        await router.stop();
      }
      ledger = f.db.prepare('SELECT id,status,retry_count FROM conversations WHERE id=?').get(row.id);
      const finalLive = await reader.readLiveIdentity('measure');
      const sample = { launchCount: launches, routerStopCount: stops, ledger, sequence, events,
        outcome: ledger.status === 'delivered' ? 'success' : ledger.retry_count > 0 ? 'retry' : 'incomplete',
        clock: fault ? { kind: 'controlled', atEnd: logicalNow, boundaryReads, advanced: logicalAdvanced || boundaryReads === 2 } : { kind: 'real' },
        runId, startupControlIds: readyIdentity?.startupControlIds || [],
        actualAdapterLaunchMs: actualReturned && launch ? actualReturned.mono-launch.mono : null,
        timing: observed && launch ? timing(launch, returned, readyIdentity, observed) : null,
        finalTargetPresent: finalLive.present, pollMs: config.pollMs,
        observationElapsedMs: performance.now()-start,
      };
      // Stop the exact run after collection, outside the measured router outcome.
      if (finalLive.present && finalLive.runId === runId) await realAdapter.stop({ tmuxName: finalLive.tmuxName, expectedRunId: runId });
      sample.targetStoppedAfterSample = !(await reader.readLiveIdentity('measure')).present;
      sample.runtimeCleanup = await confirmOwnedExit(runId);
      if (orderingError) throw Object.assign(fail(orderingError), { sample });
      const counts = sequence.map(e => `${e.kind}:${e.id}`);
      sample.duplicateDeliveries = counts.length-new Set(counts).size;
      const timeoutFault = ['slow-hook','missing-session-id'].includes(kind);
      sample.ok = launches === 1 && sample.duplicateDeliveries === 0 && sample.targetStoppedAfterSample && sample.runtimeCleanup.groupGone &&
        (timeoutFault ? ledger.retry_count === 1 && !sequence.some(e => e.kind === 'business') && stops === 1 : ledger.status === 'delivered' && stops === 0);
      if (kind === 'late-launch') sample.ok &&= events.some(e => e.event === 'stop_unconfirmed' && e.reason === 'launch_pending');
      if (kind === 'boundary-ready') sample.ok &&= boundaryReads === 2;
      if (!sample.ok) sample.error = !sample.runtimeCleanup.groupGone ? 'RUNTIME_EXIT_UNCONFIRMED' : stopping ? 'WORKER_INTERRUPTED' : 'CONVERGENCE_ASSERTION_FAILED';
      return sample;
    }
    if (request.condition === 'repeat') {
      const warmup = await runRound('normal');
      record.warmup = { ok: warmup.ok, outcome: warmup.outcome, targetStopped: warmup.targetStoppedAfterSample };
      if (!warmup.ok) throw fail('WARMUP_FAILED');
    }
    Object.assign(record, await runRound(request.case));
    return record;
  } catch (error) {
    if (error.sample) Object.assign(record, error.sample);
    record.ok = false; record.error = safeCode(error);
    if (error.details) record.authDetails = error.details;
    return record;
  } finally {
    // Reverse registration order: database closes before tmux fixture HOME removal.
    if (home && fs.existsSync(home)) {
      fs.writeFileSync(path.join(home, 'injection-cancel'), 'cancel');
      await sleep(50);
    }
    // Product stop proves tmux absence only. Wait for test-owned runtime groups
    // before the shared helper removes the HOME. An unconfirmed group makes
    // cleanup fail; never present a one-instant directory check as proof.
    try { tm?.tmux('kill-server'); } catch { /* Already absent. */ }
    for (const [runId, result] of ownedRuns) {
      if (result) continue;
      const exit = await waitOwnedRuntime(path.join(home, 'owned-runtime', `${runId}.json`), runId);
      ownedRuns.set(runId, exit); processCleanupConfirmed &&= exit.groupGone;
    }
    for (const clean of cleanup.reverse()) {
      try { await clean(); } catch { record.cleanupError = 'CLEANUP_FAILED'; record.ok = false; }
    }
    if (processCleanupConfirmed) {
      try { await tmCleanup?.(); } catch { record.cleanupError = 'CLEANUP_FAILED'; record.ok = false; }
    } else if (home) {
      // Do not delete a HOME whose writers have not stopped. Scrub the explicit
      // credential copies; retain the fixture and fail rather than race writers.
      for (const file of ['.claude/.credentials.json', '.codex/auth.json']) {
        try { fs.rmSync(path.join(home, file), { force: true }); } catch { /* Failed cleanup is already reported. */ }
      }
    }
    record.cleanup = home ? await verifyHomeAbsent(home) : { homeRemoved: true, graceMs: 0 };
    record.cleanup.ownedGroupsExited = processCleanupConfirmed;
    record.homeRemoved = record.cleanup.homeRemoved && processCleanupConfirmed;
    if (!record.homeRemoved) { record.cleanupError = 'CLEANUP_FAILED'; record.ok = false; }

  }
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
let record;
try { record = await execute(JSON.parse(input)); }
catch { record = { ok: false, error: 'WORKER_REQUEST_FAILED', homeRemoved: false }; }
if (process.send) await new Promise(resolve => process.send(record, resolve));
process.disconnect?.();
