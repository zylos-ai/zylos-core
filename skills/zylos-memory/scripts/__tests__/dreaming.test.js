import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDream } from '../dream.js';
import { dreamLock } from '../dream-lock.js';
import { createMemoryEditor } from '../memory-mcp-server.js';
import { candidatePages, tidyReference, PAGE_SOFT_LIMIT } from '../dream-pages.js';
import { createPage, rebuild } from '../reference-index.js';
import { DREAM_BATCH_BYTES, makeDreamBatches } from '../dream-history.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(relative, text) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { root, write, read: relative => fs.readFileSync(path.join(root, relative), 'utf8') };
}

const message = (id, content) => ({ id, content, direction: 'out', timestamp: '2026-11-23 00:00:00' });
const raw = (group, rows) => ({ group, rows });
const responses = groups => JSON.stringify({ groups: groups.map(group => ({ group, summary: `Summary of ${group}`, items: [] })) });
const empty = { diary: '', rule_candidates: [], pages_changed: [], pages_created: [], skipped: [] };
const tidy = { merged: [], uncertain: [], read_not_merged: [], status_changes: [] };

function fakeDatabase(conversations) {
  const coverage = new Map(), checkpoints = [];
  return { checkpoints, getDreamConversations: () => conversations.map(({ group, rows }) =>
    raw(group, rows.filter(row => row.id > (coverage.get(group) ?? 0)))).filter(group => group.rows.length),
  getCoverageEnd: group => coverage.get(group) ?? 0,
  createCheckpoint: (group, end, summary, options) => { coverage.set(group, end); checkpoints.push({ group, end, summary, ...options }); } };
}

test('run records keep the stats contract on success and failure', async t => {
  const extraction = JSON.stringify({ groups: [{ group: 'origin', summary: 'Summary',
    items: [{ type: 'diary', topic: '记录', text: 'Today', owner: false, source: 'C4 #1' }] }] });
  const merge = JSON.stringify({ ...empty, pages_changed: ['existing.md'], pages_created: ['new.md'],
    skipped: [{ item: 'diary', why: 'duplicate' }] });
  const tools = { toolCalls: 2, toolResultBytes: 17, maxToolResultBytes: 11 };

  for (const failed of [false, true]) {
    const { root, read } = fixture(t);
    await runDream({ root, config: {}, date: '2026-11-23', timezone: 'Asia/Singapore',
      database: () => fakeDatabase([raw('origin', [message(1, 'message')])]), send: () => {},
      newModel: () => ({ stage, reportToolStats }) => {
        if (stage === 'stage1') return extraction;
        assert.equal(stage, 'stage2');
        reportToolStats(tools);
        if (failed) throw new Error('fixture model exited');
        return merge;
      },
    });
    const { status, stats } = JSON.parse(read('activity-monitor/memory-dreaming/2026-11-22/run.json'));
    assert.equal(status, failed ? 'failed' : 'ok');
    const { calls, ...stages } = stats;
    assert.equal(calls.length, failed ? 4 : 2);
    assert.deepEqual(stages, {
      stage1: { batches: 1, failedBatches: 0, extracted: 1 },
      stage2: { pages_changed: failed ? 0 : 1, pages_created: failed ? 0 : 1, skipped: failed ? 0 : 1 },
      tidy: { merged: 0, archived: 0, condensed: 0, condenseFailed: 0 },
    });
    for (const { durationMs, ...call } of calls) {
      assert.ok(Number.isInteger(durationMs) && durationMs >= 0);
      if (call.stage === 'stage1') {
        assert.deepEqual(call, { stage: 'stage1', ok: true, outputBytes: Buffer.byteLength(extraction),
          toolCalls: 0, toolResultBytes: 0, maxToolResultBytes: 0 });
      } else {
        assert.deepEqual(call, { stage: 'stage2', ok: !failed,
          outputBytes: failed ? 0 : Buffer.byteLength(merge), ...tools,
          ...(failed ? { error: 'fixture model exited' } : {}) });
      }
    }
    assert.equal(calls.filter(call => call.stage === 'stage1').length, 1);
  }
});

