import { effortOptionState, modelOptionState } from '../runtime-ui.js?v=98';
import { element, fallbackName, icon, runtimeName } from './plain-text.js?v=94';
import { settingsCard } from './settings.js?v=98';

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

const runtimes = ['claude', 'codex'];
const engineName = runtime => runtime === 'codex' ? 'Codex' : 'Claude Code';
/** Drafted model/effort pairs that differ from what each engine's metadata reports. */
export function modelDraftChanges(metadata = {}, drafts = {}) {
  const changes = [];
  for (const runtime of runtimes) {
    const meta = metadata[runtime], draft = drafts[runtime];
    if (!meta || !draft) continue;
    if (draft.model && draft.model !== (meta.current_model ?? '')) changes.push({ runtime, action: 'switch-model', key: 'model', value: draft.model });
    if (draft.effort && draft.effort !== (meta.current_effort ?? '')) changes.push({ runtime, action: 'switch-effort', key: 'effort', value: draft.effort });
  }
  return changes;
}

const effortText = (value, t) => { const key = 'effort.' + value, label = t(key); return label && label !== key ? label : value; };
/** One line per drafted change, as the confirmation and the result name it. */
export function modelChangeLabel(change, t = key => key, metadata = {}) {
  const model = () => metadata[change.runtime]?.models?.find(item => item.id === change.value)?.display_name ?? change.value;
  return t(change.key === 'model' ? 'wb.settings.changeModel' : 'wb.settings.changeEffort',
    { runtime: engineName(change.runtime), value: change.key === 'effort' ? effortText(change.value, t) : model() });
}
/** The single confirmation shown before saving every drafted model and effort change together. */
export function modelSaveConfirmation(changes, t = key => key, metadata = {}) {
  return [t('wb.settings.confirmModels'), ...changes.map(change => modelChangeLabel(change, t, metadata))].join('\n');
}
/** The engine switch confirmation: what happens, then which groups restart with it. */
export function runtimeSaveConfirmation(runtime, snapshot, t = key => key) {
  return [runtime === 'codex' ? t('confirm.switch_runtime_codex') : t('confirm.switch_runtime', { value: engineName(runtime) }), runtimeConfirmation(snapshot, t)].join('\n');
}

