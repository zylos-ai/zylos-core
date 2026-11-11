import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { createDocument, tick } from './helpers/conversation-dom.js';
const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');

// Real page/controller with fixture-owned DOM and HTTP responses; no DB/PM2/tmux/network.
const root = path.dirname(process.env.HOME);
assert.match(path.basename(root), /^zylos-tests-/);
assert.equal(process.env.ZYLOS_DIR, path.join(process.env.HOME, 'zylos'));
assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
assert.equal(process.env.TMPDIR, path.join(root, 'tmp'));

for (const width of [1280, 390]) test(`one click opens an unnamed draft at ${width} width and pending clicks do not duplicate it`, async t => {
  const document = createDocument(), root = document.createElement('div');
  document.defaultView = { innerWidth: width, innerHeight: 844, addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }) };
  let created = false, release;
  const pending = new Promise(resolve => { release = resolve; }), writes = [];
  const draft = { id: 'd:sample', state: 'draft', displayName: null, display_name: null };
  const page = mountConversationPage({ root, document, storage: null, fetch: async (url, options) => {
    let body;
    if (options?.method === 'POST') {
      writes.push(JSON.parse(options.body)); await pending; created = true; body = { conversation: draft };
    } else body = url === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : url.startsWith('/api/chat/conversations?') ? { items: created ? [draft] : [], nextCursor: null }
      : /\/conversations\/[^/?]+$/.test(url) ? { conversation: draft }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => { release(); page.destroy(); });
  await page.open();
  const create = root.querySelector('[data-action="create"]');
  assert.equal(create.disabled, false);
  create.dispatch('click'); await tick();
  assert.equal(writes.length, 1, 'the first click creates instead of opening a name form');
  assert.equal(Object.keys(writes[0]).length, 0, 'creation sends no name');
  assert.equal(root.querySelector('.conversation-create-form'), null);
  assert.equal(create.disabled, true);
  create.dispatch('click'); assert.equal(writes.length, 1);
  release(); await tick(); await tick();
  assert.equal(root.querySelector('[data-conversation-id="d:sample"]').getAttribute('aria-current'), 'true');
  assert.equal(create.disabled, false);
  assert.ok(root.querySelector('.conversation-page').classList.contains('conversation-detail-open') || width === 1280);
});
