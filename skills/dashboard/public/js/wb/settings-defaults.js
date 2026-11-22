import { SUPPORTED_RUNTIMES, runtimeInstallPolicy, runtimesWith } from '../../runtime-descriptors.js';
import { countLabel } from '../count-label.js';
import { effortOptionState, modelOptionState } from '../runtime-ui.js';
import { element, fallbackName, icon, runtimeName } from './plain-text.js';
import { annotateStatus } from './board.js';
import { knownGroupTotal, modelFollowerFilter, readSettingsGroups, runtimeFollowerFilter, runtimeOverrideFilter, settingsCard } from './settings.js';
import { mountPagedList } from './paged-list.js';

export function runtimeNotFound(snapshot, runtime) {
  return runtimeInstallPolicy(runtime) === 'whenUsed' && snapshot?.instance?.versions?.[runtime]?.installed === null;
}

export function runtimeHealth(instance, runtime) {
  const health = instance?.runtimeHealth?.[runtime]?.health;
  return health === 'auth_failed' ? 'unavailable' : health == null ? 'unknown' : 'available';
}
const groupName = (row, t) => row.displayName ?? fallbackName({ ...row, sessionGroup: row.id }, t);

function interruptFollowers(page, t, label = 'wb.settings.interruptFollowers') {
  const count = knownGroupTotal(page);
  if (count == null) return t('wb.settings.cannotList');
  return [countLabel(t, label, count), ...page.items.map(row => groupName(row, t)),
    ...(count > 5 ? [t('wb.settings.moreGroups', { count })] : [])].join('\n');
}

/** Drafted model/effort pairs that differ from what each engine's metadata reports. */
export function modelDraftChanges(metadata = {}, drafts = {}) {
  const changes = [];
  for (const runtime of runtimesWith('modelOverride')) {
    const meta = metadata[runtime], draft = drafts[runtime];
    if (!meta || !draft) continue;
    if (draft.model && draft.model !== (meta.current_model ?? '')) changes.push({ runtime, action: 'switch-model', key: 'model', value: draft.model });
    if (draft.effort && draft.effort !== (meta.current_effort ?? '')) changes.push({ runtime, action: 'switch-effort', key: 'effort', value: draft.effort });
    const baseline = modelThresholdValue(meta, draft.model);
    if (draft.model && Number.isInteger(draft.threshold) && baseline != null && draft.threshold !== baseline) {
      changes.push({ runtime, action: 'set-threshold', key: 'value', value: draft.threshold, model: draft.model });
    }
  }
  return changes;
}

// Values and limits come from the backend's shared model/window policy.
export function modelThresholdValue(meta, model) {
  const value = meta?.model_thresholds?.[model];
  return Number.isFinite(value) ? value : model === meta?.current_model && Number.isFinite(meta?.new_session_threshold) ? meta.new_session_threshold : null;
}

const effortText = (value, t) => { const key = 'effort.' + value, label = t(key); return label && label !== key ? label : value; };
/** One line per drafted change, as the confirmation and the result name it. */
export function modelChangeLabel(change, t = key => key, metadata = {}) {
  if (change.action === 'set-threshold') return t('wb.settings.changeThreshold', { runtime: runtimeName(change.runtime), model: change.model, value: change.value });
  const model = () => metadata[change.runtime]?.models?.find(item => item.id === change.value)?.display_name ?? change.value;
  return t(change.key === 'model' ? 'wb.settings.changeModel' : 'wb.settings.changeEffort',
    { runtime: runtimeName(change.runtime), value: change.key === 'effort' ? effortText(change.value, t) : model() });
}
/** The single confirmation for drafted defaults and their affected running sessions. */
export function modelSaveConfirmation(changes, t = key => key, metadata = {}, pages = {}) {
  const notes = changes.some(change => change.action === 'switch-effort') ? [t('wb.settings.effortNextStart')] : [];
  return [t('wb.settings.confirmModels'), ...notes, ...changes.flatMap(change => {
    const label = modelChangeLabel(change, t, metadata);
    if (change.action !== 'switch-model') return [label];
    const page = pages[change.runtime];
    return knownGroupTotal(page) === 0 ? [label] : [label, interruptFollowers(page, t, 'wb.settings.restartModelFollowers')];
  })].join('\n');
}
async function restartFailures(data, getName, t) {
  const failed = (data?.groups ?? []).filter(group => group.restart && group.restart.status !== 'accepted');
  const messages = await Promise.all(failed.map(async group =>
    t(group.restart.status === 'unknown' ? 'wb.settings.savedRestartUnknown' : 'wb.settings.savedRestartFailed',
      { group: await getName(group.sessionGroup), reason: group.restart.reason })));
  if (data?.groupsComplete === false) messages.push(t('wb.settings.restartListIncomplete'));
  return messages;
}
/** The engine switch confirmation: what happens, then which groups restart with it. */
export function runtimeSaveConfirmation(runtime, page, t = key => key) {
  return [t('confirm.switch_runtime', { value: runtimeName(runtime) }), interruptFollowers(page, t)].join('\n');
}

