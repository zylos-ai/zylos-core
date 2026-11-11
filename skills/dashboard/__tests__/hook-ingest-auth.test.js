import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOOK_SCRIPT = new URL('../src/lib/hook-ingest.cjs', import.meta.url).pathname;

const MOCK_EVENT = JSON.stringify({
  hook_event_name: 'PostToolUse',
  session_id: 'test-session',
  tool_name: 'Bash',
  tool_input: { command: 'echo hello' }
});

function setupTmpConfig(tmpDir, config) {
  const dataDir = path.join(tmpDir, 'components', 'dashboard');
  const spoolDir = path.join(dataDir, 'spool');
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  return tmpDir;
}

function runHookIngest(zylosDir, stdin) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      // These tests assert the POST reached the server, so the hook's
      // 500ms/200ms production deadlines must not race child startup on a
      // loaded machine (same widening as the e2e backpressure test).
      env: {
        ...process.env,
        ZYLOS_DIR: zylosDir,
        ZYLOS_HOOK_EXIT_MS: '15000',
        ZYLOS_HOOK_POST_TIMEOUT_MS: '5000'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function startServer() {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ headers: { ...req.headers }, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

test('hook-ingest.cjs — Authorization header', async (t) => {
  await t.test('sends Authorization header when ingestToken is set', async () => {
    const { server, requests, port } = await startServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ingest-test-'));
    setupTmpConfig(tmpDir, { port, ingestToken: 'secret123' });

    try {
      await runHookIngest(tmpDir, MOCK_EVENT);
      assert.equal(requests.length, 1, 'must receive exactly one request');
      assert.equal(requests[0].headers.authorization, 'Bearer secret123');
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('does not send Authorization header when ingestToken is null', async () => {
    const { server, requests, port } = await startServer();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ingest-test-'));
    setupTmpConfig(tmpDir, { port, ingestToken: null });

    try {
      await runHookIngest(tmpDir, MOCK_EVENT);
      assert.equal(requests.length, 1, 'must receive exactly one request');
      assert.equal(requests[0].headers.authorization, undefined, 'must not have Authorization header');
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
