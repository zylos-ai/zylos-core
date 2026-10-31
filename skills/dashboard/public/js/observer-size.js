export const DEFAULT_OBSERVER_SIZE = Object.freeze({ cols: 80, rows: 24 });
export const OBSERVER_SIZE_LIMITS = Object.freeze({ minCols: 20, maxCols: 500, minRows: 5, maxRows: 200 });

export function validObserverSize(value) {
  return !!value && Number.isInteger(value.cols) && Number.isInteger(value.rows) &&
    value.cols >= OBSERVER_SIZE_LIMITS.minCols && value.cols <= OBSERVER_SIZE_LIMITS.maxCols &&
    value.rows >= OBSERVER_SIZE_LIMITS.minRows && value.rows <= OBSERVER_SIZE_LIMITS.maxRows;
}

// Agent tmux window size set by the operator (Set size). Rows exclude the tmux
// status line; the server also checks rows + status lines <= maxRows against
// the live session, since only it knows the status line count.
export const DEFAULT_AGENT_SIZE = Object.freeze({ cols: 120, rows: 50 });

export function validAgentSize(value) {
  return validObserverSize(value);
}
