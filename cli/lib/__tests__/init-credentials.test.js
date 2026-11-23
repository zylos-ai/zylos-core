import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { authenticateClaudeApiCredential } from '../runtime/claude/auth.js';
import { authenticateCodexApiCredential } from '../runtime/codex/auth.js';


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

for (const status of [401, 403, 400, 404]) test(`Claude stage handles HTTP ${status} without a secret-bearing log or false verified message`, { timeout: 4000 }, async t => {
  const home = isolatedCredentials(t), credential = crypto.randomUUID(), output = [];
  const baseUrl = await endpoint(t, status);
  const result = await authenticateClaudeApiCredential({ authToken: credential, baseUrl }, { log: value => output.push(value), reportError: value => output.push(value) });
  const rejected = status === 401 || status === 403;
  assert.equal(result, !rejected); assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN === credential, !rejected);
  assert.match(output.join(''), rejected ? /rejected/ : /inconclusive/);
  assert.doesNotMatch(output.join(''), /Claude API credential verified/); assert.equal(output.join('').includes(credential), false);
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
