import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8', timeout: 15000
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function receive(args, env = {}) {
  const value = name => args[args.indexOf(name) + 1];
  const channel = value('--channel'), content = value('--content');
  const endpoint = args.includes('--no-reply') || !args.includes('--endpoint') ? null : value('--endpoint');
  const delivered = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const db = await import(${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)});
    const {createStore} = await import(${JSON.stringify(new URL('../c4-v2-store.js', import.meta.url).href)});
    const store = createStore(db.getDb(), {validateComponent:()=>true});
    const row = store.insertConversation('in', ${JSON.stringify(channel)}, ${JSON.stringify(endpoint)}, ${JSON.stringify(content)}, {});
    store.claimConversation(row.id); store.markDelivered(row.id, {sessionId:'fixture'});
    db.close();
  `], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
  assert.equal(delivered.status, 0, delivered.stderr);
  return delivered;
}

// Insert delivered rows in one child.
function receiveMany(contents, env) {
  const delivered = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const db = await import(${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)});
    for (const content of ${JSON.stringify(contents)}) {
      db.insertConversation('out', 'system', null, content);
    }
    db.close();
  `], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
  assert.equal(delivered.status, 0, delivered.stderr);
}

const numbered = (count, prefix) => Array.from({ length: count },
  (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
const OLD_GUIDANCE = /unsummarized|omitted middle|Checkpoint covers id/i;

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-session-init-'));
  const env = { HOME: path.join(tmpDir, 'home'), ZYLOS_DIR: tmpDir, PM2_HOME: path.join(tmpDir, 'pm2'),
    TMPDIR: path.join(tmpDir, 'tmp'), TMUX_TMPDIR: path.join(tmpDir, 'tmp'), TZ: 'Asia/Singapore',
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../../', import.meta.url)) };
  for (const directory of [env.HOME, env.PM2_HOME, env.TMPDIR]) fs.mkdirSync(directory);
  console.log('Session init isolation:', JSON.stringify({ ...env, database: path.join(tmpDir, 'comm-bridge/c4.db'),
    amSocket: path.join(tmpDir, 'activity-monitor/am.sock'), tmux: 'not launched', pm2: 'not launched' }));
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// -- basic behavior --

describe('c4-session-init', () => {

  // Actual multi-session CLI scope/path selection, with the opposite root-file
  // condition as a decoy. Run for handoff/scope changes; unrelated UI may skip.
  // withTmpDir logs the private environment, database and socket before bounded
  // children; no terminal/service starts and the fixture root is always removed.
  for (const mode of ['single', 'multi']) for (const present of [true, false]) it(`${mode} group startup uses its own handoff when ${present ? 'present' : 'absent'}`, () => {
    withTmpDir(({ tmpDir, env }) => {
      const group = mode === 'single' ? 'origin' : 'telegram:handoff-check';
      const groupFile = path.join(tmpDir, 'memory/session-groups', group, 'handoff.md');
      const rootFile = path.join(tmpDir, 'memory/handoff.md');
      fs.mkdirSync(path.join(tmpDir, '.zylos'));
      fs.writeFileSync(path.join(tmpDir, '.zylos/config.json'), JSON.stringify({ session_mode: mode }));
      fs.mkdirSync(path.dirname(groupFile), { recursive: true });
      if (present) fs.writeFileSync(groupFile, 'unfinished group task');
      else fs.writeFileSync(rootFile, 'unrelated root task');
      assert.equal(fs.existsSync(groupFile), present);
      assert.equal(fs.existsSync(rootFile), !present);

      const { stdout, status } = cli([], { ...env, ZYLOS_SESSION_GROUP: group });
      assert.equal(status, 0);
      assert.ok(stdout.includes(`Scope: ${group}. Working memory is not injected.`));
      if (present) {
        assert.ok(stdout.includes(`Before resuming work, read ${groupFile} in full, using successive file ranges when needed. Reading does not consume it; retain unfinished items.`));
        assert.ok(stdout.includes(path.join(tmpDir, '.claude/skills/comm-bridge/references/handoff-follow-up.md')));
        assert.doesNotMatch(stdout, /No handoff file is available/);
        assert.equal(fs.readFileSync(groupFile, 'utf8'), 'unfinished group task');
      } else {
        assert.ok(stdout.includes(`No handoff file is available for this scope (${groupFile}).`));
        assert.doesNotMatch(stdout, /Before resuming work, read .*handoff/);
        assert.doesNotMatch(stdout, /handoff-follow-up\.md/);
        assert.equal(fs.readFileSync(rootFile, 'utf8'), 'unrelated root task');
      }
      assert.ok(!stdout.includes(`read ${rootFile} in full`), 'root handoff never supplies the group instruction');
      assert.equal(fs.existsSync(groupFile), present);
      assert.equal(fs.existsSync(rootFile), !present);
    });
  });

  // The real CLI reads only its scope and keeps the newest six without a handoff.
  // Run for scope/C4 boot reads; no runtime, PM2 or tmux starts. The shared
  // fixture prints isolated paths, bounds children and removes its directory.
  for (const [mode, group] of [['single','origin'], ['single',null]]) {
    it(`startup tail follows environment group ${group} with mode ${mode}`, () => {
      withTmpDir(({ tmpDir, env }) => {
        fs.mkdirSync(path.join(tmpDir, '.zylos'), {recursive:true});
        fs.writeFileSync(path.join(tmpDir,'.zylos/config.json'), JSON.stringify(mode ? {session_mode:mode} : {}));
        const setup = spawnSync(process.execPath, ['--input-type=module','-e', `
          const db = await import(${JSON.stringify(new URL('../c4-db.js',import.meta.url).href)});
          const c = db.getDb();
          for (let id=1; id<=11; id++) c.prepare("INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,'out','system',?,'delivered',?)").run(id,id===11 ? 'OTHER-GROUP-TAIL' : 'ORIGIN-TAIL-'+id,id===11 ? 'telegram:other' : 'origin');
          db.createCheckpoint('*',1,'GLOBAL SUMMARY MUST NOT LOAD');
          db.createCheckpoint('origin',2,'ORIGIN SUMMARY MUST NOT LOAD');
          db.close();
        `], {env,encoding:'utf8',timeout:15000});
        assert.equal(setup.status,0,setup.stderr);
        const selectedEnv = { ...env, ZYLOS_RUN_ID: 'isolated-run' };
        if (group) selectedEnv.ZYLOS_SESSION_GROUP = group;
        const {stdout,stderr,status} = cli([],selectedEnv);
        assert.equal(status,0,stderr);
        assert.ok(stdout.includes(`Scope: ${group ?? '*'}.`));
        assert.doesNotMatch(stdout, OLD_GUIDANCE);
        assert.match(stdout,/ORIGIN-TAIL-10/);
        assert.doesNotMatch(stdout,/SUMMARY MUST NOT LOAD/);
        if (group) {
          assert.doesNotMatch(stdout,/OTHER-GROUP-TAIL/);
          assert.match(stdout, /ORIGIN-TAIL-5\n/);
          assert.doesNotMatch(stdout, /ORIGIN-TAIL-4\n/);
        } else {
          assert.match(stdout,/OTHER-GROUP-TAIL/);
          assert.match(stdout, /ORIGIN-TAIL-6\n/);
          assert.doesNotMatch(stdout, /ORIGIN-TAIL-5\n/);
        }
      });
    });
  }

  it('adds reply routing for inbound endpoint messages', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--content', 'hello'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('hello ---- reply via: node'));
      assert.ok(stdout.includes('"telegram" "123"'));
    });
  });

  it('does not add reply routing for no-reply messages even when endpoint was provided', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--no-reply', '--content', 'no callback'], env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('no callback'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('shows up to six recent messages when there is no handoff', () => {
    withTmpDir(({ env }) => {
      const messages = numbered(15, 'backlog');
      receiveMany(messages, env);
      const { stdout, stderr, status } = cli([], env);
      assert.equal(status, 0, stderr);
      for (const content of messages.slice(-6)) assert.match(stdout, new RegExp(`${content}\n`));
      for (const content of messages.slice(0, -6)) assert.doesNotMatch(stdout, new RegExp(`${content}\n`));
      assert.doesNotMatch(stdout, OLD_GUIDANCE);
    });
  });

  it('uses the scope handoff mtime as a strict cutoff, independent of checkpoints', () => {
    withTmpDir(({ tmpDir, env }) => {
      const group = 'telegram:room';
      const handoffPath = path.join(tmpDir, 'memory/session-groups', group, 'handoff.md');
      const cutoff = new Date('2026-11-27T02:00:00.000Z');
      fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
      fs.writeFileSync(handoffPath, 'HANDOFF BODY MUST NOT LOAD');
      fs.utimesSync(handoffPath, cutoff, cutoff);
      const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const db = await import(${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)});
        const insert = db.getDb().prepare("INSERT INTO conversations(timestamp,direction,channel,content,status,session_group) VALUES(?,?,'system',?,?,?)");
        insert.run('2026-11-27 01:59:59', 'out', 'BEFORE-CUTOFF', 'delivered', '${group}');
        insert.run('2026-11-27 02:00:00', 'out', 'AT-CUTOFF', 'delivered', '${group}');
        // The newest timestamp has a smaller id than the tied earlier messages.
        insert.run('2026-11-27 02:00:20', 'out', 'LATEST-ROW', 'delivered', '${group}');
        insert.run(Date.parse('2026-11-27T02:00:10Z') / 1000, 'out', 'LEGACY-TIME', 'delivered', '${group}');
        for (let i = 1; i <= 8; i++) insert.run('2026-11-27 02:00:01', 'in', 'AFTER-CUTOFF-' + i, 'delivered', '${group}');
        insert.run('2026-11-27 02:00:21', 'out', 'OTHER-SCOPE', 'delivered', 'telegram:other');
        db.createCheckpoint('${group}', 12, 'CHECKPOINT MUST NOT LOAD');
        insert.run('2026-11-27 02:00:22', 'in', 'STILL-PENDING', 'pending', '${group}');
        db.close();
      `], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(setup.status, 0, setup.stderr);
      const { stdout, stderr, status } = cli([], { ...env, ZYLOS_SESSION_GROUP: group });
      assert.equal(status, 0, stderr);
      assert.ok(stdout.includes(handoffPath));
      const markers = Array.from({ length: 8 }, (_, i) => `AFTER-CUTOFF-${i + 1}`).concat('LEGACY-TIME', 'LATEST-ROW');
      assert.deepEqual(stdout.match(/AFTER-CUTOFF-\d+|LEGACY-TIME|LATEST-ROW/g), markers);
      assert.doesNotMatch(stdout, /BEFORE-CUTOFF|AT-CUTOFF|OTHER-SCOPE|STILL-PENDING|MUST NOT LOAD/);
      assert.doesNotMatch(stdout, OLD_GUIDANCE);
    });
  });
  it('shows a contiguous post-handoff tail or reports the omitted count and inclusive ID range', () => {
    for (const [olderCount, oversized] of [[2, false], [2, true], [1000, true]]) {
      withTmpDir(({ tmpDir, env }) => {
        const group = 'telegram:overflow';
        const firstId = 2;
        const lastId = olderCount + 3;
        const handoff = path.join(tmpDir, 'memory/session-groups', group, 'handoff.md');
        fs.mkdirSync(path.dirname(handoff), { recursive: true });
        fs.writeFileSync(handoff, 'previous work');
        const cutoff = new Date('2026-11-27T02:00:00Z');
        fs.utimesSync(handoff, cutoff, cutoff);

        const selectedEnv = { ...env, ZYLOS_SESSION_GROUP: group };
        const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
          const db = await import(${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)});
          const c = db.getDb();
          const insert = c.prepare("INSERT INTO conversations(id,timestamp,direction,channel,content,status,session_group) VALUES(?,?,'in','system',?,'delivered',?)");
          c.exec('BEGIN');
          insert.run(1, '2026-11-27 02:00:00', 'AT-CUTOFF', '${group}');
          insert.run(3, '2026-11-27 02:00:01', 'OTHER-GROUP', 'telegram:other');
          for (let n = 0; n < ${olderCount}; n++) {
            insert.run(n === 0 ? 2 : n + 3, '2026-11-27 02:00:01', 'SMALL-MESSAGE-' + n, '${group}');
          }
          insert.run(${lastId}, '2026-11-27 02:00:02', 'NEWEST-MESSAGE ' + 'x'.repeat(${oversized ? 12000 : 16}), '${group}');
          c.exec('COMMIT');
          db.createCheckpoint('*', 1, 'GLOBAL-SUMMARY');
          db.close();
        `], { env: selectedEnv, encoding: 'utf8', timeout: 15000 });
        assert.equal(setup.status, 0, setup.stderr);

        const { stdout, stderr, status } = cli([], selectedEnv);
        assert.equal(status, 0, stderr);
        assert.doesNotMatch(stdout, /AT-CUTOFF|OTHER-GROUP/);
        if (!oversized) {
          assert.deepEqual(stdout.match(/SMALL-MESSAGE-\d+|NEWEST-MESSAGE/g),
            ['SMALL-MESSAGE-0', 'SMALL-MESSAGE-1', 'NEWEST-MESSAGE']);
          assert.doesNotMatch(stdout, /omitted from the start of the tail/);
        } else {
          assert.doesNotMatch(stdout, /SMALL-MESSAGE|NEWEST-MESSAGE/);
          assert.ok(stdout.includes(`omitted from the start of the tail: ${olderCount + 1}.`));
          const command = stdout.match(/Retrieve them by ID with: (.+)/)?.[1];
          assert.ok(command?.includes(`--begin ${firstId} --end ${lastId} --group '${group}'`));
          const fetchPath = path.join(tmpDir, '.claude/skills/comm-bridge/scripts/c4-fetch.js');
          fs.mkdirSync(path.dirname(fetchPath), { recursive: true });
          fs.symlinkSync(fileURLToPath(new URL('../c4-fetch.js', import.meta.url)), fetchPath);
          const fetched = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, ...selectedEnv }, encoding: 'utf8', timeout: 15000 });
          assert.equal(fetched.status, 0, fetched.stderr);
          assert.equal(fetched.stdout.match(/SMALL-MESSAGE-\d+|NEWEST-MESSAGE/g)?.length, olderCount + 1);
          assert.doesNotMatch(fetched.stdout, /OTHER-GROUP|GLOBAL-SUMMARY/);
        }
      });
    }
  });
});
