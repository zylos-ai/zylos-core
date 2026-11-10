import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { ZYLOS_DIR } from '../config.js';
import {
  parseInitFlags, resolveFromEnv, resolveInitBaseUrl, validateInitOptions, validateInitInput, printInitHelp,
  promptClaudeApiCredential, authenticateClaudeApiCredential, authenticateCodexApiCredential, persistInitCredentials,
  runInitAuthentication, continueInitAfterPersistence, consumeInitAuthenticationResult,
} from '../../commands/init.js';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value && value.startsWith(isolationRoot + path.sep), 'auth tests require the official isolated runner');
console.log('Init credential isolation:', JSON.stringify({ root: isolationRoot, ...isolation, resources: 'localhost HTTP only; no PM2, tmux or database' }));

const authEnv = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'];
function isolatedCredentials(t) {
  const original = new Map(['HOME', 'PATH', ...authEnv].map(key => [key, process.env[key]]));
  for (const key of authEnv) delete process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-credential-'));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "test version\\n"; else printf \'{"loggedIn":true}\\n\'; fi\n', { mode: 0o755 });
  process.env.HOME = home; process.env.PATH = bin + path.delimiter + original.get('PATH');
  t.after(() => {
    for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}
async function endpoint(t, status, inspect = () => {}) {
  const server = http.createServer((req, res) => { inspect(req); res.writeHead(status); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('flags and help expose explicit API-key and Bearer-token choices without printing values', () => {
  const credential = crypto.randomUUID(); const opts = parseInitFlags(['--auth-token', credential, '--base-url', 'https://relay.example/prefix']);
  assert.equal(opts.authToken === credential, true); assert.equal(opts.apiKey, null);
  let help = ''; const before = console.log; console.log = line => { help += String(line); };
  try { printInitHelp(); } finally { console.log = before; }
  assert.match(help, /--auth-token <token>/); assert.match(help, /ANTHROPIC_AUTH_TOKEN/); assert.match(help, /x-api-key/); assert.match(help, /Authorization: Bearer/);
  assert.equal(help.includes(credential), false);
});

for (const both of [false, true]) test(`existing Claude login ignores ambient credentials${both ? ' even when both kinds are set' : ''}`, async t => {
  isolatedCredentials(t); process.env.ANTHROPIC_AUTH_TOKEN = crypto.randomUUID();
  if (both) process.env.ANTHROPIC_API_KEY = crypto.randomUUID();
  const opts = parseInitFlags([]); resolveFromEnv(opts);
  assert.equal(opts.authToken, null); assert.equal(opts.apiKey, null); assert.equal(opts.setupToken, null);
  assert.equal(validateInitOptions(opts), null);
  const calls = [];
  const result = await runInitAuthentication(opts, {
    runtime: 'claude', quiet: true, exists: () => true, claudeStatus: () => true,
    authClaude: () => { calls.push('verify-api'); return false; },
    setupSave: () => { calls.push('save-setup'); return false; },
    resolveBase: () => { calls.push('resolve-base'); },
  });
  assert.deepEqual(calls, []); assert.equal(result.failed, undefined);
  assert.equal(result.claudeAuthenticated, true); assert.equal(result.pendingAuthToken, null); assert.equal(result.pendingApiKey, null);
});

test('unauthenticated ambient API inputs remain mutually exclusive and explicit flags select their own kind', t => {
  isolatedCredentials(t); process.env.ANTHROPIC_API_KEY = crypto.randomUUID(); process.env.ANTHROPIC_AUTH_TOKEN = crypto.randomUUID();
  const opts = parseInitFlags([]); resolveFromEnv(opts, { authenticated: () => false });
  assert.match(validateInitOptions(opts), /mutually exclusive/); assert.equal(opts.authFromEnv, true);
  for (const kind of ['api-key', 'auth-token', 'setup-token']) {
    const value = kind === 'setup-token' ? 'sk-ant-oat-' + crypto.randomUUID() : crypto.randomUUID();
    const explicit = parseInitFlags(['--' + kind, value, '--base-url', 'https://relay.example']);
    let loginLookups = 0;
    resolveFromEnv(explicit, { authenticated: () => { loginLookups += 1; return true; } });
    assert.equal(loginLookups, 0);
    assert.equal(validateInitOptions(explicit), null); assert.equal(explicit.authFromEnv, false);
    assert.equal([explicit.apiKey, explicit.authToken, explicit.setupToken].filter(Boolean).length, 1);
  }
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-placeholder';
  const setup = parseInitFlags([]); resolveFromEnv(setup, { authenticated: () => false }); assert.equal(setup.apiKey, null); assert.equal(setup.authToken, null);
  for (const args of [['--api-key', 'placeholder', '--auth-token', 'placeholder'], ['--setup-token', 'sk-ant-oat-placeholder', '--auth-token', 'placeholder']]) {
    assert.match(validateInitOptions(parseInitFlags(args)), /mutually exclusive/);
  }
});

test('explicit Bearer input suppresses ambient API key input symmetrically', t => {
  isolatedCredentials(t); process.env.ANTHROPIC_API_KEY = crypto.randomUUID();
  const credential = crypto.randomUUID(); const opts = parseInitFlags(['--auth-token', credential, '--base-url', 'https://relay.example']);
  resolveFromEnv(opts, { authenticated: () => false });
  assert.equal(opts.authToken === credential, true); assert.equal(opts.apiKey, null); assert.equal(opts.authFromEnv, false);
  assert.equal(validateInitOptions(opts), null);
});

test('only relay API-key formats bypass the official prefix gate and invalid URLs never echo credentials', t => {
  isolatedCredentials(t); const credential = crypto.randomUUID();
  for (const baseUrl of ['https://relay.example', 'http://127.0.0.1:8080/prefix']) assert.equal(validateInitOptions({ apiKey: credential, baseUrl }), null);
  for (const baseUrl of [undefined, 'https://api.anthropic.com', 'http://api.anthropic.com', 'https://api.anthropic.com:444']) assert.match(validateInitOptions({ apiKey: credential, baseUrl }), /sk-ant-/);
  const invalid = validateInitOptions({ authToken: credential, baseUrl: `https://user:${credential}@relay.example` });
  assert.match(invalid, /Invalid base URL/); assert.equal(invalid.includes(credential), false);
  assert.match(validateInitOptions({ authToken: credential + '\n' }), /printable ASCII/);
  for (const invalid of ['\u200b', '\uff21', '\u00e9']) {
    for (const kind of ['apiKey', 'authToken', 'codexApiKey', 'setupToken']) {
      assert.match(validateInitOptions({ [kind]: credential + invalid, baseUrl: 'https://relay.example' }), /printable ASCII/);
    }
  }
});

test('custom-address interactive prompt explicitly selects Bearer without probing the other header', async () => {
  const credential = crypto.randomUUID(); const questions = [], output = [];
  const result = await promptClaudeApiCredential({ baseUrl: 'https://relay.example' }, {
    choose: async (question, choices) => { questions.push({ question, choices }); return 2; },
    secret: async () => credential, log: value => output.push(value),
  });
  assert.equal(result.authToken === credential, true); assert.equal(result.apiKey, undefined);
  assert.equal(questions.length, 1); assert.match(questions[0].choices.join(' '), /x-api-key/); assert.match(questions[0].choices.join(' '), /Authorization: Bearer/);
  assert.equal(output.join('').includes(credential), false);
  let officialChoices = 0;
  const official = await promptClaudeApiCredential({}, { choose: () => { officialChoices += 1; return 1; }, secret: async () => 'sk-ant-placeholder', log: () => {} });
  assert.equal(typeof official.apiKey, 'string'); assert.equal(officialChoices, 0);
});

// Credential verifier + real localhost HTTP + process credential selection; settings.json is never written.
// Run on auth input/header/base/status/write changes; skip docs-only changes. HOME is private and fake claude cannot make vendor calls.
for (const kind of ['apiKey', 'authToken']) test(`selected ${kind} stage verifies at its custom base, selects only that credential and writes no settings.json`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID(), output = [];
  const baseUrl = await endpoint(t, 200, req => {
    assert.equal(req.url, '/relay/v1/messages');
    assert.equal(kind === 'authToken' ? req.headers.authorization === `Bearer ${credential}` : req.headers['x-api-key'] === credential, true);
  });
  const result = await authenticateClaudeApiCredential({ [kind]: credential, baseUrl: baseUrl + '/relay' }, { log: value => output.push(value), reportError: value => output.push(value) });
  assert.equal(result, true);
  assert.equal(process.env[kind === 'authToken' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] === credential, true);
  assert.equal(process.env[kind === 'authToken' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'], undefined);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false, 'settings.json is not created');
  assert.equal(fs.existsSync(path.join(home, 'zylos', '.env')), false, 'auth stage must defer .env to template deployment');
  assert.equal(output.join('').includes(credential), false);
});

for (const status of [401, 403, 400, 503]) test(`Claude stage handles HTTP ${status} without a secret-bearing log or false verified message`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID(), output = [];
  const baseUrl = await endpoint(t, status);
  const result = await authenticateClaudeApiCredential({ authToken: credential, baseUrl }, { log: value => output.push(value), reportError: value => output.push(value) });
  const rejected = status === 401 || status === 403;
  assert.equal(result, !rejected); assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN === credential, !rejected);
  assert.match(output.join(''), rejected ? /rejected/ : /inconclusive/);
  assert.equal(output.join('').includes('verified and saved'), false); assert.equal(output.join('').includes(credential), false);
});

test('Codex auth stage uses the selected base and native OPENAI_API_KEY store with arbitrary relay credential', { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID();
  const baseUrl = await endpoint(t, 200, req => { assert.equal(req.url, '/custom/v1/models'); assert.equal(req.headers.authorization === `Bearer ${credential}`, true); });
  assert.equal(await authenticateCodexApiCredential(credential, { baseUrl: baseUrl + '/custom/v1', quiet: true }), true);
  const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(auth.OPENAI_API_KEY === credential, true); assert.equal(auth.auth_mode, 'apikey');
});

for (const runtime of ['claude', 'codex']) test(`rejected ${runtime} replacement preserves existing credential files and endpoint without forwarding the prior secret`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), previous = crypto.randomUUID(), attempted = crypto.randomUUID(), output = [];
  const file = path.join(home, runtime === 'claude' ? '.claude/settings.json' : '.codex/auth.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = runtime === 'claude' ? JSON.stringify({ env: { ANTHROPIC_API_KEY: previous, ANTHROPIC_BASE_URL: 'https://previous.example' } })
    : JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: previous });
  fs.writeFileSync(file, content);
  if (runtime === 'claude') process.env.ANTHROPIC_BASE_URL = 'https://previous.example';
  else process.env.OPENAI_BASE_URL = 'https://previous.example/v1';
  const baseUrl = await endpoint(t, 401, req => {
    assert.equal(req.headers.authorization === `Bearer ${attempted}`, true);
    assert.equal(Object.values(req.headers).some(value => String(value).includes(previous)), false);
  });
  const hooks = { log: value => output.push(value), reportError: value => output.push(value) };
  assert.equal(runtime === 'claude' ? await authenticateClaudeApiCredential({ authToken: attempted, baseUrl }, hooks)
    : await authenticateCodexApiCredential(attempted, { baseUrl, ...hooks }), false);
  assert.equal(fs.readFileSync(file, 'utf8') === content, true);
  assert.equal(runtime === 'claude' ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL, runtime === 'claude' ? 'https://previous.example' : 'https://previous.example/v1');
  assert.equal(output.join('').includes(previous) || output.join('').includes(attempted), false);
});

