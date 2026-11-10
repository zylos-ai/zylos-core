import { renderConversationContent } from '/js/wb/conversation-content.js';
import { createChatAttachment } from '/js/wb/chat-attachments.js';
import { icon } from '/js/wb/plain-text.js';
import { renderQuestion } from '/js/wb/chat-questions.js';
import { CONTENT_PREFIX, makeQuestionSummary, parseC4Content } from '/chat-schema.js';

const words = await (await fetch('/i18n/wb.zh.json')).json();
const t = key => words[key] ?? key;
const blocks = [
  { id: 'boolean', type: 'form_intent', data: { title: '提醒设置', fields: [{ key: 'remind', label: '值班前一天提醒我', type: 'boolean', defaultValue: true }], action: { type: 'form.submit', target: 'answer.form' } } },
  { id: 'danger', type: 'confirmation', data: { title: '删除测试群组？', severity: 'destructive', body: '删除后无法恢复。', action: { type: 'confirmation.respond', target: 'answer.confirm' } } },
  { id: 'waiting', type: 'choice', data: { prompt: '缓存方案', options: [{ id: 'a', label: 'Redis' }, { id: 'b', label: 'LRU' }], action: { type: 'choice.select', target: 'answer.choice' } } },
  { id: 'answered', type: 'choice', data: { prompt: '缓存方案', options: [{ id: 'a', label: 'Redis' }, { id: 'b', label: 'LRU' }], action: { type: 'choice.select', target: 'answer.choice' } } },
  { id: 'breakdown', type: 'breakdown', data: { parts: [{ key: 'a', label: '完成', value: 14 }, { key: 'b', label: '评审', value: 5 }] } },
  { id: 'category', type: 'category_series', data: { points: [{ key: 'a', label: '告警项', value: 12, assessment: { status: 'critical' } }, { key: 'b', label: '正常项', value: 3 }], reference: { label: '告警线', value: 10 } } },
];
blocks.push(
  ...[[1, 'category-single'], [2, 'category-pair'], [4, 'category-reference']].map(([count, id]) => ({
    id, type: 'category_series', data: { title: count + ' 项分类对比',
      points: Array.from({ length: count }, (_, i) => ({ key: 'item_' + i, label: '分类 ' + (i + 1), value: [12, 8, 5, 3][i] })),
      ...(count === 4 ? { reference: { label: '告警线', value: 10 } } : {}),
    },
  })),
  { id: 'segmented', type: 'form_intent', data: { title: '登记主体信息', fields: [
    { key: 'kind', label: '主体类型', type: 'single_select', required: true, defaultValue: 'company', options: [{ id: 'person', label: '个人' }, { id: 'company', label: '企业' }] },
  ], action: { type: 'form.submit', target: 'answer.form' } } },
);
const resources = [];
for (const [index, value] of blocks.entries()) {
  const block = { ...value, schemaVersion: 1, fallbackText: value.id };
  const envelope = { version: 1, kind: 'message', messageId: 'message-' + block.id, fallbackText: block.id, blocks: [block] };
  const interactive = ['choice', 'form_intent', 'confirmation'].includes(block.type);
  if (interactive) {
    envelope.interruptId = 'question-' + block.id;
    envelope.interrupt = { blockId: block.id, reason: block.type === 'confirmation' ? 'confirmation' : 'input_required' };
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
  const { body } = message(block.id);
  const content = renderConversationContent({ document, row, t, renderQuestion: args => renderQuestion({ ...args, document, question, t, canWrite: true, formState: block.id === 'waiting' ? { selected: ['b'] } : {}, onSubmit: async () => {} }) });
  body.append(content); resources.push(content); content.mount();
}
// A short filename must not determine the image's display width.
const attachment = renderConversationContent({ document, t, row: { id: 20, direction: 'out', content: '', attachments: [
  { id: 'image', name: 'a.png', kind: 'image', available: true },
] }, attachmentContext: { conversationId: 'fixture' } });
message('image').body.append(attachment); resources.push(attachment); attachment.mount();
const preview = document.createElement('div'); preview.className = 'conversation-upload-tray'; preview.id = 'tray'; document.querySelector('main').append(preview);
const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#0f766e"/></svg>'], { type: 'image/svg+xml' });
const previewUrl = URL.createObjectURL(blob);
const tray = createChatAttachment({ document, t, attachment: { name: 'a.png', kind: 'image', status: 'ready' }, mode: 'tray', localUrl: previewUrl });
preview.append(tray.node); resources.push(tray); tray.mount();
window.addEventListener('beforeunload', () => { resources.forEach(resource => resource.destroy()); URL.revokeObjectURL(previewUrl); });

function message(id) {
  const article = document.createElement('article'); article.className = 'chat-message conversation-message chat-out'; article.id = id;
  const avatar = document.createElement('span'); avatar.className = 'conversation-avatar'; avatar.append(icon(document, 'bot'));
  const body = document.createElement('div'); body.className = 'conversation-message-body'; article.append(avatar, body); document.querySelector('main').append(article);
  return { article, body };
}

const longText = '部署记录：所有后台任务保持正常运行，附件中的日志仅用于核对执行结果。这里保留完整说明，便于阅读最近的处理过程与后续安排。'.repeat(6);
for (const [id, attachments] of [['long-text', []], ['long-text-file', [{ id: 'log', name: 'log.txt', kind: 'file', available: true, size: 84 }]]]) {
  appendContent(id, { id: id === 'long-text' ? 30 : 31, direction: 'out', content: longText, attachments });
}
for (const mode of ['text', 'file', 'chart']) {
  const withChart = mode === 'chart';
  const id = mode === 'text' ? 'markdown-only' : withChart ? 'markdown-chart-file' : 'markdown-file';
  const parts = [
    { id: 'explanation', type: 'markdown', schemaVersion: 1, data: { text: longText } },
    ...(withChart ? [{ id: 'totals', type: 'breakdown', schemaVersion: 1, fallbackText: '完成14，评审5', data: { parts: [{ key: 'done', label: '完成', value: 14 }, { key: 'review', label: '评审', value: 5 }] } }] : []),
    ...(mode === 'text' ? [] : [{ id: 'log-file', type: 'x-zylos.file', schemaVersion: 1, fallbackText: '日志文件', data: { attachmentId: 'log', nameSnapshot: 'log.txt' } }]),
  ];
  const envelope = { version: 1, kind: 'message', messageId: id, fallbackText: '部署说明和日志', blocks: parts };
  const row = { id: withChart ? 33 : 32, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope), attachments: mode === 'text' ? [] : [{ id: 'log', name: 'log.txt', kind: 'file', available: true, size: 84 }] };
  if (parseC4Content(row.content).kind !== 'envelope') throw new Error('Invalid mixed content fixture');
  appendContent(id, row);
}

