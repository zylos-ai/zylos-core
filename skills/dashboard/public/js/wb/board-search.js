import { createFetchGuard } from './fetch-guard.js?v=81';

export function createBoardSearch({ fetchRows, onRows, onClear, onError,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const guard = createFetchGuard();
  let timer, query = '';
  return {
    input(value) {
      query = value.trim();
      clearTimer(timer);
      const gen = guard.next();
      if (!query) {
        onClear();
        return;
      }
      timer = setTimer(async () => {
        try {
          const result = await fetchRows(query);
          if (guard.current(gen)) onRows(result.rows ?? []);
        } catch (error) {
          if (guard.current(gen)) onError(error);
        }
      }, 300);
    },
    query: () => query,
    destroy() {
      clearTimer(timer);
      guard.invalidate();
    },
  };
}