// Cross-module init stage + real local verifier + native credential writes. Run for endpoint or stage wiring changes; skip docs-only changes.
for (const runtime of ['claude', 'codex']) for (const source of ['deployment environment', 'native configuration']) test(`${runtime} authentication stage verifies a credential-only replacement at its saved ${source} endpoint`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const credential = crypto.randomUUID(), requests = [], guardedCalls = [];
  const origin = await endpoint(t, 200, req => {
    requests.push(req.url);
    assert.equal(req.headers.authorization === `Bearer ${credential}`, true);
  });
  const base = origin + (runtime === 'claude' ? '/saved' : '/saved/v1');
  if (source === 'deployment environment') {
    fs.writeFileSync(path.join(zylosDir, '.env'), `${runtime === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'}=${base}\n`);
  } else {
    const native = path.join(home, runtime === 'claude' ? '.claude/settings.json' : '.codex/config.toml');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, runtime === 'claude' ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }) : `openai_base_url = "${base}"\n`);
  }
  const args = runtime === 'claude' ? ['--auth-token', credential] : ['--codex-api-key', credential];
  const opts = parseInitFlags(args); resolveFromEnv(opts);
  assert.equal(opts.baseUrl, null); assert.equal(opts.codexBaseUrl, null);
  const nativeBefore = source === 'native configuration' && runtime === 'claude' ? fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8') : null;
  const result = await runInitAuthentication(opts, { runtime, quiet: true, skipConfirm: true, exists: () => true,
    resolveBase: (options, selected) => resolveInitBaseUrl(options, selected, { home, zylosDir }),
    authClaude: (options, hooks) => { assert.equal(options.baseUrl, base); guardedCalls.push('claude'); return authenticateClaudeApiCredential(options, hooks); },
    authCodex: (value, hooks) => { assert.equal(hooks.baseUrl, base); guardedCalls.push('codex'); return authenticateCodexApiCredential(value, hooks); },
    writeCodex: () => true,
  });
  assert.equal(result.failed, undefined); assert.equal(result[runtime === 'claude' ? 'claudeAuthenticated' : 'codexAuthenticated'], true);
  assert.equal(result[runtime === 'claude' ? 'pendingClaudeBaseUrl' : 'pendingCodexBaseUrl'], base);
  assert.deepEqual(guardedCalls, [runtime]); assert.deepEqual(requests, [runtime === 'claude' ? '/saved/v1/messages' : '/saved/v1/models']);
  if (runtime === 'claude') {
    // The credential is selected for this run and saved to .env later; settings.json is only read.
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN === credential, true);
    const settingsFile = path.join(home, '.claude/settings.json');
    if (nativeBefore === null) assert.equal(fs.existsSync(settingsFile), false);
    else assert.equal(fs.readFileSync(settingsFile, 'utf8'), nativeBefore);
  } else {
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.codex/auth.json'), 'utf8')).OPENAI_API_KEY === credential, true);
  }
});

