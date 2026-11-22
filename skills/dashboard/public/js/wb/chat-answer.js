/** Human display of a validated answer envelope; retain unfamiliar saved text. */
export function answerDisplay({ interruptId, questionSummary, fallbackText }) {
  const prefix = [
    `Re interruptId=${interruptId} (Q:${questionSummary}): `,
    `回答了 interruptId=${interruptId}（问题：${questionSummary}）：`,
  ].find(candidate => fallbackText.startsWith(candidate));
  return {
    question: questionSummary,
    answer: prefix === undefined ? fallbackText : fallbackText.slice(prefix.length),
    matchedPrefix: prefix !== undefined
  };
}
