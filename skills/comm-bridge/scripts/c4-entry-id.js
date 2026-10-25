// C4's existing driver returns Number ids; never query a rounded neighbor.
export function safeEntryId(value) {
  const text = String(value);
  const number = Number(text);
  return /^[1-9][0-9]{0,18}$/.test(text) && Number.isSafeInteger(number) ? number : null;
}
