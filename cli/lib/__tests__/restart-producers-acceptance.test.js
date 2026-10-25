import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { requestRuntimeRestart } from '../request-runtime-restart.js';
import { submit } from '../am-sock-client.js';
import { upgradeRuntime } from '../../../skills/upgrade-claude/scripts/upgrade.js';
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function loadProducer(file, replacements, outputKey) {
  let source = fs.readFileSync(file, 'utf8');
  if (outputKey) source = source.replaceAll('console.log(', `globalThis[${JSON.stringify(outputKey)}].output(`).replaceAll('console.error(', `globalThis[${JSON.stringify(outputKey)}].output(`).replaceAll('process.stdout.write(', `globalThis[${JSON.stringify(outputKey)}].output(`);
  for (const [relative, url] of Object.entries(replacements)) {
    assert.ok(source.includes(`from '${relative}'`), relative);
    source = source.replaceAll(`from '${relative}'`, `from '${url}'`);
  }
  source = source.replace(/from '(\.[^']+)'/g, (_, relative) => `from '${new URL(relative, file).href}'`);
  return import(data(source));
}
async function fixture(t, response) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-producers-')); const socketPath = path.join(root, 'am.sock');
  const requests = [], peers = new Set(), trace = [];
  const server = net.createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
    let bytes = ''; socket.on('data', chunk => { bytes += chunk; if (!bytes.includes('\n')) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf('\n'))); requests.push(request); trace.push('submit');
      if (response === 'timeout') return;
      if (response === 'uncertain') socket.end('{"ok":');
      else socket.end(JSON.stringify({ version: 1, type: request.type, requestId: request.requestId,
        ...(response === 'accepted' ? { ok: true, result: 'accepted', runCount: 2 } : { ok: false, code: 'manual_restart_pending' }) }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const restart = (options = {}) => requestRuntimeRestart({ ...options, readMode: () => ({ mode: 'multi' }), readTransition: () => null,
    send: (request, options) => submit(request, { ...options, socketPath, replyMaxMs: 20 }), lookup: async () => { trace.push('lookup'); return 'unknown'; },
    enqueueExit: () => { throw new Error('must not fallback to /exit'); } });
  return { root, requests, trace, restart };
}
async function invoke(t, producer, response, repeatOnUnknown = false) {
  const f = await fixture(t, response); const key = `producer_${randomUUID()}`;
  globalThis[key] = { ...f, restart: async (options) => {
    if (producer === 'component') assert.deepEqual(options, { afterServiceRestart: true });
    const result = await f.restart(options); if (repeatOnUnknown && result.error?.code === 'restart_result_unknown') await f.restart(); return result;
  } };
  t.after(() => { delete globalThis[key]; });
  const ref = `globalThis[${JSON.stringify(key)}]`;
  const requestModule = data(`export const requestRuntimeRestart = options => ${ref}.restart(options);`);
  const priorArgv = process.argv, priorExitCode = process.exitCode, output = [];
  globalThis[key].output = (...args) => { output.push(args.join(' ')); return true; };
  try {
    process.argv = ['node', 'fixture', '--json', '--yes'];
    if (producer === 'component') {
      const self = data(`const f=${ref}; export const checkForCoreUpdates=()=>({success:true,hasUpdate:true,current:'1.0.0',latest:'1.0.1'});
        export const downloadCoreToTemp=()=>({success:true,tempDir:f.root}); export const readChangelog=()=>'';
        export const cleanupTemp=()=>{}; export const cleanupBackup=()=>{};
        export const runSelfUpgrade=()=>{f.trace.push('install');return {success:true,instructionFilesRebuilt:true,from:'1.0.0',to:'1.0.1'};};`);
      const locks = data('export const acquireLock=()=>({success:true}); export const releaseLock=()=>{};');
      const module = await loadProducer(new URL('../../commands/component.js', import.meta.url), {
        '../lib/self-upgrade.js': self, '../lib/lock.js': locks, '../lib/request-runtime-restart.js': requestModule,
      }, key);
      await module.upgradeComponent(['--self', '--json', '--yes']);
    } else if (producer === 'restart') {
      const loader = data(`export const loadCoreModule=()=>import(${JSON.stringify(requestModule)});`);
      const module = await loadProducer(new URL('../../../skills/restart-claude/scripts/restart.js', import.meta.url), {
        '../../activity-monitor/scripts/core-modules.js': loader,
      }, key);
      await module.main(['--json']);
    } else {
      const result = await upgradeRuntime({ readMode: () => ({ mode: 'multi' }), readTransition: () => null,
        install: () => f.trace.push('install'), requestRestart: () => globalThis[key].restart(),
        enqueue: () => { throw new Error('must not enqueue'); }, waitForExit: () => { throw new Error('must not poll'); } });
      output.push(JSON.stringify(result));
    }
  } finally { process.argv = priorArgv; process.exitCode = priorExitCode; }
  assert.equal(f.requests.length, 1, `${producer}/${response} submits exactly once`);
  assert.equal(f.requests[0].type, 'restart_all'); assert.equal(f.requests[0].reason, 'upgrade');
  assert.deepEqual(f.trace, [...(producer === 'restart' ? [] : ['install']), 'submit', ...(['uncertain', 'timeout'].includes(response) ? ['lookup'] : [])]);
  const all = output.join('\n');
  if (response === 'rejected') assert.match(all, /manual_restart_pending/);
  if (['uncertain', 'timeout'].includes(response)) assert.match(all, /restart_result_unknown/);
  if (response === 'accepted') assert.match(all, /accepted/);
  if (producer === 'component' && response !== 'accepted') {
    const report=JSON.parse(output.find(line=>line.trim().startsWith('{')));
    assert.equal(report.runtimeRestart.ok,false);assert.doesNotMatch(report.reply,/No action needed/);
    if(response==='rejected') assert.match(report.reply,/All currently running managed sessions, including Origin, need manual restart/);
    else assert.match(report.reply,/do not resubmit automatically/);
  }
}
test('IB-17 actual component/restart/upgrade entry producers: Unix Sock success, refusal and uncertain result', async t => {
  for (const producer of ['component', 'restart', 'upgrade']) for (const response of ['accepted', 'rejected', 'uncertain', 'timeout']) await invoke(t, producer, response);
});
test('IB-17 producer acceptance rejects automatic resubmission after uncertain delivery', async t => {
  for (const producer of ['component', 'restart', 'upgrade']) await assert.rejects(invoke(t, producer, 'uncertain', true), { code: 'ERR_ASSERTION' });
});
