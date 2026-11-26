import { listOverrides as coreListOverrides } from '../../../../comm-bridge/scripts/c4-config-handler.js';
import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';
import { validKey } from './display-names.js';

const invalidResult = () => Object.assign(new Error('Unexpected Core read result'), { code: 'invalid_envelope' });

/**
 * Group catalog, queue and override reads for the group snapshot, run in this process on Core's read-only C4
 * store. Each read opens its own read-only connection and closes it before returning; a failure is reported with
 * the read's reason and never thrown.
 */
export function createCoreReads({ zylosDir, loadCoreModule = defaultLoadCoreModule, listOverrides = coreListOverrides, now = Date.now } = {}) {
  async function read(reason, operation) {
    let handle;
    try {
      handle = await (await loadCoreModule('c4-read-store.js')).openReadStore(zylosDir);
      return { ok: true, data: operation(handle.store), readAt: now() };
    } catch (error) {
      return { ok: false, reason, detail: error.code ?? 'read_failed', readAt: now() };
    } finally {
      try { handle?.close(); } catch {}
    }
  }
  const groups = (options = {}) => read('c4_groups_failed', store => store.queries.listGroups(options));
  const groupQueues = () => read('queue_summary_failed', store => store.listGroupQueues());
  // The complete runtime override catalog, then the baseline and model overrides of the listed groups, the groups
  // with a runtime override and Origin, in bounded batches.
  const readOverrides = groupKeys => read('override_list_failed', store => {
    const data = { baseline: null, runtime: [], model: [] };
    let after = null;
    do {
      const page = listOverrides({ store, after: after ?? undefined });
      if (!Array.isArray(page?.runtime)
          || page.runtime.some(row => !row || typeof row.sessionGroup !== 'string' || typeof row.runtime !== 'string')
          || (page.nextAfter != null && (typeof page.nextAfter !== 'string' || (after !== null && page.nextAfter <= after)))) {
        throw invalidResult();
      }
      data.runtime.push(...page.runtime);
      after = page.nextAfter ?? null;
    } while (after !== null);
    const keys = [...new Set([...groupKeys.filter(validKey), ...data.runtime.map(row => row.sessionGroup), 'origin'])];
    for (let i = 0; i < keys.length; i += 500) {
      const batch = listOverrides({ store, groups: keys.slice(i, i + 500) });
      if (!batch?.baseline || !Array.isArray(batch.model)) throw invalidResult();
      data.baseline ??= batch.baseline;
      data.model.push(...batch.model);
    }
    return data;
  });
  return { groups, groupQueues, readOverrides };
}