test('cleaned batches preserve message order, split only oversized groups and pack small groups together', () => {
  const signal = '<smart-mode>omit this</smart-mode><group-context>keep this</group-context>';
  const { batches } = makeDreamBatches([
    raw('origin', [message(1, 'a'.repeat(100 * 1024) + signal), message(2, 'b'.repeat(100 * 1024))]),
    raw('chat:small', [message(3, 'c'.repeat(20 * 1024))]),
    raw('chat:short', [message(4, 'd'.repeat(30 * 1024))]),
    raw('chat:overflow', [message(5, 'e'.repeat(110 * 1024))]),
  ], '2026-11-23', 'Asia/Singapore');
  assert.deepEqual(batches.map(batch => batch.groups.map(group => group.end)), [[1], [2], [3, 4], [5]]);
  assert.ok(batches.every(batch => Buffer.byteLength(batch.input) <= DREAM_BATCH_BYTES));
  assert.match(batches[0].input, /2026-11-23 08:00 OUT/);
  assert.match(batches[0].input, /<group-context>keep this<\/group-context>/);
  assert.doesNotMatch(batches[0].input, /omit this/);
});

test('dream lock rejects a replaced or expired editor token and can take over a dead owner', async t => {
  const { root } = fixture(t);
  let now = 0, live = true;
  const owner = dreamLock(root, { now: () => now, alive: () => live });
  const token = await owner.acquire();
  assert.equal(await owner.acquire(), null);
  now += 30_000;
  await owner.heartbeat(token);
  now += 120_001;
  await assert.rejects(owner.guard(token, () => assert.fail('expired')), { code: 'TOKEN_MISMATCH' });
  const second = await owner.acquire();
  assert.notEqual(second, token);
  const editor = createMemoryEditor({ ZYLOS_MEMORY_DREAM_ROOT: root });
  assert.equal((await editor({ op: 'create', path: 'identity.md', replacement: 'Test', token })).code, 'TOKEN_MISMATCH');
  live = false;
  assert.notEqual(await owner.acquire(), null);
});

test('failed extraction blocks later merge input and coverage in that group, while invalid merge JSON commits the good batches', async t => {
  const { root, read } = fixture(t);
  const db = fakeDatabase([
    raw('origin', [message(1, 'a'.repeat(100 * 1024)), message(2, 'b'.repeat(100 * 1024)), message(3, 'c'.repeat(100 * 1024))]),
    raw('chat:peer', [message(4, 'd'.repeat(20 * 1024))]),
  ]);
  const inputs = [], notices = [];
  const result = await runDream({ root, config: {}, date: '2026-11-23', timezone: 'Asia/Singapore',
    database: () => db, send: message => notices.push(message),
    newModel: () => ({ stage, input, tools }) => {
      inputs.push({ stage, input });
      if (stage === 'stage2') {
        assert.equal(tools, true);
        assert.equal(db.checkpoints.length, 0);
        return 'invalid merge result';
      }
      assert.equal(tools, false);
      if (input.includes('(C4 #2)')) return '{';
      if (input.includes('(C4 #3)')) return JSON.stringify({ groups: [{ group: 'origin', summary: 'Deferred origin batch', items: [] }] });
      return responses([input.includes('## Group origin') ? 'origin' : 'chat:peer']);
    },
  });
  assert.equal(result.failed, true);
  const failed = inputs.filter(({ input }) => input.includes('(C4 #2)'));
  assert.equal(failed.length, 3);
  assert.ok(failed[1].input.startsWith(failed[0].input + '\n'));
  assert.match(failed[1].input, /Validation error/);
  const merges = inputs.filter(({ stage }) => stage === 'stage2');
  assert.equal(merges.length, 1);
  assert.match(merges[0].input, /Summary of origin/);
  assert.match(merges[0].input, /Summary of chat:peer/);
  assert.doesNotMatch(merges[0].input, /Deferred origin batch/);
  assert.deepEqual(db.checkpoints.map(({ group, end }) => [group, end]), [['origin', 1], ['chat:peer', 4]]);
  assert.deepEqual(db.getDreamConversations().map(group => group.rows.map(row => row.id)), [[2, 3]]);
  assert.equal(read('activity-monitor/memory-dreaming/2026-11-22/invalid-stage2-response.txt'), 'invalid merge result');
  assert.equal(fs.existsSync(path.join(root, 'memory/sessions/2026-11-22.md')), false);
  assert.equal(notices.length, 1);
});

test('coverage never advances past an oversized message with a failed fragment', async t => {
  const { root } = fixture(t);
  const rows = [message(1, 'complete'), message(2, 'x'.repeat(DREAM_BATCH_BYTES) + 'final fragment'), message(3, 'later')];
  const db = fakeDatabase([raw('origin', rows)]);
  const result = await runDream({ root, config: {}, date: '2026-11-23', timezone: 'Asia/Singapore',
    database: () => db, send: () => {},
    newModel: () => ({ stage, input }) => {
      if (stage === 'stage2') return JSON.stringify(empty);
      if (input.includes('final fragment')) throw new Error('failed extraction');
      return responses(['origin']);
    },
  });
  assert.equal(result.failedBatches.length, 1);
  assert.equal(db.getCoverageEnd('origin'), 1);
  assert.deepEqual(db.getDreamConversations()[0].rows.map(row => row.id), [2, 3]);
});

