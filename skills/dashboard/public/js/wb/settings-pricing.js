import { element } from './plain-text.js?v=94';
import { priceWithEditedBaseRates } from '../pricing-form.js';

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
export function appendPriceRow(tbody, prefix, prices, builtIn, { document = tbody.ownerDocument, t = key => key } = {}) {
  const row = element(document, 'tr'); row._originalPrice = prices; row.dataset.prefix = prefix;
  const prefixCell = element(document, 'td'), prefixInput = element(document, 'input');
  prefixInput.className = 'settings-input settings-prefix'; prefixInput.value = prefix; prefixInput.readOnly = builtIn;
  prefixCell.append(prefixInput); row.append(prefixCell);
  for (const field of fields) {
    const cell = element(document, 'td'), input = element(document, 'input');
    input.className = 'settings-input settings-num'; input.type = 'number'; input.min = '0'; input.step = '0.01'; input.value = String(prices?.[field] ?? 0);
    cell.append(input); row.append(cell);
  }
  const extra = element(document, 'td');
  if (builtIn) extra.append(element(document, 'span', '🔒'));
  else {
    const remove = element(document, 'button', '×', 'settings-remove-btn'); remove.type = 'button'; remove.title = t('btn.remove');
    remove.addEventListener('click', () => row.remove()); extra.append(remove);
  }
  if (prices?.longContext || prices?.fastModeMultiplier != null) {
    prefixCell.append(element(document, 'small', [prices.longContext ? t('wb.settings.longContext') : '', prices.fastModeMultiplier != null ? `Fast ×${prices.fastModeMultiplier}` : ''].filter(Boolean).join(' · ')));
  }
  row.append(extra); tbody.append(row); return row;
}
export const priceUsers = (snapshot, runtime) => (snapshot?.rows ?? []).filter(row => ['running', 'starting'].includes(row.presence) && row.target?.runtime === runtime);
export function visiblePricePrefixes(payload, costs = [], expanded = false) {
  const builtIn = new Set(payload?.builtInModels ?? []), prefixes = Object.keys(payload?.modelPrices ?? {});
  const used = new Set(costs.map(row => prefixes.filter(prefix => row.model?.startsWith(prefix)).sort((a, b) => b.length - a.length)[0]));
  return prefixes.filter(prefix => expanded || !builtIn.has(prefix) || used.has(prefix));
}