for (const runtime of ['claude', 'codex']) test(`${runtime} endpoint resolution prefers explicit input then environment then deployment configuration`, t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const envKey = runtime === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
  const args = runtime === 'claude' ? ['--auth-token', crypto.randomUUID()] : ['--codex-api-key', crypto.randomUUID()];
  fs.writeFileSync(path.join(zylosDir, '.env'), `${envKey}=https://deployment.example\nANTHROPIC_AUTH_TOKEN=unused\n`);
  const deployment = parseInitFlags(args); resolveFromEnv(deployment); resolveInitBaseUrl(deployment, runtime, { home, zylosDir });
  assert.equal(runtime === 'claude' ? deployment.baseUrl : deployment.codexBaseUrl, 'https://deployment.example');
  process.env[envKey] = 'https://environment.example';
  const environment = parseInitFlags(args); resolveFromEnv(environment); resolveInitBaseUrl(environment, runtime, { home, zylosDir });
  assert.equal(runtime === 'claude' ? environment.baseUrl : environment.codexBaseUrl, 'https://environment.example');
  const explicit = parseInitFlags([...args, runtime === 'claude' ? '--base-url' : '--codex-base-url', 'https://explicit.example']);
  resolveFromEnv(explicit); resolveInitBaseUrl(explicit, runtime, { home, zylosDir });
  assert.equal(runtime === 'claude' ? explicit.baseUrl : explicit.codexBaseUrl, 'https://explicit.example');
});

for (const runtime of ['claude', 'codex']) test(`malformed saved ${runtime} endpoint is read only for API verification and fails without a stack or secret`, async t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const native = path.join(home, runtime === 'claude' ? '.claude/settings.json' : '.codex/config.toml'); fs.mkdirSync(path.dirname(native));
  const credential = crypto.randomUUID(); fs.writeFileSync(native, runtime === 'claude' ? '{"secret":"' + credential : 'broken = [');
  const resolveBase = (opts, chosen) => resolveInitBaseUrl(opts, chosen, { home, zylosDir });
  const ordinary = parseInitFlags([]); resolveFromEnv(ordinary, { authenticated: () => true });
  const hooks = { runtime, skipConfirm: true, quiet: true, exists: () => true, claudeStatus: () => true, codexStatus: () => true,
    resolveBase, writeCodex: () => true };
  const normal = await runInitAuthentication(ordinary, hooks);
  assert.equal(normal.failed, undefined); assert.equal(normal.exitCode, 0);
  const output = [], args = runtime === 'claude' ? ['--auth-token', credential] : ['--codex-api-key', credential];
  const api = parseInitFlags(args); resolveFromEnv(api, { authenticated: () => true });
  const authCalls = [];
  const failed = await runInitAuthentication(api, { ...hooks, reportError: message => output.push(message),
    authClaude: () => { authCalls.push('claude'); return false; },
    authCodex: () => { authCalls.push('codex'); return false; } });
  assert.deepEqual(authCalls, []); assert.equal(failed.failed, true); assert.equal(failed.exitCode, 1); assert.equal(output.length, 1);
  assert.match(output[0], /Could not read saved API endpoint/); assert.equal(output[0].includes(credential), false); assert.doesNotMatch(output[0], /\n\s+at /);
  const explicit = parseInitFlags([...args, runtime === 'claude' ? '--base-url' : '--codex-base-url', 'https://explicit.example']);
  assert.doesNotThrow(() => resolveBase(explicit, runtime));
});

