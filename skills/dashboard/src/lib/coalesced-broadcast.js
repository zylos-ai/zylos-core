// Run broadcasts outside event ingestion, coalescing triggers until the next
// available window. A slow broadcast starts a fresh interval when it finishes.
export function createCoalescedBroadcast(broadcast, intervalMs = 1000) {
  let timer = null;
  let lastFinishedAt = 0;
  return function schedule() {
    if (timer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastFinishedAt));
    timer = setTimeout(() => {
      const finished = () => { lastFinishedAt = Date.now(); timer = null; };
      try {
        const pending = broadcast();
        if (pending && typeof pending.finally === 'function') {
          pending.finally(finished);
          return;
        }
      } catch (error) { finished(); throw error; }
      finished();
    }, delay);
    timer.unref?.();
  };
}
