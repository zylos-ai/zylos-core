// Run broadcasts outside event ingestion, coalescing triggers until the next
// available window. A slow broadcast starts a fresh interval when it finishes.
export function createCoalescedBroadcast(broadcast, intervalMs = 1000) {
  let timer = null;
  let lastFinishedAt = 0;
  return function schedule() {
    if (timer) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastFinishedAt));
    timer = setTimeout(() => {
      try { broadcast(); }
      finally { lastFinishedAt = Date.now(); timer = null; }
    }, delay);
    timer.unref?.();
  };
}

export function createSessionCache(read, ttlMs = 15_000) {
  let cached;
  return sessionId => {
    const now = Date.now();
    if (sessionId !== null && sessionId !== undefined && cached && cached.sessionId === sessionId && now - cached.at < ttlMs) return cached.value;
    const value = read();
    cached = { sessionId, value, at: Date.now() };
    return value;
  };
}

// Share the same snapshot between the local state event and fleet self tile.
export function broadcastFleetSnapshot(sse, buildState, broadcastFleet) {
  if (sse.clients.size === 0) return;
  const state = buildState();
  sse.broadcast('fleet_state', state);
  broadcastFleet(state);
}