test('merge process failure keeps all coverage and alerts once during consecutive failures', async t => {
  const { root } = fixture(t);
  const db = fakeDatabase([raw('origin', [message(1, 'message')])]);
  const notices = [];
  let calls = 0;
  for (const date of ['2026-11-22', '2026-11-23', '2026-11-24']) {
    const result = await runDream({ root, config: {}, date, timezone: 'Asia/Singapore',
      database: () => db, send: message => notices.push(message),
      newModel: () => ({ stage }) => {
        if (stage === 'stage1') return responses(['origin']);
        calls++;
        assert.equal(stage, 'stage2');
        throw new Error('failed inside model process');
      },
    });
    assert.equal(result.failed, true);
  }
  assert.equal(calls, 9);
  assert.equal(db.checkpoints.length, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /two consecutive days/);
});

test('a completed dream publishes the diary, proposes rules, and repairs invalid headers independently', async t => {
  const { root, read, write } = fixture(t);
  const db = fakeDatabase([raw('origin', [message(1, 'message')])]);
  const relative = 'reference/projects/malformed.md';
  const legacyLog = '# Work log\n\nLate entry after the previous snapshot.';
  const diary = '# Day\n' + 'd'.repeat(25 * 1024);
  const rule = { text: 'Care for fixtures', source: 'C4 #1', owner_stated: true, destination: 'rules' };
  const notices = [];
  let repaired = 0;
  const result = await runDream({ root, config: {}, date: '2026-12-01', timezone: 'Asia/Singapore',
    database: () => db, send: message => notices.push(message),
    newModel: () => async ({ stage, page, input, token }) => {
      if (stage === 'stage1') {
        assert.match(input, /^Day: 2026-11-30 \(Asia\/Singapore\)/);
        return responses(['origin']);
      }
      if (stage === 'stage2') {
        assert.match(input, /^Date: 2026-11-30\n/);
        write('memory/' + relative, pageText('Broken', 'done', '2026-11-21'));
        write('memory/sessions/2026-11-30.md', legacyLog);
        return JSON.stringify({ ...empty, diary, rule_candidates: [rule] });
      }
      assert.equal(stage, 'repair');
      assert.equal(page, relative);
      assert.match(input, /Invalid Status "done"/);
      const edit = createMemoryEditor({ ZYLOS_MEMORY_DREAM_ROOT: root, ZYLOS_MEMORY_DREAM_PAGE: page });
      const response = await edit({ op: 'edit', path: page, expected: '** done', replacement: '** completed', token });
      assert.equal(response.ok, true);
      repaired++;
      return 'repaired';
    },
  });
  assert.equal(result.failed, false);
  assert.equal(repaired, 1);
  assert.equal(db.getCoverageEnd('origin'), 1);
  assert.equal(read('memory/sessions/2026-11-30.md'), `${legacyLog}\n\n${diary}`);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Care for fixtures/);
  assert.match(notices[0], /C4 #1/);
});

