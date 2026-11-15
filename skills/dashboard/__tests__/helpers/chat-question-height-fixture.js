import { renderConversationContent } from '/js/wb/conversation-content.js';
import { renderQuestion } from '/js/wb/chat-questions.js';
import { CONTENT_PREFIX, makeQuestionSummary, parseC4Content, validateAnswer } from '/chat-schema.js';

const words = await (await fetch('/i18n/wb.zh.json')).json();
const t = key => words[key] ?? key;
const options = [{ id: 'first', label: '第一项' }, { id: 'second', label: '第二项' }];
const block = { id: 'details', schemaVersion: 1, type: 'form_intent', fallbackText: '登记信息', data: {
  title: '登记信息', fields: [
    { key: 'name', label: '名称', type: 'text', required: true },
    { key: 'count', label: '数量', type: 'number', unit: '项' },
    { key: 'date', label: '日期', type: 'date' },
    { key: 'kind', label: '类型', type: 'single_select', options },
    { key: 'mode', label: '方式', type: 'single_select', required: true, defaultValue: 'first', options },
    { key: 'tags', label: '标签', type: 'multi_select', options },
    { key: 'notes', label: '说明', type: 'multiline_text' },
  ], action: { type: 'form.submit', target: 'answer.form' },
} };
const envelope = { version: 1, kind: 'message', messageId: 'height-message', fallbackText: '登记信息', blocks: [block],
  interruptId: 'height-question', interrupt: { blockId: block.id, reason: 'input_required' } };
envelope.questionSummary = makeQuestionSummary(envelope);
const row = { id: 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) };
if (parseC4Content(row.content).kind !== 'envelope') throw new Error('Invalid question fixture');
const question = { c4Id: '1', messageId: envelope.messageId, interruptId: envelope.interruptId,
  questionSummary: envelope.questionSummary, status: 'paused' };
window.questionSubmissions = [];
window.completeQuestionSubmission = null;
const article = document.createElement('article'); article.className = 'conversation-message chat-out'; article.id = 'height-question';
const body = document.createElement('div'); body.className = 'conversation-message-body'; article.append(body);
document.querySelector('main').append(article);
const content = renderConversationContent({ document, row, t, renderQuestion: args => renderQuestion({ ...args, document, question, t,
  canWrite: true, formState: {}, onSubmit: action => {
    if (!validateAnswer(action, envelope)) throw new Error('Invalid answer');
    window.questionSubmissions.push(action);
    return new Promise(resolve => { window.completeQuestionSubmission = resolve; });
  },
}) });
body.append(content); content.mount();
window.addEventListener('beforeunload', () => content.destroy());
window.componentFixtureReady = true;
