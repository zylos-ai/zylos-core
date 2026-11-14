// Keep the deadline active through response body decoding, and release timers
// on every completion path.
export async function withRequestTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

// Stop waiting for startup without cancelling useful work or its late updates.
export async function waitUntilDeadline(work, deadline = Infinity) {
  if (!Number.isFinite(deadline)) return work;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    await Promise.race([work, Promise.resolve()]);
    return;
  }
  let timer;
  try {
    await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, remaining); })]);
  } finally {
    clearTimeout(timer);
  }
}
