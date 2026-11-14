// Minimal injected DOM: no browser, sockets, processes, storage or product-source evaluation.
class TextNode {
  constructor(value, document) { this.nodeType = 3; this.nodeValue = String(value); this.ownerDocument = document; this.parentNode = null; }
  get nodeName() { return '#text'; }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
  get nextSibling() { const siblings = this.parentNode?.childNodes ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  remove() { this.parentNode?.removeChild(this); }
}
export class Node {
  constructor(tag = '', document) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.parentNode = null;
    this.childNodes = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.scrollTop = 0; this.open = false;
    const attributes = this.attributes;
    Object.defineProperty(attributes, Symbol.iterator, { value: function* () {
      for (const [name, value] of Object.entries(attributes)) yield { name, value };
    } });
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
  }
  get nodeName() { return this.tagName; }
  // Legacy DOM helpers assign/splice an element-only children array. Keep that
  // array backed by childNodes; standard text-bearing nodes expose elements only.
  get children() { return this.childNodes.every(node => node.nodeType === 1) ? this.childNodes : this.childNodes.filter(node => node.nodeType === 1); }
  set children(nodes) {
    for (const child of this.childNodes) if (child.parentNode === this) child.parentNode = null;
    this.childNodes = [...nodes];
    for (const child of this.childNodes) child.parentNode = this;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  contains(node) { return node === this || this.childNodes.some(child => child.nodeType === 1 ? child.contains(node) : child === node); }
  querySelectorAll(selector) {
    if (!/^\.[\w-]+$/.test(selector)) throw Error('Unsupported fixture selector: ' + selector);
    return this.children.flatMap(child => [...(child.classList.contains(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  get nextSibling() { const siblings = this.parentNode?.childNodes ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  // Legacy helpers read/write direct text separately from element children.
  get text() { return this.legacyText ?? this.childNodes.filter(node => node.nodeType === 3).map(node => node.nodeValue).join(''); }
  set text(value) { this.legacyText = String(value); }
  set textContent(value) {
    delete this.legacyText;
    this.replaceChildren();
    if (String(value)) this.append(new TextNode(value, this.ownerDocument));
  }
  get textContent() { return (this.legacyText ?? '') + this.childNodes.map(child => child.textContent).join(''); }
  set className(value) { this.attributes.class = String(value); }
  get className() { return this.attributes.class ?? ''; }
  get classList() {
    const values = () => new Set(this.className.split(' ').filter(Boolean));
    const write = set => { this.className = [...set].join(' '); };
    return {
      add: (...items) => { const set = values(); items.forEach(value => set.add(value)); write(set); },
      contains: value => values().has(value),
      remove: (...items) => { const set = values(); items.forEach(value => set.delete(value)); write(set); },
      toggle: (value, flag) => { const set = values(), enabled = flag ?? !set.has(value); if (enabled) set.add(value); else set.delete(value); write(set); return enabled; },
    };
  }
  get id() { return this.attributes.id ?? ''; }
  set id(value) { this.attributes.id = String(value); }
  get title() { return this.attributes.title ?? ''; }
  set title(value) { this.attributes.title = String(value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  // Nothing is laid out here, so no node has a box on screen.
  getClientRects() { return []; }
  append(...children) { for (const child of children) this.insertBefore(typeof child === 'string' ? new TextNode(child, this.ownerDocument) : child, null); }
  insertBefore(child, before) {
    if (child === before) return child;
    if (before != null && !this.childNodes.includes(before)) throw Error('insertBefore reference is not a child');
    child.parentNode?.removeChild(child);
    const index = before == null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(index, 0, child); child.parentNode = this; return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw Error('removeChild target is not a child');
    this.childNodes.splice(index, 1); child.parentNode = null; return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...children) { for (const child of [...this.childNodes]) this.removeChild(child); this.append(...children); }
  addEventListener(name, handler) { const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(fn => fn !== handler)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  dispatch(name, event = {}) { this.listeners.get(name)?.forEach(fn => fn({ target: this, currentTarget: this, ...event })); }
  focus() { this.focused = true; this.ownerDocument.activeElement = this; }
}
export function createDocument() {
  const document = { createElement: tag => new Node(tag, document), createTextNode: value => new TextNode(value, document), documentElement: { dataset: {} } };
  return document;
}
export function allNodes(root) { return [root, ...root.children.flatMap(allNodes)]; }
export function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export const tick = () => new Promise(resolve => setImmediate(resolve));
