// Injected DOM for direct module tests; no browser or product source evaluation.
export class Element {
  constructor(tag, ownerDocument) { this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.text = ''; }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...(this.classes ?? [])].join(' '); }
  get classList() { return { contains: value => this.classes?.has(value) ?? false, toggle: (value, on) => { this.classes ??= new Set(); if (on ?? !this.classes.has(value)) this.classes.add(value); else this.classes.delete(value); } }; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes.reverse()) { node.remove(); node.parentElement = this; this.children.unshift(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.text = ''; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    const attr = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/);
    if (attr) { const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()); const value = attr[1].startsWith('data-') ? this.dataset[key] : this.attributes[key]; if (value === undefined || (attr[2] !== undefined && value !== attr[2])) return false; selector = selector.replace(attr[0], ''); }
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return !selector || this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  addEventListener(name, fn) { const handlers = this.listeners.get(name) ?? []; handlers.push(fn); this.listeners.set(name, handlers); }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(handler => handler !== fn)); }
  async dispatch(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) await fn({ target: this, ...event }); }
  focus() { this.focused = true; }
}
export function documentFixture() { const document = { createElement: tag => new Element(tag, document), documentElement: { dataset: { detail: 'plain' } } }; return document; }
export function node(document, tag, id) { const result = document.createElement(tag); if (id) result.id = id; return result; }