export function renderDefaults(root, { snapshot, page, metadata = {}, document = root.ownerDocument,
  t = key => key, read, execute, confirm = async () => true, writable = () => true, onGroup = () => {} } = {}) {
  root.replaceChildren();
  const groups = defaultGroups(snapshot, page);
  const technical = () => document.documentElement?.dataset.detail === 'technical';
  const controls = [];
  const lock = (node, fn) => { controls.push({ node, lock: fn }); node.disabled = fn(); };
  function groupRow(row, meta) {
    const button = element(document, 'button', undefined, 'wb-gl-row'); button.type = 'button';
    button.append(element(document, 'span', row.name?.displayName ?? fallbackName(row, t)));
    if (meta) button.append(element(document, 'small', meta));
    button.addEventListener('click', () => onGroup(row.sessionGroup));
    return button;
  }
  const failed = () => element(document, 'p', t('wb.unknown') + (technical() ? ' · override_list_failed' : ''), 'wb-note');
  // Counts stay visible; names fold into a searchable list so large instances are not spelled out.
  function groupList(rows, meta, { searchable = rows?.length > 8 } = {}) {
    const details = element(document, 'details', undefined, 'wb-glist');
    const summary = element(document, 'summary'); summary.append(icon(document, 'chev', 'xs'), element(document, 'span', t('wb.settings.showGroups', { count: rows.length })));
    const box = element(document, 'div', undefined, 'wb-gl-box'), list = element(document, 'div', undefined, 'wb-gl-rows');
    const redraw = query => {
      const term = query.toLocaleLowerCase();
      const shown = rows.filter(row => [row.sessionGroup, row.name?.displayName].some(value => String(value ?? '').toLocaleLowerCase().includes(term)));
      list.replaceChildren(...(shown.length ? shown.map(row => groupRow(row, meta?.(row))) : [element(document, 'p', t('wb.noMatch'), 'wb-gl-empty')]));
    };
    if (searchable) {
      const input = element(document, 'input'); input.type = 'search'; input.placeholder = t('wb.settings.searchGroups');
      input.addEventListener('input', () => redraw(input.value)); box.append(input);
    }
    redraw(''); box.append(list); details.append(summary, box); return details;
  }
  const stateText = row => t('wb.state.' + (row.state?.kind ?? 'unknown'));

  // ─── Default engine ───
  const engine = settingsCard(document, { icon: 'bot', title: t('wb.settings.currentRuntime'), sub: technical() ? 'zylos runtime' : '' });
  engine.card.id = 'settings-current-runtime';
  let draftRuntime = groups.baseline;
  const line = element(document, 'div', undefined, 'wb-set-inline');
  const seg = element(document, 'div', undefined, 'wb-seg2'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('wb.settings.currentRuntime'));
  const segButtons = {};
  for (const runtime of runtimes) {
    const health = runtimeHealth(snapshot, runtime);
    const button = element(document, 'button', engineName(runtime)); button.type = 'button'; button.id = 'settings-use-' + runtime;
    button.title = health === 'unavailable' ? t('wb.settings.health.unavailable') : '';
    button.addEventListener('click', () => { draftRuntime = runtime; redrawEngine(); });
    lock(button, () => !writable() || health === 'unavailable');
    seg.append(button); segButtons[runtime] = button;
  }
  line.append(seg);
  for (const runtime of runtimes) {
    const health = runtimeHealth(snapshot, runtime);
    const login = element(document, 'span', undefined, 'wb-login wb-login-' + health);
    login.append(element(document, 'span', undefined, 'wb-hdot'), element(document, 'span', runtime === 'codex' ? 'Codex' : 'Claude'), element(document, 'span', t('wb.settings.health.' + health)));
    line.append(login);
  }
  const saveRuntime = element(document, 'button', t('wb.settings.saveRuntime'), 'wb-btn wb-btn-primary'); saveRuntime.type = 'button'; saveRuntime.id = 'settings-save-runtime';
  const undoRuntime = element(document, 'button', t('wb.settings.undo'), 'wb-btn'); undoRuntime.type = 'button'; undoRuntime.id = 'settings-undo-runtime';
  undoRuntime.addEventListener('click', () => { draftRuntime = groups.baseline; redrawEngine(); });
  lock(saveRuntime, () => !writable() || draftRuntime == null || draftRuntime === groups.baseline || runtimeHealth(snapshot, draftRuntime) === 'unavailable');
  saveRuntime.addEventListener('click', async () => {
    if (saveRuntime.disabled || !(await confirm(runtimeSaveConfirmation(draftRuntime, snapshot, t)))) return;
    saveRuntime.disabled = true;
    try {
      const accepted = await execute('switch-runtime', { runtime: draftRuntime }, { confirmed: true });
      engineResult.textContent = accepted === false ? t('wb.settings.saveFailed') : t('wb.settings.restartRefresh');
    } catch (error) { engineResult.textContent = error.message; }
    finally { refreshLocks(); }
  });
  line.append(saveRuntime, undoRuntime);
  const engineResult = element(document, 'p', '', 'wb-note'); engineResult.setAttribute('role', 'status');
  const split = element(document, 'div', undefined, 'wb-set-split');
  const followerCol = element(document, 'div');
  followerCol.append(element(document, 'div', t('wb.settings.followers', { count: groups.followers == null ? t('wb.unknown') : groups.followers.length }), 'wb-gsum'));
  if (groups.followers == null) followerCol.append(failed());
  else if (groups.followers.length) followerCol.append(groupList(groups.followers, stateText, { searchable: true }));
  const overrideCol = element(document, 'div');
  overrideCol.append(element(document, 'div', t('wb.settings.overrides', { count: groups.total ?? t('wb.unknown') }), 'wb-gsum'));
  if (groups.total == null) overrideCol.append(failed());
  const overrides = element(document, 'div', undefined, 'wb-gl-box');
  const flat = element(document, 'div', undefined, 'wb-gl-rows'); flat.append(...groups.flat.map(row => groupRow(row, row.target?.runtime ? runtimeName(row.target.runtime) : null)));
  const searchRoot = element(document, 'div', undefined, 'wb-gl-rows');
  const search = createOverrideSearch({ read, onChange(value) {
    searchRoot.replaceChildren(); flat.hidden = value != null && !value.error;
    if (value == null) return;
    if (value.error) { searchRoot.append(element(document, 'p', t('wb.readFailed') + (technical() ? ' · override_list_failed' : ''), 'wb-gl-empty')); return; }
    if (!value.rows.length) searchRoot.append(element(document, 'p', t('wb.noMatch'), 'wb-gl-empty'));
    else searchRoot.append(...value.rows.map(row => groupRow(row, row.runtime ? runtimeName(row.runtime) : null)));
    if (value.nextAfter != null) {
      const more = element(document, 'button', t('wb.detail.loadMore'), 'wb-link-btn wb-gl-more'); more.type = 'button';
      more.addEventListener('click', () => search.more()); searchRoot.append(more);
    }
  } });
  if (groups.total !== 0) {
    const input = element(document, 'input'); input.id = 'settings-overrides-search'; input.type = 'search'; input.placeholder = t('wb.settings.searchGroups');
    input.addEventListener('input', () => search.input(input.value)); overrides.append(input);
    overrides.append(flat, searchRoot);
    if (groups.older) {
      const older = element(document, 'button', t('wb.settings.older'), 'wb-link-btn wb-gl-more'); older.type = 'button';
      older.addEventListener('click', () => input.focus()); overrides.append(older);
    }
    overrideCol.append(overrides);
  }
  split.append(followerCol, overrideCol);
  const engineNote = element(document, 'p', t('wb.settings.runtimeNote'), 'wb-note');
  engine.card.append(line, engineResult, split, engineNote); root.append(engine.card);
  function redrawEngine() {
    for (const runtime of runtimes) segButtons[runtime].setAttribute('aria-pressed', String(draftRuntime === runtime));
    const changed = draftRuntime != null && draftRuntime !== groups.baseline;
    saveRuntime.hidden = undoRuntime.hidden = !changed;
    refreshLocks();
  }

  // ─── Default model and effort, one row per engine, one save for the card ───
  const models = settingsCard(document, { icon: 'sliders', title: t('wb.settings.modelsTitle'), sub: t('wb.settings.modelsSub') });
  const drafts = {}, rows = {};
  const result = element(document, 'p', '', 'wb-note'); result.setAttribute('role', 'status');
  const undo = element(document, 'button', t('wb.settings.undo'), 'wb-btn'); undo.type = 'button';
  const save = element(document, 'button', t('btn.save'), 'wb-btn wb-btn-primary'); save.type = 'button'; save.id = 'settings-save-models';
  models.acts.append(undo, save);
  for (const runtime of runtimes) {
    const meta = metadata[runtime];
    const row = element(document, 'div', undefined, 'wb-pref');
    const label = element(document, 'span', undefined, 'wb-pref-l'); label.append(element(document, 'i', undefined, 'wb-sw wb-sw-' + runtime), element(document, 'span', engineName(runtime)));
    const cell = element(document, 'div', undefined, 'wb-pref-c'); row.append(label, cell); models.card.append(row);
    if (!meta) { cell.append(element(document, 'span', t('wb.unknown'), 'wb-note')); continue; }
    drafts[runtime] = { model: meta.current_model ?? '', effort: meta.current_effort ?? '' };
    const fields = element(document, 'div', undefined, 'wb-set-inline');
    const model = element(document, 'select'); model.id = 'settings-model-' + runtime; model.setAttribute('aria-label', t('actions.model'));
    const custom = element(document, 'input'); custom.id = 'settings-model-custom-' + runtime; custom.placeholder = t('actions.model_placeholder'); custom.className = 'wb-input';
    const effort = element(document, 'select'); effort.id = 'settings-effort-' + runtime; effort.setAttribute('aria-label', t('actions.effort'));
    const dirty = element(document, 'span', t('wb.settings.unsavedOne'), 'wb-dirty');
    const options = modelOptionState(meta);
    for (const item of options.options) { const option = element(document, 'option', item.labelKey ? t(item.labelKey) : item.label); option.value = item.value; option.disabled = Boolean(item.disabled); model.append(option); }
    model.value = options.custom ? '__custom__' : meta.current_model ?? ''; custom.value = options.customValue; custom.hidden = !options.custom;
    const modelValue = () => model.value === '__custom__' ? custom.value.trim() : model.value;
    const renderEffort = () => {
      const state = effortOptionState(meta, modelValue(), drafts[runtime].effort || meta.current_effort);
      effort.replaceChildren();
      for (const item of state.options) { const option = element(document, 'option', item.labelKey ? t(item.labelKey, item.labelParams) : item.value); option.value = item.value; option.disabled = item.disabled; option.selected = item.selected; effort.append(option); }
      effort.hidden = state.hidden;
      const selected = state.options.find(item => item.selected);
      effort.value = selected?.value ?? '';
      drafts[runtime].effort = selected && !selected.disabled ? selected.value : '';
    };
    const changed = () => { drafts[runtime].model = modelValue(); renderEffort(); redrawModels(); };
    model.addEventListener('change', () => { custom.hidden = model.value !== '__custom__'; if (!custom.hidden) custom.focus(); changed(); });
    custom.addEventListener('input', changed);
    effort.addEventListener('change', () => { drafts[runtime].effort = effort.value; redrawModels(); });
    renderEffort(); drafts[runtime].effort = meta.current_effort ?? drafts[runtime].effort;
    fields.append(element(document, 'span', t('actions.model'), 'wb-fld-l'), wrapSelect(document, model), custom, element(document, 'span', t('actions.effort'), 'wb-fld-l'), wrapSelect(document, effort), dirty);
    const users = modelFollowers(snapshot, runtime);
    const count = element(document, 'small', users == null ? t('wb.unknown') : users.length ? t('wb.settings.modelFollowers', { count: users.length }) : t('wb.settings.noFollowers'), 'wb-pref-note');
    cell.append(fields, count);
    if (users?.length) cell.append(groupList(users, stateText));
    rows[runtime] = { model, custom, effort, dirty, meta, renderEffort };
    lock(model, () => !writable()); lock(custom, () => !writable());
    lock(effort, () => !writable() || effortOptionState(meta, modelValue(), drafts[runtime].effort || meta.current_effort).disabled);
  }
  models.card.append(element(document, 'p', t('wb.settings.nextStartNote'), 'wb-note'), result);
  root.append(models.card);
  const changes = () => modelDraftChanges(metadata, drafts);
  function redrawModels() {
    const pending = changes();
    for (const [runtime, row] of Object.entries(rows)) row.dirty.hidden = !pending.some(change => change.runtime === runtime);
    undo.hidden = save.hidden = !pending.length;
    refreshLocks();
  }
  lock(save, () => !writable() || !changes().length);
  undo.addEventListener('click', () => {
    for (const [runtime, row] of Object.entries(rows)) {
      drafts[runtime] = { model: row.meta.current_model ?? '', effort: row.meta.current_effort ?? '' };
      const initial = modelOptionState(row.meta); row.model.value = initial.custom ? '__custom__' : row.meta.current_model ?? ''; row.custom.value = initial.customValue; row.custom.hidden = !initial.custom; row.renderEffort(); drafts[runtime].effort = row.meta.current_effort ?? '';
      row.effort.value = drafts[runtime].effort;
    }
    redrawModels();
  });
  save.addEventListener('click', async () => {
    const pending = changes();
    if (save.disabled || !pending.length) return;
    // One confirmation lists every change; cancelling sends nothing and leaves the result line alone.
    if (!(await confirm(modelSaveConfirmation(pending, t, metadata)))) return;
    save.disabled = true; const applied = [];
    const report = () => {
      const left = pending.filter(change => !applied.includes(change));
      if (!left.length) return t('wb.settings.nextStart');
      if (!applied.length) return t('wb.settings.saveFailed');
      const list = changes => changes.map(change => modelChangeLabel(change, t, metadata)).join(t('wb.settings.listSep'));
      return t('wb.settings.partlySaved', { done: list(applied), left: list(left) });
    };
    try {
      for (const change of pending) {
        const accepted = await execute(change.action, { runtime: change.runtime, [change.key]: change.value }, { confirmed: true });
        if (accepted === false) break;
        applied.push(change);
        if (rows[change.runtime]) rows[change.runtime].meta = { ...rows[change.runtime].meta, ['current_' + change.key]: change.value };
      }
      result.textContent = report();
    } catch (error) { result.textContent = applied.length ? report() + ' · ' + error.message : error.message; }
    finally { metadata = Object.fromEntries(Object.entries(rows).map(([runtime, row]) => [runtime, row.meta])); redrawModels(); }
  });
  function refreshLocks() { for (const { node, lock: fn } of controls) node.disabled = fn(); }
  redrawEngine(); redrawModels();
  return { destroy: () => search.destroy(), refreshLocks };
}

function wrapSelect(document, select) {
  const wrap = element(document, 'span', undefined, 'wb-select-wrap'); wrap.append(select, icon(document, 'chev', 'xs'));
  return wrap;
}