// Interactive stage + saved native parser only. Run for API preparation/error handling changes;
// skip docs-only changes. Private HOME, recorded auth stubs, no HTTP or installer.
for (const runtime of ['claude', 'codex']) test(`interactive ${runtime} API choice stops on malformed saved configuration before credential verification`, async t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const credential = crypto.randomUUID(), calls = [], output = [];
  const native = path.join(home, runtime === 'claude' ? '.claude/settings.json' : '.codex/config.toml');
  fs.mkdirSync(path.dirname(native));
  fs.writeFileSync(native, runtime === 'claude' ? '{"secret":"' + credential : 'broken = [');
  const result = await runInitAuthentication(parseInitFlags([]), {
    runtime, quiet: true, exists: () => true, claudeStatus: () => false, codexStatus: () => false,
    choose: async () => { calls.push('choose'); return runtime === 'claude' ? 2 : 1; },
    resolveBase: (opts, chosen) => resolveInitBaseUrl(opts, chosen, { home, zylosDir }),
    promptClaude: async () => { calls.push('prompt-credential'); return { authToken: credential }; },
    secret: async () => { calls.push('prompt-credential'); return credential; },
    authClaude: async () => { calls.push('verify-claude'); return false; },
    authCodex: async () => { calls.push('verify-codex'); return false; },
    writeCodex: () => { calls.push('write-config'); return true; },
    log: message => output.push(message), reportError: message => output.push(message),
  });
  assert.equal(result.failed, true); assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, ['choose']);
  assert.equal(result.pendingClaudeBaseUrl, null); assert.equal(result.pendingCodexBaseUrl, null);
  assert.match(output.join(''), /Could not read saved API endpoint/);
  assert.equal(output.join('').includes(credential), false); assert.doesNotMatch(output.join(''), /\n\s+at /);
});

test('unexpected endpoint resolution errors propagate without invoking authentication', async t => {
  isolatedCredentials(t); const expected = new Error('controlled endpoint lookup failure'), calls = [];
  await assert.rejects(runInitAuthentication(parseInitFlags(['--auth-token', crypto.randomUUID()]), {
    runtime: 'claude', quiet: true, exists: () => true,
    resolveBase: () => { throw expected; },
    authClaude: async () => { calls.push('verify'); return false; },
  }), error => error === expected);
  assert.deepEqual(calls, []);
});

for (const key of ['apiKey', 'authToken', 'setupToken']) test(`post-template ${key} persistence failure stops before any base writer`, () => {
  const calls = [], output = [], credential = crypto.randomUUID();
  const fail = () => { calls.push('credential'); return false; };
  assert.equal(persistInitCredentials({ [key]: credential, claudeBaseUrl: 'https://relay.example', codexBaseUrl: 'https://codex.example/v1' }, {
    saveKeyEnv: fail, saveTokenEnv: fail, saveSetupEnv: fail,
    saveClaudeBase: () => { calls.push('base'); return true; }, saveCodexBase: () => { calls.push('base'); return true; },
    saveCodexConfig: () => { calls.push('config'); return true; }, reportError: message => output.push(message),
  }), false);
  assert.deepEqual(calls, ['credential']); assert.match(output.join(''), /Initialization stopped before starting services/);
  assert.equal(output.join('').includes(credential), false);
});

test('post-template native environment EISDIR failure is reported without writing the new endpoint', t => {
  isolatedCredentials(t); const envFile = path.join(ZYLOS_DIR, '.env');
  const existed = fs.existsSync(envFile), previous = existed ? fs.readFileSync(envFile) : null;
  if (existed) fs.unlinkSync(envFile);
  fs.mkdirSync(envFile);
  t.after(() => { fs.rmdirSync(envFile); if (previous) fs.writeFileSync(envFile, previous); });
  let baseWrites = 0; const output = [];
  assert.equal(persistInitCredentials({ authToken: crypto.randomUUID(), claudeBaseUrl: 'https://new.example' }, {
    saveClaudeBase: () => { baseWrites += 1; return true; }, reportError: message => output.push(message),
  }), false);
  assert.equal(baseWrites, 0); assert.match(output.join(''), /Failed to persist runtime credentials/);
});

test('post-template endpoint and Codex-config writer failures propagate and success writes each pending value once', () => {
  const output = [], calls = [];
  assert.equal(persistInitCredentials({ claudeBaseUrl: 'https://relay.example' }, { saveClaudeBase: () => false, reportError: message => output.push(message) }), false);
  assert.equal(persistInitCredentials({ codexBaseUrl: 'https://relay.example/v1' }, {
    saveCodexBase: () => true, saveCodexConfig: () => false, reportError: message => output.push(message),
  }), false);
  assert.equal(persistInitCredentials({ authToken: crypto.randomUUID(), claudeBaseUrl: 'https://relay.example', codexBaseUrl: 'https://codex.example/v1' }, {
    saveTokenEnv: () => { calls.push('token'); return true; }, saveClaudeBase: () => { calls.push('claudeBase'); return true; },
    saveCodexBase: () => { calls.push('codexBase'); return true; }, saveCodexConfig: () => { calls.push('codexConfig'); return true; },
  }), true);
  assert.deepEqual(calls, ['token', 'claudeBase', 'codexBase', 'codexConfig']); assert.equal(output.length, 2);
});

