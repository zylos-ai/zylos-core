import { runtimeAuthFixture } from './helpers/runtime-auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, buildDiagnosticJson } from '../../commands/doctor.js';

test('doctor selects runtime CLI and authentication checks through the implementation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-runtime-'));
  const saved = process.env.PATH, calls = path.join(root, 'calls');
  t.after(() => { process.env.PATH = saved; fs.rmSync(root, { recursive: true, force: true }); });
  fs.symlinkSync('/usr/bin/which', path.join(root, 'which'));
  for (const command of ['agy', 'claude', 'codex']) fs.writeFileSync(path.join(root, command),
    `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(calls)}, process.argv[1]+' '+process.argv.slice(2).join(' ')+'\\n'); console.log('1.5.11');`, { mode: 0o755 });
  process.env.PATH = root;
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'AGY_BIN', 'CLAUDE_BIN', 'CODEX_BIN']) {
    const value = process.env[name];
    delete process.env[name];
    t.after(() => { if (value !== undefined) process.env[name] = value; });
  }
  let status = 'success', authChecks = 0;
  const collect = (runtime, env = new Map()) => collectDiagnostics(env, {
    resolve: async () => {
      const runtimeImpl = await runtimeAuthFixture(runtime, {
        auth: { checkAuth: async () => { authChecks++; return { status }; } },
      });
      return { runtime, sessionGroup: null, live: { tmuxName: 'fixture' }, runtimeImpl };
    },
    tmuxCheck: () => ({ installed: false }), pm2Check: () => ({ installed: false }),
    psCheck: () => ({ available: true }), modeStatus: () => null,
  });
  const version = { success: true, version: 'fixture' };
  const healthy = await collect('agy');
  let json = buildDiagnosticJson(healthy, version);
  assert.equal(healthy.display, 'Antigravity'); assert.equal(json.display, 'Antigravity');
  assert.equal(json.groups.ai_service.checks.cli.version, '1.5.11');
  assert.deepEqual(json.groups.ai_service.checks.autonomous, { ok: null, skipped: true });
  assert.equal(json.groups.ai_service.passed, true);
  assert.equal(json.issues.some(row => /Claude|Autonomous/.test(row.label)), false);
  status = 'failure'; json = buildDiagnosticJson(await collect('agy'), version);
  assert.match(json.issues.find(row => row.id === 'cli_not_authed').hint, /zylos runtime agy --save-apikey <key>/);
  assert.equal(json.issues.some(row => row.id === 'autonomous_off'), false);
  status = 'uncertain'; json = buildDiagnosticJson(await collect('agy'), version);
  assert.equal(json.issues.find(row => row.id === 'cli_auth_unverified').hint,
    'Check the network connection and firewall, then retry');
  json = buildDiagnosticJson(await collect('agy', new Map([['HTTPS_PROXY', 'http://127.0.0.1:7890']])), version);
  assert.equal(json.issues.find(row => row.id === 'cli_auth_unverified').hint,
    'Check the network and HTTPS_PROXY in .env (current: http://127.0.0.1:7890), then retry');
  assert.equal(json.groups.ai_service.skipped, false);
  assert.equal(json.groups.ai_service.passed, false);
  assert.equal(json.issues.some(row => row.id === 'network_unreachable'), false);
  fs.renameSync(path.join(root, 'agy'), path.join(root, 'agy-disabled'));
  json = buildDiagnosticJson(await collect('agy'), version);
  assert.match(json.issues.find(row => row.id === 'cli_missing').label, /Antigravity/);
  assert.equal(authChecks, 4, 'missing CLI skips auth');
  for (const runtime of ['future', 'toString']) {
    json = buildDiagnosticJson(await collect(runtime), version);
    assert.equal(json.groups.ai_service.skipped, true);
    assert.equal(json.groups.ai_service.passed, null);
    assert.deepEqual(json.groups.ai_service.checks.autonomous, { ok: null, skipped: true });
    assert.ok(json.issues.some(row => row.id === 'runtime_unknown' && /does not provide diagnostics/.test(row.hint)));
    assert.equal(json.issues.some(row => ['cli_missing', 'autonomous_off'].includes(row.id)), false);
  }
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), Array(4).fill(`${path.join(root, 'agy')} --version`));
  for (const [runtime, display] of [['claude', 'Claude'], ['codex', 'Codex']]) {
    status = 'failure'; const diag = await collect(runtime); json = buildDiagnosticJson(diag, version);
    assert.equal(diag.display, display);
    assert.equal(json.runtime, runtime);
    assert.equal(json.display, display);
    assert.deepEqual(json.groups.ai_service.checks.autonomous,
      runtime === 'codex' ? { ok: null, skipped: true } : { ok: false });
    assert.equal(json.issues.find(row => row.id === 'cli_not_authed').hint,
      `Replace credentials or log in again with zylos auth ${runtime}`);
    const config = path.join(os.homedir(), '.claude');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'settings.json'), '{"skipDangerousModePermissionPrompt":true}');
    status = 'success';
    json = buildDiagnosticJson(await collect(runtime), version);
    assert.equal(json.groups.system.checks.network, undefined);
    assert.equal(json.groups.ai_service.passed, true);
    assert.deepEqual(json.groups.ai_service.checks.autonomous,
      runtime === 'codex' ? { ok: null, skipped: true } : { ok: true });
  }
});
