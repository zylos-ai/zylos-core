import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquire, release } from '../sync-lock.js';
import { createMemoryEditor } from '../memory-mcp-server.js';

// Integration boundary: hand-driven Origin read/write steps, real memory editor,
// token guard and index generator against a private copy of template memory.
// Run for shared-reference procedure/tool changes; skip for unrelated group state.
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR come from the official runner and are
// checked before use. No tmux or DB is needed: admission's live-run reader is
// supplied by the fixture. This does not cover runtime discovery, C4 fetching,
// cursor advancement, a model's interpretation or owner-approved reorganization.
// Child CLIs are synchronous with bounded timeouts; release and fixture cleanup belong to this test.
test('origin reroutes legacy writes to pages and updates navigation after rebuilding indexes', async t => {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]);
    assert.equal(path.resolve(process.env[key]).startsWith(path.resolve(os.userInfo().homedir) + path.sep), false);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME,
    TMPDIR: process.env.TMPDIR, tmux: 'unused; fixture live-run reader', database: 'unused' }));
  const memory = path.join(root, 'memory');
  fs.cpSync(path.resolve(import.meta.dirname, '../../../../templates/memory'), memory, { recursive: true });
  fs.appendFileSync(path.join(memory, 'reference/projects.md'), '\n## Share password\nUpdated: 2026-11-10\nImplementation is active.\n');
  fs.appendFileSync(path.join(memory, 'reference/decisions.md'), '\n## Share access\nUse an owner-set password.\n');
  const read = name => fs.readFileSync(path.join(memory, name), 'utf8');
  const hash = name => createHash('sha256').update(fs.readFileSync(path.join(memory, name))).digest('hex');
  const oldHashes = ['reference/projects.md', 'reference/decisions.md'].map(hash);
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: '11111111-1111-4111-8111-111111111111' };
  const token = await acquire({ kind: 'origin', env }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  try {
    const editor = createMemoryEditor(env);
    const rebuild = () => execFileSync(process.execPath,
      [path.resolve(import.meta.dirname, '../reference-index.js'), 'rebuild'],
      { env, encoding: 'utf8', timeout: 5000 });
    const create = (name, replacement) => editor({ op: 'create', path: name, replacement, token });
    rebuild();
    for (const kind of ['projects', 'decisions']) assert.ok(read(`reference/${kind}/INDEX.md`).includes('Index'));
    // The old paths are read-only, so move the intended facts into new pages.
    for (const kind of ['projects', 'decisions']) {
      const result = await create(`reference/${kind}.md`, 'new facts');
      assert.equal(result.code, 'LEGACY_READ_ONLY');
      t.diagnostic(`${kind} old-path result: ${result.code}`);
      const title = kind === 'projects' ? 'Share password' : 'Share access';
      const content = `# ${title}\n<!-- zylos:entry kind=${kind} -->\n- **Status:** active\n- **Updated:** 2026-11-11\n- **Keys:** share-password\n- **Moved from:** ${kind}.md “${title}”\n\n## Imported legacy context\n${kind === 'projects' ? 'Implementation is active.' : 'Use an owner-set password.'}\n\n## 2026-11-11\nNew facts from this round.\n`;
      assert.equal((await create(`reference/${kind}/share-password.md`, content)).ok, true);
    }
    rebuild();
    for (const kind of ['projects', 'decisions']) {
      const index = read(`reference/${kind}/INDEX.md`);
      assert.ok(index.includes('| share-password.md |'));
      t.diagnostic(`reference/${kind}/INDEX.md:\n${index}`);
    }
    // Rewrite only navigation references after successful INDEX publication.
    const before = read('references.md');
    const after = before.replaceAll('reference/projects.md', 'reference/projects/INDEX.md')
      .replaceAll('reference/decisions.md', 'reference/decisions/INDEX.md');
    assert.notEqual(before, after);
    const result = await editor({ op: 'edit', path: 'references.md', expected: before, replacement: after, token });
    assert.equal(result.ok, true);
    const navigation = read('references.md');
    assert.ok(navigation.includes('reference/projects/INDEX.md'));
    assert.ok(navigation.includes('reference/decisions/INDEX.md'));
    t.diagnostic('references.md navigation now points at both INDEX files.');
    assert.deepEqual(['reference/projects.md', 'reference/decisions.md'].map(hash), oldHashes);
  } finally {
    await release({ kind: 'origin', token, env });
  }
});
