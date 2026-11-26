import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDream } from '../dream.js';
import { dreamLock } from '../dream-lock.js';
import { createMemoryEditor } from '../memory-mcp-server.js';
import { candidatePages, tidyReference } from '../dream-pages.js';
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
const tidy = { merged: [], uncertain: [], read_not_merged: [], status_changes: [], condensed: [] };

function fakeDatabase(conversations) {
  const coverage = new Map(), checkpoints = [];
  return { checkpoints, getDreamConversations: () => conversations.map(({ group, rows }) =>
    raw(group, rows.filter(row => row.id > (coverage.get(group) ?? 0)))).filter(group => group.rows.length),
  getCoverageEnd: group => coverage.get(group) ?? 0,
  createCheckpoint: (group, end, summary) => { coverage.set(group, end); checkpoints.push({ group, end, summary }); } };
}

test('cleaned batches preserve message order, split only oversized groups and pack small groups together', () => {
  const signal = '<smart-mode>omit this</smart-mode><group-context>keep this</group-context>';
  const batches = makeDreamBatches([
    raw('origin', [message(1, 'a'.repeat(100 * 1024) + signal), message(2, 'b'.repeat(100 * 1024))]),
    raw('chat:small', [message(3, 'c'.repeat(20 * 1024))]),
    raw('chat:short', [message(4, 'd'.repeat(30 * 1024))]),
  ], '2026-11-23', 'Asia/Singapore');
  assert.deepEqual(batches.map(batch => batch.groups.map(group => group.end)), [[1], [2], [3, 4]]);
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

test('failed extraction blocks later coverage in that group, while invalid merge JSON still commits the good batches', async t => {
  const { root, read } = fixture(t);
  const db = fakeDatabase([
    raw('origin', [message(1, 'a'.repeat(100 * 1024)), message(2, 'b'.repeat(100 * 1024))]),
    raw('chat:peer', [message(3, 'c'.repeat(20 * 1024))]),
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
      if (input.includes('(C4 #1)')) return '{';
      return responses([input.includes('## Group origin') ? 'origin' : 'chat:peer']);
    },
  });
  assert.equal(result.failed, true);
  const failed = inputs.filter(({ input }) => input.includes('(C4 #1)'));
  assert.equal(failed.length, 3);
  assert.ok(failed[1].input.startsWith(failed[0].input + '\n'));
  assert.match(failed[1].input, /Validation error/);
  assert.equal(inputs.filter(({ stage }) => stage === 'stage2').length, 1);
  assert.deepEqual(db.checkpoints.map(({ group, end }) => [group, end]), [['chat:peer', 3]]);
  assert.deepEqual(db.getDreamConversations().map(group => group.rows.map(row => row.id)), [[1, 2]]);
  assert.equal(read('activity-monitor/memory-dreaming/2026-11-23/invalid-stage2-response.txt'), 'invalid merge result');
  assert.equal(fs.existsSync(path.join(root, 'memory/sessions/2026-11-23.md')), false);
  assert.equal(notices.length, 1);
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
  const diary = '# Day\n' + 'd'.repeat(25 * 1024);
  const rule = { text: 'Care for fixtures', source: 'C4 #1', owner_stated: true, destination: 'rules' };
  const notices = [];
  let repaired = 0;
  const result = await runDream({ root, config: {}, date: '2026-11-23', timezone: 'Asia/Singapore',
    database: () => db, send: message => notices.push(message),
    newModel: () => async ({ stage, page, input, token }) => {
      if (stage === 'stage1') return responses(['origin']);
      if (stage === 'stage2') {
        write('memory/' + relative, pageText('Broken', 'done', '2026-11-21'));
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
  assert.equal(read('memory/sessions/2026-11-23.md'), diary);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Care for fixtures/);
  assert.match(notices[0], /C4 #1/);
});

function pageText(title, status, date, key = 'Shared Key', body = 'Body') {
  return `# ${title}\n<!-- zylos:entry kind=projects -->\n- **Status:** ${status}\n- **Updated:** ${date}\n- **Keys:** ${key}\n\n## Current\n${body}\n`;
}

test('candidate search discounts common terms and ranks rare Keys and body identifiers', () => {
  const pages = Array.from({ length: 4 }, (_, index) => ({
    relative: `page-${index}.md`,
    keys: index === 0 ? ['common', 'topic 9916'] : ['common'],
    text: index === 1 ? '# Page\n\ncommon and PR #525' : '# Page\n\ncommon content',
  }));
  const search = candidatePages(pages);
  assert.deepEqual(search({ topic: 'common', text: 'Follow up TOPIC_9916 and #525', source: '' }),
    ['page-0.md (topic 9916)', 'page-1.md (#525)']);
});

test('weekly tidy uses a single review then batches original large pages, and archives using refreshed status', async t => {
  const { root, read } = fixture(t);
  const ref = name => `reference/projects/${name}.md`;
  const add = (name, status, date, key, text) => createPage(root, ref(name), pageText(name, status, date, key, text));
  add('keep', 'active', '2026-11-01', 'unique pair', 'keep');
  add('duplicate', 'active', '2026-11-01', 'unique pair', 'duplicate');
  add('stale', 'active', '2026-10-13');
  add('finished', 'completed', '2026-10-22');
  add('recent', 'completed', '2026-10-24');
  const names = Array.from({ length: 12 }, (_, index) => `large-${index}`);
  for (const [index, name] of names.entries()) add(name, 'active', '2026-11-20', name, 'x'.repeat(25 * 1024 + index));
  rebuild(root);
  const batches = [];
  const errors = await tidyReference({ root, date: '2026-11-22', mutate: action => action(), repair: () => [],
    call: async input => {
      const first = batches.length === 0;
      const list = input.match(/## Large pages\n([\s\S]*?)\n## Candidate pairs/)[1];
      const paths = list.split('\n').filter(Boolean).map(line => line.match(/^- (\S+)/)[1]);
      batches.push(paths);
      for (const file of paths) assert.equal(read(`memory/archive/dreaming/2026-11-22/${file}`), read(`memory/${file}`));
      if (!first) {
        assert.match(input, /older than 30 days\n## Large pages/);
        assert.match(input, /## Candidate pairs$/);
        return tidy;
      }
      assert.match(input, /reference\/projects\/stale\.md \(Updated 2026-10-13\)/);
      assert.match(input, /duplicate\.md and reference\/projects\/keep\.md/);
      const file = path.join(root, 'memory', ref('stale'));
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('** active', '** completed'));
      return { ...tidy, merged: [{ keep: ref('keep'), archive: ref('duplicate'), why: 'Same matter' }] };
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(batches.map(batch => batch.length), [5, 5, 2]);
  assert.deepEqual(batches.flat(), [...names].reverse().map(ref));
  assert.match(read('memory/reference/projects/archive/duplicate.md'), /Merged into: reference\/projects\/keep\.md/);
  for (const file of ['stale', 'finished']) assert.match(read(`memory/reference/projects/archive/${file}.md`), /Status:\*\* completed/);
  assert.match(read('memory/reference/projects/INDEX.md'), /recent\.md/);
});
