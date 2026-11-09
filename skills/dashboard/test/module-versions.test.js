import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
// Served from outside public/ (see the static handler); it is still followed for its own imports.
const servedFrom = { 'chat-schema.js': fileURLToPath(new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url)) };

const specifiers = source => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);

// Every module and stylesheet the entry page reaches through static imports, with each ?v= it is loaded at.
function loadedVersions() {
  const index = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  const versions = new Map(), queue = [];
  const visit = (file, version) => {
    if (!versions.has(file)) { versions.set(file, new Set()); queue.push(file); }
    versions.get(file).add(version);
  };
  for (const [, ref] of index.matchAll(/(?:src|href)="__ASSET_ROOT__\/([^"]+)"/g)) {
    const [file, query = ''] = ref.split('?');
    if (file.startsWith('vendor/')) continue; // a plain script served from node_modules, not a page module
    visit(file, new URLSearchParams(query).get('v'));
  }
  while (queue.length) {
    const file = queue.shift();
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(servedFrom[file] ?? path.join(publicRoot, file), 'utf8');
    for (const spec of specifiers(source)) {
      if (!spec.startsWith('.')) continue;
      const [rel, query = ''] = spec.split('?');
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), rel)), new URLSearchParams(query).get('v'));
    }
  }
  return versions;
}

test('every module the page loads is imported at one cache version only', () => {
  const versions = loadedVersions();
  assert.ok(versions.has('js/app.js') && versions.has('js/wb/conversation-page.js') && versions.has('js/wb/board.js') && versions.has('js/wb/timezone-names.js'), 'the walk reaches the page modules');
  const mixed = [...versions].filter(([, set]) => set.size > 1).map(([file, set]) => `${file}: ${[...set].join(', ')}`);
  assert.deepEqual(mixed, [], 'a module imported at two ?v= values loads twice and keeps two copies of its state');
  for (const file of versions.keys()) assert.ok(servedFrom[file] || fs.existsSync(path.join(publicRoot, file)), `${file} exists`);
});
