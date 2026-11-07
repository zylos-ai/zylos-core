import { effortOptionState } from '../runtime-ui.js';
import { element, fallbackName } from './plain-text.js?v=94';

const running = row => ['running', 'starting'].includes(row.presence);
export function defaultGroups(snapshot, page) {
  const rows = snapshot?.rows ?? [];
  const overrides = snapshot?.overrides;
  const keys = new Set(overrides?.runtime?.map(row => row.sessionGroup) ?? []);
  const followers = overrides == null ? null : rows.filter(row => running(row) && !keys.has(row.sessionGroup));
  const flat = overrides == null ? [] : rows.filter(row => row.sessionGroup != null && keys.has(row.sessionGroup));
  const total = Number.isInteger(page?.runtimeTotal) ? page.runtimeTotal : null;
  return { followers, flat, total, baseline: snapshot?.baselineRuntime ?? null,
    older: overrides != null && total != null && snapshot?.hasOlder != null && total > flat.length };
}
export function modelFollowers(snapshot, runtime) {
  if (snapshot?.overrides == null) return null;
  return (snapshot.rows ?? []).filter(row => running(row) && row.target?.runtime === runtime &&
    !snapshot.overrides.model?.some(item => item.sessionGroup === row.sessionGroup && item.runtime === runtime));
}
export function runtimeHealth(snapshot, runtime) {
  const health = snapshot?.instance?.runtimeHealth?.[runtime]?.health;
  return health === 'auth_failed' ? 'unavailable' : health == null ? 'unknown' : 'available';
}
export function runtimeConfirmation(snapshot, t = key => key) {
  const rows = defaultGroups(snapshot).followers;
  if (rows == null) return t('wb.settings.cannotList');
  return [t('wb.settings.interruptFollowers', { count: rows.length }), ...rows.slice(0, 5).map(row =>
    row.name?.displayName ?? fallbackName(row, t)), ...(rows.length > 5 ? [t('wb.settings.moreGroups', { count: rows.length })] : [])].join('\n');
}
export function createOverrideSearch({ read, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let sequence = 0, timer, query = '', rows = [], nextAfter = null, destroyed = false;
  async function request(append) {
    const captured = ++sequence, currentQuery = query;
    const suffix = new URLSearchParams({ q: currentQuery });
    if (append && nextAfter != null) suffix.set('after', nextAfter);
    try {
      const result = await read('/api/workbench/runtime-overrides?' + suffix);
      if (destroyed || captured !== sequence) return;
      rows = append ? [...rows, ...(result.runtime ?? [])] : result.runtime ?? [];
      nextAfter = result.nextAfter ?? null;
      onChange({ query, rows, nextAfter, error: null });
    } catch (error) {
      if (!destroyed && captured === sequence) onChange({ query, rows, nextAfter, error });
    }
  }
  return {
    input(value) {
      clearTimer(timer); sequence++; query = String(value).trim(); rows = []; nextAfter = null;
      if (!query) { onChange(null); return; }
      timer = setTimer(() => request(false), 300);
    },
    more() { if (nextAfter != null && query) return request(true); },
    destroy() { destroyed = true; sequence++; clearTimer(timer); },
  };
}

export function renderDefaults(root, { snapshot, page, metadata = {}, document = root.ownerDocument,
  t = key => key, read, execute, confirm = async () => true, writable = () => true, onGroup = () => {} } = {}) {
  root.replaceChildren();
  const groups = defaultGroups(snapshot, page);
  const current = element(document, 'p', t('wb.settings.currentRuntime') + ': ' + (groups.baseline ?? t('wb.unknown')));
  current.id = 'settings-current-runtime'; root.append(current);
  const result = element(document, 'p', '', 'modal-status');
  const controls = [], effortControls = [];
  function groupButton(row) {
    const button = element(document, 'button', row.name?.displayName ?? fallbackName(row, t), 'action-btn action-btn-sm');
    button.type = 'button'; button.addEventListener('click', () => onGroup(row.sessionGroup));
    return button;
  }
  function groupList(rows, key, { searchable = false } = {}) {
    const details = element(document, 'details');
    details.append(element(document, 'summary', t(key, { count: rows == null ? t('wb.unknown') : rows.length })));
    if (rows == null) { details.append(element(document, 'p', t('wb.unknown') + (document.documentElement?.dataset.detail === 'technical' ? ' · override_list_failed' : ''))); return details; }
    const list = element(document, 'div'); list.style.maxHeight = '16rem'; list.style.overflowY = 'auto';
    const redraw = query => {
      const term = query.toLocaleLowerCase();
      list.replaceChildren(...rows.filter(row => [row.sessionGroup, row.name?.displayName].some(value => String(value ?? '').toLocaleLowerCase().includes(term))).map(groupButton));
    };
    if (searchable) {
      const input = element(document, 'input'); input.type = 'search'; input.placeholder = t('wb.search');
      input.addEventListener('input', () => redraw(input.value)); details.append(input);
    }
    redraw(''); details.append(list); return details;
  }
  root.append(groupList(groups.followers, 'wb.settings.followers', { searchable: true }));
  const overrides = element(document, 'details');
  overrides.append(element(document, 'summary', t('wb.settings.overrides', { count: groups.total ?? t('wb.unknown') })));
  if (groups.total == null) overrides.append(element(document, 'p', t('wb.unknown') + (document.documentElement?.dataset.detail === 'technical' ? ' · override_list_failed' : '')));
  const flat = element(document, 'div'); flat.style.maxHeight = '16rem'; flat.style.overflowY = 'auto';
  flat.append(...groups.flat.map(groupButton)); overrides.append(flat);
  const searchRoot = element(document, 'div'); searchRoot.style.maxHeight = '16rem'; searchRoot.style.overflowY = 'auto';
  const search = createOverrideSearch({ read, onChange(value) {
    searchRoot.replaceChildren(); flat.hidden = value != null && !value.error;
    if (value == null) return;
    if (value.error) { searchRoot.append(element(document, 'p', t('wb.readFailed') + (document.documentElement?.dataset.detail === 'technical' ? ' · override_list_failed' : ''))); return; }
    if (!value.rows.length) searchRoot.append(element(document, 'p', t('wb.noMatch')));
    else searchRoot.append(...value.rows.map(groupButton));
    if (value.nextAfter != null) {
      const more = element(document, 'button', t('wb.detail.loadMore'), 'action-btn'); more.type = 'button';
      more.addEventListener('click', () => search.more()); searchRoot.append(more);
    }
  } });
  if (groups.total !== 0) {
    const input = element(document, 'input'); input.id = 'settings-overrides-search'; input.type = 'search'; input.placeholder = t('wb.search');
    input.addEventListener('input', () => search.input(input.value)); overrides.append(input);
    if (groups.older) {
      const older = element(document, 'button', t('wb.settings.older'), 'action-btn action-btn-sm'); older.type = 'button';
      older.addEventListener('click', () => input.focus()); overrides.append(older);
    }
  }
  overrides.append(searchRoot); root.append(overrides);
  for (const runtime of ['claude', 'codex']) {
    const panel = element(document, 'section', undefined, 'action-group');
    const health = runtimeHealth(snapshot, runtime), meta = metadata[runtime];
    panel.append(element(document, 'h3', runtime === 'codex' ? 'Codex' : 'Claude'));
    panel.append(element(document, 'p', t('wb.settings.health.' + health)));
    const saveRuntime = element(document, 'button', t('wb.settings.useRuntime'), 'action-btn'); saveRuntime.type = 'button'; saveRuntime.id = 'settings-use-' + runtime; saveRuntime.title = health === 'unavailable' ? t('wb.settings.health.unavailable') : '';
    const lock = () => !writable() || health === 'unavailable';
    controls.push({ button: saveRuntime, lock }); saveRuntime.disabled = lock();
    saveRuntime.addEventListener('click', async () => {
      if (lock() || !(await confirm(runtimeConfirmation(snapshot, t)))) return;
      saveRuntime.disabled = true;
      try {
        const accepted = await execute('switch-runtime', { runtime });
        result.textContent = accepted === false ? t('wb.settings.saveFailed') : t('wb.settings.restartRefresh');
      } catch (error) { result.textContent = error.message; }
      finally { refreshLocks(); }
    });
    panel.append(saveRuntime);
    if (meta) {
      const model = element(document, 'input'); model.id = 'settings-model-' + runtime; model.value = meta.current_model ?? ''; model.placeholder = t('actions.model');
      const options = element(document, 'datalist'); options.id = 'settings-model-options-' + runtime; model.setAttribute('list', options.id);
      for (const item of meta.models ?? []) { const option = element(document, 'option'); option.value = item.id; option.textContent = item.display_name ?? item.id; options.append(option); }
      const effort = element(document, 'select'); effort.id = 'settings-effort-' + runtime;
      const renderEffort = () => {
        const state = effortOptionState(meta, model.value.trim(), effort.value || meta.current_effort);
        effort.replaceChildren(); effort.disabled = !writable() || state.disabled;
        for (const item of state.options) { const option = element(document, 'option', item.labelKey ? t(item.labelKey, item.labelParams) : item.value); option.value = item.value; option.disabled = item.disabled; option.selected = item.selected; effort.append(option); }
        effort.hidden = state.hidden;
      };
      effortControls.push({ effort, model, meta });
      renderEffort(); model.addEventListener('input', () => { renderEffort(); refreshLocks(); });
      panel.append(model, options, effort);
      for (const [action, field, key] of [['switch-model', model, 'model'], ['switch-effort', effort, 'effort']]) {
        const save = element(document, 'button', t('btn.save') + ' · ' + t('actions.' + key), 'action-btn'); save.type = 'button'; save.id = 'settings-save-' + key + '-' + runtime;
        const saveLock = () => !writable() || (key === 'effort' && effortOptionState(meta, model.value.trim(), effort.value || meta.current_effort).disabled);
        controls.push({ button: save, lock: saveLock }); save.disabled = saveLock();
        save.addEventListener('click', async () => {
          if (saveLock() || !field.value.trim()) return;
          save.disabled = true;
          try {
            const accepted = await execute(action, { runtime, [key]: field.value.trim() });
            result.textContent = accepted === false ? t('wb.settings.saveFailed') : t('wb.settings.nextStart');
          } catch (error) { result.textContent = error.message; }
          finally { refreshLocks(); }
        });
        panel.append(save);
      }
    } else panel.append(element(document, 'p', t('wb.unknown')));
    panel.append(groupList(modelFollowers(snapshot, runtime), 'wb.settings.modelFollowers'));
    root.append(panel);
  }
  function refreshLocks() {
    for (const { effort, model, meta } of effortControls) { model.disabled = !writable(); effort.disabled = !writable() || effortOptionState(meta, model.value.trim(), effort.value || meta.current_effort).disabled; }
    for (const { button, lock } of controls) button.disabled = lock();
  }
  root.append(result); refreshLocks();
  return { destroy: () => search.destroy(), refreshLocks };
}
