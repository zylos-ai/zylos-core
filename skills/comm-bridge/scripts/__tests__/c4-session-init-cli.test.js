import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

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

// Insert delivered rows in one child; returns the session group of the last row.
function receiveMany(contents, env = {}, { channel = 'system', endpoint = null, groupName } = {}) {
  const delivered = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const db = await import(${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)});
    const {createStore} = await import(${JSON.stringify(new URL('../c4-v2-store.js', import.meta.url).href)});
    const store = createStore(db.getDb(), {validateComponent:()=>true});
    let group = null;
    for (const content of ${JSON.stringify(contents)}) {
      const row = store.insertConversation('in', ${JSON.stringify(channel)}, ${JSON.stringify(endpoint)}, content,
        ${JSON.stringify(groupName ? { groupName } : {})});
      store.claimConversation(row.id); store.markDelivered(row.id, {sessionId:'fixture'});
      group = db.getDb().prepare('SELECT session_group FROM conversations WHERE id=?').pluck().get(row.id);
    }
    db.close();
    process.stdout.write(JSON.stringify(group));
  `], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
  assert.equal(delivered.status, 0, delivered.stderr);
  return JSON.parse(delivered.stdout);
}

const numbered = (count, prefix, size = 0) => Array.from({ length: count },
  (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}${size ? ` ${'x'.repeat(size)}` : ''}`);
const OMITTED_MIDDLE = /latest \d+ shown\. Before judging old tasks, promises or todos, inspect the omitted middle/;

function checkpoint(args, env = {}) {
  return spawnSync('node', [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8', timeout: 15000
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-session-init-'));
  const env = { HOME: path.join(tmpDir, 'home'), ZYLOS_DIR: tmpDir, PM2_HOME: path.join(tmpDir, 'pm2'),
    TMPDIR: path.join(tmpDir, 'tmp'), TMUX_TMPDIR: path.join(tmpDir, 'tmp'), TZ: 'Asia/Singapore',
    ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../../', import.meta.url)) };
  for (const directory of [env.HOME, env.PM2_HOME, env.TMPDIR]) fs.mkdirSync(directory);
  console.log('Session init isolation:', JSON.stringify({ ...env, database: path.join(tmpDir, 'comm-bridge/c4.db'),
    amSocket: path.join(tmpDir, 'activity-monitor/am.sock'), tmux: 'not launched', pm2: 'not launched' }));
  // Warm up DB
  checkpoint(['latest'], env);
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

  // Real CLI + private SQLite storage checks tail, coverage and lag guidance.
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
        // A Sync threshold below the backlog keeps the latest-tail view with its coverage line.
        const selectedEnv = {...env, ZYLOS_RUN_ID:'isolated-run', ZYLOS_SYNC_THRESHOLD:'5'};
        if (group) selectedEnv.ZYLOS_SESSION_GROUP = group;
        const {stdout,stderr,status} = cli([],selectedEnv);
        assert.equal(status,0,stderr);
        assert.ok(stdout.includes(`Scope: ${group ?? '*'}.`));
        assert.match(stdout,new RegExp('Checkpoint covers id '+(group ? 2 : 1)));
        assert.match(stdout,/ORIGIN-TAIL-10/);
        assert.doesNotMatch(stdout,/SUMMARY MUST NOT LOAD/);
        if (group) {
          assert.doesNotMatch(stdout,/OTHER-GROUP-TAIL/);
          assert.match(stdout,/--unsummarized --group origin --limit 50/);
        } else {
          assert.match(stdout,/OTHER-GROUP-TAIL/);
          assert.match(stdout,/--unsummarized --limit 50/);
          assert.doesNotMatch(stdout,/--unsummarized --group/);
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

  // Startup view of a backlog left for the next session. Run for session-init,
  // Sync threshold or shard budget changes; same private-database isolation as above.
  it('injects the whole unsummarized backlog at the Sync threshold and the latest six above it', () => {
    withTmpDir(({ env }) => {
      const quiet = { ...env, ZYLOS_SYNC_THRESHOLD: '' };
      receiveMany(numbered(15, 'backlog'), quiet);
      const at = cli([], quiet);
      assert.equal(at.status, 0, at.stderr);
      for (const content of numbered(15, 'backlog')) assert.ok(at.stdout.includes(`${content}\n`), content);
      assert.doesNotMatch(at.stdout, OMITTED_MIDDLE);

      receiveMany(['backlog-16'], quiet);
      const above = cli([], quiet);
      assert.equal(above.status, 0, above.stderr);
      assert.ok(above.stdout.includes('About 16 messages unsummarized; latest 6 shown.'));
      assert.ok(above.stdout.includes('backlog-11\n') && above.stdout.includes('backlog-16\n'));
      assert.ok(!above.stdout.includes('backlog-10\n'));
    });
  });

  it('a multi-session group injects only its own whole small backlog', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.zylos'));
      fs.writeFileSync(path.join(tmpDir, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi' }));
      const quiet = { ...env, ZYLOS_SYNC_THRESHOLD: '' };
      const earlier = numbered(9, 'earlier');
      const group = receiveMany(earlier, quiet, { channel: 'telegram', endpoint: 'chat-1', groupName: 'room' });
      receiveMany(['other group message'], quiet, { channel: 'telegram', endpoint: 'chat-2', groupName: 'other' });
      assert.equal(receiveMany(['the new message'], quiet, { channel: 'telegram', endpoint: 'chat-1', groupName: 'room' }), group);
      const { stdout, status, stderr } = cli([], { ...quiet, ZYLOS_SESSION_GROUP: group });
      assert.equal(status, 0, stderr);
      assert.ok(stdout.includes(`Scope: ${group}.`));
      for (const content of [...earlier, 'the new message']) assert.ok(stdout.includes(content), content);
      assert.ok(!stdout.includes('other group message'));
      assert.doesNotMatch(stdout, OMITTED_MIDDLE);
    });
  });
});
