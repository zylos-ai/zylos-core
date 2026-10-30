import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';

const cli = new URL('../c4-send.js', import.meta.url).pathname;
const endpoint = 'private-route-\'"$`\\\nvalue';
const argMax = Number(execFileSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).trim());
assert.ok(Number.isSafeInteger(argMax) && argMax > 0);

for (const absorbed of [false, true]) {
  test(`${absorbed ? 'absorbed' : 'ordinary'} real CLI failure set retains exactly the committed audit`, { timeout: 30000 }, async t => {
    for (const fault of ['success', 'E2BIG', 'EACCES', 'ENOENT', 'missing', 'deleted', 'syntax', 'DB_BUSY']) {
      await t.test(fault, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-routing-send-cli-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        fs.mkdirSync(path.join(root, 'comm-bridge'));
        fs.mkdirSync(path.join(root, '.zylos'));
        fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
        const f = fixture(t, {}, path.join(root, 'comm-bridge/c4.db'));
        f.db.pragma('journal_mode=WAL');
        const script = path.join(root, '.claude/skills/demo/scripts/send.js');
        fs.mkdirSync(path.dirname(script), { recursive: true });
        const marker = path.join(root, 'component.json');
        const good = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))`;
        fs.writeFileSync(script, fault === 'syntax' ? 'this is not valid JavaScript !!!' : good);
        let args = ['demo', endpoint, '--stdin'];
        if (absorbed) {
          const row = f.store.insertConversation('in', 'demo', endpoint, 'original request');
          const { runId } = f.store.beginModeTransition('single', 'multi');
          f.store.setDrainFence('*');
          f.store.absorbForTransition(runId);
          args = ['--absorbed-reply', runId, String(row.id)];
        }
        const bin = path.join(root, 'bin');
        fs.mkdirSync(bin);
        let childPath = process.env.PATH;
        if (['EACCES', 'ENOENT', 'deleted'].includes(fault)) {
          childPath = bin;
          if (fault === 'EACCES') fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o600 });
          if (fault === 'deleted') {
            // Node is launched only after the audit; delete before it loads send.js.
            fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n/bin/rm -- "$1"\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
          }
        }
        if (fault === 'missing') fs.unlinkSync(script);
        const writer = fault === 'DB_BUSY' ? new Database(f.filename) : null;
        const counts = () => ['conversations', 'channel_namespaces', 'group_heads'].map(table =>
          f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
        const before = counts();
        if (writer) { writer.exec('BEGIN IMMEDIATE'); t.after(() => writer.close()); }
        let result;
        try {
          result = spawnSync(process.execPath, [cli, ...args], {
            env: { ...process.env, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: path.resolve(import.meta.dirname, '../../../..'), PATH: childPath },
            input: fault === 'E2BIG' ? 'x'.repeat(argMax + 1) : 'reply body', encoding: 'utf8', timeout: 12000,
          });
        } finally { if (writer) writer.exec('ROLLBACK'); }
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        const rows = f.db.prepare("SELECT * FROM conversations WHERE direction='out'").all();
        const committed = !['missing', 'DB_BUSY'].includes(fault);
        assert.equal(rows.length, committed ? 1 : 0, fault);
        if (!committed) assert.deepEqual(counts(), before, 'precommit failure must not leak D1/D5/D6');
        if (committed) {
          assert.equal(rows[0].status, 'delivered');
          assert.equal(rows[0].endpoint_id, endpoint);
          assert.equal(rows[0].content, fault === 'E2BIG' ? 'x'.repeat(argMax + 1) : 'reply body');
        }
        if (fault === 'success') {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(fs.readFileSync(marker)), [endpoint, 'reply body']);
        } else {
          assert.equal(result.status, 1, result.stderr);
          const code = ['E2BIG', 'EACCES', 'ENOENT'].includes(fault) ? 'COMPONENT_SPAWN_FAILED'
            : fault === 'missing' ? 'INVALID_ARGS' : fault === 'DB_BUSY' ? 'DB_BUSY' : 'SEND_FAILED';
          assert.match(result.stderr, new RegExp(`\\[C4\\] ${code}:`));
          if (code === 'COMPONENT_SPAWN_FAILED') {
            assert.ok(result.stderr.includes(fault));
            assert.ok(!result.stderr.includes(endpoint));
            assert.match(result.stderr, /audit retained; not sent/);
          }
          if (code === 'SEND_FAILED') assert.match(result.stderr, /audit retained; delivery unconfirmed/);
          assert.equal(fs.existsSync(marker), false, 'component body must not execute');
          if (fault === 'deleted') assert.equal(fs.existsSync(script), false);
        }
        if (absorbed) assert.equal(f.db.prepare("SELECT count(*) n FROM conversations WHERE status='switch_absorbed'").get().n, 1);
      });
    }
  });
}
