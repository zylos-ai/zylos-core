import { createDocument as minimalDocument, allNodes } from '../fixtures/workbench-dom.js';
export { allNodes, tick, deferred } from '../fixtures/workbench-dom.js';

// Inject DOM ownership, supported selectors and suppression of clicks on disabled controls.
// Pixel layout belongs to the isolated browser test; unsupported selectors fail explicitly.
export function createDocument() {
  const document = minimalDocument(), createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag);
    node.value = '';
    node.parentNode = null;
    node.scrollTop = node.scrollHeight = node.clientHeight = 0;
    Object.defineProperties(node, {
      firstElementChild: { get: () => node.children[0] ?? null },
      lastElementChild: { get: () => node.children.at(-1) ?? null },
      parentElement: { get: () => node.parentNode },
      textContent: {
        get: () => (node.text ?? '') + node.children.map(child => child.textContent).join(''),
        set(value) { node.text = String(value); node.children.forEach(child => { child.parentNode = null; }); node.children = []; }
      }
    });
    node.remove = () => {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node);
      node.parentNode = null;
    };
    node.insertBefore = (child, before) => {
      child.remove();
      const index = before == null ? -1 : node.children.indexOf(before);
      node.children.splice(index < 0 ? node.children.length : index, 0, child);
      child.parentNode = node;
      return child;
    };
    node.append = (...children) => children.forEach(child => node.insertBefore(child, null));
    node.prepend = (...children) => children.slice().reverse().forEach(child => node.insertBefore(child, node.firstElementChild));
    node.replaceChildren = (...children) => { node.textContent = ''; node.append(...children); };
    node.replaceWith = replacement => { const parent = node.parentNode; if (parent) { parent.insertBefore(replacement, node); node.remove(); } };
    node.getAttribute = name => name.startsWith('data-') ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null : node.attributes[name] ?? null;
    node.matches = selector => selectors(selector).some(part => matches(node, part));
    node.querySelectorAll = selector => {
      const parts = selectors(selector);
      return allNodes(node).slice(1).filter(child => parts.some(part => matches(child, part)));
    };
    node.querySelector = selector => node.querySelectorAll(selector)[0] ?? null;
    node.closest = selector => { for (let current = node; current; current = current.parentNode) if (current.matches(selector)) return current; return null; };
    node.getBoundingClientRect = () => ({ top: 0, bottom: 0 });
    node.focus = () => { document.activeElement = node; };
    const dispatch = node.dispatch.bind(node);
    node.dispatch = (name, event = {}) => { if (!(name === 'click' && node.disabled)) dispatch(name, event); };
    return node;
  };
  return document;
}
function selectors(selector) {
  const attribute = String.raw`\[[\w-]+(?:="[^"\s,]*")?\]`;
  const qualifier = `(?:\\.[\\w-]+|${attribute})`;
  const simple = `(?:[a-z][a-z0-9-]*${qualifier}*|${qualifier}+)`;
  const supported = new RegExp(`^${simple}(?:(?:\\s*>\\s*|\\s+)${simple})*$`, 'i');
  const parts = typeof selector === 'string' ? selector.split(',').map(part => part.trim()) : [];
  if (!parts.length || parts.some(part => !part || !supported.test(part))) {
    throw new Error(`Unsupported conversation DOM selector: ${String(selector)}`);
  }
  return parts;
}
function matches(node, selector) {
  const child = selector.lastIndexOf('>');
  if (child >= 0) return matches(node, selector.slice(child + 1).trim()) && !!node.parentNode && matches(node.parentNode, selector.slice(0, child).trim());
  const parts = selector.split(/\s+/);
  if (parts.length > 1) {
    if (!matches(node, parts.pop())) return false;
    for (let parent = node.parentNode; parent; parent = parent.parentNode) if (matches(parent, parts.join(' '))) return true;
    return false;
  }
  const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name)) return false;
  for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const actual = node.getAttribute(name);
    if (actual === null || value !== undefined && actual !== value) return false;
  }
  return true;
}
export const visibleNodes = root => allNodes(root).filter(node => {
  for (let current = node; current; current = current.parentNode) if (current.hidden) return false;
  return true;
});
export function visibleText(node) {
  return node.hidden ? '' : (node.text ?? '') + node.children.map(visibleText).join('');
}
