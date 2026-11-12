import { element } from './plain-text.js?v=106';
import { renderChatContent, parseC4Content } from './chat-blocks.js?v=157';
import { createChatAttachment } from './chat-attachments.js?v=155';
import { applyChatView } from './chat-view.js?v=106';
import { conversationChartResource } from './conversation-charts.js?v=158';
import cjkFriendly from '../markdown-it-cjk-friendly/index.js?v=1';
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
  if (['chat_conversation_not_found', 'chat_message_not_found'].includes(code)) {
    return 'chat.error.notFound';
  }
  if (['chat_core_unavailable', 'chat_history_unavailable', 'chat_conversation_unavailable'].includes(code)) {
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
  chartTimeZone = () => null
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
  const createMarkdown = document.defaultView?.markdownit;
  if (typeof createMarkdown === 'function') {
    const markdown = createMarkdown({
      html: false,
      linkify: true,
      breaks: true
    }).use(cjkFriendly);
    // Images are not part of this renderer's capability. Keep their descriptions as text.
    markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
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