test('saved endpoint assignments accept horizontal whitespace recognized by environment readers', t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  fs.writeFileSync(path.join(zylosDir, '.env'), '\u00a0ANTHROPIC_BASE_URL\u00a0=\u00a0https://saved.example\n');
  const opts = parseInitFlags(['--auth-token', crypto.randomUUID()]); resolveFromEnv(opts); resolveInitBaseUrl(opts, 'claude', { home, zylosDir });
  assert.equal(opts.baseUrl, 'https://saved.example');
});

// Exercise the same selected-runtime orchestration called by initCommand, with no installer or services.
for (const runtime of ['claude', 'codex']) for (const accepted of [true, false]) test(`${runtime} authentication ${accepted ? 'stages its endpoint after verification' : 'rejects without activating or staging the endpoint'}`, async t => {
  isolatedCredentials(t); const credential = crypto.randomUUID(), calls = [], output = [];
  const envKey = runtime === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
  process.env[envKey] = 'https://previous.example';
  const base = 'https://selected.example/v1';
  const opts = parseInitFlags(runtime === 'claude' ? ['--auth-token', credential, '--base-url', base] : ['--codex-api-key', credential, '--codex-base-url', base]);
  const auth = async (value, options) => {
    calls.push('verify'); assert.equal(process.env[envKey], 'https://previous.example');
    assert.equal(runtime === 'claude' ? value.baseUrl : options.baseUrl, base);
    assert.equal(runtime === 'claude' ? value.authToken === credential : value === credential, true);
    return accepted;
  };
  const activate = value => { calls.push('activate'); assert.equal(value, base); process.env[envKey] = value; return true; };
  const result = await runInitAuthentication(opts, { runtime, skipConfirm: true, quiet: true, exists: () => true,
    claudeStatus: () => true, codexStatus: () => true, authClaude: auth, authCodex: auth,
    saveClaudeBase: activate, saveCodexBase: activate, writeCodex: () => true, log: message => output.push(message), reportError: message => output.push(message) });
  assert.equal(result[runtime === 'claude' ? 'claudeAuthenticated' : 'codexAuthenticated'], accepted);
  assert.equal(result[runtime === 'claude' ? 'pendingClaudeBaseUrl' : 'pendingCodexBaseUrl'], accepted ? base : null);
  assert.equal(result.pendingAuthToken === credential, runtime === 'claude' && accepted);
  assert.deepEqual(calls, accepted ? ['verify', 'activate'] : ['verify']); assert.equal(result.exitCode, accepted ? 0 : 1);
  assert.equal(process.env[envKey], accepted ? base : 'https://previous.example'); assert.equal(output.join('').includes(credential), false);
});

// Cross-module interactive stage + real local verifier. Run for prompt, endpoint or stage changes; skip docs-only changes.
// HOME stays private; guarded wrappers prohibit vendor fallbacks.
for (const runtime of ['claude', 'codex']) for (const accepted of [true, false]) test(`interactive ${runtime} API choice resolves its saved endpoint and ${accepted ? 'stages it after acceptance' : 'leaves the previous endpoint on rejection'}`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const credential = crypto.randomUUID(), output = [], events = [], activations = [], guardedCalls = []; let requests = 0;
  const envKey = runtime === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
  process.env[envKey] = 'https://previous.example';
  const origin = await endpoint(t, accepted ? 200 : 401, req => {
    requests += 1; assert.equal(req.url, runtime === 'claude' ? '/chosen/v1/messages' : '/chosen/v1/models');
    assert.equal(req.headers.authorization === `Bearer ${credential}`, true); assert.equal(process.env[envKey], 'https://previous.example');
  });
  const base = origin + (runtime === 'claude' ? '/chosen' : '/chosen/v1');
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), runtime === 'claude' ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }) : '{broken');
  fs.writeFileSync(path.join(home, '.codex/config.toml'), runtime === 'codex' ? `openai_base_url = "${base}"\n` : 'broken = [');
  const opts = parseInitFlags([]); // Runtime was selected interactively after flag parsing.
  const activate = value => { activations.push(value); process.env[envKey] = value; return true; };
  const result = await runInitAuthentication(opts, { runtime, quiet: true, exists: () => true,
    claudeStatus: () => false, codexStatus: () => false,
    choose: async () => { events.push('choose'); return runtime === 'claude' ? 2 : 1; },
    resolveBase: (options, selected) => { events.push('resolve'); assert.equal(selected, runtime); resolveInitBaseUrl(options, selected, { home, zylosDir }); },
    promptClaude: async ({ baseUrl }) => { assert.equal(baseUrl, base); return { authToken: credential }; }, secret: async () => credential,
    authClaude: (options, hooks) => { assert.equal(options.baseUrl, base); guardedCalls.push('claude'); return authenticateClaudeApiCredential(options, hooks); },
    authCodex: (value, hooks) => { assert.equal(hooks.baseUrl, base); guardedCalls.push('codex'); return authenticateCodexApiCredential(value, hooks); },
    saveClaudeBase: activate, saveCodexBase: activate,
    writeCodex: () => true, log: message => output.push(message), reportError: message => output.push(message),
  });
  assert.equal(requests, 1); assert.deepEqual(events, ['choose', 'resolve']); assert.deepEqual(guardedCalls, [runtime]);
  assert.equal(result.failed, undefined); assert.equal(result[runtime === 'claude' ? 'claudeAuthenticated' : 'codexAuthenticated'], accepted);
  assert.equal(result[runtime === 'claude' ? 'pendingClaudeBaseUrl' : 'pendingCodexBaseUrl'], accepted ? base : null);
  assert.equal(result.pendingApiKey, null);
  if (runtime === 'claude') assert.equal(result.pendingAuthToken === credential, accepted);
  assert.deepEqual(activations, accepted ? [base] : []);
  assert.equal(process.env[envKey], accepted ? base : 'https://previous.example'); assert.equal(output.join('').includes(credential), false);
});

