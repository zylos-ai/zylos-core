import { CONTENT_PREFIX } from '/chat-schema.js';
import { renderChatContent } from '/js/wb/chat-blocks.js';
import { applyChatView } from '/js/wb/chat-view.js';

const fallback = '未来组件的文字说明 <img src=x onerror=alert(1)>\n现有内容继续显示。';
const envelope = {
  version: 1, kind: 'message', messageId: 'future-message', fallbackText: 'Complete message in words',
  blocks: [
    { id: 'before', type: 'markdown', schemaVersion: 1, data: { text: '前面的正常内容' } },
    { id: 'future', type: 'future_widget', schemaVersion: 1, fallbackText: fallback, data: { action: 'unrecognized', attachmentId: 'unrecognized' } },
    { id: 'chart', type: 'category_series', schemaVersion: 1, fallbackText: 'A 7', data: { title: '保留的已知图表', points: [{ key: 'a', label: 'Alpha', value: 7 }] } },
    { id: 'after', type: 'markdown', schemaVersion: 1, data: { text: '后面的正常内容' } },
  ],
  metadata: { view: { schemaVersion: 1, root: 'layout', nodes: [
    { id: 'layout', type: 'stack', children: ['first', 'second', 'third', 'fourth'] },
    ...['before', 'future', 'chart', 'after'].map((blockId, i) => ({ id: ['first', 'second', 'third', 'fourth'][i], type: 'block', blockId })),
  ] } },
};
const row = { id: 42, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) };
const rendered = renderChatContent({ document, row, layout: (root, view, nodes) => applyChatView(document, root, view, nodes),
  renderAttachment() { throw Error('Unknown content invoked attachment renderer'); },
  renderQuestion() { throw Error('Unknown content invoked question renderer'); },
});
document.querySelector('.conversation-message-body').append(rendered);
window.unknownFixture = { ready: true, fallback };
