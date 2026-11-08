import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { ZYLOS_DIR } from '../config.js';
import {
  parseInitFlags, resolveFromEnv, resolveInitBaseUrl, validateInitOptions, printInitHelp,
  promptClaudeApiCredential, authenticateClaudeApiCredential, authenticateCodexApiCredential, persistInitCredentials,
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

test('environment auth input wins over authenticated existing CLI while flags select their own kind', t => {
  isolatedCredentials(t); const credential = crypto.randomUUID(); process.env.ANTHROPIC_AUTH_TOKEN = credential;
  process.env.ANTHROPIC_BASE_URL = 'https://relay.example';
  const opts = parseInitFlags([]); resolveFromEnv(opts);
  assert.equal(opts.authToken === credential, true); assert.equal(validateInitOptions(opts), null);
  const explicitKey = parseInitFlags(['--api-key', credential]); resolveFromEnv(explicitKey);
  assert.equal(explicitKey.apiKey === credential, true); assert.equal(explicitKey.authToken, null);
  const explicitSetup = parseInitFlags(['--setup-token', 'sk-ant-oat-placeholder']); resolveFromEnv(explicitSetup);
  assert.equal(explicitSetup.authToken, null); assert.equal(explicitSetup.apiKey, null);
});

test('ambiguous environment API-key and auth-token inputs fail before auth or persistence', t => {
  isolatedCredentials(t); process.env.ANTHROPIC_API_KEY = crypto.randomUUID(); process.env.ANTHROPIC_AUTH_TOKEN = crypto.randomUUID();
  const opts = parseInitFlags([]); resolveFromEnv(opts);
  assert.match(validateInitOptions(opts), /mutually exclusive/);
  for (const args of [['--api-key', 'placeholder', '--auth-token', 'placeholder'], ['--setup-token', 'sk-ant-oat-placeholder', '--auth-token', 'placeholder']]) {
    assert.match(validateInitOptions(parseInitFlags(args)), /mutually exclusive/);
  }
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-placeholder';
  const setup = parseInitFlags([]); resolveFromEnv(setup); assert.equal(setup.apiKey, null); assert.equal(setup.authToken, null);
});

test('only relay API-key formats bypass the official prefix gate and invalid URLs never echo credentials', t => {
  isolatedCredentials(t); const credential = crypto.randomUUID();
  for (const baseUrl of ['https://relay.example', 'http://127.0.0.1:8080/prefix']) assert.equal(validateInitOptions({ apiKey: credential, baseUrl }), null);
  for (const baseUrl of [undefined, 'https://api.anthropic.com', 'http://api.anthropic.com', 'https://api.anthropic.com:444']) assert.match(validateInitOptions({ apiKey: credential, baseUrl }), /sk-ant-/);
  const invalid = validateInitOptions({ authToken: credential, baseUrl: `https://user:${credential}@relay.example` });
  assert.match(invalid, /Invalid base URL/); assert.equal(invalid.includes(credential), false);
  assert.match(validateInitOptions({ authToken: credential + '\n' }), /line breaks/);
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
  const official = await promptClaudeApiCredential({}, { choose: () => assert.fail('official prompt is unchanged'), secret: async () => 'sk-ant-placeholder', log: () => {} });
  assert.equal(typeof official.apiKey, 'string');
});

// Real init authentication stage + real localhost HTTP + native settings writer.
// Run on auth input/header/base/status/write changes. HOME is private and fake claude cannot make vendor calls.
for (const kind of ['apiKey', 'authToken']) test(`selected ${kind} stage verifies at its custom base and writes only the selected settings variable`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID(), output = [];
  const baseUrl = await endpoint(t, 200, req => {
    assert.equal(req.url, '/relay/v1/messages');
    assert.equal(kind === 'authToken' ? req.headers.authorization === `Bearer ${credential}` : req.headers['x-api-key'] === credential, true);
  });
  const result = await authenticateClaudeApiCredential({ [kind]: credential, baseUrl: baseUrl + '/relay' }, { log: value => output.push(value), reportError: value => output.push(value) });
  assert.equal(result, true);
  const env = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env;
  assert.equal(env[kind === 'authToken' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] === credential, true);
  assert.equal(env[kind === 'authToken' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'], undefined);
  assert.equal(fs.existsSync(path.join(home, 'zylos', '.env')), false, 'auth stage must defer .env to template deployment');
  assert.equal(output.join('').includes(credential), false);
});

for (const status of [401, 403, 400, 503]) test(`Claude stage handles HTTP ${status} without a secret-bearing log or false verified message`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID(), output = [];
  const baseUrl = await endpoint(t, status);
  const result = await authenticateClaudeApiCredential({ authToken: credential, baseUrl }, { log: value => output.push(value), reportError: value => output.push(value) });
  const rejected = status === 401 || status === 403;
  assert.equal(result, !rejected); assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), !rejected);
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

for (const runtime of ['claude', 'codex']) test(`replacement resolves the saved ${runtime} endpoint before making a real verification request`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const credential = crypto.randomUUID(); let requests = 0;
  const origin = await endpoint(t, 200, req => {
    requests += 1;
    assert.equal(req.url, runtime === 'claude' ? '/saved/v1/messages' : '/saved/v1/models');
    assert.equal(req.headers.authorization === `Bearer ${credential}`, true);
  });
  const base = origin + (runtime === 'claude' ? '/saved' : '/saved/v1');
  const native = path.join(home, runtime === 'claude' ? '.claude/settings.json' : '.codex/config.toml');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, runtime === 'claude' ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: crypto.randomUUID() } }) : `openai_base_url = "${base}"\n`);
  const args = runtime === 'claude' ? ['--auth-token', credential] : ['--codex-api-key', credential];
  const opts = parseInitFlags(args);
  resolveFromEnv(opts, { runtime, home, zylosDir });
  assert.equal(runtime === 'claude' ? opts.baseUrl : opts.codexBaseUrl, base);
  assert.equal(opts.apiKey, null, 'saved credentials are never promoted while finding an endpoint');
  assert.equal(runtime === 'claude' ? await authenticateClaudeApiCredential(opts, { quiet: true })
    : await authenticateCodexApiCredential(opts.codexApiKey, { baseUrl: opts.codexBaseUrl, quiet: true }), true);
  assert.equal(requests, 1);
  const envKey = runtime === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
  fs.writeFileSync(path.join(zylosDir, '.env'), `${envKey}=https://deployment.example\nANTHROPIC_AUTH_TOKEN=unused\n`);
  const deployment = parseInitFlags(args); resolveFromEnv(deployment, { runtime, home, zylosDir });
  assert.equal(runtime === 'claude' ? deployment.baseUrl : deployment.codexBaseUrl, 'https://deployment.example');
  process.env[envKey] = 'https://environment.example';
  const environment = parseInitFlags(args); resolveFromEnv(environment, { runtime, home, zylosDir });
  assert.equal(runtime === 'claude' ? environment.baseUrl : environment.codexBaseUrl, 'https://environment.example');
  const explicit = parseInitFlags([...args, runtime === 'claude' ? '--base-url' : '--codex-base-url', 'https://explicit.example']);
  resolveFromEnv(explicit, { runtime, home, zylosDir });
  assert.equal(runtime === 'claude' ? explicit.baseUrl : explicit.codexBaseUrl, 'https://explicit.example');
});

