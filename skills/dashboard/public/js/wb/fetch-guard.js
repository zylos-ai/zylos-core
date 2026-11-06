export function createFetchGuard() {
  let generation = 0;
  return {
    next: () => ++generation,
    current: gen => gen === generation,
    invalidate: () => ++generation,
  };
}
