// The legacy interrupt / chop-chop buttons and the observer tab only work while the Origin session runs.
// Workbench drawer actions use data-wb-action, so this selector never reaches them.
export const ORIGIN_LOCK_SELECTOR = '#observer-tab, [data-action="interrupt"], [data-action="chop-chop"]';

export function lockOriginButtons(buttons, { unavailable, readOnly, reason }) {
  for (const button of buttons) {
    button.disabled = unavailable || readOnly || Boolean(button.closest('.modal-body-disabled'));
    // The observer tab keeps the workbench's install / disabled hint whenever the Origin is available.
    button.title = (unavailable && reason) || button.dataset.wbHint || '';
  }
}
