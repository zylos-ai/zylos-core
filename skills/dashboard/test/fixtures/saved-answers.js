export function savedAnswer(fallbackText, { interruptId = 'interrupt-one', questionSummary = 'Choose a plan' } = {}) {
  const request = { id: 'answer-one', protocolVersion: '0.1', type: 'choice.select', target: 'test.answer',
    context: { messageId: 'message-one', blockId: 'block-one' }, payload: { selected: ['a'] } };
  return { version: 1, kind: 'answer', messageId: request.id, interruptId, questionSummary,
    fallbackText, action: request, metadata: { zylos: { answerId: request.id } } };
}

const question = 'Choose a plan（fast）： <script>question</script>';
const literalAnswer = '<img src=x>\nKeep interruptId=user-text';
const cases = [
  ['matching prefix', savedAnswer(`回答了 interruptId=interrupt-one（问题：${question}）：${literalAnswer}`, { questionSummary: question }), literalAnswer],
  ['different interrupt', savedAnswer('回答了 interruptId=different（问题：Choose a plan）：Plan A')],
  ['different question', savedAnswer('回答了 interruptId=interrupt-one（问题：Different question）：Plan A')],
  ['prefix within text', savedAnswer('Before 回答了 interruptId=interrupt-one（问题：Choose a plan）：Plan A')],
  ['legacy text', savedAnswer('Original answer: Plan A')],
  ['matching Markdown answer', savedAnswer('回答了 interruptId=interrupt-one（问题：Choose a plan）：**Plan A**'), '**Plan A**'],
  ['legacy Markdown text', savedAnswer('Original answer: **Plan A**'), undefined, 'Original answer: Plan A'],
  ['long legacy Markdown text', savedAnswer(`Original answer: **${'😀'.repeat(170)}**`), undefined, `Original answer: ${'😀'.repeat(170)}`],
  ['long Unicode answer', savedAnswer(`回答了 interruptId=interrupt-one（问题：Choose a plan）：${'😀'.repeat(170)}`), '😀'.repeat(170)]
];

export const savedAnswerCases = cases.map(([name, envelope, answer = envelope.fallbackText, preview = answer]) => ({
  name, envelope, answer, preview: Array.from(preview).slice(0, 160).join('')
}));