test('system notices advance coverage without reaching models or prompting a same-date rerun', async t => {
  const { root } = fixture(t);
  const systemNotice = id => ({ ...message(id, 'system-only text'), delivery_action: 'system_notice' });
  const rows = [message(1, 'first'), systemNotice(2)];
  const db = fakeDatabase([raw('origin', rows), raw('chat:notice-only', [systemNotice(3)])]);
  const notices = [];
  let calls = 0;
  const launch = () => runDream({ root, config: {}, date: '2026-11-23', timezone: 'Asia/Singapore',
    database: () => db, send: text => notices.push(text),
    newModel: () => ({ stage, input }) => {
      calls++;
      if (stage === 'stage1') {
        assert.match(input, /\(C4 #1\)/);
        assert.doesNotMatch(input, /system-only text|\(C4 #[23]\)|chat:notice-only/);
      }
      return stage === 'stage1' ? responses(['origin']) : JSON.stringify({ ...empty,
        rule_candidates: [{ text: 'Care for fixtures', source: 'C4 #1', owner_stated: true, destination: 'rules' }],
      });
    },
  });
  assert.equal((await launch()).failed, false);
  rows.push(message(4, 'later delivery'));
  assert.equal((await launch()).skipped, 'already attempted');
  assert.equal(calls, 2);
  assert.equal(notices.length, 1);
  assert.equal(db.getCoverageEnd('origin'), 2);
  assert.deepEqual(db.checkpoints.find(({ group }) => group === 'chat:notice-only'),
    { group: 'chat:notice-only', end: 3, summary: null, noContent: true });
});

function pageText(title, status, date, key = 'Shared Key', body = 'Body') {
  return `# ${title}\n<!-- zylos:entry kind=projects -->\n- **Status:** ${status}\n- **Updated:** ${date}\n- **Keys:** ${key}\n\n## Current\n${body}\n`;
}

test('candidate search ranks shared identifiers by rarity and ignores ordinary numbers', () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({
    relative: `page-${index}.md`,
    text: '# Page\n\nZYLO-397 beta.17 2442 8ed23d0 v0.8.2',
  }));
  pages.push({ relative: 'rare.md', text: '# Page\n\n#1638' });
  pages.push({ relative: 'numbers.md', text: '# Page\n\n2026-11-28 11:30 2 24 v2 5m 24h' });
  const search = candidatePages(pages);
  assert.deepEqual(search({
    topic: '#1638 ZYLO-397',
    text: 'beta.17 2442 8ed23d0 2026-11-28 11:30 2 24 v2 5m 24h',
    source: 'v0.8.2',
  }), [
    'rare.md (#1638)',
    'page-0.md (zylo 397, beta.17, 2442, 8ed23d0, v0.8.2)',
    'page-1.md (zylo 397, beta.17, 2442, 8ed23d0, v0.8.2)',
    'page-2.md (zylo 397, beta.17, 2442, 8ed23d0, v0.8.2)',
  ]);
});

test('weekly tidy reviews once, archives by refreshed status, then condenses each large page in its own call', async t => {
  const { root, read } = fixture(t);
  const ref = name => `reference/projects/${name}.md`;
  const add = (name, status, date, key, text) => createPage(root, ref(name), pageText(name, status, date, key, text));
  add('keep', 'active', '2026-11-01', 'unique pair', 'keep');
  add('duplicate', 'active', '2026-11-01', 'unique pair', 'x'.repeat(40 * 1024));
  add('stale', 'active', '2026-10-13');
  add('still-active', 'active', '2026-10-13', 'ongoing');
  add('finished', 'completed', '2026-10-22');
  add('recent', 'completed', '2026-10-24');
  for (const [index, name] of ['large-0', 'large-1', 'large-2', 'large-3'].entries()) {
    add(name, 'active', '2026-11-20', name, `## 当前状况\n${'y'.repeat(25 * 1024 + index * 1000)}`);
  }
  rebuild(root);
  const reviews = [], condensed = [];
  const errors = await tidyReference({ root, date: '2026-11-22', mutate: action => action(), repair: () => [],
    call: async input => {
      reviews.push(input);
      assert.doesNotMatch(input, /## Large pages/);
      assert.match(input, /reference\/projects\/stale\.md \(Updated 2026-10-13\)/);
      assert.match(input, /reference\/projects\/still-active\.md \(Updated 2026-10-13\)/);
      assert.match(input, /duplicate\.md and reference\/projects\/keep\.md/);
      const file = path.join(root, 'memory', ref('stale'));
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('** active', '** completed'));
      return { ...tidy, merged: [{ keep: ref('keep'), archive: ref('duplicate'), why: 'Same matter' }] };
    },
    condense: async (input, check) => {
      const file = input.match(/^Page: (\S+)$/m)[1];
      condensed.push(file);
      assert.equal(read(`memory/archive/dreaming/2026-11-22/${file}`), read(`memory/${file}`));
      assert.match(input, /## Header \(kept as is by the script\)\n# large-\d\n<!-- zylos:entry/);
      assert.throws(() => check(`## Current\n${'z'.repeat(PAGE_SOFT_LIMIT)}`));
      if (file === ref('large-2')) throw new Error('Dream model call timed out');
      if (file === ref('large-1')) fs.appendFileSync(path.join(root, 'memory', file), 'live edit\n');
      return check(`## Current\nCondensed ${file}`);
    },
  });
  assert.equal(reviews.length, 1);
  assert.deepEqual(condensed, ['large-3', 'large-2', 'large-1', 'large-0'].map(ref));
  assert.deepEqual(errors.map(error => error.match(/reference\/\S+\.md/)[0]), [ref('large-2'), ref('large-1')]);
  for (const name of ['large-3', 'large-0']) {
    assert.equal(read(`memory/${ref(name)}`), `${pageText(name, 'active', '2026-11-20', name, '').split('\n\n')[0]}\n\n## Current\nCondensed ${ref(name)}\n`);
  }
  assert.match(read(`memory/${ref('large-1')}`), /live edit/);
  assert.match(read('memory/reference/projects/archive/duplicate.md'), /Merged into: reference\/projects\/keep\.md/);
  for (const file of ['stale', 'finished']) assert.match(read(`memory/reference/projects/archive/${file}.md`), /Status:\*\* completed/);
  assert.match(read('memory/reference/projects/INDEX.md'), /recent\.md/);
  assert.match(read('memory/reference/projects/still-active.md'), /Status:\*\* active/);
});

test('a body too long for one call is condensed from notes on parts cut at entry starts, again while the notes are too long', async t => {
  const { root, read } = fixture(t);
  const ref = 'reference/projects/huge.md';
  const entries = Array.from({ length: 300 }, (_, index) => `- 2026-11-${String(index % 28 + 1).padStart(2, '0')} entry ${index}\n  ${'w'.repeat(700)}`);
  const body = `## 当前状况\nold\n\n## 未完成\n${entries.join('\n')}`;
  createPage(root, ref, pageText('huge', 'active', '2026-11-20', 'huge', body));
  rebuild(root);
  const rounds = [[]];
  let final;
  const errors = await tidyReference({ root, date: '2026-11-22', mutate: action => action(), repair: () => [], call: async () => tidy,
    condense: async (input, check) => {
      const part = input.match(/^## (Body|Notes) part (\d+) of (\d+)\n([\s\S]*)$/m);
      if (!part) { final = input; return check('## Current\nFrom notes'); }
      assert.ok(Buffer.byteLength(part[4]) <= 120 * 1024);
      if (part[2] === '1' && rounds.at(-1).length) rounds.push([]);
      assert.equal(part[1], rounds.length === 1 ? 'Body' : 'Notes');
      rounds.at(-1).push(part[4]);
      // First-round notes are over their target (the notes together exceed one call's input) and are still accepted.
      return check(rounds.length === 1 ? `## Notes ${part[2]}\n${'- n\n'.repeat(20000)}` : `## Notes\nround 2 notes ${part[2]}`);
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(rounds.length, 2);
  assert.ok(rounds[0].length > 1);
  assert.equal(rounds[0].join('\n'), read(`memory/archive/dreaming/2026-11-22/${ref}`).split(/\r?\n[ \t]*\r?\n/).slice(1).join('\n\n'));
  assert.ok(rounds[0].slice(1).every(part => part.startsWith('- 2026-11-')));
  assert.match(rounds[1].join('\n'), /^### Notes on part 1 of 2\n\n## Notes 1\n[\s\S]*\n### Notes on part 2 of 2\n\n## Notes 2\n/);
  assert.match(final, new RegExp(rounds[1].map((_, index) => `### Notes on part ${index + 1} of ${rounds[1].length}\n\n## Notes\nround 2 notes ${index + 1}`).join('\n\n')));
  assert.doesNotMatch(final, /entry 0|- n\n/);
  assert.match(read(`memory/${ref}`), /\n\n## Current\nFrom notes\n$/);
});

test('notes that do not shorten the text stop condensing the page and leave it unchanged', async t => {
  const { root, read } = fixture(t);
  const ref = 'reference/projects/huge.md';
  const entries = Array.from({ length: 300 }, (_, index) => `- 2026-11-01 entry ${index}\n  ${'w'.repeat(700)}`);
  createPage(root, ref, pageText('huge', 'active', '2026-11-20', 'huge', `## 未完成\n${entries.join('\n')}`));
  rebuild(root);
  const original = read(`memory/${ref}`);
  const labels = [];
  const errors = await tidyReference({ root, date: '2026-11-22', mutate: action => action(), repair: () => [], call: async () => tidy,
    condense: async (input, check) => {
      const part = input.match(/^## (Body|Notes|Notes on the body)\b.*\n([\s\S]*)$/m);
      labels.push(part[1]);
      // Bounds the run if a second round were wrongly started; the assertion below then fails.
      if (part[1] !== 'Body') throw new Error('unexpected call');
      return check(`## Notes\n${part[2]}`);
    },
  });
  assert.deepEqual(errors.map(error => error.match(/reference\/\S+\.md/)[0]), [ref]);
  assert.ok(labels.length > 1);
  assert.ok(labels.every(label => label === 'Body'));
  assert.equal(read(`memory/${ref}`), original);
});
