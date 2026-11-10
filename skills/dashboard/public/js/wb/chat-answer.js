/** Human display of a validated answer envelope; retain unfamiliar saved text. */
export function answerDisplay(envelope) {
  const prefix = `回答了 interruptId=${envelope.interruptId}（问题：${envelope.questionSummary}）：`;
  return {
    question: envelope.questionSummary,
    answer: envelope.fallbackText.startsWith(prefix) ? envelope.fallbackText.slice(prefix.length) : envelope.fallbackText
  };
}
