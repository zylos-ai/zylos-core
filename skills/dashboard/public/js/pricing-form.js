// The form edits base rates; keep model-specific tariffs on a read/save cycle.
export function priceWithEditedBaseRates(original, values) {
  return {
    ...original,
    input: Number(values[0]),
    output: Number(values[1]),
    cacheRead: Number(values[2]),
    cacheCreation: Number(values[3])
  };
}
