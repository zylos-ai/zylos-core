import { isIdentityError } from '../tmux-protocol.js';
import { promptLineInputState, usageOverlayKey } from '../shared/prompt-input.js';

export function getClaudeInputBoxText(capture) {
  const lines = capture.split('\n');
  const separators = lines.flatMap((line, index) => /^─{10,}/.test(line) ? [index] : []);
  if (separators.length < 2) return null;
  return lines.slice(separators.at(-2) + 1, separators.at(-1)).join('\n');
}
export function checkClaudeFallbackInputBox(capture) {
  const text = getClaudeInputBoxText(capture);
  if (text === null) return 'indeterminate';
  const right = Array.from((text.split('\n')[0] || '').replace(/^\s*[›❯]/, '')).slice(0, 10).join('');
  return right.replace(/[\p{C}\p{Z}]+/gu, '').length ? 'has_content' : 'empty';
}

async function inputState(args) {
  const verdict = await promptLineInputState(args);
  if (verdict !== 'has_content') return verdict;
  try {
    const fallback = checkClaudeFallbackInputBox(await args.capture());
    if (fallback !== 'indeterminate') return fallback === 'empty' ? 'disputed_empty' : fallback;
  } catch (cause) {
    if (isIdentityError(cause)) throw cause;
  }
  return verdict;
}

export const input = Object.freeze({
  bracketedPaste: false,
  inputState,
  requireEmptyBeforePaste: false,
  pasteCharThreshold: 800,
  dismissOverlay: usageOverlayKey,
});