export function renderDefaults(root, { instance, groupCounts = {}, metadata = {}, sessionRoot, document = root.ownerDocument,
  t = key => key, read, recheck, execute, confirm = async () => false, writable = () => true, onGroup = () => {}, version = () => {} } = {}) {
  root.replaceChildren();
  let baselineRuntime = instance?.default_runtime ?? null, destroyed = false;
  const loadedNames = new Map();
  function remember(row) {
    if (row.displayName != null) loadedNames.set(row.id, row.displayName);
  }
  async function confirmationPage(filter) {
    try {
      const page = await readSettingsGroups(read, filter, { limit: 5 });
      page.items.forEach(remember);
      return page;
    } catch { return null; }
  }
  async function resultName(id) {
    if (loadedNames.has(id)) return loadedNames.get(id);
    if (!destroyed) {
      try {
        const row = await read('/api/groups/' + encodeURIComponent(id) + (id === 'origin' ? '?include=' : ''));
        if (row.displayName != null) {
          loadedNames.set(id, row.displayName);
          return row.displayName;
        }
      } catch { /* The group key is still available. */ }
    }
    return id;
  }
  const technical = () => document.documentElement?.dataset.detail === 'technical';
  const controls = [];
  const lock = (node, fn) => { controls.push({ node, lock: fn }); node.disabled = fn(); };
  if (sessionRoot) {
    renderHotTtl(sessionRoot, { metadata, document, t, execute, confirm, writable: () => !destroyed && writable(), lock,
      refreshLocks: () => refreshLocks() });
  }
  function groupRow(row, meta, showStatus) {
    const button = element(document, 'button', undefined, 'wb-gl-row'); button.type = 'button';
    button.append(element(document, 'span', groupName(row, t)));
    if (meta) {
      const label = element(document, 'small', meta);
      if (showStatus) annotateStatus(document, label, row, { t });
      button.append(label);
    }
    button.addEventListener('click', () => onGroup(row.id));
    return button;
  }
  const failed = () => element(document, 'p', t('wb.unknown') + (technical() ? ' · override_list_failed' : ''), 'wb-note');
  function groupList(total, filter, meta) {
    const details = element(document, 'details', undefined, 'wb-glist');
    const summary = element(document, 'summary'); summary.append(icon(document, 'chev', 'xs'), element(document, 'span', countLabel(t, 'wb.settings.showGroups', total)));
    const list = element(document, 'div', undefined, 'wb-gl-box wb-gl-rows');
    const failure = element(document, 'p', t('wb.readFailed'), 'wb-note wb-plist-empty');
    failure.hidden = true;
    const isOpen = () => !destroyed && details.open;
    const pages = mountPagedList({
      document, t, list, placeholder: t('wb.settings.searchGroups'),
      server: {
        async readPage({ limit, cursor, q, total }) {
          if (!isOpen()) throw Error('list_closed');
          const page = await readSettingsGroups(read, filter, { limit, cursor, q, total });
          if (page.listKnown !== true) throw Error('list_unknown');
          return page;
        },
        render(items) {
          if (!isOpen()) return;
          failure.hidden = true;
          list.replaceChildren(...items.map(row => {
            remember(row);
            return groupRow(row, meta(row), meta === stateText);
          }));
        },
        onError() { if (isOpen()) failure.hidden = false; },
      },
    });
    pages.search.querySelector('input').maxLength = 64;
    details.addEventListener('toggle', () => {
      if (!isOpen()) return;
      failure.hidden = true;
      return pages.refresh({ first: true });
    });
    const content = element(document, 'div', undefined, 'wb-gl-content');
    content.append(pages.search, list, pages.empty, failure, pages.pager);
    details.append(summary, content);
    return details;
  }
  const stateText = row => t('wb.state.' + (row.state?.kind ?? 'unknown'));

  // ─── Default engine ───
  const engine = settingsCard(document, { icon: 'bot', title: t('wb.settings.currentRuntime'), sub: technical() ? 'zylos runtime' : '' });
  engine.card.id = 'settings-current-runtime';
  let view = baselineRuntime ?? SUPPORTED_RUNTIMES[0], savingRuntime = false, recheckBusy = false;
  const line = element(document, 'div', undefined, 'wb-set-inline');
  const select = element(document, 'select', undefined, 'wb-input wb-select');
  select.id = 'settings-engine';
  select.setAttribute('aria-label', t('wb.settings.currentRuntime'));
  const options = SUPPORTED_RUNTIMES.map(runtime => {
    const option = element(document, 'option');
    option.value = runtime;
    select.append(option);
    return option;
  });
  const selectWrap = wrapSelect(document, select, 'wb-select-wrap wb-engine-select');
  const defaultBadge = element(document, 'span', t('wb.settings.defaultEngineBadge'), 'wb-default-badge');
  const setDefault = element(document, 'button', t('wb.settings.setDefault'), 'wb-btn wb-btn-primary');
  setDefault.type = 'button';
  setDefault.id = 'settings-set-default';
  line.append(selectWrap, defaultBadge, setDefault);
  const unavailable = () => runtimeHealth(instance, view) === 'unavailable';
  const notFound = () => runtimeNotFound({ instance }, view);
  lock(select, () => savingRuntime);
  lock(setDefault, () => savingRuntime || !writable() || unavailable() || notFound());
  setDefault.addEventListener('click', async () => {
    if (setDefault.disabled || view === baselineRuntime) return;
    const runtime = view;
    savingRuntime = true;
    refreshLocks();
    try {
      const current = await confirmationPage(runtimeFollowerFilter);
      if (destroyed || !writable()) return;
      const needsConfirmation = knownGroupTotal(current) !== 0;
      if (needsConfirmation &&
          !(await confirm(runtimeSaveConfirmation(runtime, current, t), { title: t('wb.settings.confirm.runtime'), danger: true }))) return;
      if (destroyed || !writable()) return;
      const result = await execute('switch-runtime', { runtime, ...(needsConfirmation && { confirmed: true }) }, { confirmed: true });
      if (result === false) {
        engineResult.textContent = t('wb.settings.saveFailed');
        return;
      }
      baselineRuntime = runtime;
      const saved = t(result?.messageKey ?? 'result.runtime_saved', {
        ...result?.messageParams, value: runtimeName(baselineRuntime),
      });
      engineResult.textContent = [saved, ...await restartFailures(result?.data, resultName, t)].join('\n');
      if (!destroyed) redrawEngine();
    } catch (error) { engineResult.textContent = error.message; }
    finally { savingRuntime = false; refreshLocks(); }
  });
  const engineResult = element(document, 'p', '', 'wb-note'); engineResult.id = 'settings-engine-result'; engineResult.setAttribute('role', 'status');
  const split = element(document, 'div', undefined, 'wb-set-split');
  // A count of zero tells nothing, so its line is left out.
  function groupColumn(key, total, filter, meta) {
    const col = element(document, 'div');
    col.hidden = total === 0;
    col.append(element(document, 'div', countLabel(t, key, total ?? t('wb.unknown')), 'wb-gsum'));
    if (total == null) col.append(failed());
    else if (total > 0) col.append(groupList(total, filter, meta));
    return col;
  }
  split.append(
    groupColumn('wb.settings.followers', groupCounts.followers, runtimeFollowerFilter, stateText),
    groupColumn('wb.settings.overrides', groupCounts.overrides, runtimeOverrideFilter, row => runtimeName(row.runtime)),
  );
  const loginNote = element(document, 'p', t('wb.settings.runtimeNote'), 'wb-note');
  const installNote = element(document, 'p', undefined, 'wb-note wb-note-act');
  const installText = element(document, 'span');
  const recheckButton = element(document, 'button', t('wb.recheck'), 'wb-btn wb-btn-sm');
  recheckButton.type = 'button';
  installNote.append(installText, recheckButton);
  lock(recheckButton, () => !writable() || recheckBusy);
  recheckButton.addEventListener('click', async () => {
    if (recheckButton.disabled || recheckBusy) return;
    recheckBusy = true;
    refreshLocks();
    try {
      await recheck();
      if (destroyed) return;
      const current = await read('/api/instance');
      if (destroyed) return;
      instance = { ...instance, versions: current.versions };
      engineResult.textContent = '';
      redrawEngine();
    } catch (error) {
      engineResult.textContent = t('status.failed', { error: error.message });
    } finally {
      recheckBusy = false;
      refreshLocks();
    }
  });
  const engineVersion = element(document, 'div', undefined, 'wb-engine-version');
  engineVersion.id = 'settings-engine-version';
  const selectedRuntime = () => view;
  const drawVersion = () => version(engineVersion, selectedRuntime());
  const modelSettings = element(document, 'div', undefined, 'wb-engine-models');
  engine.card.append(line, loginNote, installNote, engineVersion, engineResult, split, modelSettings);
  root.append(engine.card);
  function redrawEngine() {
    for (const option of options) {
      const runtime = option.value;
      option.textContent = [runtimeName(runtime), t('wb.settings.health.' + runtimeHealth(instance, runtime)),
        ...(runtime === baselineRuntime ? [t('wb.settings.defaultEngineBadge')] : [])].join(' · ');
    }
    select.value = view;
    const isDefault = view === baselineRuntime;
    const missing = notFound();
    const signedOut = unavailable();
    defaultBadge.hidden = !isDefault;
    setDefault.hidden = isDefault;
    loginNote.hidden = isDefault || !signedOut || missing;
    installNote.hidden = isDefault || !missing;
    if (!installNote.hidden) {
      installText.textContent = t('wb.runtimeNotFound', { runtime: runtimeName(view), command: `zylos runtime ${view}` });
    }
    split.hidden = isDefault || signedOut || missing;
    drawVersion();
    refreshLocks();
  }

  // ─── Default model, effort and rotation threshold per engine ───
  const drafts = {}, rows = {};
  const result = element(document, 'p', '', 'wb-note'); result.id = 'settings-model-result'; result.setAttribute('role', 'status');
  let savingModels = false;
  const undo = element(document, 'button', t('wb.settings.undo'), 'wb-btn'); undo.type = 'button';
  const save = element(document, 'button', t('btn.save'), 'wb-btn wb-btn-primary'); save.type = 'button'; save.id = 'settings-save-models';
  const actions = element(document, 'div', undefined, 'wb-engine-model-actions');
  actions.append(undo, save);
  const boxes = {};
  const editableRuntimes = runtimesWith('modelOverride');
  function appendModelFollowers(box, runtime) {
    const users = groupCounts.models?.[runtime];
    box.append(element(document, 'small', users == null ? t('wb.unknown') : users
      ? countLabel(t, 'wb.settings.modelFollowers', users) : t('wb.settings.noFollowers'), 'wb-pref-note'));
    if (users > 0) box.append(groupList(users, modelFollowerFilter(runtime), stateText));
  }
  for (const runtime of editableRuntimes) {
    let meta = metadata[runtime];
    const box = element(document, 'div', undefined, 'wb-pref-c');
    boxes[runtime] = box;
    modelSettings.append(box);
    if (!meta) { box.append(element(document, 'span', t('wb.unknown'), 'wb-note')); continue; }
    drafts[runtime] = { model: meta.current_model ?? '', effort: meta.current_effort ?? '' };
    const fields = element(document, 'div', undefined, 'wb-model-fields');
    const model = element(document, 'select', undefined, 'wb-input wb-select'); model.id = 'settings-model-' + runtime; model.setAttribute('aria-label', t('actions.model'));
    const custom = element(document, 'input'); custom.id = 'settings-model-custom-' + runtime; custom.placeholder = t('actions.model_placeholder'); custom.className = 'wb-input';
    const effortField = element(document, 'label', undefined, 'wb-model-field');
    const effort = element(document, 'select', undefined, 'wb-input wb-select'); effort.id = 'settings-effort-' + runtime; effort.setAttribute('aria-label', t('actions.effort'));
    const threshold = element(document, 'input', undefined, 'wb-input wb-input-num'); threshold.id = 'settings-threshold-' + runtime;
    threshold.type = 'number'; threshold.min = '10'; threshold.step = '1'; threshold.setAttribute('aria-label', t('actions.threshold'));
    const thresholdEdits = new Map();
    let thresholdSequence = 0;
    const dirty = element(document, 'span', t('wb.settings.unsavedOne'), 'wb-dirty');
    const options = modelOptionState(meta);
    for (const item of options.options) { const option = element(document, 'option', item.labelKey ? t(item.labelKey) : item.label); option.value = item.value; option.disabled = Boolean(item.disabled); model.append(option); }
    model.value = options.custom ? '__custom__' : meta.current_model ?? ''; custom.value = options.customValue; custom.hidden = !options.custom;
    const modelValue = () => model.value === '__custom__' ? custom.value.trim() : model.value;
    const renderEffort = () => {
      const state = effortOptionState(meta, modelValue(), drafts[runtime].effort || meta.current_effort, value => effortText(value, t));
      effort.replaceChildren();
      for (const item of state.options) { const option = element(document, 'option', item.labelKey ? t(item.labelKey, item.labelParams) : effortText(item.value, t)); option.value = item.value; option.disabled = item.disabled; option.selected = item.selected; effort.append(option); }
      effortField.hidden = state.hidden;
      const selected = state.options.find(item => item.selected);
      effort.value = selected?.value ?? '';
      drafts[runtime].effort = selected && !selected.disabled ? selected.value : '';
    };
    const renderThreshold = () => {
      const selected = modelValue();
      const value = thresholdEdits.has(selected) ? thresholdEdits.get(selected) : modelThresholdValue(rows[runtime]?.meta ?? meta, selected);
      threshold.value = value == null ? '' : String(value);
      threshold.max = String((rows[runtime]?.meta ?? meta).model_threshold_max?.[selected] ?? 95);
      drafts[runtime].threshold = value;
      refreshLocks();
    };
    const loadThreshold = async () => {
      const selected = modelValue(), sequence = ++thresholdSequence;
      renderThreshold();
      if (!selected || modelThresholdValue(rows[runtime]?.meta ?? meta, selected) != null || !read) return;
      try {
        const next = await read('/api/instance/runtime-options?' + new URLSearchParams({ runtime, model: selected }));
        if (destroyed || sequence !== thresholdSequence || selected !== modelValue()) return;
        if (next?.runtime === runtime && next.model_thresholds) {
          meta = { ...meta, ...next };
          if (rows[runtime]) rows[runtime].meta = meta;
          metadata[runtime] = meta;
          renderThreshold(); redrawModels();
        }
      } catch { /* The empty disabled threshold remains explicitly unknown. */ }
    };
    const changed = () => { drafts[runtime].model = modelValue(); renderEffort(); void loadThreshold(); redrawModels(); };
    model.addEventListener('change', () => { custom.hidden = model.value !== '__custom__'; if (!custom.hidden) custom.focus(); changed(); });
    custom.addEventListener('input', changed);
    effort.addEventListener('change', () => { drafts[runtime].effort = effort.value; redrawModels(); });
    threshold.addEventListener('input', () => {
      const value = threshold.value === '' ? NaN : Number(threshold.value);
      thresholdEdits.set(modelValue(), value); drafts[runtime].threshold = value; redrawModels();
    });
    renderEffort(); drafts[runtime].effort = meta.current_effort ?? drafts[runtime].effort;
    const field = (label, ...children) => { const box = element(document, 'label', undefined, 'wb-model-field'); box.append(element(document, 'span', label, 'wb-fld-l'), ...children); return box; };
    const thresholdBox = element(document, 'span', undefined, 'wb-set-inline'); thresholdBox.append(threshold, element(document, 'span', '%'));
    effortField.append(element(document, 'span', t('actions.effort'), 'wb-fld-l'), wrapSelect(document, effort));
    fields.append(field(t('actions.model'), wrapSelect(document, model), custom), effortField, field(t('actions.threshold'), thresholdBox), dirty);
    box.append(fields);
    appendModelFollowers(box, runtime);
    rows[runtime] = { model, custom, effort, threshold, thresholdEdits, dirty, meta, renderEffort, renderThreshold,
      thresholdInvalid: () => modelValue() && (modelThresholdValue(rows[runtime]?.meta ?? meta, modelValue()) == null
        ? Boolean((rows[runtime]?.meta ?? meta).model_thresholds)
        : drafts[runtime].threshold !== modelThresholdValue(rows[runtime]?.meta ?? meta, modelValue()) &&
          (!Number.isInteger(drafts[runtime].threshold) || drafts[runtime].threshold < 10 || drafts[runtime].threshold > Number(threshold.max))) };
    lock(model, () => savingModels || !writable()); lock(custom, () => savingModels || !writable());
    lock(effort, () => savingModels || !writable() || effortOptionState(meta, modelValue(), drafts[runtime].effort || meta.current_effort).disabled);
    lock(threshold, () => savingModels || !writable() || !modelValue() || modelThresholdValue(rows[runtime]?.meta ?? meta, modelValue()) == null);
    void loadThreshold();
  }
  for (const runtime of runtimesWith('modelOverride', 'unsupported')) {
    const box = element(document, 'div', undefined, 'wb-pref-c');
    box.append(element(document, 'p', t('wb.config.modelUnavailable', { runtime: runtimeName(runtime) }), 'wb-note'));
    appendModelFollowers(box, runtime);
    boxes[runtime] = box;
    modelSettings.append(box);
  }
  const nextStartNote = element(document, 'p', t('wb.settings.nextStartNote'), 'wb-note');
  modelSettings.append(nextStartNote, result, actions);
  const changes = () => modelDraftChanges(metadata, drafts).filter(change => change.runtime === view);
  select.addEventListener('change', () => {
    if (select.disabled) return;
    view = select.value;
    result.textContent = '';
    redrawEngine();
    redrawModels();
  });
  function redrawModels() {
    const pending = modelDraftChanges(metadata, drafts);
    const editing = editableRuntimes.includes(view);
    for (const [runtime, box] of Object.entries(boxes)) box.hidden = runtime !== view;
    for (const [runtime, row] of Object.entries(rows)) row.dirty.hidden = !pending.some(change => change.runtime === runtime);
    nextStartNote.hidden = result.hidden = !editing;
    actions.hidden = undo.hidden = save.hidden = !pending.some(change => change.runtime === view);
    refreshLocks();
  }
  lock(undo, () => savingModels || !writable());
  lock(save, () => savingModels || !writable() || !changes().length || Boolean(rows[view]?.thresholdInvalid()));
  undo.addEventListener('click', () => {
    const runtime = view, row = rows[runtime];
    if (undo.disabled || !row) return;
    drafts[runtime] = { model: row.meta.current_model ?? '', effort: row.meta.current_effort ?? '' };
    const initial = modelOptionState(row.meta); row.model.value = initial.custom ? '__custom__' : row.meta.current_model ?? ''; row.custom.value = initial.customValue; row.custom.hidden = !initial.custom; row.renderEffort(); drafts[runtime].effort = row.meta.current_effort ?? '';
    row.effort.value = drafts[runtime].effort;
    row.thresholdEdits.clear(); row.renderThreshold();
    redrawModels();
  });
  save.addEventListener('click', async () => {
    const pending = changes();
    if (save.disabled || !pending.length) return;
    savingModels = true;
    refreshLocks();
    const applied = [], failures = [];
    const report = () => {
      const left = pending.filter(change => !applied.includes(change));
      if (!applied.length) return t('wb.settings.saveFailed');
      const list = changes => changes.map(change => modelChangeLabel(change, t, metadata)).join(t('wb.settings.listSep'));
      const saved = left.length ? t('wb.settings.partlySaved', { done: list(applied), left: list(left) }) : t('wb.settings.defaultsSaved');
      return [
        saved,
        ...(applied.some(change => change.action === 'switch-effort') ? [t('wb.settings.effortNextStart')] : []),
        ...(applied.some(change => change.action === 'set-threshold') ? [t('wb.settings.thresholdNextRotation')] : []),
      ].join(' ');
    };
    try {
      const modelChanges = pending.filter(change => change.action === 'switch-model');
      const current = Object.fromEntries(await Promise.all(modelChanges.map(async change =>
        [change.runtime, await confirmationPage(modelFollowerFilter(change.runtime))])));
      if (destroyed || !writable()) return;
      const affected = modelChanges.filter(change => knownGroupTotal(current[change.runtime]) !== 0);
      const danger = affected.length > 0;
      const needsConfirmation = danger || modelChanges.length !== pending.length;
      if (needsConfirmation && !(await confirm(modelSaveConfirmation(pending, t, metadata, current), { title: t('wb.settings.confirm.models'), danger }))) return;
      if (destroyed || !writable()) return;
      for (const change of pending) {
        const body = { runtime: change.runtime, [change.key]: change.value,
          ...(affected.includes(change) && { confirmed: true }),
          ...(change.action === 'set-threshold' && { model: change.model }) };
        if (destroyed) break;
        const accepted = await execute(change.action, body, { confirmed: true });
        if (accepted === false) break;
        applied.push(change);
        if (change.action === 'switch-model') failures.push(...await restartFailures(accepted?.data, resultName, t));
        if (rows[change.runtime]) {
          const row = rows[change.runtime];
          row.meta = change.action === 'set-threshold'
            ? { ...row.meta, model_thresholds: { ...row.meta.model_thresholds, [change.model]: change.value } }
            : { ...row.meta, ['current_' + change.key]: change.value };
        }
      }
      if (view === pending[0].runtime) result.textContent = [report(), ...failures].join('\n');
    } catch (error) {
      if (view === pending[0].runtime) result.textContent = [...(applied.length ? [report(), ...failures] : []), error.message].join('\n');
    } finally {
      if (applied.length) metadata = Object.fromEntries(Object.entries(rows).map(([runtime, row]) => [runtime, row.meta]));
      savingModels = false;
      redrawModels();
    }
  });
  function refreshLocks() { for (const { node, lock: fn } of controls) node.disabled = fn(); }
  redrawEngine(); redrawModels();
  return { destroy: () => { destroyed = true; }, refreshLocks, selectedRuntime, refreshVersion: drawVersion };
}

