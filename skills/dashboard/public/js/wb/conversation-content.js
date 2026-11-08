import { element } from './plain-text.js?v=94';
import { renderChatContent } from './chat-blocks.js?v=102';
import { applyChatView } from './chat-view.js?v=102';
import { conversationChartResource } from './conversation-charts.js?v=102';
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
  return 'chat.error.requestFailed';
}

/** Render validated complete Content with optional View and page-owned chart resources. */
export function renderConversationContent({
  document,
  row,
  t,
  renderQuestion,
  supportsBlock,
  showTechnicalDetails = false
}) {
  const resources = [];
  const content = renderChatContent({
    document,
    row,
    t,
    renderQuestion,
    supportsBlock,
    showTechnicalDetails,
    layout: (root, view, blockNodes) => applyChatView(document, root, view, blockNodes),
    renderChart({ block, fallback }) {
      const resource = conversationChartResource({ document, block, fallback, t });
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
    });
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
  content.mount = () => { for (const resource of resources) resource.mount(); };
  content.destroy = () => { for (const resource of resources) resource.destroy(); };
  return content;
}
