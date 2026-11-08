export function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text ?? '');
  if (className) node.className = className;
  return node;
}
export function fallbackName(row, t = key => key) {
  const key = row.sessionGroup;
  if (key == null) return t('wb.single');
  if (key === 'origin') return t('wb.term.origin');
  const colon = key.indexOf(':');
  const namespace = colon < 0 ? key : key.slice(0, colon);
  const component = row.c4?.componentName ?? namespace;
  const platforms = new Set(['telegram', 'lark', 'feishu', 'web-console', 'openmax', 'wechat']);
  const platform = platforms.has(component) ? t('wb.platform.' + component) : component;
  return colon < 0 ? platform : platform + ' · ' + key.slice(colon + 1);
}
