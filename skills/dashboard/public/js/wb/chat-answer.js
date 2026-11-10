/** Human display of a validated answer envelope; retain unfamiliar saved text. */
export function answerDisplay(envelope) {
  const prefix = `回答了 interruptId=${envelope.interruptId}（问题：${envelope.questionSummary}）：`;
  const matchedPrefix = envelope.fallbackText.startsWith(prefix);
  return {
    question: envelope.questionSummary,
    answer: matchedPrefix ? envelope.fallbackText.slice(prefix.length) : envelope.fallbackText,
    matchedPrefix
  };
}
