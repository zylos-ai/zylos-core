import assert from 'node:assert/strict';

export const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function loadingFixture(t, createConversationState, override = () => undefined) {
  let time = 1000, serial = 0, identity = 'local';
  const tasks = new Map(), listeners = new Set(), calls = [];
  const document = { hidden: false, visibilityState: 'visible', addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const state = createConversationState({ document, identity: () => identity, now: () => time,
    setTimeout(fn, ms) { const id = ++serial; tasks.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    request: async (path, options) => {
      assert.ok(calls.length < 250, 'bounded request log');
      const url = new URL(path, 'http://fixture'); calls.push({ path, url, options, at: time });
      const value = override(url, options, time); if (value !== undefined) return value;
      if (path === '/api/session-mode') return { data: { sessionMode: 'multi' } };
      if (url.pathname === '/api/chat/conversations') return { items: [{ id: 'g:AA', displayName: 'Conversation' }], nextCursor: null };
      if (url.pathname.endsWith('/messages')) return { items: url.searchParams.get('direction') === 'before' ? [{ id: 1, direction: 'in', status: 'pending', content: 'first' }] : [], afterCursor: 'after1', nextCursor: null };
      if (url.pathname.endsWith('/questions')) return { items: [], nextCursor: null };
      if (url.pathname.endsWith('/status')) return { items: [] };
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      return { conversation: { id, state: 'active' }, conversationId: id, stored: true };
    }
  });
  t.after(() => { state.destroy(); assert.equal(tasks.size, 0, 'all fake timers are reclaimed'); });
  return {
    state, calls,
    setIdentity(value) { identity = value; },
    async open() { await state.open(); await state.select('g:AA'); },
    async visible(value) { document.hidden = !value; document.visibilityState = value ? 'visible' : 'hidden'; for (const fn of listeners) fn(); await flush(); },
    async advance(ms) {
      const until = time + ms;
      for (let step = 0; ; step++) {
        assert.ok(step < 1000, 'bounded fake-clock advance');
        const next = [...tasks].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; tasks.delete(next[0]); next[1].fn(); await flush();
      }
      time = until; await flush();
    }
  };
}
