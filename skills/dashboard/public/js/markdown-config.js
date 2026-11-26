import cjkFriendly from './markdown-it-cjk-friendly/index.js';

// A bare address ends at the first CJK or full-width punctuation mark (、。，：）」 and the like), so
// "文档见 https://zylos.ai/docs，有问题再说。" links only the address, as in the phone App.
const CJK_PUNCTUATION = /[\u2000-\u206F\u3000-\u303F\uFF00-\uFFEF]/;
function trimLink(link) {
  const cut = link?.raw.search(CJK_PUNCTUATION) ?? -1;
  if (cut <= 0) return link;
  const tail = link.raw.length - cut;
  return Object.assign(link, { raw: link.raw.slice(0, cut), text: link.text.slice(0, -tail),
    url: link.url.slice(0, -tail), lastIndex: link.lastIndex - tail });
}
/** Makes markdown-it's linkify end bare addresses at CJK punctuation. */
export function endLinksAtCjkPunctuation(md) {
  const { linkify } = md;
  const match = linkify.match.bind(linkify), matchAtStart = linkify.matchAtStart.bind(linkify);
  linkify.match = text => match(text)?.map(trimLink) ?? null;
  linkify.matchAtStart = text => trimLink(matchAtStart(text));
  return md;
}

// Memory content is semi-trusted (agent-written): html:false keeps raw HTML escaped,
// and every link opens in a new tab without access to this page.
export function createMarkdownRenderer(markdownit) {
  if (typeof markdownit !== 'function') return null;
  const md = markdownit({ html: false, linkify: true }).use(cjkFriendly);
  // Only links with a scheme (https://, ftp:// …) become links. Bare file names such as identity.md or
  // state.md would otherwise turn into links to a .md domain; www. addresses without a scheme stay text too.
  md.linkify.set({ fuzzyLink: false });
  endLinksAtCjkPunctuation(md);
  const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
  const defaultLinkOpen = md.renderer.rules.link_open || renderToken;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return md;
}

/** Rendered HTML; when the vendored script failed to load, the escaped raw view instead. */
export function markdownHtml(md, text, esc) {
  const source = String(text || '');
  if (!md) return `<pre class="memory-raw"><code>${esc(source)}</code></pre>`;
  return md.render(source);
}
