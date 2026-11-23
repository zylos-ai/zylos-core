// covers: skills/comm-bridge/scripts/sqlite-driver.js skills/comm-bridge/scripts/sqlite-schema.js skills/comm-bridge/scripts/c4-schema.js skills/scheduler/scripts/schema.js cli/zylos.js cli/lib/self-upgrade.js cli/lib/github.js skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.9.0-v1.sql skills/comm-bridge/scripts/__tests__/fixtures/migration-history/scheduler-v0.9.0-v1.sql
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import crypto from 'node:crypto';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import { migrateDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import * as schedulerSchema from '../../../skills/scheduler/scripts/schema.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(ROOT, 'cli/zylos.js');
const CURRENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Targets are derived from the installed version so the cases hold on any
// release line, including a prerelease of a new major.
const CURRENT_CORE = CURRENT.split(/[-+]/)[0];
const MAJOR = Number(CURRENT_CORE.split('.')[0]);
const NEXT = `${MAJOR + 1}.0.0`;
const DATABASE_CONTENT = 'isolated version-selection database sentinel\n';
const HISTORY = path.join(ROOT, 'skills/comm-bridge/scripts/__tests__/fixtures/migration-history');
const sha256 = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

// These tests exercise the real CLI across its version selector, GitHub client,
// archive downloader and target handoff. Only external commands and downloaded
// target/recovery materials are fixtures; installed product sources stay intact.
function fixture(t, { pages = [[]], target = NEXT, downloadFails = false, c4 = 'current', deployment = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suv-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const zylos = path.join(root, 'zylos');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const pm2 = path.join(root, 'pm2');
  const tmux = path.join(root, 'tmux');
  for (const dir of [home, zylos, bin, tmp, pm2, tmux]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  const callsFile = path.join(root, 'commands.jsonl');
  const handoffFile = path.join(root, 'handoff.json');
  const recoveryFile = path.join(root, 'recovery.jsonl');
  // An already-current version checks the live databases, so C4 and scheduler
  // are real databases at the installed layout, opened with the live skills'
  // driver; the historical web-console file is never opened.
  const databases = ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db']
    .map(relative => path.join(zylos, relative));
  for (const [file, sql, owner] of [[databases[0], 'c4-v0.9.0-v1.sql', c4Schema], [databases[1], 'scheduler-v0.9.0-v1.sql', schedulerSchema]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
      db.exec(fs.readFileSync(path.join(HISTORY, sql), 'utf8'));
      if (owner !== c4Schema || c4 !== 'older') migrateDatabase(db, owner, { strict: false });
      if (owner === c4Schema && c4 === 'newer') db.pragma(`user_version = ${c4Schema.SUPPORTED_SCHEMA_VERSION + 1}`);
    } finally { db.close(); }
  }
  fs.mkdirSync(path.dirname(databases[2]), { recursive: true });
  fs.writeFileSync(databases[2], DATABASE_CONTENT);
  let databaseHashes = databases.map(sha256);
  fs.mkdirSync(path.join(zylos, '.claude/skills'), { recursive: true });
  for (const owner of ['comm-bridge', 'scheduler']) fs.symlinkSync(path.join(ROOT, 'skills', owner), path.join(zylos, '.claude/skills', owner));
  const stable = path.join(zylos, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.mkdirSync(path.join(zylos, '.backup/self-upgrade'), { recursive: true });
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), "'use strict';\n");
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `
    const fs = require('node:fs');
    exports.bootstrap = (root, options) => {
      fs.appendFileSync(${JSON.stringify(recoveryFile)}, JSON.stringify({root, options})+'\\n');
      return {active:false, blocked:false};
    };
  `);

  const source = path.join(root, 'archive/package');
  fs.mkdirSync(path.join(source, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'zylos', version: target, type: 'module' }));
  fs.writeFileSync(path.join(source, 'cli/lib/upgrade-entry.js'), `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(handoffFile)}, fs.readFileSync(0, 'utf8'));
    process.stdout.write('isolated target entry\\n');
  `);
  const archive = path.join(root, 'target.tar.gz');
  execFileSync('/usr/bin/tar', ['czf', archive, '-C', path.dirname(source), 'package']);
  const routes = path.join(root, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify({ pages, target, archive, downloadFails }));
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), url = args.at(-1);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({command:'curl',args})+'\\n');
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routes)},'utf8'));
const parsed = new URL(url);
if (parsed.origin === 'https://api.github.com' && parsed.pathname === '/repos/zylos-ai/zylos-core/tags') {
  const page = Number(parsed.searchParams.get('page') || 1);
  process.stdout.write(JSON.stringify(routes.pages[page-1] || []));
} else if (url === 'https://github.com/zylos-ai/zylos-core/archive/refs/tags/v'+routes.target+'.tar.gz') {
  if (routes.downloadFails) { console.error('curl: (22) The requested URL returned error: 404'); process.exit(22); }
  const index = args.indexOf('-o');
  if (index < 0) process.exit(97);
  fs.copyFileSync(routes.archive,args[index+1]);
} else { console.error('Unexpected fixture request: '+url); process.exit(98); }
`, { mode: 0o755 });
  for (const command of ['gh', 'pm2', 'tmux', 'npm', 'git', 'ssh', 'ps']) {
    fs.writeFileSync(path.join(bin, command), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})+'\\n');
process.exit(99);
`, { mode: 0o755 });
  }
  fs.symlinkSync('/usr/bin/tar', path.join(bin, 'tar'));
  fs.symlinkSync('/usr/bin/gzip', path.join(bin, 'gzip'));
  const env = {
    HOME: home,
    ZYLOS_DIR: zylos,
    PM2_HOME: pm2,
    TMPDIR: tmp,
    TMUX_TMPDIR: tmux,
    TMUX: `${path.join(tmux, 'private.sock')},0,0`,
    PATH: bin,
    LANG: 'C',
    TZ: 'UTC',
    ZYLOS_UPSTREAM_CONFIG: 'direct',
    ZYLOS_UPSTREAM_TRUST_HOSTS: 'none',
    ZYLOS_GH_RETRY_DELAY_MS: '0,0',
  };
  const calls = () => fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const run = args => {
    for (const value of [home, zylos, pm2, tmp, tmux, ...databases]) {
      assert.ok((fs.existsSync(value) ? fs.realpathSync(value) : value).startsWith(root + path.sep), value);
    }
    assert.equal(env.PATH, bin);
    for (const command of ['curl', 'gh', 'pm2', 'tmux', 'npm']) {
      assert.ok(fs.realpathSync(path.join(bin, command)).startsWith(root + path.sep));
    }
    // Report actual arguments and isolated destinations before each CLI process.
    t.diagnostic(JSON.stringify({ args, env, databases }));
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    assert.deepEqual(databases.map(sha256), databaseHashes);
    const dangerous = calls().filter(call => !['gh', 'curl'].includes(call.command));
    assert.deepEqual(dangerous, [], 'service/install commands must stay unused');
    return result;
  };
  // An uninitialized machine: no deployment directory at all.
  if (!deployment) { fs.rmSync(zylos, { recursive: true }); databaseHashes = databases.map(sha256); }
  return {
    run, calls, handoffFile, zylosDir: zylos,
    recoveryCalls: () => fs.existsSync(recoveryFile) ? fs.readFileSync(recoveryFile, 'utf8') : '',
  };
}

