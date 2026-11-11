import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CONTENT_PREFIX, makeQuestionSummary } from '../../../comm-bridge/scripts/c4-content-schema.js';

const protocol = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
export function runtimeMessages(nonce = randomUUID().replaceAll('-', '')) {
  const questions = [], messages = [`FIXTURE_TEXT:${nonce}`];
  const chart = structuredClone(protocol.valid.find(item => item.name === 'time_series').envelope);
  chart.messageId += `_${nonce}`; messages.push(CONTENT_PREFIX + JSON.stringify(chart));
  for (const kind of ['single', 'multiple', 'confirmation', 'form']) {
    const question = structuredClone(protocol.valid.find(item => item.name === kind).envelope);
    question.messageId += `_${nonce}`; question.interruptId += `_${nonce}`;
    const data = question.blocks[0].data;
    if (data.prompt) data.prompt = `Fixture ${nonce} ${kind}`;
    else data.title = `Fixture ${nonce} ${kind}`;
    question.blocks[0].fallbackText = `Fixture ${nonce} ${kind}`;
    question.questionSummary = makeQuestionSummary(question);
    question.fallbackText = `${question.questionSummary}; waiting for an answer`;
    question.metadata = { zylos: { fixtureSecret: `DO_NOT_PROJECT_${nonce}` } };
    questions.push(question); messages.push(CONTENT_PREFIX + JSON.stringify(question));
  }
  return { nonce, questions, messages };
}

export function runtimeAnswer(question) {
  const block = question.blocks[0];
  const payload = block.type === 'confirmation' ? { outcome: 'cancel' } : block.type === 'form_intent'
    ? { values: { name: 'Fixture', count: 2, tags: ['a'] } } : { selected: ['a'] };
  return { id: `answer_${randomUUID()}`, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
    context: { messageId: question.messageId, blockId: block.id }, payload };
}
