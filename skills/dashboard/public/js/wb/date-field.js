import { element, icon } from './plain-text.js?v=103';

/**
 * A styled date-time field over a hidden native `datetime-local` input. The native field shows its
 * format in the browser's language (mm/dd/yyyy on an English browser); this one shows the value or a
 * placeholder in the page language, and a click still opens the native picker.
 */
export function dateField(document, input, placeholder) {
  input.classList.add('wb-date-native');
  const field = element(document, 'label', undefined, 'wb-input wb-date');
  const text = element(document, 'span', undefined, 'wb-date-text');
  const sync = () => {
    text.textContent = input.value ? input.value.replace('T', ' ') : placeholder();
    field.classList.toggle('wb-unset', !input.value);
  };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  field.addEventListener('click', () => {
    try { input.showPicker?.(); } catch {}
  });
  field.append(icon(document, 'clock', 'xs'), text, input);
  sync();
  return { field, sync };
}
