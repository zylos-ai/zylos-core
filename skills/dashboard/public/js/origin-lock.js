// The observer tab only works while the Origin session runs; workbench drawer actions carry
// their own availability, so this selector never reaches them.
export const ORIGIN_LOCK_SELECTOR = '#observer-tab';

export function lockOriginButtons(buttons, { unavailable, readOnly, reason }) {
  for (const button of buttons) {
    button.disabled = unavailable || readOnly || Boolean(button.closest('.modal-body-disabled'));
    // The observer tab keeps the workbench's install / disabled hint whenever the Origin is available.
    button.title = (unavailable && reason) || button.dataset.wbHint || '';
  }
}
