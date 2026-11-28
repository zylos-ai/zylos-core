import { element } from './plain-text.js';
import { createFold } from './fold.js';
import { countLabel } from '../count-label.js';
import { parseSentAnnotations } from './chat-compose-text.js';
import { renderChatContent, parseC4Content } from './chat-blocks.js';
import { createChatAttachment } from './chat-attachments.js';
import { applyChatView } from './chat-view.js';
import { conversationChartResource } from './conversation-charts.js';
import cjkFriendly from '../markdown-it-cjk-friendly/index.js';
import { endLinksAtCjkPunctuation } from '../markdown-config.js';
export function conversationErrorKey(code) {
  if (['chat_auth_required', 'chat_conversation_forbidden', 'insufficient_scope'].includes(code)) {
    return 'chat.error.forbidden';
  }
  if (code === 'chat_requires_multi') {
    return 'chat.error.requiresMulti';
  }
  if (code === 'chat_conversation_started') {
    return 'chat.error.conversationStarted';
  }
  if (['not_found', 'chat_conversation_not_found', 'chat_message_not_found'].includes(code)) {
    return 'chat.error.notFound';
  }
  if (['unavailable', 'chat_core_unavailable', 'chat_history_unavailable', 'chat_conversation_unavailable'].includes(code)) {
    return 'chat.error.unavailable';
  }
  if (code === 'chat_send_unknown') {
    return 'chat.error.sendUnknown';
  }
  if (code === 'invalid_chat_quote') {
    return 'chat.error.invalidQuote';
  }
  return 'chat.error.requestFailed';
}

