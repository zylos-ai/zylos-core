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

export function usageOverlayKey(screen) {
  return isUsageOverlayCapture(screen) ? 'Escape' : null;
}

export async function promptLineInputState({ cursorX, readCursorY, capture }) {
  if (!Number.isInteger(cursorX) || cursorX < 0) return 'indeterminate';
  if (cursorX > 2) return 'has_content';
  const cursorY = await readCursorY();
  const promptY = findPromptY(await capture());
  if (!Number.isInteger(cursorY) || cursorY < 0 || promptY < 0) return 'indeterminate';
  return cursorY === promptY ? 'empty' : 'has_content';
}
