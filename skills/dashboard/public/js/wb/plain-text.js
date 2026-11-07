export function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text ?? '');
  if (className) node.className = className;
  return node;
}
/** Line icon from css/wb-icons.css; decorative, so hidden from assistive technology. */
export function icon(document, name, size) {
  const node = element(document, 'i', undefined, `wb-ico wb-ico-${name}${size ? ' wb-ico-' + size : ''}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}
export function platformOf(row) {
  const key = row.sessionGroup ?? '';
  const colon = key.indexOf(':');
  return row.c4?.componentName ?? (colon < 0 ? key : key.slice(0, colon));
}
export function fallbackName(row, t = key => key) {
  const key = row.sessionGroup;
  if (key == null) return t('wb.single');
  if (key === 'origin') return t('wb.term.origin');
  const colon = key.indexOf(':');
  const component = platformOf(row);
  const platforms = new Set(['telegram', 'lark', 'feishu', 'web-console', 'openmax', 'wechat']);
  const platform = platforms.has(component) ? t('wb.platform.' + component) : component;
  return colon < 0 ? platform : platform + ' · ' + key.slice(colon + 1);
}