function parsed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}



for (const beta of [false, true]) {
  // Boundary: default/beta current-major selection across paginated tags.
  // Run when release selection changes; skip for finalizer/recovery-only changes.
  test(`${beta ? 'beta' : 'stable'} selection stays in the installed major across pages`, t => {
    const target = beta ? `${MAJOR}.99.1-beta.2` : `${MAJOR}.99.0`;
    const first = Array.from({ length: 100 }, (_, i) => ({ name: `v${MAJOR + 1}.0.${i}` }));
    const f = fixture(t, {
      target,
      pages: [first, [{ name: `v${MAJOR}.99.1-beta.2` }, { name: `v${MAJOR}.99.0` }]],
    });
    const output = parsed(f.run(['upgrade', '--self', '--check', '--json', ...(beta ? ['--beta'] : [])]));
    assert.equal(output.latest, target);
    assert.equal(output.hasUpdate, true);
    assert.ok(f.calls().some(call => call.command === 'curl' && call.args.at(-1).endsWith('&page=2')));
    assert.doesNotMatch(output.reply, new RegExp(`${MAJOR + 1}\\.0\\.`));
    assert.equal(f.recoveryCalls(), '');
    assert.equal(fs.existsSync(f.handoffFile), false);
  });
}

// Boundary: exact release archive and existing target-owned JSON handoff.
// Run when explicit selection/download/handoff wiring changes; skip for real
// installation/finalizer tests, which this inert target does not cover.
test('explicit upgrade downloads the exact tag and hands off to its entry', t => {
  const f = fixture(t, { pages: [[{ name: `v${NEXT}` }]] });
  const result = f.run(['upgrade', '--self', '--version', NEXT, '--yes']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /isolated target entry/);
  // Pre-upgrade recovery discovers transactions in-process here; the deployed
  // bootstrap stub is not part of this path, so it is not asserted.
  const handoff = JSON.parse(fs.readFileSync(f.handoffFile, 'utf8'));
  assert.equal(handoff.fromVersion, CURRENT);
  assert.equal(handoff.installedRoot, ROOT);
  assert.ok(handoff.tempDir.includes('/tmp/zylos-self-upgrade-'));
  const archives = f.calls().filter(call => call.command === 'curl' && call.args.at(-1).includes('/archive/'));
  assert.equal(archives.length, 1);
  assert.equal(archives[0].args.at(-1), `https://github.com/zylos-ai/zylos-core/archive/refs/tags/v${NEXT}.tar.gz`);
});

// Boundary: a failed exact archive download never selects a branch. Run when
// selection/download wiring changes; skip for target-package execution changes.
test('explicit archive failure does not fall back to a branch or execute a target', t => {
  const f = fixture(t, { pages: [[{ name: `v${NEXT}` }]], downloadFails: true });
  const result = f.run(['upgrade', '--self', '--version', NEXT, '--yes']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.handoffFile), false);
  assert.ok(f.calls().filter(call => call.command === 'curl')
    .every(call => !call.args.at(-1).includes('/heads/') && !call.args.at(-1).includes('/tarball/main')));
});
