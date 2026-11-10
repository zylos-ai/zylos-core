import { renderConversationContent } from '/js/wb/conversation-content.js';
import { CONTENT_PREFIX, parseC4Content } from '/chat-schema.js';

const resources = [];
const compositions = [
  ['section-stack', 'section', 'stack'],
  ['section-columns', 'section', 'columns'],
  ['section-section', 'section', 'section'],
  ['stack-section', 'stack', 'section'],
  ['compact-section', 'stack', 'section', true],
  ['columns-section', 'columns', 'section'],
];
for (const [index, [id, outer, inner, compact]] of compositions.entries()) {
  const blocks = ['before', 'first', 'second', 'after'].map(key => ({
    id: key, type: 'markdown', schemaVersion: 1,
    data: { text: key + '：用于测量真实正文与嵌套容器的间距。' },
  }));
  const nodes = [
    { id: 'outer', type: outer,
      ...(outer === 'section' ? { body: ['before-node', 'inner', 'after-node'] } : { children: ['before-node', 'inner', 'after-node'] }),
      ...(compact ? { gap: 'compact' } : {}),
    },
    { id: 'inner', type: inner,
      ...(inner === 'section' ? { body: ['first-node', 'second-node'] } : { children: ['first-node', 'second-node'] }),
    },
    ...blocks.map(block => ({ id: block.id + '-node', type: 'block', blockId: block.id })),
  ];
  const envelope = { version: 1, kind: 'message', messageId: id, fallbackText: id, blocks,
    metadata: { view: { schemaVersion: 1, root: 'outer', nodes } },
  };
  const row = { id: index + 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) };
  if (parseC4Content(row.content).kind !== 'envelope') throw new Error('Invalid nested spacing fixture: ' + id);
  const article = document.createElement('article');
  article.id = id; article.className = 'chat-message conversation-message chat-out';
  const body = document.createElement('div');
  body.className = 'conversation-message-body conversation-message-body-wide';
  article.append(body); document.querySelector('main').append(article);
  const content = renderConversationContent({ document, row, t: key => key });
  body.append(content); content.mount(); resources.push(content);
}
window.addEventListener('beforeunload', () => resources.forEach(resource => resource.destroy()));
window.componentFixtureReady = true;
