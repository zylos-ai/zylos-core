import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-fetch.js', import.meta.url));
const RECEIVE_PATH = fileURLToPath(new URL('../c4-db.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  const channel = args[args.indexOf('--channel') + 1];
  const endpoint = args.includes('--endpoint') ? args[args.indexOf('--endpoint') + 1] : 'null';
  const content = args[args.indexOf('--content') + 1];
  return spawnSync(process.execPath, [RECEIVE_PATH, 'insert', 'out', channel, endpoint, content], {
    env: { ...process.env, ...env }, encoding: 'utf8'
  });
}

function checkpoint(args, env = {}) {
  return spawnSync(process.execPath, [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fetch-cli-'));
  const env = { ZYLOS_DIR: tmpDir };
  // Warm up DB
  checkpoint(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// -- --unsummarized --

describe('c4-fetch --unsummarized', () => {
  it('reports no unsummarized conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('count=0'));
    });
  });

  it('fetches unsummarized conversations', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('unsummarized scope=*'));
      assert.ok(stdout.includes('count=2'));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('keeps outbound endpoint content clean without reply routing', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--content', 'clean msg'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('clean msg'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('includes last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'old msg'], env);
      checkpoint(['create', '1', '--summary', 'First sync done'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'new msg'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('First sync done'));
      assert.ok(stdout.includes('new msg'));
      assert.ok(!stdout.includes('old msg'));
    });
  });
});

// -- --begin / --end --

describe('c4-fetch --begin --end', () => {
  it('fetches conversations in range', () => {
    withTmpDir(({ env }) => {
      receive(['--channel', 'system', '--no-reply', '--content', 'msg1'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg2'], env);
      receive(['--channel', 'system', '--no-reply', '--content', 'msg3'], env);

      const { stdout, status } = cli(['--begin', '1', '--end', '2'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(!stdout.includes('msg3'));
    });
  });

  it('reports no conversations for empty range', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--begin', '100', '--end', '200'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No conversations in this range'));
    });
  });
});

// -- validation --

describe('c4-fetch validation', () => {
  it('errors with no arguments', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('errors with incomplete --begin/--end', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['--begin', '1'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('end must be an integer'));
    });
  });
});

