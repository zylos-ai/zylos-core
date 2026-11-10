import { renderConversationContent } from '/js/wb/conversation-content.js';
import { createChatAttachment } from '/js/wb/chat-attachments.js';
import { icon } from '/js/wb/plain-text.js';
import { renderQuestion } from '/js/wb/chat-questions.js';
import { CONTENT_PREFIX, makeQuestionSummary, parseC4Content } from '/chat-schema.js';
import { createActivityArea } from '/js/wb/conversation-activity.js';
import { instanceStrip } from '/js/wb/instance-strip.js';

const words = await (await fetch('/i18n/wb.zh.json')).json();
const t = (key, values = {}) => (words[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
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
    id, type: 'category_series', data: { title: count + ' 项分类对比', xLabel: '状态', yLabel: '数量',
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
const planBlocks = plans.map((title, i) => i === 1
  ? { id: 'plan-' + i, type: 'x-zylos.file', schemaVersion: 1, fallbackText: '比较资料', data: { attachmentId: 'comparison-file', nameSnapshot: '方案资料.pdf' } }
  : { id: 'plan-' + i, type: 'markdown', schemaVersion: 1, data: { text: title + '：按统一的成本、维护工作和交付周期比较。桌面应并排显示，手机依次阅读。' } });
const columnsEnvelope = { version: 1, kind: 'message', messageId: 'columns-message', fallbackText: '三个方案并排比较', blocks: planBlocks,
  metadata: { view: { schemaVersion: 1, root: 'columns-root', nodes: [
    { id: 'columns-root', type: 'columns', layout: 'balanced', children: plans.map((_, i) => 'plan-node-' + i) },
    ...plans.map((_, i) => ({ id: 'plan-node-' + i, type: 'block', blockId: 'plan-' + i })),
  ] } },
};
const columnsRow = { id: 40, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(columnsEnvelope),
  attachments: [{ id: 'comparison-file', name: '方案资料.pdf', kind: 'file', available: true, size: 84 }] };
if (parseC4Content(columnsRow.content).kind !== 'envelope') throw new Error('Invalid columns fixture');
appendContent('columns', columnsRow);
const spacingMarkdown = (id, text) => ({ id, type: 'markdown', schemaVersion: 1, data: { text } });
const spacingCard = id => ({ id, type: 'breakdown', schemaVersion: 1, fallbackText: '完成14，评审5',
  data: { title: '交付进度', parts: [{ key: 'done', label: '完成', value: 14 }, { key: 'review', label: '评审', value: 5 }] } });
const spacingFile = { id: 'spacing-file', type: 'x-zylos.file', schemaVersion: 1, fallbackText: '交付资料',
  data: { attachmentId: 'spacing-report', nameSnapshot: '交付资料.pdf' } };
const spacingAttachment = { id: 'spacing-report', name: '交付资料.pdf', kind: 'file', available: true, size: 84 };
for (const [index, [id, parts, stack]] of [
  ['stack-view', [spacingMarkdown('stack-intro', '交付记录：下面按顺序列出完成情况与核对资料。'), spacingCard('stack-card'),
    spacingMarkdown('stack-summary', '请保留说明与附件之间清晰、一致的阅读间距。'), spacingFile], true],
  ['markdown-first', [spacingMarkdown('flow-intro', '交付记录从正文开始，首块应与头像和消息内容区顶部对齐。'), spacingFile], false],
  ['card-ending', [spacingMarkdown('ending-intro', '最后一块是进度卡片，卡片底部应与消息内容区底部对齐。'), spacingCard('ending-card')], false],
].entries()) {
  const envelope = { version: 1, kind: 'message', messageId: id, fallbackText: '交付进度与资料', blocks: parts,
    ...(stack ? { metadata: { view: { schemaVersion: 1, root: 'spacing-root', nodes: [
      { id: 'spacing-root', type: 'stack', children: parts.map((_, i) => 'spacing-node-' + i) },
      ...parts.map((block, i) => ({ id: 'spacing-node-' + i, type: 'block', blockId: block.id })),
    ] } } } : {}),
  };
  const row = { id: 50 + index, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope),
    attachments: parts.includes(spacingFile) ? [spacingAttachment] : [] };
  if (parseC4Content(row.content).kind !== 'envelope') throw new Error('Invalid spacing fixture');
  appendContent(id, row);
}
const sectionParts = [
  spacingMarkdown('section-heading', '**交付分区：完成情况与后续资料**'),
  spacingMarkdown('section-intro', '正文区先说明当前状态，再展示进度卡片和核对资料。'),
  spacingCard('section-card'), spacingFile,
  spacingMarkdown('section-actions', '下一步：请核对资料后确认交付。'),
];
const sectionEnvelope = { version: 1, kind: 'message', messageId: 'section-message', fallbackText: '交付分区与资料', blocks: sectionParts,
  metadata: { view: { schemaVersion: 1, root: 'section-root', nodes: [
    { id: 'section-root', type: 'section', header: ['section-heading-node'],
      body: ['section-intro-node', 'section-card-node', 'section-file-node'], actions: ['section-actions-node'] },
    { id: 'section-heading-node', type: 'block', blockId: 'section-heading' },
    { id: 'section-intro-node', type: 'block', blockId: 'section-intro' },
    { id: 'section-card-node', type: 'block', blockId: 'section-card' },
    { id: 'section-file-node', type: 'block', blockId: 'spacing-file' },
    { id: 'section-actions-node', type: 'block', blockId: 'section-actions' },
  ] } },
};
const sectionRow = { id: 60, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(sectionEnvelope), attachments: [spacingAttachment] };
if (parseC4Content(sectionRow.content).kind !== 'envelope') throw new Error('Invalid section fixture');
appendContent('section-view', sectionRow);
const nestedParts = [
  spacingMarkdown('nested-intro', '正文先说明结果，最后用堆叠展示详细说明与进度。'),
  spacingMarkdown('nested-detail', '堆叠中的说明与卡片应保持独立的十二像素间距。'),
  spacingCard('nested-card'),
];
const nestedEnvelope = { version: 1, kind: 'message', messageId: 'nested-section-message', fallbackText: '分区中的堆叠', blocks: nestedParts,
  metadata: { view: { schemaVersion: 1, root: 'nested-section-root', nodes: [
    { id: 'nested-section-root', type: 'section', body: ['nested-intro-node', 'nested-stack'] },
    { id: 'nested-intro-node', type: 'block', blockId: 'nested-intro' },
    { id: 'nested-stack', type: 'stack', children: ['nested-detail-node', 'nested-card-node'] },
    { id: 'nested-detail-node', type: 'block', blockId: 'nested-detail' },
    { id: 'nested-card-node', type: 'block', blockId: 'nested-card' },
  ] } },
};
const nestedRow = { id: 61, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(nestedEnvelope) };
if (parseC4Content(nestedRow.content).kind !== 'envelope') throw new Error('Invalid nested section fixture');
appendContent('nested-section', nestedRow);
const errorsTray = document.createElement('div'); errorsTray.className = 'conversation-upload-tray'; errorsTray.id = 'tray-errors'; document.querySelector('main').append(errorsTray);
for (const status of ['ready', 'failed', 'expired']) {
  const resource = createChatAttachment({ document, t, mode: 'tray', attachment: { name: status + '.txt', kind: 'file', status }, onRetry: () => {}, onRemove: () => {} });
  errorsTray.append(resource.node); resources.push(resource); resource.mount();
}
const failedImage = createChatAttachment({ document, t, mode: 'tray', attachment: { name: 'failed-image.png', kind: 'image', status: 'failed' }, onRetry: () => {}, onRemove: () => {} });
failedImage.node.id = 'tray-failed-image'; errorsTray.append(failedImage.node); resources.push(failedImage); failedImage.mount();
// Real presentation modules with fixed data; no backend, runtime or task runs.
const activity = createActivityArea({ document, t });
activity.update({ key: 'handoff-status', live: false, round: { state: 'done' }, segment: {
  start: 0, end: 2000, steps: [
    { kind: 'tool', status: 'failed', start: 0, end: 1000, label: { key: 'read', arg: 'handoff.md' } },
    { kind: 'tool', status: 'incomplete', start: 1000, end: 2000, label: { key: 'described', arg: '等待后续工作' } },
  ] } }, { open: true, now: 2000 });
message('handoff-status').body.append(activity.node);
for (const capacity of [2, 256]) {
  const { body } = message('pool-' + capacity);
  const strip = document.createElement('div'); strip.className = 'wb-instance-strip'; body.append(strip);
  instanceStrip(strip, { mode: 'multi', baselineRuntime: 'claude', rows: [], instance: {
    pool: { used: 1, capacity, waiting: 0, capacityRecord: { valid: true, fresh: true, source: 'auto' } },
    accounts: { claude: { used_percentage: 30 } } } }, { document, t, level: 'technical' });
}
appendContent('answer-card', { id: 999, direction: 'in', content: CONTENT_PREFIX + JSON.stringify({
  version: 1, kind: 'answer', messageId: 'answer-card-id', interruptId: 'private-interrupt-id', questionSummary: '选择缓存方案？',
  fallbackText: '回答了 interruptId=private-interrupt-id（问题：选择缓存方案？）：采用 LRU 缓存，先保留现有容量。',
  action: { protocolVersion: '0.1', id: 'answer-card-id', type: 'choice.select', target: 'answer.choice',
    context: { messageId: 'cache-question', blockId: 'question' }, payload: { selected: ['lru'] } },
  metadata: { zylos: { answerId: 'answer-card-id' } }
}) });
window.componentFixtureReady = true;