/** One global value, loaded and saved through the selected instance's normal action path. */
export function renderHotTtl(root, { metadata = {}, document = root.ownerDocument, t = key => key,
  execute, confirm = async () => false, writable = () => true, lock, refreshLocks = () => {} } = {}) {
  root.replaceChildren();
  const meta = Object.values(metadata).find(m => m?.session_hot_ttl)?.session_hot_ttl;
  const seconds = meta?.seconds;
  let baseline = Number.isFinite(seconds) ? seconds / 60 : null, busy = false;
  const min = meta?.min_minutes ?? 5, max = meta?.max_minutes ?? 1440;
  const editable = () => ['single', 'multi'].includes(meta?.mode) && meta?.read_only === false && !meta?.environment_set;
  const label = element(document, 'label', t('wb.settings.hotTtl.label'), 'wb-fld-l');
  label.setAttribute('for', 'settings-hot-ttl-minutes');
  const input = element(document, 'input', undefined, 'wb-input wb-input-num');
  input.id = 'settings-hot-ttl-minutes'; input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1';
  input.value = baseline == null ? '' : Number.isInteger(baseline) ? String(baseline) : baseline.toFixed(1);
  let displayedBaseline = input.value;
  input.readOnly = !editable();
  input.setAttribute('aria-describedby', 'settings-hot-ttl-help');
  const save = element(document, 'button', t('btn.save'), 'wb-btn wb-btn-primary');
  save.id = 'settings-save-hot-ttl'; save.type = 'button';
  const row = element(document, 'div', undefined, 'wb-set-inline'); row.append(input, element(document, 'span', t('wb.settings.hotTtl.minutes')), save);
  const help = element(document, 'p', t('wb.settings.hotTtl.help'), 'wb-note'); help.id = 'settings-hot-ttl-help';
  const range = element(document, 'p', '', 'wb-note'); range.id = 'settings-hot-ttl-range';
  const source = element(document, 'p', '', 'wb-note'); source.id = 'settings-hot-ttl-source';
  const result = element(document, 'p', '', 'wb-note'); result.id = 'settings-hot-ttl-result'; result.setAttribute('role', 'status');
  if (!meta || baseline == null) source.textContent = t('wb.unknown');
  else {
    const notes = [];
    if (meta.environment_set) notes.push(t(meta.environment_valid ? 'wb.settings.hotTtl.environment' : 'wb.settings.hotTtl.environmentInvalid'));
    if (meta.mode === 'single') notes.push(t('wb.settings.hotTtl.single'));
    else if (meta.mode !== 'multi') notes.push(t('wb.unknown'));
    if (seconds % 60 !== 0) notes.push(t('wb.settings.hotTtl.exactSeconds', { minutes: Math.floor(seconds / 60), remainder: seconds % 60, seconds }));
    source.textContent = notes.join('\n');
  }
  const minutes = () => input.value.trim() === '' ? NaN : Number(input.value);
  const invalid = () => !Number.isInteger(minutes()) || minutes() < min || minutes() > max;
  const lockInput = () => busy || !writable() || !editable() || baseline == null;
  const lockSave = () => lockInput() || invalid() || input.value === displayedBaseline || minutes() === baseline;
  const redraw = () => {
    input.disabled = lockInput(); save.disabled = lockSave();
    range.textContent = t(editable() && writable() && baseline != null ? 'wb.settings.hotTtl.range' : 'wb.settings.hotTtl.readOnly', { min, max });
  };
  lock?.(input, lockInput); lock?.(save, lockSave);
  input.addEventListener('input', redraw);
  save.addEventListener('click', async () => {
    if (lockSave()) return;
    const value = minutes();
    if (!(await confirm(t('wb.settings.hotTtl.confirm', { minutes: value }), { title: t('wb.settings.confirm.hotTtl'), danger: false }))) return;
    if (lockSave()) return;
    busy = true; redraw();
    try {
      const accepted = await execute('set-session-hot-ttl', { minutes: value }, { confirmed: true });
      if (accepted === false) result.textContent = t('wb.settings.saveFailed');
      else { baseline = value; displayedBaseline = String(value); source.textContent = ''; result.textContent = t('wb.settings.hotTtl.saved'); }
    } catch (error) { result.textContent = error.message; }
    finally { busy = false; redraw(); refreshLocks(); }
  });
  root.append(label, row, help, range, source, result); redraw();
}

function wrapSelect(document, select, className = 'wb-select-wrap') {
  const wrap = element(document, 'span', undefined, className); wrap.append(select, icon(document, 'chev', 'xs'));
  return wrap;
}
