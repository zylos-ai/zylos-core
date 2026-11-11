// Keep mounted detail nodes and their native interaction state. Explicit keys
// identify data rows; structural elements use their stable role/class.
// Only callbacks registered through listen() are replaced on retained nodes.
// A subtree using direct addEventListener() must have a key that changes when
// those callbacks' dependencies change, so its closures stay current.
const handlers = new WeakMap();

export function listen(node, type, handler) {
  let entries = handlers.get(node);
  if (!entries) handlers.set(node, entries = new Map());
  const previous = entries.get(type);
  if (previous) node.removeEventListener(type, previous);
  entries.set(type, handler);
  node.addEventListener(type, handler);
}

function key(node) {
  if (node.nodeType !== 1) return '#text';
  return node.dataset.updateKey ?? (node.id || `${node.tagName}:${String(node.className ?? '').split(' ')[0]}`);
}

function updateNode(node, next) {
  if (node.nodeType === 3) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  const attributes = new Map([...next.attributes].map(item => [item.name, item.value]));
  const nativeFold = node.tagName === 'DETAILS' && next.dataset.updateOpen !== 'true';
  const nativeScrollButton = node.classList.contains('wb-timeline-latest');
  const nativeAttribute = name => (nativeFold && name === 'open') || (nativeScrollButton && name === 'hidden');
  for (const item of [...node.attributes]) if (!nativeAttribute(item.name) && !attributes.has(item.name)) node.removeAttribute(item.name);
  for (const [name, value] of attributes) if (!nativeAttribute(name) && node.getAttribute(name) !== value) node.setAttribute(name, value);
  for (const property of ['hidden', 'disabled', 'title']) {
    if (property === 'hidden' && nativeScrollButton) continue;
    if (node[property] !== next[property]) node[property] = next[property];
  }
  // Evidence/table folds are native user state. A raw fold is controlled by its
  // preview key and fetched-message state instead.
  if (next.dataset.updateOpen === 'true' && node.open !== next.open) node.open = next.open;
  const previous = handlers.get(node) ?? new Map(), incoming = handlers.get(next) ?? new Map();
  for (const [type, handler] of previous) node.removeEventListener(type, handler);
  for (const [type, handler] of incoming) node.addEventListener(type, handler);
  handlers.set(node, incoming);
  reconcileChildren(node, next);
  for (const property of ['value', 'checked', 'selected']) {
    if (property in next && node[property] !== next[property]) node[property] = next[property];
  }
}

export function reconcileChildren(root, desired) {
  const existing = [...root.childNodes], available = new Map();
  for (const node of existing) {
    const identity = key(node);
    if (!available.has(identity)) available.set(identity, []);
    available.get(identity).push(node);
  }
  let cursor = root.firstChild;
  const retained = new Set();
  for (const next of [...desired.childNodes]) {
    const candidates = available.get(key(next));
    const node = candidates?.shift();
    const current = node && node.nodeType === next.nodeType && node.nodeName === next.nodeName ? node : next;
    if (current === node) updateNode(node, next);
    retained.add(current);
    if (current !== cursor) root.insertBefore(current, cursor);
    cursor = current.nextSibling;
  }
  for (const node of existing) if (!retained.has(node)) root.removeChild(node);
}
