/** Only the first complete line is a quote marker; all other text stays literal. */
export function parseChatQuote(content) {
  const match = /^\[quote c4_id=([1-9][0-9]*)\](?:\n|$)/.exec(content);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return { id: Number(match[1]), content: content.slice(match[0].length) };
}

export function stripChatQuote(content) {
  return parseChatQuote(content)?.content ?? content;
}
