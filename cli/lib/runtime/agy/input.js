import { usageOverlayKey } from '../shared/prompt-input.js';

/** The nearest rules above and below the caret bound AGY's input. Panels
 * below it have their own rules. Popup selections above further options are
 * not an input frame. */
export function checkAgyInputState(capture, cursorX, cursorY) {
  const lines = String(capture || '').split('\n');
  const rules = lines.flatMap((line, index) => /^\s*─{10,}\s*$/.test(line) ? [index] : []);
  if (rules.length < 2 || !Number.isInteger(cursorX) || cursorX < 0 || !Number.isInteger(cursorY)) return 'indeterminate';
  const top = rules.findLast(y => y < cursorY);
  const bottom = rules.find(y => y > cursorY);
  if (top === undefined || bottom === undefined) return 'indeterminate';
  const nonempty = lines.slice(top + 1, bottom).flatMap((line, index) => line.trim() ? [{ line, y: top + 1 + index }] : []);
  if (!nonempty.length || !/^\s*>/.test(nonempty[0].line) ||
      cursorY < nonempty.at(-1).y || cursorY >= bottom) return 'indeterminate';
  if (nonempty.length === 1 && /^\s*>\s*$/.test(nonempty[0].line)) {
    return cursorY === nonempty[0].y && cursorX <= 2 ? 'empty' : 'has_content';
  }
  return 'has_content';
}

async function inputState({ cursorX, readCursorY, capture }) {
  const cursorY = await readCursorY();
  return checkAgyInputState(await capture(), cursorX, cursorY);
}

export const input = Object.freeze({
  bracketedPaste: true,
  inputState,
  requireEmptyBeforePaste: true,
  pasteCharThreshold: 800,
  dismissOverlay: usageOverlayKey,
});
