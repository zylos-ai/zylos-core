import { element, fallbackName } from './plain-text.js?v=85';
export function showSidePanel(root, row, { document = root.ownerDocument, t = key => key } = {}) {
  const close = element(document, 'button', t('wb.back'));
  close.type = 'button'; close.addEventListener('click', () => { root.hidden = true; });
  root.replaceChildren(close, element(document, 'h2', row.name?.displayName ?? fallbackName(row, t)),
    element(document, 'p', t('wb.state.' + (row.state?.kind ?? 'unknown'))));
  root.hidden = false;
}
