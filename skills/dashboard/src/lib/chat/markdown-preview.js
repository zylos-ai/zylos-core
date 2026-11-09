import '../../../public/js/markdown-it.min.js';
import { cjkEmphasis } from '../../../public/js/markdown-cjk-emphasis.js';

// Reuse the same vendored Markdown parser as the message body, without rendering HTML.
const markdown = globalThis.markdownit({ html: false, linkify: false }).use(cjkEmphasis);
export function markdownPreview(text, { locale = 'zh' } = {}) {
  const code = locale === 'en' ? '[Code]' : '[代码]';
  const parts = [];
  function inline(tokens) {
    for (const token of tokens ?? []) {
      if (token.type === 'text' || token.type === 'code_inline') parts.push(token.content);
      else if (token.type === 'image') inline(token.children);
      else if (token.type === 'softbreak' || token.type === 'hardbreak') parts.push('\n');
    }
  }
  for (const token of markdown.parse(String(text ?? ''), {})) {
    if (token.type === 'inline') inline(token.children);
    else if (token.type === 'fence' || token.type === 'code_block') parts.push(code, '\n');
    else if (['paragraph_close', 'heading_close', 'list_item_close', 'tr_close'].includes(token.type)
        && parts.length && !parts.at(-1).endsWith('\n')) parts.push('\n');
    else if (['th_close', 'td_close'].includes(token.type)) parts.push(' ');
  }
  return parts.join('').trim() || String(text ?? '');
}