test('unreadable selected saved endpoint fails generically while explicit selection bypasses unrelated native files', t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  const native = path.join(home, '.claude/settings.json'); fs.mkdirSync(path.dirname(native));
  const credential = crypto.randomUUID(); fs.writeFileSync(native, '{"secret":"' + credential);
  assert.throws(() => resolveFromEnv(parseInitFlags(['--auth-token', credential]), { home, zylosDir }), error => {
    assert.equal(error.message.includes(credential), false); return /Could not read saved API endpoint/.test(error.message);
  });
  const explicit = parseInitFlags(['--auth-token', credential, '--base-url', 'https://explicit.example']);
  resolveFromEnv(explicit, { home, zylosDir }); assert.equal(explicit.baseUrl, 'https://explicit.example');
  const codex = path.join(home, '.codex/config.toml'); fs.mkdirSync(path.dirname(codex)); fs.writeFileSync(codex, 'broken = [');
  process.env.ANTHROPIC_BASE_URL = 'https://environment.example';
  resolveFromEnv(parseInitFlags(['--auth-token', credential]), { home, zylosDir });
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

test('interactive Codex selection resolves its native endpoint without reading unrelated malformed Claude settings', { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude/settings.json'), '{broken');
  const credential = crypto.randomUUID(); let requests = 0;
  const origin = await endpoint(t, 200, req => { requests += 1; assert.equal(req.url, '/chosen/v1/models'); });
  fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex/config.toml'), `openai_base_url = "${origin}/chosen/v1"\n`);
  const opts = parseInitFlags([]); resolveFromEnv(opts, { home, zylosDir });
  assert.equal(opts.baseUrl, null); assert.equal(opts.codexBaseUrl, null);
  resolveInitBaseUrl(opts, 'codex', { home, zylosDir });
  assert.equal(await authenticateCodexApiCredential(credential, { baseUrl: opts.codexBaseUrl, quiet: true }), true);
  assert.equal(requests, 1);
});

test('saved endpoint assignments accept horizontal whitespace recognized by environment readers', t => {
  const home = isolatedCredentials(t), zylosDir = path.join(home, 'zylos'); fs.mkdirSync(zylosDir);
  fs.writeFileSync(path.join(zylosDir, '.env'), '\u00a0ANTHROPIC_BASE_URL\u00a0=\u00a0https://saved.example\n');
  const opts = parseInitFlags(['--auth-token', crypto.randomUUID()]); resolveFromEnv(opts, { home, zylosDir });
  assert.equal(opts.baseUrl, 'https://saved.example');
});
