import { renderConversationContent } from '/js/wb/conversation-content.js';
import { renderQuestion } from '/js/wb/chat-questions.js';
import { CONTENT_PREFIX, makeQuestionSummary, parseC4Content } from '/chat-schema.js';

const words = await (await fetch('/i18n/wb.zh.json')).json();
const t = key => words[key] ?? key;
const blocks = [
  { id: 'waiting', type: 'choice', data: { prompt: '缓存方案', options: [{ id: 'a', label: 'Redis' }, { id: 'b', label: 'LRU' }], action: { type: 'choice.select', target: 'answer.choice' } } },
  { id: 'answered', type: 'choice', data: { prompt: '缓存方案', options: [{ id: 'a', label: 'Redis' }, { id: 'b', label: 'LRU' }], action: { type: 'choice.select', target: 'answer.choice' } } },
  { id: 'breakdown', type: 'breakdown', data: { parts: [{ key: 'a', label: '完成', value: 14 }, { key: 'b', label: '评审', value: 5 }] } },
  { id: 'category', type: 'category_series', data: { points: [{ key: 'a', label: '告警项', value: 12, assessment: { status: 'critical' } }, { key: 'b', label: '正常项', value: 3 }], reference: { label: '告警线', value: 10 } } },
];
const resources = [];
for (const [index, value] of blocks.entries()) {
  const block = { ...value, schemaVersion: 1, fallbackText: value.id };
  const envelope = { version: 1, kind: 'message', messageId: 'message-' + block.id, fallbackText: block.id, blocks: [block] };
  const interactive = block.type === 'choice';
  if (interactive) {
    envelope.interruptId = 'question-' + block.id;
    envelope.interrupt = { blockId: block.id, reason: 'input_required' };
    envelope.questionSummary = makeQuestionSummary(envelope);
  }
  const row = { id: index + 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) };
  if (parseC4Content(row.content).kind !== 'envelope') throw new Error('Invalid component fixture');
  const question = { c4Id: String(row.id), messageId: envelope.messageId, interruptId: envelope.interruptId,
    questionSummary: envelope.questionSummary, status: block.id === 'answered' ? 'answered' : 'paused', answerId: null, action: null };
  if (question.status === 'answered') {
    question.answerId = 'saved-answer';
    question.action = { id: question.answerId, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: envelope.messageId, blockId: block.id }, payload: { selected: ['b'] } };
  }
  const article = document.createElement('article'); article.className = 'conversation-message chat-out'; article.id = block.id;
  const body = document.createElement('div'); body.className = 'conversation-message-body'; article.append(body); document.querySelector('main').append(article);
  const content = renderConversationContent({ document, row, t, renderQuestion: args => renderQuestion({ ...args, document, question, t, canWrite: true, onSubmit: async () => {} }) });
  body.append(content); resources.push(content); content.mount();
}
// A local SVG fixture has a 16:9 intrinsic ratio, different from the 4:3 loading ratio.
const attachment = renderConversationContent({ document, t, row: { id: 5, direction: 'out', content: '', attachments: [
  { id: 'image', name: 'sample.svg', kind: 'image', available: true },
] }, attachmentContext: { conversationId: 'fixture' } });
document.querySelector('main').append(attachment); resources.push(attachment); attachment.mount();
window.addEventListener('beforeunload', () => resources.forEach(resource => resource.destroy()));
window.componentFixtureReady = true;
