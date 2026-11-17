export function findPromptY(capture) {
  const lines = String(capture || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[›❯]/.test(lines[i])) {
      return i;
    }
  }
  return -1;
}

export function isUsageOverlayCapture(capture) {
  if (!capture) return false;
  const hasUsageHeader = /Settings:\s+Status\s+Config\s+Usage/i.test(capture);
  const hasEscHint = /Esc to cancel/i.test(capture);
  return hasUsageHeader && hasEscHint;
}

/** AGY's final rule pair bounds its input. The caret is on the last input
 * row; popup choices selected above further options are not an input frame. */
export function checkAgyInputState(capture, cursorX, cursorY) {
  const lines = String(capture || '').split('\n');
  const rules = lines.flatMap((line, index) => /^\s*─{10,}\s*$/.test(line) ? [index] : []);
  if (rules.length < 2 || !Number.isInteger(cursorX) || cursorX < 0 || !Number.isInteger(cursorY)) return 'indeterminate';
  const top = rules.at(-2), bottom = rules.at(-1);
  const nonempty = lines.slice(top + 1, bottom).flatMap((line, index) => line.trim() ? [{ line, y: top + 1 + index }] : []);
  if (!nonempty.length || !/^\s*>/.test(nonempty[0].line) ||
      cursorY < nonempty.at(-1).y || cursorY >= bottom) return 'indeterminate';
  if (nonempty.length === 1 && /^\s*>\s*$/.test(nonempty[0].line)) {
    return cursorY === nonempty[0].y && cursorX <= 2 ? 'empty' : 'has_content';
  }
  return 'has_content';
}