for (const kind of ['apiKey', 'authToken']) test(`explicit ${kind} replaces an existing Claude login through the real authentication stage`, async t => {
  isolatedCredentials(t); const credential = crypto.randomUUID(), calls = [];
  const flag = { apiKey: '--api-key', authToken: '--auth-token' }[kind];
  const opts = parseInitFlags([flag, credential, '--base-url', 'https://relay.example']);
  const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true, quiet: true, exists: () => true,
    claudeStatus: () => true, authClaude: async value => { calls.push('api'); assert.equal(value[kind] === credential, true); return true; },
    setupSave: () => { calls.push('setup'); return false; }, saveClaudeBase: () => true });
  assert.equal(result.claudeAuthenticated, true); assert.equal(result[{ apiKey: 'pendingApiKey', authToken: 'pendingAuthToken' }[kind]] === credential, true);
  assert.deepEqual(calls, ['api']);
});

test('explicit setup token preserves an existing Claude login without saving or verifying the replacement', async t => {
  const home = isolatedCredentials(t), credential = 'sk-ant-oat-' + crypto.randomUUID(), calls = [];
  const file = path.join(home, '.claude/settings.json'); fs.mkdirSync(path.dirname(file));
  const previous = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: crypto.randomUUID() } }); fs.writeFileSync(file, previous);
  const result = await runInitAuthentication(parseInitFlags(['--setup-token', credential]), { runtime: 'claude', skipConfirm: true, quiet: true, exists: () => true,
    claudeStatus: () => true,
    setupSave: () => { calls.push('save'); return true; }, setupVerify: () => { calls.push('verify'); return { valid: false, authError: true }; },
    setupRollback: () => { calls.push('rollback'); },
  });
  assert.equal(result.failed, undefined); assert.equal(result.claudeAuthenticated, true); assert.equal(result.pendingSetupToken, null);
  assert.deepEqual(calls, []); assert.equal(fs.readFileSync(file, 'utf8') === previous, true);
});

test('Claude selection retains an explicit Codex base-only change even with an ambient OpenAI key', async t => {
  isolatedCredentials(t); process.env.OPENAI_API_KEY = crypto.randomUUID();
  const calls = [], base = 'https://codex.example/v1', opts = parseInitFlags(['--codex-base-url', base]); resolveFromEnv(opts, { authenticated: () => true });
  const result = await runInitAuthentication(opts, { runtime: 'claude', quiet: true, exists: () => true, claudeStatus: () => true,
    authCodex: () => { calls.push('verify'); return false; }, saveCodexBase: value => { calls.push('save'); assert.equal(value, base); return true; } });
  assert.equal(result.pendingCodexBaseUrl, base); assert.deepEqual(calls, ['save']);
});

for (const accepted of [false, true]) test(`post-template continuation ${accepted ? 'starts only after successful persistence' : 'stops service startup on persistence failure'}`, async () => {
  const calls = [], credential = crypto.randomUUID();
  const result = await continueInitAfterPersistence({ authToken: credential }, async () => { calls.push('start-services'); }, {
    persist: values => { calls.push('persist'); assert.equal(values.authToken === credential, true); return accepted; },
    onFailure: () => { calls.push('failure'); },
  });
  assert.equal(result, accepted); assert.deepEqual(calls, accepted ? ['persist', 'start-services'] : ['persist', 'failure']);
});

test('interactive setup token rejects invisible characters before saving or verification', async t => {
  isolatedCredentials(t); const credential = 'sk-ant-oat-' + crypto.randomUUID() + '\u200b', output = [], calls = [];
  const result = await runInitAuthentication(parseInitFlags([]), { runtime: 'claude', quiet: true, exists: () => true, claudeStatus: () => false,
    choose: async () => 3, secret: async () => credential,
    setupSave: () => { calls.push('save'); return false; }, setupVerify: () => { calls.push('verify'); return { valid: false }; },
    log: message => output.push(message), reportError: message => output.push(message),
  });
  assert.equal(result.claudeAuthenticated, false); assert.equal(result.pendingSetupToken, null); assert.deepEqual(calls, []);
  assert.match(output.join(''), /printable ASCII/); assert.equal(output.join('').includes(credential), false);
});

for (const runtime of ['claude', 'codex']) for (const available of [true, false]) test(`base-only ${runtime} change enters pending persistence with ${available ? 'an available' : 'an unavailable'} CLI without API verification`, async t => {
  isolatedCredentials(t); const base = 'https://selected.example/v1', calls = [];
  const opts = parseInitFlags([runtime === 'claude' ? '--base-url' : '--codex-base-url', base]);
  const result = await runInitAuthentication(opts, { runtime, quiet: true, skipConfirm: true, exists: () => available,
    claudeStatus: () => true, codexStatus: () => true,
    resolveBase: () => { calls.push('resolve'); }, authClaude: () => { calls.push('claude-verify'); return false; }, authCodex: () => { calls.push('codex-verify'); return false; },
    saveClaudeBase: value => { calls.push('save'); assert.equal(value, base); return true; }, saveCodexBase: value => { calls.push('save'); assert.equal(value, base); return true; },
    writeCodex: () => true,
  });
  assert.equal(result.failed, undefined); assert.equal(result[runtime === 'claude' ? 'pendingClaudeBaseUrl' : 'pendingCodexBaseUrl'], base);
  assert.deepEqual(calls, ['save']);
});

for (const [runtime, kind, flag] of [['claude', 'API key', '--api-key'], ['claude', 'Bearer token', '--auth-token'], ['codex', 'API key', '--codex-api-key']]) test(`unavailable ${runtime} CLI never activates a new endpoint supplied with an unverified ${kind}`, async t => {
  isolatedCredentials(t); const credential = crypto.randomUUID(), calls = [];
  const envKey = runtime === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'; process.env[envKey] = 'https://previous.example';
  const args = [flag, credential, runtime === 'claude' ? '--base-url' : '--codex-base-url', 'https://new.example/v1'];
  const result = await runInitAuthentication(parseInitFlags(args), { runtime, quiet: true, skipConfirm: true, exists: () => false,
    authClaude: () => { calls.push('verify'); return false; }, authCodex: () => { calls.push('verify'); return false; },
    saveClaudeBase: () => { calls.push('activate'); return true; }, saveCodexBase: () => { calls.push('activate'); return true; },
  });
  assert.deepEqual(calls, []); assert.equal(result.pendingClaudeBaseUrl, null); assert.equal(result.pendingCodexBaseUrl, null);
  assert.equal(result.pendingAuthToken, null); assert.equal(result.pendingApiKey, null); assert.equal(process.env[envKey], 'https://previous.example');
});

