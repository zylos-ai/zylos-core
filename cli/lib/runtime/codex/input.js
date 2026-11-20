import { promptLineInputState, usageOverlayKey } from '../shared/prompt-input.js';

export const input = Object.freeze({
  bracketedPaste: false,
  inputState: promptLineInputState,
  requireEmptyBeforePaste: false,
  pasteCharThreshold: 800,
  dismissOverlay: usageOverlayKey,
});
