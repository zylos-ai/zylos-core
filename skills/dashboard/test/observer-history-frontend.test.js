import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ObserverHistory, createHistoryMarkdown, escapeHistory } from '../public/js/observer-history.js';

function controller() {
  const history = Object.create(ObserverHistory.prototype);
  const elements = {
    timeline: { scrollHeight: 1000, scrollTop: 920, clientHeight: 80 },
    internal: { checked: false }, older: {}, latest: {}, status: {},
    entries: { append() {}, prepend() {} }
  };
  Object.assign(history, { active: true, generation: 0, session: 'current', current: 'current', controllers: new Set(), fields: new Map(), entries: new Map(), doc: { hidden: false }, el: key => elements[key], t: key => key });
  return { history, elements };
}

test('history Markdown escapes HTML and permits only http(s) links, without remote images', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('public/js/markdown-it.min.js', 'utf8'), context);
  const render = createHistoryMarkdown(context.markdownit);
  const result = render('<script>alert(1)</script> [bad](javascript:alert(1)) [file](file:///etc/passwd) [mail](mailto:x@y.com) [good](https://example.com) ![tracker](https://example.com/pixel)');
  assert.doesNotMatch(result, /<script|<img|href="(?:javascript|file|mailto):/);
  assert.match(result, /href="https:\/\/example.com"[^>]*rel="noopener noreferrer"/);
  assert.match(result, /&lt;script&gt;/);
  assert.equal(escapeHistory('"<>&\''), '&quot;&lt;&gt;&amp;&#39;');
});

test('leaving history aborts requests and polling without owning live terminal state', () => {
  const { history } = controller();
  history.lease = { id: 'live' };
  const abort = new AbortController(); history.controllers.add(abort);
  history.schedule(); assert.ok(history.timer);
  history.setActive(false);
  assert.equal(history.active, false); assert.equal(abort.signal.aborted, true);
  assert.equal(history.controllers.size, 0); assert.equal(history.lease.id, 'live');
  assert.equal(history.timer._destroyed, true);
});

test('history polling only runs at bottom of a visible active view', () => {
  const { history, elements } = controller();
  history.doc.hidden = true; history.schedule(); assert.equal(history.timer, undefined);
  history.doc.hidden = false; elements.timeline.scrollTop = 0; history.schedule(); assert.equal(history.timer, undefined);
  elements.timeline.scrollTop = 920; history.schedule(); assert.ok(history.timer);
  history.cancel();
});

test('response from a previous session is discarded even when fetch ignores abort', async () => {
  const { history } = controller(); let resolve;
  history.endpoint = path => '/fleet/example' + path;
  history.request = async (url, options) => {
    assert.match(url, /^\/fleet\/example\/api\/observer\/history\/entries/);
    assert.equal(options.cache, 'no-store');
    await new Promise(done => { resolve = done; });
    return { ok: true, json: async () => ({ entries: [{ id: 'secret-old-session' }] }) };
  };
  const pending = history.json('entries', { session: 'old' });
  history.cancel(); resolve();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('older pagination preserves scroll position and merges pending-tool updates by id', async () => {
  const { history, elements } = controller();
  const order = []; const replaced = [];
  elements.entries.prepend = (...nodes) => { order.unshift(...nodes.map(n => n.id)); elements.timeline.scrollHeight += 300; };
  elements.entries.append = (...nodes) => order.push(...nodes.map(n => n.id));
  history.before = 'o:20'; history.after = 'o:30';
  history.renderEntry = entry => ({ id: entry.id, replaceWith: node => replaced.push(node.id) });
  history.entries.set('o:30', { entry: { id: 'o:30', status: 'running' }, node: history.renderEntry({ id: 'o:30' }) });
  history.json = async (_route, params) => {
    assert.equal(params.before, 'o:20');
    return { entries: [{ id: 'o:10' }], updates: [{ id: 'o:30', status: 'success' }, { id: 'o:5', status: 'success' }], before: 'o:10', after: 'o:20', hasOlder: true };
  };
  await history.load('before');
  assert.equal(elements.timeline.scrollTop, 1220);
  assert.deepEqual(order, ['o:10']); assert.deepEqual(replaced, ['o:30']);
  assert.equal(history.after, 'o:30'); assert.equal(history.before, 'o:10'); history.cancel();
});

test('Observer history controls do not call live terminal lifecycle', () => {
  const app = fs.readFileSync('public/js/app.js','utf8');
  const controls = app.slice(app.indexOf('function initObserverControls()'), app.indexOf('function initMemoryControls()'));
  assert.doesNotMatch(controls, /closeObserver|openObserver|releaseObserverLease|srcdoc/);
  assert.match(controls, /parentElement.hidden = historyMode/);
  assert.match(controls, /history.setActive\(historyMode\)/);
});

test('session search follows the internal-record visibility setting', async () => {
  const { history, elements } = controller();
  elements.query = { value: 'needle' };
  elements.results = { childNodes: [], replaceChildren() {}, querySelector() { return null; } };
  const requests = [];
  history.json = async (route, params) => { requests.push({ route, params }); return { matches: [], hasMore: false }; };
  elements.internal.checked = true;
  await history.search();
  elements.internal.checked = false;
  await history.search();
  assert.deepEqual(requests.map(request => request.params.internal), [1, 0]);
  assert.ok(requests.every(request => request.route === 'search' && request.params.session === 'current'));
});

test('session labels distinguish duplicate titles using browser local start time', () => {
  const { history } = controller();
  const year = new Date().getFullYear();
  const first = new Date(year, 0, 2, 3, 4).toISOString();
  const second = new Date(year, 0, 2, 4, 5).toISOString();
  assert.equal(history.sessionLabel({ id: 'a', title: 'Same title', startedAt: first }), '01-02 03:04 · Same title');
  assert.equal(history.sessionLabel({ id: 'b', title: 'Same title', startedAt: second }), '01-02 04:05 · Same title');
  assert.equal(history.sessionLabel({ id: 'current', kind: 'subagent', title: 'Same title', startedAt: first }), '↳ observer.history.current · 01-02 03:04 · Same title');
  assert.equal(history.sessionLabel({ id: 'a', title: 'Old', startedAt: new Date(year - 1, 11, 31, 23, 59).toISOString() }), `${year - 1}-12-31 23:59 · Old`);
});

test('session labels omit absent or invalid time without empty separators or duplicated fallback', () => {
  const { history } = controller();
  for (const startedAt of [undefined, null, '', 'invalid']) {
    assert.equal(history.sessionLabel({ id: 'a', title: 'Title', startedAt }), 'Title');
  }
  assert.equal(history.sessionLabel({ id: 'a' }), 'a');
  assert.equal(history.sessionLabel({ id: 'a', startedAt: 'invalid' }), 'invalid');
  const startedAt = new Date(new Date().getFullYear(), 0, 2, 3, 4).toISOString();
  assert.equal(history.sessionLabel({ id: 'a', startedAt }), startedAt);
});

test('history controls align the search row with the session select, not its label', () => {
  const css = fs.readFileSync('public/css/style.css', 'utf8');
  assert.match(css, /\.history-controls \{[^}]*align-items: flex-end;/);
  assert.match(css, /\.history-controls select, \.history-controls input\[type="search"\] \{[^}]*height: 36px;/);
  assert.match(css, /\.history-controls label \{[^}]*min-height: 36px;/);
});
