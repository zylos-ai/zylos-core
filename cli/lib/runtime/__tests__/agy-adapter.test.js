import { createSessionOps } from '../session-ops.js';
import { checkAuth } from '../agy/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';


function probeExecutor({ status = 200, error = null, inspect = () => {} } = {}) {
  return (command, args, options, callback) => {
    const stdin = new PassThrough();
    let input = '';
    stdin.on('data', chunk => { input += chunk; });
    stdin.on('finish', () => {
      inspect({ command, args, options, input });
      callback(error, String(status));
    });
    return { stdin };
  };
}

async function fixture(t, contents = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-adapter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (contents) await fs.writeFile(path.join(root, '.env'), contents);
  // Unit probes must never fall back to a real curl if their transport seam
  // changes. Only explicitly injected executors can make a request here.
  const bin = path.join(root, 'empty-bin');
  await fs.mkdir(bin);
  return { root, env: { HOME: root, PATH: bin } };
}

for (const status of [200, 400, 401, 403, 429, 500]) test(`agy auth classifies HTTP ${status} without exposing the credential`, async t => {
  const f = await fixture(t, 'GEMINI_API_KEY=test-secret\n');
  let calls = 0;
  const adapterOptions = { ...f, execFile: probeExecutor({ status, inspect: ({ command, args, options, input }) => {
    calls++;
    assert.equal(command, 'curl');
    assert.equal(args[0], '-q');
    assert.equal(args[args.indexOf('--url') + 1], 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(args[args.indexOf('--header') + 1], '@-');
    assert.equal(args.includes('--location'), false);
    assert.equal(JSON.stringify(args).includes('test-secret'), false);
    assert.equal(input, 'x-goog-api-key: test-secret\n');
    assert.equal(options.timeout, 11_000);
    assert.equal(options.env.GEMINI_API_KEY, 'test-secret');
  } }) };
  const result = await checkAuth(adapterOptions);
  assert.equal(result.status, status === 200 ? 'success' : [400, 401, 403].includes(status) ? 'failure' : 'uncertain');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.equal(calls, 1);
});

for (const separator of ['\r', '\n', '\r\n']) test(`agy auth rejects ${JSON.stringify(separator)} key headers before starting a request`, async t => {
  const f = await fixture(t);
  let calls = 0;
  const adapterOptions = { ...f, env: { ...f.env, GEMINI_API_KEY: `key${separator}Injected: value` }, execFile: () => { calls++; } };
  assert.deepEqual(await checkAuth(adapterOptions), { status: 'uncertain', reason: 'http_probe_network_error' });
  assert.equal(calls, 0);
});

test('agy always uses one guarded bracketed paste even when the caller disables it', async () => {
  const calls = [];
  let file;
  const connection = {
    commandBatch: async commands => {
      file = commands[0][3];
      assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\nthree');
      assert.equal(commands[1][0], 'paste-buffer');
      assert.equal(commands[1].includes('-p'), true);
      calls.push('paste');
    },
    cleanupBuffer: async () => calls.push('cleanup'),
  };
  const adapter = createSessionOps({ dependencies: { revalidateSessionTarget: async () => calls.push('guard') } });
  await adapter.sendText({ runtime: 'agy', target: { paneId: '%1' }, connection, text: 'one\ntwo\nthree', bracketedPaste: false });
  assert.deepEqual(calls, ['guard', 'paste', 'cleanup']);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
