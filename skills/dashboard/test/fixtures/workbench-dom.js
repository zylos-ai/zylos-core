// Minimal injected DOM: no browser, sockets, processes, storage or product-source evaluation.
export class Node {
  constructor(tag = '', document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.hidden = false; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get className() { return [...(this.classes ?? [])].join(' '); }
  get classList() { return { add: (...values) => { this.classes ??= new Set(); values.forEach(v => this.classes.add(v)); }, contains: value => this.classes?.has(value) ?? false, remove: (...values) => values.forEach(v => this.classes?.delete(v)), toggle: (value, flag) => { this.classes ??= new Set(); const enabled = flag ?? !this.classes.has(value); if (enabled) this.classes.add(value); else this.classes.delete(value); } }; }
  // Nothing is laid out here, so no node has a box on screen.
  getClientRects() { return []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener(name, handler) { const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(fn => fn !== handler)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  dispatch(name, event = {}) { this.listeners.get(name)?.forEach(fn => fn(event)); }
  focus() { this.focused = true; }
}
export function createDocument() {
  const document = { createElement: tag => new Node(tag, document), documentElement: { dataset: {} } };
  return document;
}
export function allNodes(root) { return [root, ...root.children.flatMap(allNodes)]; }
export function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export const tick = () => new Promise(resolve => setImmediate(resolve));
