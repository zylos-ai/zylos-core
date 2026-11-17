export function findPromptY(capture, runtime) {
  if (runtime === 'agy') return findAgyPromptY(capture);
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

/** agy renders its input inside the final pair of horizontal rules.
 * Popup choices can also begin with >, so never scan them as prompts. */
export function findAgyPromptY(capture) {
  const lines = String(capture || '').split('\n');
  const rules = lines.flatMap((line, index) => /^\s*─{10,}\s*$/.test(line) ? [index] : []);
  if (rules.length < 2) return -1;
  const top = rules.at(-2), bottom = rules.at(-1);
  const content = lines.slice(top + 1, bottom);
  const prompts = content.flatMap((line, index) => /^\s*>\s*$/.test(line) ? [top + 1 + index] : []);
  return prompts.length === 1 && content.every(line => !line.trim() || /^\s*>\s*$/.test(line)) ? prompts[0] : -1;
}

export function checkAgyInputState(capture, cursorX, cursorY) {
  const lines = String(capture || '').split('\n');
  const rules = lines.flatMap((line, index) => /^\s*─{10,}\s*$/.test(line) ? [index] : []);
  if (rules.length < 2 || !Number.isInteger(cursorX) || cursorX < 0 || !Number.isInteger(cursorY)) return 'indeterminate';
  const top = rules.at(-2), bottom = rules.at(-1);
  const nonempty = lines.slice(top + 1, bottom).flatMap((line, index) => line.trim() ? [{ line, y: top + 1 + index }] : []);
  if (nonempty.length !== 1 || !/^\s*>/.test(nonempty[0].line) || cursorY !== nonempty[0].y) return 'indeterminate';
  return /^\s*>\s*$/.test(nonempty[0].line) && cursorX <= 2 ? 'empty' : 'has_content';
}
