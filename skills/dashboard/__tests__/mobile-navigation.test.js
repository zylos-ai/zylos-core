import test from 'node:test';
import assert from 'node:assert/strict';
import { Node, allNodes } from './fixtures/workbench-dom.js';
import { mountMobileNavigation } from '../public/js/wb/mobile-navigation.js';

// DOM ownership and mutation subscriptions only; real layout stays in the
// isolated mobile browser case. No browser, network, process or storage starts.
function navigationDocument() {
  const observations = [], observer = { disconnects: 0 };
  const documentEvents = new Node('document'), viewEvents = new Node('window');
  const matches = (node, selector) => {
    if (selector === 'button:not([hidden])') return node.tagName === 'BUTTON' && !node.hidden;
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    const [, tag, cls, attribute, value] = selector.match(/^(\w+)?(?:\.([\w-]+))?(?:\[([\w-]+)="([^"]+)"\])?$/) ?? [];
    if (!tag && !cls && !attribute) throw Error('Unsupported navigation fixture selector: ' + selector);
    const attr = attribute?.startsWith('data-') ? node.dataset[attribute.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] : node.getAttribute(attribute);
    return (!tag || node.tagName === tag.toUpperCase()) && (!cls || node.classList.contains(cls)) && (!attribute || attr === value);
  };
  const document = { createElement(tag) {
    const node = new Node(tag, document);
    node.querySelectorAll = selector => allNodes(node).slice(1).filter(item => matches(item, selector));
    node.querySelector = selector => node.querySelectorAll(selector)[0] ?? null;
    node.after = other => node.parentNode?.insertBefore(other, node.nextSibling);
    node.replaceWith = other => { node.parentNode?.insertBefore(other, node); node.remove(); };
    node.click = () => { if (!node.disabled) node.dispatch('click'); };
    return node;
  }, addEventListener: documentEvents.addEventListener.bind(documentEvents),
  removeEventListener: documentEvents.removeEventListener.bind(documentEvents) };
  document.documentElement = document.createElement('html');
  document.body = document.createElement('body'); document.documentElement.append(document.body);
  document.querySelector = selector => allNodes(document.documentElement).find(node => matches(node, selector)) ?? null;
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.detail = 'plain';
  document.defaultView = { innerWidth: 390,
    addEventListener: viewEvents.addEventListener.bind(viewEvents), removeEventListener: viewEvents.removeEventListener.bind(viewEvents),
    MutationObserver: class {
      constructor(callback) { observer.callback = callback; }
      observe(target, options) { observations.push({ target, options }); }
      disconnect() { observer.disconnects++; }
    } };
  const add = (parent, tag, { id, cls, tab } = {}) => {
    const node = document.createElement(tag);
    if (id) node.id = id; if (cls) node.className = cls; if (tab) node.dataset.tab = tab;
    parent.append(node); return node;
  };
  const header = add(document.body, 'header', { cls: 'app-header' });
  const sourceTabs = ['overview', 'chat', 'schedule', 'memory', 'trends', 'observer'].map(tab => add(header, 'button', { cls: 'tab', tab, id: tab === 'observer' ? 'observer-tab' : undefined }));
  for (const id of ['wb-settings-btn', 'fleet-manage-btn', 'wb-tech-btn', 'wb-theme-toggle', 'wb-detail-toggle', 'tab-bar-agent-name', 'tab-bar-core-version']) add(header, 'button', { id });
  document.querySelector('#observer-tab').hidden = true;
  add(document.body, 'section', { id: 'tab-settings' });
  const chat = add(document.body, 'section', { id: 'wb-chat' });
  const reload = add(chat, 'button', { cls: 'conversation-reload' });
  const create = add(chat, 'button', { cls: 'conversation-create' });
  const history = add(chat, 'div', { cls: 'conversation-history' });
  return { document, observations, observer, header, chat, history, reload, create, sourceTabs, viewEvents };
}

test('mobile navigation watches availability controls without watching conversation content', () => {
  const f = navigationDocument(), { document } = f;
  const navigation = mountMobileNavigation({ document, t: key => key, getView: () => ({ tab: 'chat', fleet: false }) });
  try {
    assert.ok(f.observations.some(record => record.target === f.reload));
    assert.ok(f.observations.some(record => record.target === f.create));
    assert.ok(f.sourceTabs.every(tab => f.observations.some(record => record.target === tab)));
    for (const { target, options } of f.observations) {
      assert.equal(options.subtree, undefined, 'does not subscribe to descendants');
      assert.equal(options.childList, undefined, 'does not subscribe to appended messages or labels');
      assert.equal(options.characterData, undefined, 'does not subscribe to running timers');
      assert.equal(options.attributes, true);
      assert.ok(![f.header, f.chat, f.history].includes(target), 'content containers are not observed');
    }
    f.reload.disabled = true; f.create.hidden = true;
    f.observer.callback();
    assert.equal(document.querySelector('#wb-mobile-list-refresh').disabled, true);
    assert.equal(document.querySelector('#wb-mobile-list-create').hidden, true);
    f.reload.disabled = false; f.create.hidden = false;
    f.observer.callback();
    assert.equal(document.querySelector('#wb-mobile-list-refresh').disabled, false);
    assert.equal(document.querySelector('#wb-mobile-list-create').hidden, false);
  } finally { navigation.destroy(); }
  assert.equal(f.observer.disconnects, 1);
});
