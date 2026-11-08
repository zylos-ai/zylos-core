import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick } from './fixtures/workbench-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');

// Only DOM ownership is needed here; layout remains covered by the browser case.
// No sockets, databases, storage, subprocesses or real network requests are used.
function pageDocument() {
  const document = createDocument();
  const createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag);
    Object.defineProperty(node, 'lastElementChild', { get: () => node.children.at(-1) });
    node.remove = () => {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node);
      node.parentNode = null;
    };
    node.insertBefore = (child, before) => {
      child.remove();
      const index = node.children.indexOf(before);
      node.children.splice(index < 0 ? node.children.length : index, 0, child);
      child.parentNode = node;
    };
    node.append = (...children) => children.forEach(child => node.insertBefore(child, null));
    node.replaceChildren = (...children) => {
      node.children.forEach(child => { child.parentNode = null; });
      node.children = [];
      node.append(...children);
    };
    node.querySelectorAll = selector => allNodes(node).slice(1).filter(child =>
      selector.startsWith('.') && child.classList.contains(selector.slice(1)));
    node.getBoundingClientRect = () => ({ top: 0, bottom: 0 });
    node.scrollTop = node.scrollHeight = node.clientHeight = 0;
    return node;
  };
  return document;
}

for (const stop of ['close', 'destroy']) {
  test(`conversation page forwards the group request signal and aborts it on ${stop}`, { timeout: 2000 }, async t => {
    const document = pageDocument(), root = document.createElement('div');
    const sessionGroup = 'dashboard:page-signal', id = 'g:' + Buffer.from(sessionGroup).toString('hex').toUpperCase();
    let signal, aborts = 0;
    const page = mountConversationPage({ root, document, fetch: async (path, options) => {
      if (path === '/api/workbench/groups') {
        signal = options.signal;
        assert.ok(signal instanceof AbortSignal, 'the actual page request adapter passes an AbortSignal to fetch');
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          aborts++;
          reject(new Error('aborted'));
        }, { once: true }));
      }
      const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
        : path.startsWith('/api/chat/conversations?') ? { items: [{ id, sessionGroup }], nextCursor: null }
        : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id, sessionGroup, state: 'active' } }
        : { items: [], nextCursor: null, afterCursor: 'after' };
      return { ok: true, status: 200, json: async () => body };
    } });
    t.after(() => page.destroy());
    assert.equal(await page.openGroup(sessionGroup), true);
    assert.ok(signal, 'selecting an active conversation starts its optional group request');
    assert.equal(signal.aborted, false);
    page[stop]();
    await tick();
    assert.equal(signal.aborted, true);
    assert.equal(aborts, 1, 'the fetch transport observes cancellation exactly once');
  });
}