export function createPricingPanel({ root, host, snapshot, data, usage = {}, document = root.ownerDocument,
  t = key => key, formatTokens = value => Number(value).toLocaleString(), writable = () => true, write, onRuntime = () => {} }) {
  let runtime = data.active === 'codex' ? 'codex' : 'claude', expanded = false, stopped = false;
  const drafts = structuredClone(data.runtimes), usedModels = usage?.models ?? [];
  let renderedPrefixes = new Set();
  const tabs = element(document, 'div', undefined, 'action-row');
  const summary = element(document, 'p'), users = element(document, 'p'), unmatched = element(document, 'div');
  const tabButtons = new Map();
  for (const value of ['claude', 'codex']) {
    const button = element(document, 'button', value === 'codex' ? 'Codex' : 'Claude', 'action-btn'); button.type = 'button'; button.id = 'settings-price-tab-' + value;
    button.addEventListener('click', () => { try { capture(); runtime = value; expanded = false; render(); } catch (error) { status.textContent = error.message; status.hidden = false; } });
    tabs.append(button); tabButtons.set(value, button);
  }
  const showAll = element(document, 'button', t('wb.settings.showAll'), 'action-btn action-btn-sm'); showAll.type = 'button'; showAll.id = 'settings-price-show-all';
  showAll.addEventListener('click', () => { try { capture(); expanded = true; render(); } catch (error) { status.textContent = error.message; status.hidden = false; } });
  root.prepend(tabs, summary, users, unmatched);
  root.append(showAll);
  const baseRows = host.querySelector('#settings-price-rows'), priorityRows = host.querySelector('#settings-priority-price-rows');
  const fastInput = host.querySelector('#settings-fast-multiplier'), status = host.querySelector('#settings-status');
  function capture() {
    const payload = drafts[runtime];
    const rendered = collectPriceRows([...baseRows.querySelectorAll('tr')]);
    const hiddenBuiltIns = Object.fromEntries(Object.entries(payload.modelPrices ?? {}).filter(([key]) =>
      (payload.builtInModels ?? []).includes(key) && !renderedPrefixes.has(key)));
    payload.modelPrices = { ...hiddenBuiltIns, ...rendered };
    if (runtime === 'codex') payload.priorityModelPrices = collectPriceRows([...priorityRows.querySelectorAll('tr')]);
    else if (fastInput.value !== fastInput.dataset.initialValue) {
      const value = fastInput.value === '' ? null : Number(fastInput.value);
      if (value !== null && (!Number.isFinite(value) || value <= 0)) throw Error('invalid_fast_multiplier');
      payload._editedFastMultiplier = value;
    }
  }
  function render() {
    const payload = drafts[runtime], costs = usedModels.filter(row => row.runtime === runtime);
    onRuntime(runtime, payload);
    for (const [value, button] of tabButtons) button.classList.toggle('active', value === runtime);
    baseRows.replaceChildren();
    const shown = visiblePricePrefixes(payload, costs, expanded);
    renderedPrefixes = new Set(shown);
    for (const key of shown) appendPriceRow(baseRows, key, payload.modelPrices[key], (payload.builtInModels ?? []).includes(key), { document, t });
    priorityRows.replaceChildren();
    for (const [key, prices] of Object.entries(payload.priorityModelPrices ?? {})) appendPriceRow(priorityRows, key, prices, (payload.builtInPriorityModels ?? []).includes(key), { document, t });
    host.querySelector('#settings-priority-pricing-group').hidden = runtime !== 'codex';
    host.querySelector('#settings-fast-mode-group').hidden = runtime !== 'claude';
    const multiplier = Object.hasOwn(payload, '_editedFastMultiplier') ? payload._editedFastMultiplier : payload.fastMode?.configuredMultiplier;
    fastInput.value = multiplier == null ? '' : String(multiplier);
    fastInput.dataset.initialValue = fastInput.value;
    summary.textContent = usage == null ? t('wb.unknown') + ' · ' + t('wb.readFailed') : ['claude', 'codex'].map(value => `${value}: $${usedModels.filter(row => row.runtime === value).reduce((sum, row) => sum + Number(row.cost ?? 0), 0).toFixed(4)}`).join(' · ') + ' · ' + t('wb.settings.last7d');
    users.textContent = t('wb.settings.priceUsers', { count: snapshot == null ? t('wb.unknown') : priceUsers(snapshot, runtime).length });
    const bars = element(document, 'div');
    const max = Math.max(1, ...costs.map(row => Number(row.cost ?? 0)));
    for (const cost of costs) {
      const label = element(document, 'p', `${cost.model ?? t('wb.unknown')} · $${Number(cost.cost ?? 0).toFixed(4)}`);
      const bar = element(document, 'progress'); bar.max = max; bar.value = Number(cost.cost ?? 0); label.append(bar); bars.append(label);
    }
    const previous = root.querySelector('[data-price-costs]'); previous?.remove(); bars.dataset.priceCosts = ''; root.append(bars);
    unmatched.replaceChildren();
    for (const item of usage?.unmatched ?? []) {
      const line = element(document, 'p', t('wb.settings.unmatched', { model: item.model ?? t('wb.unknown'), tokens: formatTokens(item.tokens ?? 0) }));
      const add = element(document, 'button', t('wb.settings.addPrice'), 'action-btn action-btn-sm'); add.type = 'button'; add.disabled = !writable();
      add.addEventListener('click', () => {
        try {
          capture(); runtime = item.runtime === 'codex' ? 'codex' : 'claude'; expanded = true;
          drafts[runtime].modelPrices[item.model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          render();
        } catch (error) { status.textContent = error.message; status.hidden = false; }
      }); line.append(add); unmatched.append(line);
    }
    showAll.hidden = expanded || shown.length === Object.keys(payload.modelPrices ?? {}).length;
    [...baseRows.querySelectorAll('input, button'), ...priorityRows.querySelectorAll('input, button'), ...host.querySelectorAll('#settings-add-model, #settings-add-priority-model, #settings-fast-multiplier, #settings-save')].forEach(node => { node.disabled = !writable(); });
  }
  render();
  return {
    async save() {
      if (stopped || !writable()) return;
      status.hidden = false; status.textContent = t('status.executing');
      try {
        capture();
        const runtimes = {};
        for (const value of ['claude', 'codex']) {
          const payload = drafts[value]; runtimes[value] = { modelPrices: payload.modelPrices };
          if (value === 'codex') runtimes[value].priorityModelPrices = payload.priorityModelPrices;
          else if (Object.hasOwn(payload, '_editedFastMultiplier')) runtimes[value].fastModeMultiplier = payload._editedFastMultiplier;
        }
        await write({ runtimes }); if (!stopped) status.textContent = t('wb.settings.pricesSaved');
      } catch (error) { if (!stopped) status.textContent = error.message; }
    },
    runtime: () => runtime,
    destroy() { stopped = true; tabs.remove(); summary.remove(); users.remove(); unmatched.remove(); showAll.remove(); root.querySelector('[data-price-costs]')?.remove(); },
  };
}