for (const setupLike of [false, true]) test(`official API key ${setupLike ? 'setup-token mix-up' : 'missing prefix'} reports its original diagnostic without a verification request`, async t => {
  isolatedCredentials(t); const credential = (setupLike ? 'sk-ant-oat-' : '') + crypto.randomUUID(), output = [], calls = [];
  const result = await runInitAuthentication(parseInitFlags(['--api-key', credential, '--base-url', 'https://api.anthropic.com']), {
    runtime: 'claude', quiet: true, skipConfirm: true, exists: () => true, claudeStatus: () => true,
    authClaude: () => { calls.push('request'); return false; }, reportError: message => output.push(message),
  });
  assert.equal(result.failed, true); assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
  assert.match(output.join(''), setupLike ? /That looks like a setup token/ : /Invalid API key.*sk-ant-/s);
  assert.doesNotMatch(output.join(''), /Could not read or apply API endpoint/); assert.equal(output.join('').includes(credential), false);
});

test('unexpected authentication dependency errors propagate instead of becoming a configuration failure', async t => {
  isolatedCredentials(t); const expected = new Error('controlled authentication failure');
  await assert.rejects(runInitAuthentication(parseInitFlags(['--auth-token', crypto.randomUUID(), '--base-url', 'https://relay.example']), {
    runtime: 'claude', quiet: true, exists: () => true, authClaude: () => { throw expected; },
  }), error => error === expected);
});

const relayFlag = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
// Seed an install with the setting on in .env and process.env, the given saved
// Claude base URL (none when omitted), optional extra .env lines, and a
// hand-configured settings.json that must stay byte-identical.
function seedRelayFlag(t, home, baseUrl, extraEnv = '') {
  const envFile = path.join(ZYLOS_DIR, '.env'), settingsFile = path.join(home, '.claude', 'settings.json');
  const previous = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null, previousFlag = process.env[relayFlag];
  t.after(() => {
    if (previous) fs.writeFileSync(envFile, previous); else fs.rmSync(envFile, { force: true });
    if (previousFlag === undefined) delete process.env[relayFlag]; else process.env[relayFlag] = previousFlag;
  });
  fs.writeFileSync(envFile, `KEEP=unchanged\n${baseUrl ? `ANTHROPIC_BASE_URL=${baseUrl}\n` : ''}${relayFlag}=1\n${extraEnv}`);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settingsText = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://hand-relay.example', ANTHROPIC_API_KEY: 'sk-ant-api03-hand' } }, null, 4) + '\n\n';
  fs.writeFileSync(settingsFile, settingsText);
  process.env[relayFlag] = '1';
  return () => ({
    env: fs.readFileSync(envFile, 'utf8').includes(relayFlag),
    process: process.env[relayFlag],
    settingsUntouched: fs.readFileSync(settingsFile, 'utf8') === settingsText,
  });
}
const ON = { env: true, process: '1', settingsUntouched: true }, OFF = { env: false, process: undefined, settingsUntouched: true };
async function subscriptionLogin() {
  let statusCalls = 0, logins = 0;
  const result = await runInitAuthentication(parseInitFlags([]), { runtime: 'claude', quiet: true, exists: () => true,
    claudeStatus: () => statusCalls++ > 0, choose: async () => 1, nativeLogin: () => { logins += 1; }, log: () => {},
  });
  assert.equal(logins, 1); assert.equal(result.claudeAuthenticated, true); assert.equal(result.subscriptionLogin, true);
  return result;
}

for (const [where, baseUrl, leftoverKey, expected] of [
  ['without a base URL, with a leftover API key', undefined, true, ON],
  ['on the official API, with a leftover API key', 'https://api.anthropic.com', true, ON],
  ['behind a saved relay, with a leftover API key', 'https://relay.example', true, ON],
  ['without a base URL or saved credential', undefined, false, OFF],
  ['on the official API without a saved credential', 'https://api.anthropic.com', false, OFF],
  ['behind a saved relay without a saved credential', 'https://relay.example', false, ON],
]) {
  test(`init subscription login ${where} leaves the relay traffic setting ${expected === ON ? 'on' : 'off'}`, async t => {
    const state = seedRelayFlag(t, isolatedCredentials(t), baseUrl, leftoverKey ? `ANTHROPIC_API_KEY=sk-ant-api03-${crypto.randomUUID()}\n` : '');
    const result = await subscriptionLogin();
    assert.equal(persistInitCredentials({ setupToken: result.pendingSetupToken, subscriptionLogin: result.subscriptionLogin,
      claudeBaseUrl: result.pendingClaudeBaseUrl }), true);
    assert.deepEqual(state(), expected);
  });
}

for (const [where, baseUrl] of [['without a base URL', undefined], ['on the official API', 'https://api.anthropic.com']]) {
  test(`zylos init --auth-token ${where} turns the relay traffic setting on`, t => {
    const state = seedRelayFlag(t, isolatedCredentials(t), baseUrl);
    fs.writeFileSync(path.join(ZYLOS_DIR, '.env'), `KEEP=unchanged\n${baseUrl ? `ANTHROPIC_BASE_URL=${baseUrl}\n` : ''}`);
    delete process.env[relayFlag];
    assert.equal(persistInitCredentials({ authToken: 'bearer-' + crypto.randomUUID() }), true);
    assert.deepEqual(state(), ON);
  });
}

