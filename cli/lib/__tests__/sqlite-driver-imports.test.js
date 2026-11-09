import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Two copies of better-sqlite3 in one process are two SQLite libraries whose POSIX locks undo each other, so product
// code takes the driver from the shared loader. The upgrade backup worker runs as its own child process and loads the
// driver of the old or new package explicitly.
const ROOT = path.resolve(import.meta.dirname, '../../..');
const ALLOWED = ['cli/lib/core-db-backup-worker.js', 'skills/comm-bridge/scripts/sqlite-driver.js'];
const SPECIFIER = String.raw`(['"\x60])(?:[^'"\x60\n]*/)?better-sqlite3(?:/[^'"\x60\n]*)?\1`;

// Static and side-effect imports, export-from, import(), require(), and calls of a createRequire() result.
function directLoad(source) {
  const callers = ['require', 'import', ...[...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:module\.)?createRequire\s*\(/g)]
    .map(match => match[1].replaceAll('$', '\\$'))];
  return new RegExp(String.raw`(?:\b(?:from|import)\s*|(?:\b(?:${callers.join('|')})|\))\s*\(\s*)${SPECIFIER}`)
    .exec(source)?.[0];
}

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '__tests__', 'test'].includes(entry.name)) yield* sources(file);
    } else if (/\.[cm]?js$/.test(entry.name) && !entry.name.endsWith('.test.js')) yield file;
  }
}

test('product code loads better-sqlite3 only through the shared driver loader', () => {
  const allowedSeen = [];
  for (const top of ['cli', 'skills', 'scripts', 'templates']) {
    for (const file of sources(path.join(ROOT, top))) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      const load = directLoad(fs.readFileSync(file, 'utf8'));
      if (ALLOWED.includes(relative)) {
        assert.ok(load, `${relative} no longer loads better-sqlite3 directly; remove it from the allowed list`);
        allowedSeen.push(relative);
      } else {
        assert.equal(load, undefined,
          `${relative} loads better-sqlite3 directly (${load}); import skills/comm-bridge/scripts/sqlite-driver.js instead`);
      }
    }
  }
  assert.deepEqual(allowedSeen.sort(), ALLOWED);
});
