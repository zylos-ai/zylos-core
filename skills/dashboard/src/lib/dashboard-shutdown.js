import { performance } from 'node:perf_hooks';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function settleByDeadline(promise, deadline, onTimeout) {
  return new Promise((resolve) => {
    const remaining = Math.max(0, deadline - performance.now());
    const timeout = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      resolve({ timedOut: true, error: null });
    }, remaining);
    timeout.unref?.();
    promise.then(
      (value) => { clearTimeout(timeout); resolve({ timedOut: false, error: null, value }); },
      (error) => { clearTimeout(timeout); resolve({ timedOut: false, error }); },
    );
  });
}

export async function shutdownDashboardTransports({
  server,
  observerService,
  observerControl,
  reason = 'dashboard_shutdown',
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  deadline = performance.now() + timeoutMs,
}) {
  // Start stream closure and containment teardown before asking HTTP to drain:
  // upgraded sockets are not owned by closeAllConnections().
  const observerWork = (async () => {
    let serviceError = null;
    let controlError = null;
    try { await observerService.shutdown(reason); } catch (error) { serviceError = error; }
    try { await observerControl.close(); } catch (error) { controlError = error; }
    if (serviceError) throw serviceError;
    if (controlError) throw controlError;
  })();

  const httpWork = new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  const [observer, http] = await Promise.all([
    settleByDeadline(observerWork, deadline),
    settleByDeadline(httpWork, deadline, () => server.closeAllConnections?.()),
  ]);
  return { observer, http, deadline };
}
