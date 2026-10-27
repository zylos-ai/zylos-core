import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';

const identity = new URL('../../../../skills/activity-monitor/scripts/bootstrap-identity.js', import.meta.url).href;
const runtimeBase = new URL('../', import.meta.url).href;
const pathsModule = new URL('../../session-group-paths.js', import.meta.url).href;

function probe(f, scope = { kind: 'multi', sessionGroup: 'origin' }) {
  const script = path.join(f.root, 'probe.mjs');
  const result = path.join(f.root, 'identity.json');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import {readBootstrapIdentity} from ${JSON.stringify(identity)};
import {openTmuxConnection} from ${JSON.stringify(`${runtimeBase}tmux-connection.js`)};
const load = name => import(name === 'session-group-paths.js' ? ${JSON.stringify(pathsModule)} : ${JSON.stringify(runtimeBase)} + name.replace('runtime/',''));
const publish = data => {
  fs.writeFileSync(${JSON.stringify(`${result}.tmp`)}, JSON.stringify(data));
  fs.renameSync(${JSON.stringify(`${result}.tmp`)}, ${JSON.stringify(result)});
};
try {
  const data = await readBootstrapIdentity(${JSON.stringify(scope)}, {
    load, open: () => openTmuxConnection({binary:${JSON.stringify(f.binary)},socketPath:${JSON.stringify(f.socketPath)}}),
  });
  publish({ok:true,data});
} catch (error) {
  publish({ok:false,code:error.code,message:error.message});
}
`);
  return { script, result };
}

for (const runtime of ['claude', 'codex']) {
test(`Bootstrap accepts the bound ${runtime} managed run`, async t => {
  const f = readyTmuxTarget(t, { prefix: 'bootstrap-real-', mode: 'multi', runtime, ledger: false });
  const p = probe(f);
  f.tmux('respawn-pane', '-k', '-t', '=zylos-group-origin:', process.execPath, p.script);
  for (let i = 0; i < 200 && !fs.existsSync(p.result); i++) await delay(20);
  const observed = JSON.parse(fs.readFileSync(p.result, 'utf8'));
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.data.runtime, runtime);
  assert.equal(observed.data.tmuxName, 'zylos-group-origin');
  assert.equal(observed.data.runId, 'run-1');
});

test(`Bootstrap rejects a stale ${runtime} run ID`, t => {
  const f = readyTmuxTarget(t, { prefix: 'bootstrap-outsider-', mode: 'multi', runtime, ledger: false });
  const p = probe(f);
  const paneId = f.tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{pane_id}');
  execFileSync(process.execPath, [p.script], {
    env: { ...f.env, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'old-run', TMUX_PANE: paneId },
    timeout: 10000,
  });
  const observed = JSON.parse(fs.readFileSync(p.result, 'utf8'));
  assert.deepEqual(observed, { ok: false, code: 'IDENTITY_UNAVAILABLE', message: 'Hook is not in the current managed runtime pane' });
});

test(`Legacy Bootstrap accepts a ${runtime} pane ancestor and rejects an outsider (M12)`, async t => {
  const f = readyTmuxTarget(t, { prefix: 'bootstrap-legacy-', runtime, ledger: false });
  const tmuxName = `${runtime}-main`;
  f.tmux('rename-session', '-t', '=zylos-group-origin', tmuxName);
  f.tmux('set-environment', '-u', '-t', `=${tmuxName}`, 'ZYLOS_RUN_ID');
  // Keep a native parent alive so process names come from the OS, not node argv.
  const native = path.join(f.root, runtime);
  const source = path.join(f.root, 'parent.c');
  fs.writeFileSync(source, '#include <unistd.h>\n#include <sys/wait.h>\nint main(int n,char **v){pid_t p=fork();if(p==0){execv(v[1],v+1);_exit(127);}int s;waitpid(p,&s,0);return 0;}\n');
  execFileSync('cc', [source, '-o', native], { timeout: 20000 });
  const p = probe(f, { kind: 'legacy', sessionGroup: null });
  const paneId = f.tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{pane_id}');
  execFileSync(native, [process.execPath, p.script], {
    env: { ...f.env, TMUX_PANE: paneId }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.result, 'utf8')),
    { ok: false, code: 'IDENTITY_UNAVAILABLE', message: 'Hook is not in the current managed runtime pane' });
  fs.unlinkSync(p.result);
  f.tmux('respawn-pane', '-k', '-t', `=${tmuxName}:`, native, process.execPath, p.script);
  for (let i = 0; i < 200 && !fs.existsSync(p.result); i++) await delay(20);
  const observed = JSON.parse(fs.readFileSync(p.result, 'utf8'));
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.data.runtime, runtime);
  assert.equal(observed.data.tmuxName, tmuxName);
  assert.equal(observed.data.runId, null);
  assert.ok(observed.data.runtimePid > 1);
});
}
