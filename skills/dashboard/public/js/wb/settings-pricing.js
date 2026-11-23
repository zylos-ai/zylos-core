import { DEFAULT_RUNTIME, runtimesWith } from '../../runtime-descriptors.js';
import { countLabel } from '../count-label.js';
import { element, icon, runtimeName } from './plain-text.js';
import { money } from './instance-strip.js';
import { priceWithEditedBaseRates } from '../pricing-form.js';
import { mountPagedList } from './paged-list.js';

const fields = ['input', 'output', 'cacheRead', 'cacheCreation'];
export function collectPriceRows(rows) {
  const prices = {};
  for (const row of rows) {
    const inputs = [...row.querySelectorAll('input')];
    const prefix = inputs[0].value.trim();
    if (!prefix) throw Error('model_prefix_required');
    if (Object.hasOwn(prices, prefix)) throw Error('duplicate_model_prefix');
    const values = inputs.slice(1, 5).map(input => Number(input.value));
    if (values.length !== 4 || values.some(value => !Number.isFinite(value) || value < 0) || inputs.slice(1, 5).some(input => input.value.trim() === '')) throw Error('invalid_model_price');
    prices[prefix] = priceWithEditedBaseRates(row._originalPrice, values);
  }
  return prices;
}
/** Rows as typed, without validation; blank prefixes count as new rows. */
export function draftPriceRows(rows) {
  const prices = {};
  rows.forEach((row, index) => {
    const inputs = [...row.querySelectorAll('input')];
    prices[inputs[0].value.trim() || '\u0000' + index] = Object.fromEntries(fields.map((field, i) => [field, inputs[i + 1].value.trim() === '' ? NaN : Number(inputs[i + 1].value)]));
  });
  return prices;
}
/** Changed cells, added rows and removed rows between a saved table and a draft. */
export function countPriceChanges(saved = {}, draft = {}) {
  let count = 0;
  for (const [prefix, prices] of Object.entries(draft)) {
    if (!Object.hasOwn(saved, prefix)) { count++; continue; }
    count += fields.filter(field => !(Number(prices[field]) === Number(saved[prefix]?.[field] ?? 0))).length;
  }
  return count + Object.keys(saved).filter(prefix => !Object.hasOwn(draft, prefix)).length;
}
export function appendPriceRow(tbody, prefix, prices, builtIn, { document = tbody.ownerDocument, t = key => key, saved, cost, onChange = () => {} } = {}) {
  const row = element(document, 'tr'); row._originalPrice = prices; row.dataset.prefix = prefix;
  const prefixCell = element(document, 'td'), prefixInput = element(document, 'input');
  prefixInput.className = 'settings-input settings-prefix' + (builtIn ? ' wb-pfx-fixed' : ''); prefixInput.value = prefix; prefixInput.readOnly = builtIn;
  prefixInput.placeholder = t('wb.settings.prefix'); prefixInput.setAttribute('aria-label', t('wb.settings.prefix'));
  const name = element(document, 'span', undefined, 'wb-mname'); name.append(prefixInput);
  if (builtIn) { const lock = icon(document, 'lock', 'xs'); lock.setAttribute('aria-hidden', 'false'); lock.setAttribute('title', t('wb.settings.builtIn')); name.append(lock); }
  if (prices?.longContext) { const badge = element(document, 'span', t('wb.settings.longContext'), 'wb-pbadge'); badge.title = t('wb.settings.longContextHint'); name.append(badge); }
  if (prices?.fastModeMultiplier != null) name.append(element(document, 'span', t('wb.settings.fastBadge', { value: prices.fastModeMultiplier }), 'wb-pbadge'));
  prefixCell.append(name); row.append(prefixCell);
  const inputs = [prefixInput];
  for (const field of fields) {
    const cell = element(document, 'td'), input = element(document, 'input');
    input.className = 'settings-input settings-num'; input.type = 'number'; input.min = '0'; input.step = '0.01'; input.value = String(prices?.[field] ?? 0);
    input.setAttribute('aria-label', `${prefix} ${t('settings.col_' + { input: 'input', output: 'output', cacheRead: 'cache_read', cacheCreation: 'cache_write' }[field])}`);
    if (saved?.[field] !== undefined) input.dataset.saved = String(saved[field]);
    cell.append(input); row.append(cell); inputs.push(input);
  }
  const mark = () => { for (const input of inputs.slice(1)) input.classList.toggle('wb-dirty-in', !saved || Number(input.value) !== Number(input.dataset.saved)); onChange(); };
  for (const input of inputs) input.addEventListener('input', mark);
  if (cost !== undefined) {
    const use = element(document, 'td', undefined, 'wb-use');
    if (cost?.value) {
      const track = element(document, 'span', undefined, 'wb-use-trk'), fill = element(document, 'i');
      fill.style.width = Math.max(3, cost.value / cost.max * 100) + '%'; track.append(fill); use.append(track, element(document, 'span', money(cost.value)));
    } else { use.classList.toggle('wb-use-none', true); use.textContent = '—'; }
    row.append(use);
  }
  const extra = element(document, 'td', undefined, 'wb-pdel');
  if (!builtIn) {
    const remove = element(document, 'button', undefined, 'wb-icon-btn wb-icon-btn-sm settings-remove-btn'); remove.type = 'button'; remove.title = t('btn.remove'); remove.setAttribute('aria-label', t('btn.remove'));
    remove.append(icon(document, 'trash', 'xs'));
    remove.addEventListener('click', () => { row.remove(); onChange(); }); extra.append(remove);
  }
  row.append(extra); tbody.append(row);
  for (const input of inputs.slice(1)) input.classList.toggle('wb-dirty-in', Boolean(saved) && Number(input.value) !== Number(input.dataset.saved) || !saved);
  return row;
}
const matchPrefix = (prefixes, model) => prefixes.filter(prefix => model?.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
/** Every price row, the most used in the last 7 days first; rows without use keep their saved order. */
export function orderedPricePrefixes(payload, costs = []) {
  const totals = priceRowCosts(payload, costs);
  return Object.keys(payload?.modelPrices ?? {}).map((prefix, index) => ({ prefix, index, cost: totals[prefix] ?? 0 }))
    .sort((a, b) => b.cost - a.cost || a.index - b.index).map(row => row.prefix);
}
/** Last-7-day cost per price row (longest matching prefix wins). */
export function priceRowCosts(payload, costs = []) {
  const prefixes = Object.keys(payload?.modelPrices ?? {}), totals = {};
  for (const row of costs) { const prefix = matchPrefix(prefixes, row.model); if (prefix != null) totals[prefix] = (totals[prefix] ?? 0) + Number(row.cost ?? 0); }
  return totals;
}

export function createPricingPanel({ root, host, groupCounts = {}, data, usage = {}, document = root.ownerDocument,
  t = key => key, formatTokens = value => Number(value).toLocaleString(), writable = () => true, write, onRuntime = () => {}, onDirty = () => {} }) {
  const usageRuntimes = runtimesWith('usage');
  const mode = id => data.runtimes[id]?.fastMode?.mode;
  const pricingRuntime = value => usageRuntimes.includes(value) ? value : DEFAULT_RUNTIME;
  let runtime = pricingRuntime(data.active), stopped = false;
  const saved = structuredClone(data.runtimes), drafts = structuredClone(data.runtimes), usedModels = usage?.models ?? [];
  const top = host.querySelector('#settings-pricing-top') ?? root;
  const summary = element(document, 'p', undefined, 'wb-price-sum'), unmatched = element(document, 'div');
  const tabs = element(document, 'div', undefined, 'wb-rt-tabs'); tabs.setAttribute('role', 'tablist');
  const tabButtons = new Map();
  for (const value of runtimesWith('usage')) {
    const button = element(document, 'button', undefined, 'wb-rt-tab'); button.type = 'button'; button.id = 'settings-price-tab-' + value; button.setAttribute('role', 'tab');
    button.addEventListener('click', () => { try { capture(); runtime = value; render(); } catch (error) { status.textContent = error.message; status.hidden = false; } });
    tabs.append(button); tabButtons.set(value, button);
  }
  if (top === root) root.prepend(summary, unmatched, tabs); else top.append(summary, unmatched, tabs);
  const baseRows = host.querySelector('#settings-price-rows'), priorityRows = host.querySelector('#settings-priority-price-rows');
  const fastInput = host.querySelector('#settings-fast-multiplier'), status = host.querySelector('#settings-status');
  const baseTitle = host.querySelector('#settings-price-title'), baseCount = host.querySelector('#settings-price-count'), savebar = host.querySelector('.settings-footer'), dirtyText = host.querySelector('#settings-dirty');
  // The base price table is one of the settings page's long lists: search by model, eight rows a page. Rows off the
  // page stay in the table, so what was typed in them is still saved.
  const table = baseRows.closest('.settings-table-scroll') ?? baseRows;
  const pages = mountPagedList({ document, t, list: table, rows: () => [...baseRows.querySelectorAll('tr')], text: row => row.querySelector('input')?.value ?? '', placeholder: t('wb.settings.searchModels') });
  table.before(pages.search); table.after(pages.empty, pages.pager);
  const fastSaved = Object.fromEntries(usageRuntimes
    .filter(id => mode(id) === 'multiplier')
    .map(id => [id, String(saved[id]?.fastMode?.configuredMultiplier ?? '')]));
  fastInput?.addEventListener('input', () => { fastInput.classList.toggle('wb-dirty-in', fastInput.value !== fastSaved[runtime]); refreshDirty(); });
  function capture() {
    const payload = drafts[runtime];
    const rendered = collectPriceRows([...baseRows.querySelectorAll('tr')]);
    payload.modelPrices = rendered;
    if (mode(runtime) === 'service_tier') payload.priorityModelPrices = collectPriceRows([...priorityRows.querySelectorAll('tr')]);
    else if (mode(runtime) === 'multiplier' && fastInput.value !== fastInput.dataset.initialValue) {
      const value = fastInput.value === '' ? null : Number(fastInput.value);
      if (value !== null && (!Number.isFinite(value) || value <= 0)) throw Error('invalid_fast_multiplier');
      payload._editedFastMultiplier = value;
    }
  }
  /** Unsaved changes per engine: the visible tab is read as typed, the other one from its captured draft. */
  function changes() {
    const counts = {};
    for (const value of runtimesWith('usage')) {
      const payload = drafts[value], original = saved[value] ?? {};
      const base = value === runtime ? draftPriceRows([...baseRows.querySelectorAll('tr')]) : payload.modelPrices;
      let count = countPriceChanges(original.modelPrices, base);
      if (mode(value) === 'service_tier') count += countPriceChanges(original.priorityModelPrices, value === runtime ? draftPriceRows([...priorityRows.querySelectorAll('tr')]) : payload.priorityModelPrices);
      if (mode(value) === 'multiplier') {
        let fast = fastSaved[value];
        if (value === runtime) fast = fastInput.value;
        else if (Object.hasOwn(payload, '_editedFastMultiplier')) fast = String(payload._editedFastMultiplier ?? '');
        if (fast !== fastSaved[value]) count++;
      }
      counts[value] = count;
    }
    return counts;
  }
  function refreshDirty() {
    const counts = changes(), total = usageRuntimes.reduce((sum, id) => sum + counts[id], 0);
    for (const [value, button] of tabButtons) {
      const users = groupCounts[value] ?? t('wb.unknown');
      const sw = element(document, 'i', undefined, 'wb-sw wb-sw-' + value);
      const label = element(document, 'span', t('wb.settings.priceTable', { runtime: runtimeName(value) }));
      const use = element(document, 'small', countLabel(t, 'wb.settings.priceUsers', users));
      button.replaceChildren(sw, label, use);
      if (counts[value]) button.append(element(document, 'span', t('wb.settings.changedN', { count: counts[value] }), 'wb-dirty'));
    }
    if (savebar) savebar.hidden = !total;
    if (dirtyText) dirtyText.textContent = t('wb.settings.unsavedList', { list: runtimesWith('usage').filter(value => counts[value]).map(value => t('wb.settings.unsavedRuntime', { runtime: runtimeName(value), count: counts[value] })).join(t('wb.settings.listSep')) });
    onDirty(total);
    return total;
  }
  function render() {
    const payload = drafts[runtime], original = saved[runtime] ?? {}, costs = usedModels.filter(row => row.runtime === runtime);
    onRuntime(runtime, payload);
    for (const [value, button] of tabButtons) button.setAttribute('aria-selected', String(value === runtime));
    if (baseTitle) baseTitle.textContent = t('wb.settings.basePrices', { runtime: runtimeName(runtime) });
    baseRows.replaceChildren();
    const rowCosts = priceRowCosts(payload, costs);
    const max = Math.max(1, ...Object.values(rowCosts));
    for (const key of orderedPricePrefixes(payload, costs)) appendPriceRow(baseRows, key, payload.modelPrices[key], (payload.builtInModels ?? []).includes(key),
      { document, t, saved: original.modelPrices?.[key], cost: { value: rowCosts[key] ?? 0, max }, onChange: refreshDirty });
    priorityRows.replaceChildren();
    for (const [key, prices] of Object.entries(payload.priorityModelPrices ?? {})) appendPriceRow(priorityRows, key, prices, (payload.builtInPriorityModels ?? []).includes(key),
      { document, t, saved: original.priorityModelPrices?.[key], onChange: refreshDirty });
    host.querySelector('#settings-priority-pricing-group').hidden = mode(runtime) !== 'service_tier';
    host.querySelector('#settings-fast-mode-group').hidden = mode(runtime) !== 'multiplier';
    const multiplier = Object.hasOwn(payload, '_editedFastMultiplier') ? payload._editedFastMultiplier : payload.fastMode?.configuredMultiplier;
    fastInput.value = multiplier == null ? '' : String(multiplier);
    fastInput.dataset.initialValue = fastInput.value;
    fastInput.classList.toggle('wb-dirty-in', fastInput.value !== fastSaved[runtime]);
    summary.replaceChildren();
    if (usage == null) summary.append(element(document, 'span', t('wb.unknown') + ' · ' + t('wb.readFailed')));
    else {
      for (const value of runtimesWith('usage')) {
        const part = element(document, 'span', undefined, 'wb-price-sum-rt');
        part.append(element(document, 'i', undefined, 'wb-sw wb-sw-' + value), element(document, 'span', runtimeName(value)),
          element(document, 'b', money(usedModels.filter(row => row.runtime === value).reduce((sum, row) => sum + Number(row.cost ?? 0), 0))));
        summary.append(part);
      }
      summary.append(element(document, 'span', t('wb.settings.last7d'), 'wb-price-sum-span'));
    }
    unmatched.replaceChildren();
    for (const item of usage?.unmatched ?? []) {
      const line = element(document, 'div', undefined, 'wb-warn-row');
      const text = element(document, 'div');
      text.append(element(document, 'b', item.model ?? t('wb.unknown'), 'wb-mono'), element(document, 'span', t('wb.settings.unmatchedTitle', { runtime: runtimeName(item.runtime) })),
        element(document, 'small', t('wb.settings.unmatchedNote', { tokens: formatTokens(item.tokens ?? 0) })));
      line.append(icon(document, 'alert'), text);
      if (tabButtons.has(item.runtime)) {
        const add = element(document, 'button', t('wb.settings.addPrice'), 'wb-btn'); add.type = 'button'; add.disabled = !writable();
        add.addEventListener('click', () => {
          try {
            capture(); runtime = item.runtime;
            drafts[runtime].modelPrices[item.model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
            render();
            pages.refresh({ reveal: [...baseRows.querySelectorAll('tr')].find(row => row.dataset.prefix === item.model) });
          } catch (error) { status.textContent = error.message; status.hidden = false; }
        });
        line.append(add);
      }
      unmatched.append(line);
    }
    if (baseCount) baseCount.textContent = countLabel(t, 'wb.settings.priceCount', Object.keys(payload.modelPrices ?? {}).length);
    pages.refresh();
    [...baseRows.querySelectorAll('input'), ...baseRows.querySelectorAll('button'), ...priorityRows.querySelectorAll('input'), ...priorityRows.querySelectorAll('button'), ...host.querySelectorAll('#settings-add-model, #settings-add-priority-model, #settings-fast-multiplier, #settings-save')].forEach(node => { node.disabled = !writable(); });
    refreshDirty();
  }
  render();
  return {
    async save() {
      if (stopped || !writable()) return;
      status.hidden = false; status.textContent = t('status.executing');
      try {
        capture();
        const runtimes = {};
        for (const value of runtimesWith('usage')) {
          const payload = drafts[value]; runtimes[value] = { modelPrices: payload.modelPrices };
          if (mode(value) === 'service_tier') runtimes[value].priorityModelPrices = payload.priorityModelPrices;
          else if (mode(value) === 'multiplier' && Object.hasOwn(payload, '_editedFastMultiplier')) runtimes[value].fastModeMultiplier = payload._editedFastMultiplier;
        }
        await write({ runtimes });
        if (stopped) return;
        // What was written is the new baseline: dirty marks, the save bar and the navigation count all clear.
        for (const value of runtimesWith('usage')) {
          saved[value] ??= {};
          saved[value].modelPrices = structuredClone(runtimes[value].modelPrices);
          if (mode(value) === 'service_tier') saved[value].priorityModelPrices = structuredClone(runtimes[value].priorityModelPrices);
          if (mode(value) === 'multiplier' && Object.hasOwn(runtimes[value], 'fastModeMultiplier')) {
            const multiplier = runtimes[value].fastModeMultiplier;
            for (const side of [saved[value], drafts[value]]) side.fastMode = { ...side.fastMode, configuredMultiplier: multiplier };
            delete drafts[value]._editedFastMultiplier;
            fastSaved[value] = String(multiplier ?? '');
          }
        }
        render();
        status.hidden = false; status.textContent = t('wb.settings.pricesSaved');
      } catch (error) { if (!stopped) status.textContent = error.message; }
    },
    /** A blank editable row in the base or the priority table. */
    addRow(priority = false) {
      if (stopped || !writable()) return;
      const row = appendPriceRow(priority ? priorityRows : baseRows, '', { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, false,
        { document, t, cost: priority ? undefined : { value: 0, max: 1 }, onChange: refreshDirty });
      if (!priority) pages.refresh({ reveal: row });
      refreshDirty(); row.querySelector('input')?.focus?.();
    },
    runtime: () => runtime,
    destroy() { stopped = true; tabs.remove(); summary.remove(); unmatched.remove(); pages.search.remove(); pages.empty.remove(); pages.pager.remove(); table.style.minHeight = ''; if (savebar) savebar.hidden = true; onDirty(0); },
  };
}
