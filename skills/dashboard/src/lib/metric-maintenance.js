import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

export async function runMetricMaintenance(store, {
  now = new Date(), lastConversionDate = null,
  conversionMaxBytes = 2 * 1024 * 1024 * 1024,
  vacuumChunkPages = 1000, vacuumMaxPages = 10000, signal,
} = {}) {
  if (!Number.isSafeInteger(vacuumChunkPages) || vacuumChunkPages < 1 ||
      !Number.isSafeInteger(vacuumMaxPages) || vacuumMaxPages < 1) {
    throw new RangeError('Invalid incremental vacuum limits');
  }
  const anchor = now.toISOString();
  store.deleteMetricsByNameAndSource('usage_event', '%', 90, anchor);
  store.deleteMetricsByNameAndSource('ttft%', '%', 90, anchor);
  store.deleteMetricsByNameAndSource('turn_duration%', '%', 90, anchor);
  store.deleteMetricsByNameAndSource('statusline_summary', '%', 30, anchor);
  store.deleteMetricsByNameAndSource('system_summary', '%', 14, anchor);
  store.deleteMetricsByNameAndSource('pm2_summary', '%', 7, anchor);
  store.deleteMetricsByNameAndSource('pm2_cpu', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_memory', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_restarts', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_status', '%', 0, anchor);
  store.deleteMetricsByNameAndSource('pm2_uptime', '%', 0, anchor);
  store.deleteOtherLegacyMetricsOlderThan(90, anchor);
  store.deleteEventsOlderThan(30, anchor);
  store.deleteSnapshotsOlderThan(7, anchor);
  store.deleteFactsOlderThan(365, anchor);
  store.walCheckpoint();

  const dateKey = anchor.slice(0, 10);
  let conversion = null;
  if (store.autoVacuumMode() !== 2 && now.getUTCDay() === 0 && lastConversionDate !== dateKey && !signal?.aborted) {
    lastConversionDate = dateKey;
    try {
      conversion = store.enableIncrementalVacuum(conversionMaxBytes);
    } catch (error) {
      // Return the attempt date even on failure so the hourly caller does not
      // repeat a costly conversion throughout the same Sunday.
      conversion = { converted: false, failed: true, reason: 'conversion_failed' };
      process.stderr.write(`[retention] auto_vacuum conversion failed: ${error.message}; retry on a later Sunday\n`);
    }
    if (conversion.skipped) {
      process.stderr.write(`[retention] Skipped auto_vacuum conversion: ${conversion.reason}; effectiveBytes=${conversion.effectiveBytes}, freeBytes=${conversion.freeBytes ?? 'unknown'}; see docs/modules/db-maintenance.md\n`);
    }
  }

  let pagesFreed = 0;
  let chunks = 0;
  if (store.autoVacuumMode() === 2) {
    for (let budget = vacuumMaxPages; budget > 0 && !signal?.aborted;) {
      if (store.spaceUsage().freePages === 0) break;
      const pages = Math.min(vacuumChunkPages, budget);
      const freed = store.incrementalVacuum(pages);
      pagesFreed += freed;
      chunks += 1;
      budget -= pages;
      if (freed === 0) break;
      // Let HTTP, Observer heartbeats and shutdown run between bounded chunks.
      await yieldToEventLoop();
    }
    if (pagesFreed > 0 && !signal?.aborted) store.walCheckpoint();
  }
  return { conversion, lastConversionDate, pagesFreed, chunks };
}