function appendContent(id, row) {
  const { body } = message(id);
  const content = renderConversationContent({ document, row, t, attachmentContext: { conversationId: 'fixture' } });
  if (content.classList.contains('conversation-chart-content') || content.classList.contains('conversation-composed-content')) body.classList.add('conversation-message-body-wide');
  body.append(content); resources.push(content); content.mount();
}

const plans = ['方案甲', '方案乙', '方案丙'];
const planBlocks = plans.map((title, i) => ({ id: 'plan-' + i, type: 'markdown', schemaVersion: 1, data: { text: title + '：按统一的成本、维护工作和交付周期比较。桌面应并排显示，手机依次阅读。' } }));
const columnsEnvelope = { version: 1, kind: 'message', messageId: 'columns-message', fallbackText: '三个方案并排比较', blocks: planBlocks,
  metadata: { view: { schemaVersion: 1, root: 'columns-root', nodes: [
    { id: 'columns-root', type: 'columns', layout: 'balanced', children: plans.map((_, i) => 'plan-node-' + i) },
    ...plans.map((_, i) => ({ id: 'plan-node-' + i, type: 'block', blockId: 'plan-' + i })),
  ] } },
};
const columnsRow = { id: 40, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(columnsEnvelope) };
if (parseC4Content(columnsRow.content).kind !== 'envelope') throw new Error('Invalid columns fixture');
appendContent('columns', columnsRow);
const errorsTray = document.createElement('div'); errorsTray.className = 'conversation-upload-tray'; errorsTray.id = 'tray-errors'; document.querySelector('main').append(errorsTray);
for (const status of ['ready', 'failed', 'expired']) {
  const resource = createChatAttachment({ document, t, mode: 'tray', attachment: { name: status + '.txt', kind: 'file', status }, onRetry: () => {}, onRemove: () => {} });
  errorsTray.append(resource.node); resources.push(resource); resource.mount();
}
window.componentFixtureReady = true;
