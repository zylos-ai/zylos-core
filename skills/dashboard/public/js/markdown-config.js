// Memory content is semi-trusted (agent-written): html:false keeps raw HTML escaped,
// and every link opens in a new tab without access to this page.
export function createMarkdownRenderer(markdownit) {
  if (typeof markdownit !== 'function') return null;
  const md = markdownit({ html: false, linkify: true });
  // Only links with a scheme (https://, ftp:// …) become links. Bare file names such as identity.md or
  // state.md would otherwise turn into links to a .md domain; www. addresses without a scheme stay text too.
  md.linkify.set({ fuzzyLink: false });
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
