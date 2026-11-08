import { element } from './plain-text.js?v=94';

/** Compose only the complete nodes referenced by the shared parser's validated View. */
export function applyChatView(document, root, view, blockNodes) {
  const nodes = new Map(view.nodes.map(node => [node.id, node]));
  const referenced = new Set();
  function render(id) {
    const node = nodes.get(id);
    if (node.type === 'block') {
      referenced.add(node.blockId);
      return blockNodes.get(node.blockId);
    }
    const wrapper = element(document, node.type === 'section' ? 'section' : 'div', undefined, 'conversation-view-' + node.type);
    if (node.type === 'section') {
      for (const slot of ['header', 'body', 'actions']) if (node[slot]?.length) {
        const part = element(document, 'div', undefined, 'conversation-view-' + slot);
        for (const child of node[slot]) part.append(render(child));
        wrapper.append(part);
      }
    } else {
      if (node.type === 'columns') {
        wrapper.dataset.layout = node.layout ?? 'balanced';
        wrapper.style.setProperty('--conversation-columns', String(node.children.length));
      } else wrapper.dataset.gap = node.gap ?? 'normal';
      for (const child of node.children) wrapper.append(render(child));
    }
    return wrapper;
  }
  const composed = render(view.root);
  const unreferenced = [...blockNodes].filter(([id]) => !referenced.has(id)).map(([, node]) => node);
  root.replaceChildren(composed, ...unreferenced);
}