/** Render validated complete Content with optional View and page-owned chart resources. */
export function renderConversationContent({
  document,
  row,
  t,
  renderQuestion,
  supportsBlock,
  attachmentContext = {},
  showTechnicalDetails = false,
  chartTimeZone = () => null,
  onLocate = null
}) {
  const resources = [];
  const attachmentResources = [];
  const plainAttachments = parseC4Content(row.content).kind === 'text';
  let mounted = false, destroyed = false;
  let hasCharts = false;
  const makeAttachment = attachment => createChatAttachment({ document, attachment, context: attachmentContext, t });
  const blockAttachment = (block, metadata) => metadata.find(item => item.id === block.data.attachmentId)
    || { name: block.data.nameSnapshot, kind: block.type === 'x-zylos.image' ? 'image' : 'file', available: false };
  const content = renderChatContent({
    document,
    row,
    t,
    renderQuestion,
    supportsBlock,
    external: attachmentContext.external === true,
    showTechnicalDetails,
    layout: (root, view, blockNodes) => {
      applyChatView(document, root, view, blockNodes);
      root.classList.add('conversation-composed-content');
    },
    renderChart({ block, fallback }) {
      hasCharts = true;
      const resource = conversationChartResource({ document, block, fallback, t, timeZone: chartTimeZone });
      resources.push(resource);
      return resource.node;
    },
    renderAttachment({ attachment, block, attachmentIndex }) {
      const resource = makeAttachment(attachment);
      attachmentResources.push({ resource, attachment, block, attachmentIndex });
      resources.push(resource);
      return resource.node;
    }
  });
  // The owner's annotation message reads as quotes with comments (`onLocate` is passed for those rows only).
  const plain = onLocate && plainAttachments && content.querySelector(':scope > .chat-message-text');
  const sent = plain && parseSentAnnotations(plain.textContent);
  if (sent) plain.replaceWith(renderSentAnnotations({ document, sent, t, onLocate, resources }));
  const createMarkdown = document.defaultView?.markdownit;
  if (typeof createMarkdown === 'function') {
    const markdown = createMarkdown({
      html: false,
      linkify: true,
      breaks: true
    }).use(cjkFriendly);
    endLinksAtCjkPunctuation(markdown);
    // Images are not part of this renderer's capability. Keep their descriptions as text.
    markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
    // A wide table scrolls sideways inside its own box instead of squeezing every cell to a character per line.
    markdown.renderer.rules.table_open = () => '<div class="conversation-table-scroll"><table>\n';
    markdown.renderer.rules.table_close = () => '</table></div>\n';
    for (const text of content.querySelectorAll('.chat-message-text')) {
      const formatted = element(document, 'div', undefined, 'chat-message-text conversation-markdown');
      formatted.innerHTML = markdown.render(text.textContent);
      for (const link of formatted.querySelectorAll('a')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      text.replaceWith(formatted);
    }
  }
  if (hasCharts) content.classList.add('conversation-chart-content');
  content.updateAttachments = metadata => {
    if (destroyed) return;
    const items = Array.isArray(metadata) ? metadata.slice(0, 20) : [];
    const update = () => {
      for (const entry of [...attachmentResources]) {
        const next = entry.block ? blockAttachment(entry.block, items) : items[entry.attachmentIndex];
        if (next && JSON.stringify(entry.attachment) === JSON.stringify(next)) continue;
        const previous = entry.resource, index = resources.indexOf(previous);
        previous.destroy();
        if (next) {
          entry.attachment = next; entry.resource = makeAttachment(next);
          previous.node.replaceWith(entry.resource.node); resources[index] = entry.resource;
          if (mounted) entry.resource.mount();
        } else {
          previous.node.remove(); resources.splice(index, 1);
          attachmentResources.splice(attachmentResources.indexOf(entry), 1);
        }
      }
      if (plainAttachments) for (const [attachmentIndex, attachment] of items.entries()) {
        if (attachmentResources.some(entry => entry.attachmentIndex === attachmentIndex)) continue;
        const resource = makeAttachment(attachment);
        attachmentResources.push({ resource, attachment, attachmentIndex }); resources.push(resource);
        content.append(resource.node); if (mounted) resource.mount();
      }
    };
    if (attachmentContext.onLayout) attachmentContext.onLayout(update);
    else update();
  };
  content.mount = () => { if (destroyed) return; mounted = true; for (const resource of resources) resource.mount(); };
  content.destroy = () => { if (destroyed) return; destroyed = true; for (const resource of resources) resource.destroy(); };
  return content;
}

/**
 * An annotation message the owner sent from the web or the App: their own words (or a small "N annotations" label
 * for the default request), then per item the excerpt as a quote block with who wrote the original and when (folded
 * to three lines when longer; a click opens the original) and the comment. The heading and c4_id lines written for
 * the AI are not shown (Howard, Dashboard 2026-11-28). Own words and comments stay `.chat-message-text`, so they get
 * the Markdown pass like any message text.
 */
function renderSentAnnotations({ document, sent, t, onLocate, resources }) {
  const root = element(document, 'div', undefined, 'conversation-sent-annotation-view');
  if (sent.text !== null) root.append(element(document, 'p', sent.text, 'chat-message-text'));
  else root.append(element(document, 'p', countLabel(t, 'chat.annotation.count', sent.items.length), 'conversation-sent-annotation-count'));
  for (const item of sent.items) {
    const quote = element(document, 'button', undefined, 'conversation-quote-block conversation-sent-annotation-quote');
    quote.type = 'button';
    quote.title = t('chat.quote.jump');
    const author = item.author === 'AI' ? t('chat.page.ai') : t('chat.annotation.sendMe');
    const box = element(document, 'span', undefined, 'conversation-sent-annotation-fold');
    box.append(element(document, 'span', item.excerpt, 'conversation-sent-annotation-excerpt'));
    quote.append(element(document, 'span', [author, item.stamp].filter(Boolean).join(' · '), 'conversation-quote-block-who'), box);
    const fold = createFold({ document, box, t, expandKey: 'chat.annotation.more', collapseKey: 'chat.annotation.less' });
    // A click on a folded excerpt only unfolds it (the fold's own handler); once whole, a click opens the original.
    let unfolding = false;
    quote.addEventListener('click', event => { unfolding = box.classList.contains('is-cut') && box.contains(event.target); }, true);
    quote.addEventListener('click', event => {
      event.stopPropagation();
      if (!unfolding) onLocate(item.messageId);
    });
    const entry = element(document, 'div', undefined, 'conversation-sent-annotation-item');
    entry.append(quote, fold.toggle);
    if (item.comment) entry.append(element(document, 'p', item.comment, 'chat-message-text'));
    root.append(entry);
    fold.update();
    resources.push({ mount: () => fold.update(), destroy: () => fold.destroy() });
  }
  return root;
}
