import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, buildDiagnosticJson } from '../../commands/doctor.js';

test('doctor selects Antigravity CLI, Gemini connectivity and adapter authentication without Claude checks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-runtime-'));
  const saved = process.env.PATH, calls = path.join(root, 'calls');
  t.after(() => { process.env.PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });
  fs.symlinkSync('/usr/bin/which', path.join(root, 'which'));
  for (const command of ['agy', 'claude', 'codex']) fs.writeFileSync(path.join(root, command),
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(command)}+' '+process.argv.slice(2).join(' ')+'\\n'); console.log('1.5.11');`, { mode: 0o755 });
  process.env.PATH = root;
  const hosts = [];
  let status = 'success', authChecks = 0;
  const collect = runtime => collectDiagnostics(new Map(), {
    resolve: () => ({ runtime, sessionGroup: null, live: { tmuxName: 'fixture' }, adapter: {
      checkAuth: async () => { authChecks++; return { status }; },
    } }),
    network: async (_, host) => { hosts.push(host); return { reachable: true, dns: true, details: {} }; },
    tmuxCheck: () => ({ installed: false }), pm2Check: () => ({ installed: false }),
    psCheck: () => ({ available: true }), modeStatus: () => null,
  });
  const version = { success: true, version: 'fixture' };
  const healthy = await collect('agy');
  let json = buildDiagnosticJson(healthy, version);
  assert.equal(healthy.display, 'Antigravity'); assert.equal(json.display, 'Antigravity');
  assert.equal(json.groups.system.checks.network.host, 'generativelanguage.googleapis.com');
  assert.equal(json.groups.ai_service.checks.cli.version, '1.5.11');
  assert.deepEqual(json.groups.ai_service.checks.autonomous, { ok: null, skipped: true });
  assert.equal(json.groups.ai_service.passed, true);
  assert.equal(json.issues.some(row => /Claude|Autonomous/.test(row.label)), false);
  status = 'failure'; json = buildDiagnosticJson(await collect('agy'), version);
  assert.match(json.issues.find(row => row.id === 'cli_not_authed').hint, /zylos runtime agy --save-apikey <key>/);
  assert.equal(json.issues.some(row => row.id === 'autonomous_off'), false);
  status = 'uncertain'; json = buildDiagnosticJson(await collect('agy'), version);
  assert.ok(json.issues.some(row => row.id === 'cli_auth_unverified'));
  fs.renameSync(path.join(root, 'agy'), path.join(root, 'agy-disabled'));
  json = buildDiagnosticJson(await collect('agy'), version);
  assert.match(json.issues.find(row => row.id === 'cli_missing').label, /Antigravity/);
  assert.equal(authChecks, 3, 'missing CLI skips auth');
  for (const runtime of ['future', 'toString']) {
    const before = hosts.length; json = buildDiagnosticJson(await collect(runtime), version);
    assert.equal(hosts.length, before, 'unknown runtimes never probe an API');
    assert.ok(json.issues.some(row => row.id === 'runtime_unknown' && /does not provide diagnostics/.test(row.hint)));
    assert.equal(json.issues.some(row => ['cli_missing', 'autonomous_off'].includes(row.id)), false);
  }
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), Array(3).fill('agy --version'));
  for (const [runtime, display, host] of [['claude', 'Claude', 'api.anthropic.com'], ['codex', 'Codex', 'api.openai.com']]) {
    status = 'failure'; const diag = await collect(runtime); json = buildDiagnosticJson(diag, version);
    assert.equal(diag.display, display); assert.equal(diag.apiHost, host);
    assert.equal(json.runtime, undefined, 'existing runtime JSON shape is retained');
    assert.deepEqual(json.groups.ai_service.checks.autonomous, { ok: runtime === 'codex' });
    assert.equal(json.issues.find(row => row.id === 'cli_not_authed').hint,
      runtime === 'codex' ? 'Run: codex login' : 'Run zylos init to authenticate');
  }
});
