// Keep the deadline active through response body decoding, and release timers
// and upstream abort listeners on every completion path.
export async function withRequestTimeout(operation, timeoutMs, signal, deadline = Infinity) {
  signal?.throwIfAborted();
  timeoutMs = Math.min(timeoutMs, deadline - Date.now());
  if (timeoutMs <= 0) throw new DOMException('Request timed out', 'TimeoutError');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