test('init saving only a base URL recomputes the setting (relay on, then official off)', t => {
  const state = seedRelayFlag(t, isolatedCredentials(t), undefined);
  fs.writeFileSync(path.join(ZYLOS_DIR, '.env'), 'KEEP=unchanged\n');
  delete process.env[relayFlag];
  assert.equal(persistInitCredentials({ claudeBaseUrl: 'https://relay.example' }), true);
  assert.deepEqual(state(), ON, 'zylos init --base-url <relay> on a logged-in machine');
  assert.equal(persistInitCredentials({ claudeBaseUrl: 'https://api.anthropic.com' }), true);
  assert.deepEqual(state(), OFF);
});

test('init setup token and API key on the official API: setup token off, API key on, relay in the same run on', t => {
  const state = seedRelayFlag(t, isolatedCredentials(t), 'https://api.anthropic.com');
  assert.equal(persistInitCredentials({ setupToken: 'sk-ant-oat01-' + crypto.randomUUID() }), true);
  assert.deepEqual(state(), OFF, 'setup token + official');
  assert.equal(persistInitCredentials({ apiKey: 'sk-ant-api03-' + crypto.randomUUID() }), true);
  assert.deepEqual(state(), ON, 'API key + official');
  assert.equal(persistInitCredentials({ setupToken: 'sk-ant-oat01-' + crypto.randomUUID() }), true);
  assert.deepEqual(state(), OFF, 'back to setup token');
  assert.equal(persistInitCredentials({ setupToken: 'sk-ant-oat01-' + crypto.randomUUID(), claudeBaseUrl: 'https://relay.example' }), true);
  assert.deepEqual(state(), ON, 'setup token + relay in the same run');
});

test('init login without a new base URL prints the kept-relay notice; a base URL in the same run suppresses it', t => {
  seedRelayFlag(t, isolatedCredentials(t), 'https://relay.example');
  for (const [values, expected] of [
    [{ setupToken: 'sk-ant-oat01-' + crypto.randomUUID() }, true],
    [{ subscriptionLogin: true }, true],
    [{ setupToken: 'sk-ant-oat01-' + crypto.randomUUID(), claudeBaseUrl: 'https://relay.example' }, false],
    [{ apiKey: 'sk-ant-api03-' + crypto.randomUUID() }, false],
  ]) {
    const lines = [];
    assert.equal(persistInitCredentials(values, { log: line => lines.push(line) }), true);
    const notice = lines.find(line => line.includes('Still using the relay https://relay.example'));
    assert.equal(!!notice, expected, JSON.stringify(Object.keys(values)));
    if (expected) assert.match(notice, /zylos runtime claude --save-base-url https:\/\/api\.anthropic\.com/);
  }
  const official = [];
  assert.equal(persistInitCredentials({ setupToken: 'sk-ant-oat01-' + crypto.randomUUID(), claudeBaseUrl: 'https://api.anthropic.com' }), true);
  assert.equal(persistInitCredentials({ subscriptionLogin: true }, { log: line => official.push(line) }), true);
  assert.deepEqual(official, [], 'no notice on the official API');
});

test('init relay-traffic recompute failure stops initialization', () => {
  const output = [];
  assert.equal(persistInitCredentials({ setupToken: 'sk-ant-oat01-' + crypto.randomUUID() }, {
    saveSetupEnv: () => true, syncRelayTraffic: () => false, reportError: message => output.push(message) }), false);
  assert.match(output.join(''), /Initialization stopped before starting services/);
});

test('Claude authentication menu uses the baseline API-key label when no address was selected', async t => {
  isolatedCredentials(t); const menus = [];
  await runInitAuthentication(parseInitFlags([]), { runtime: 'claude', quiet: true, exists: () => true, claudeStatus: () => false,
    choose: async (question, choices) => { menus.push(choices); return 0; },
  });
  assert.equal(menus.length, 1); assert.equal(menus[0][1], 'Anthropic API key');
});


for (const [authentication, previous, expectedStop, expectedCode] of [
  [{ failed: true, exitCode: 0 }, 0, true, 1],
  [{ failed: true, exitCode: 2 }, 2, true, 1],
  [{ exitCode: 1 }, 0, false, 1],
  [{ exitCode: 0 }, 2, false, 2],
  [{ exitCode: 0 }, 0, false, 0],
]) test(`init consumes ${expectedStop ? 'fatal authentication failure' : 'authentication status'} with previous status ${previous} and resulting status ${expectedCode}`, () => {
  const original = process.exitCode;
  try {
    process.exitCode = 0;
    const result = consumeInitAuthenticationResult(authentication, previous);
    assert.equal(result.shouldStop, expectedStop); assert.equal(result.exitCode, expectedCode);
    assert.equal(process.exitCode, expectedStop ? 1 : 0);
  } finally { process.exitCode = original; }
});


for (const source of ['explicit flag', 'environment']) for (const setupLike of [false, true]) test(`initial ${source} official endpoint validation reports the ${setupLike ? 'setup-token mix-up' : 'API-key prefix'} error before setup`, t => {
  isolatedCredentials(t); const credential = (setupLike ? 'sk-ant-oat-' : '') + crypto.randomUUID();
  const args = ['--api-key', credential];
  if (source === 'explicit flag') args.push('--base-url', 'https://api.anthropic.com');
  else process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  const opts = parseInitFlags(args); resolveFromEnv(opts);
  const validation = validateInitInput(opts);
  assert.match(validation, setupLike ? /That looks like a setup token/ : /Invalid API key.*sk-ant-/s);
  assert.equal(validation.includes(credential), false);
});

test('initial validation defers API-key format while a saved endpoint remains unresolved', t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID();
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude/settings.json'), '{broken');
  const opts = parseInitFlags(['--api-key', credential]); resolveFromEnv(opts);
  assert.equal(opts.baseUrl, null); assert.equal(validateInitInput(opts), null);
});