function withAbsorbed(fn) {
  return withTmpDir(({ tmpDir, env }) => {
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as db from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
      const rows = Array.from({ length: 23 }, (_, i) => db.insertConversation('in', 'system', 'route-' + i, '🚀'.repeat(301) + '\\n尾'));
      const { runId } = db.beginModeTransition('single', 'multi');
      db.setDrainFence('*'); db.absorbForTransition(runId);
      console.log(JSON.stringify({ runId, ids: rows.map(row => row.id) })); db.close();
    `], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.equal(seed.status, 0, seed.stderr);
    const seeded = JSON.parse(seed.stdout);
    const args = ['--absorbed', '--run-id', seeded.runId];
    fn({ tmpDir, env, args, ...seeded });
  });
}

describe('c4-fetch absorbed public CLI', () => {
  it('paginates by count, previews 300 code points and supports summary', () => {
    withAbsorbed(({ env, args, ids }) => {
      const first = cli([...args, '--json'], env);
      assert.equal(first.status, 0, first.stderr);
      const page = JSON.parse(first.stdout).data;
      assert.equal(page.count, 20); assert.equal(page.next, ids[19]);
      assert.equal(page.items[0].text, '🚀'.repeat(300));
      assert.equal(page.items[0].textTruncated, true);
      const next = cli([...args, '--after', String(page.next), '--limit', '2', '--json'], env);
      assert.equal(next.status, 0, next.stderr);
      assert.deepEqual(JSON.parse(next.stdout).data.items.map(row => row.id), ids.slice(20, 22));
      const last = cli([...args, '--after', String(ids[21]), '--limit', '2'], env);
      assert.equal(last.status, 0, last.stderr); assert.match(last.stdout, /count=1 next=none/);
      const summary = cli([...args, '--summary', '--limit', '1', '--json'], env);
      assert.equal(summary.status, 0, summary.stderr);
      assert.equal(JSON.parse(summary.stdout).data.items[0].count, 23);
    });
  });
  it('returns full text and endpoint and exclusively exports original UTF8 bytes', () => {
    withAbsorbed(({ tmpDir, env, args, ids }) => {
      const fullArgs = [...args, '--id', String(ids[0])];
      for (const field of ['text', 'endpoint']) for (const json of [false, true]) {
        const expected = field === 'text' ? '🚀'.repeat(301) + '\n尾' : 'route-0';
        const flags = [...fullArgs, '--field', field, ...(json ? ['--json'] : [])];
        const full = cli(flags, env);
        assert.equal(full.status, 0, full.stderr);
        if (json) assert.equal(JSON.parse(full.stdout).data.data, expected);
        else { assert.match(full.stdout, new RegExp(`end id=${ids[0]} field=${field}\\n$`)); assert.ok(full.stdout.includes(field === 'text' ? '🚀'.repeat(301) : expected)); }
        const out = path.join(tmpDir, `export-${field}-${json}`);
        const exported = cli([...flags, '--out', out], env);
        assert.equal(exported.status, 0, exported.stderr);
        assert.deepEqual(fs.readFileSync(out), Buffer.from(expected));
        assert.equal(fs.statSync(out).mode & 0o777, 0o600);
        if (json) assert.equal(JSON.parse(exported.stdout).data.path, out);
        else assert.match(exported.stdout, /^absorbed-file /);
        const again = cli([...flags, '--out', out], env);
        assert.equal(again.status, 1); assert.match(again.stdout + again.stderr, /INVALID_ARGS/);
        assert.deepEqual(fs.readFileSync(out), Buffer.from(expected));
      }
    });
  });
  it('reports WRITE_FAILED and removes a partially written export through the public entrypoint', () => {
    withAbsorbed(({ tmpDir, env, args, ids }) => {
      const hook = path.join(tmpDir, 'write-failure.mjs');
      fs.writeFileSync(hook, `import fs from 'node:fs';
        const open = fs.openSync, write = fs.writeFileSync; let target;
        fs.openSync = function(file, flags, ...rest) { const fd = open.call(this, file, flags, ...rest); if (flags === 'wx') target = fd; return fd; };
        fs.writeFileSync = function(fd, data, ...rest) { if (fd === target) { write.call(this, fd, data.slice(0, 1), ...rest); throw Object.assign(new Error('controlled disk full'), { code: 'ENOSPC' }); } return write.call(this, fd, data, ...rest); };
      `);
      for (const json of [false, true]) {
        const out = path.join(tmpDir, `partial-${json}`);
        const result = spawnSync(process.execPath, ['--import', hook, CLI_PATH, ...args, '--id', String(ids[0]), '--out', out, ...(json ? ['--json'] : [])], { env: { ...process.env, ...env }, encoding: 'utf8' });
        assert.equal(result.status, 1, result.stderr);
        if (json) { assert.equal(JSON.parse(result.stdout).error.code, 'WRITE_FAILED'); assert.equal(result.stderr, ''); }
        else { assert.equal(result.stdout, ''); assert.match(result.stderr, /Error \[WRITE_FAILED\]/); }
        assert.equal(fs.existsSync(out), false);
      }
    });
  });
  it('rejects obsolete and conflicting flags and reports WRITE_FAILED in text and JSON', () => {
    withAbsorbed(({ tmpDir, env, args, ids }) => {
      for (const invalid of [ ['--offset','0'], ['--max-bytes','2048'], ['--limit','0'], ['--limit','101'], ['--out',path.join(tmpDir,'no-id')], ['--summary','--id',String(ids[0])], ['--id',String(ids[0]),'--limit','1'] ]) {
        const result = cli([...args, ...invalid, '--json'], env);
        assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
      }
      for (const json of [false, true]) {
        const out = path.join(tmpDir, 'missing', `export-${json}`);
        const result = cli([...args, '--id', String(ids[0]), '--out', out, ...(json ? ['--json'] : [])], env);
        assert.equal(result.status, 1);
        if (json) { assert.equal(JSON.parse(result.stdout).error.code, 'WRITE_FAILED'); assert.equal(result.stderr, ''); }
        else { assert.equal(result.stdout, ''); assert.match(result.stderr, /Error \[WRITE_FAILED\]/); }
        assert.equal(fs.existsSync(out), false);
      }
    });
  });
});
