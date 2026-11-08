// The observer is independent of Origin availability; keep its access and modal restrictions.
export const ORIGIN_LOCK_SELECTOR = '#observer-tab';

export function lockOriginButtons(buttons, { readOnly }) {
  for (const button of buttons) {
    button.disabled = readOnly || Boolean(button.closest('.modal-body-disabled'));
    button.title = button.dataset.wbHint || '';
  }
}
