const han = /^\p{Script=Han}$/u;
const punctuation = /^\p{P}$/u;

function isCjkPunctuation(character) {
  const point = character.codePointAt(0);
  return punctuation.test(character) && (
    (point >= 0x3000 && point <= 0x303f) ||
    (point >= 0xff00 && point <= 0xffef) ||
    point === 0x2018 || point === 0x2019 || point === 0x201c || point === 0x201d ||
    point === 0x2026 || point === 0x2014
  );
}

function edgeText(token, last) {
  // Escapes/entities are text_special; code and link metadata are not text.
  if (token?.type !== 'text' || !token.content) return '';
  const text = token.content;
  if (!last) return String.fromCodePoint(text.codePointAt(0));
  const end = text.length - 1;
  const low = text.charCodeAt(end);
  const high = text.charCodeAt(end - 1);
  return text.slice(low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? end - 1 : end);
}

function relaxDelimiters(state, delimiters) {
  for (let start = 0; start < delimiters.length;) {
    const first = delimiters[start];
    let end = start + 1;
    while (end < delimiters.length && delimiters[end].marker === first.marker &&
        delimiters[end].length === first.length && delimiters[end].token === delimiters[end - 1].token + 1) end++;
    if (first.marker === 0x2a || first.marker === 0x5f) {
      const before = edgeText(state.tokens[first.token - 1], true);
      const after = edgeText(state.tokens[delimiters[end - 1].token + 1], false);
      const open = han.test(before) && isCjkPunctuation(after);
      const close = isCjkPunctuation(before) && han.test(after);
      for (let index = start; index < end; index++) {
        if (open) delimiters[index].open = true;
        if (close) delimiters[index].close = true;
      }
    }
    start = end;
  }
}

export function cjkEmphasis(md) {
  // markdown-it 14 uses delimiters/tokens_meta here. On upgrade rerun
  // markdown-cjk-emphasis.test.js, memory-markdown.test.js,
  // conversation-preview.test.js and markdown-emphasis-browser.test.js.
  md.inline.ruler2.before('balance_pairs', 'cjk_emphasis', state => {
    relaxDelimiters(state, state.delimiters);
    for (const metadata of state.tokens_meta) {
      if (metadata?.delimiters) relaxDelimiters(state, metadata.delimiters);
    }
  });
}
