import { effortOptionState, modelOptionState } from '../runtime-ui.js';
import { element, icon, runtimeName } from './plain-text.js';
import { settingsCard } from './settings.js';

const effortText = (value, t) => { const key = 'effort.' + value, label = t(key); return label && label !== key ? label : value; };
const KINDS = ['model', 'effort'];

/**
 * The nightly dreaming model and effort of the instance's current runtime. `instance.defaults[runtime].dream`
 * carries what is saved (`model`/`effort`, null meaning the runtime default), the defaults and the efforts the
 * runtime accepts; the model list comes from that runtime's options when it has one.
 */
export function renderDream(root, { instance, metadata = {}, document = root.ownerDocument, t = key => key, execute,
  confirm = async () => false, writable = () => true, technical = () => false } = {}) {
  const { card } = settingsCard(document, { icon: 'moon', title: t('wb.settings.dream.title'),
    sub: technical() ? 'zylos config memory_dream_model / memory_dream_effort' : '' });
  card.id = 'settings-dream';
  const body = element(document, 'div');
  const result = element(document, 'span', '', 'wb-note wb-action-result');
  result.id = 'settings-dream-result'; result.setAttribute('role', 'status');
  card.append(body);
  root.append(card);
  let runtime = instance?.default_runtime ?? null, saved = null, busy = false, view = null;

  const defaultText = kind => t('wb.settings.dream.default', { value: kind === 'model' ? saved.default_model : effortText(saved.default_effort, t) });
  function option(select, value, text, disabled = false) {
    const node = element(document, 'option', text); node.value = value; node.disabled = disabled; select.append(node);
  }
  function draw() {
    body.replaceChildren();
    saved = runtime ? instance?.defaults?.[runtime]?.dream ?? null : null;
    view = null;
    if (!saved) { body.append(element(document, 'p', t('wb.unknown'), 'wb-note')); return; }
    body.append(element(document, 'p', t('wb.settings.dream.note', { runtime: runtimeName(runtime) }), 'wb-note'));
    // Model: the existing picker's list and custom entry, with "default (model)" standing for no saved value.
    const model = element(document, 'select', undefined, 'wb-input wb-select'); model.id = 'settings-dream-model';
    model.setAttribute('aria-label', t('wb.settings.dream.model'));
    option(model, '', defaultText('model'));
    const models = modelOptionState({ ...(metadata[runtime] ?? { runtime, models: [] }), current_model: saved.model });
    for (const item of models.options) if (item.value !== '') option(model, item.value, item.labelKey ? t(item.labelKey) : item.label);
    const custom = element(document, 'input', undefined, 'wb-input'); custom.id = 'settings-dream-model-custom';
    custom.placeholder = t('actions.model_placeholder'); custom.setAttribute('aria-label', t('actions.custom'));
    model.value = saved.model == null ? '' : models.custom ? '__custom__' : saved.model;
    custom.value = saved.model != null && models.custom ? models.customValue : '';
    custom.hidden = model.value !== '__custom__';
    // Effort: the efforts this runtime accepts, with an unavailable saved value shown as such.
    const effort = element(document, 'select', undefined, 'wb-input wb-select'); effort.id = 'settings-dream-effort';
    effort.setAttribute('aria-label', t('wb.settings.dream.effort'));
    option(effort, '', defaultText('effort'));
    const efforts = effortOptionState({ runtime, efforts_by_model: { '*': saved.efforts }, catalog_strict: true }, '*', saved.effort,
      value => effortText(value, t));
    for (const item of efforts.options) {
      if (item.value === '' && saved.effort == null) continue;
      option(effort, item.value, item.labelKey ? t(item.labelKey, item.labelParams) : effortText(item.value, t), item.disabled);
    }
    effort.value = saved.effort == null || !saved.efforts.includes(saved.effort) ? '' : saved.effort;
    if (saved.effort != null && !saved.efforts.includes(saved.effort)) effort.selectedIndex = 1;
    const field = (text, ...children) => {
      const box = element(document, 'label', undefined, 'wb-model-field');
      box.append(element(document, 'span', text, 'wb-fld-l'), ...children);
      return box;
    };
    const effortField = field(t('wb.settings.dream.effort'), wrap(effort));
    effortField.hidden = !saved.efforts.length;
    const fields = element(document, 'div', undefined, 'wb-model-fields');
    fields.append(field(t('wb.settings.dream.model'), wrap(model), custom), effortField);
    const save = element(document, 'button', t('btn.save'), 'wb-btn wb-btn-primary'); save.type = 'button'; save.id = 'settings-dream-save';
    const reset = element(document, 'button', t('wb.settings.dream.reset'), 'wb-btn'); reset.type = 'button'; reset.id = 'settings-dream-reset';
    const actions = element(document, 'div', undefined, 'wb-action-row'); actions.append(save, reset, result);
    body.append(fields, actions);
    const draft = () => ({
      model: model.value === '__custom__' ? custom.value.trim() || null : model.value || null,
      effort: effort.options[effort.selectedIndex]?.disabled ? saved.effort : effort.value || null,
    });
    const changes = () => { const next = draft(); return KINDS.filter(kind => next[kind] !== saved[kind]).map(kind => ({ kind, value: next[kind] })); };
    view = { model, custom, effort, save, reset, changes };
    model.addEventListener('change', () => { custom.hidden = model.value !== '__custom__'; if (!custom.hidden) custom.focus(); refresh(); });
    custom.addEventListener('input', refresh);
    effort.addEventListener('change', refresh);
    save.addEventListener('click', () => submit(changes()));
    reset.addEventListener('click', () => submit(KINDS.filter(kind => saved[kind] != null).map(kind => ({ kind, value: null }))));
    refresh();
  }

  async function submit(pending) {
    if (busy || !pending.length || !writable()) return;
    const target = runtime;
    const describe = ({ kind, value }) => t('wb.settings.dream.change.' + kind,
      { value: value == null ? defaultText(kind) : kind === 'effort' ? effortText(value, t) : value });
    if (!(await confirm([t('wb.settings.dream.confirm', { runtime: runtimeName(target) }), ...pending.map(describe)].join('\n'),
      { title: t('wb.settings.confirm.dream'), danger: false }))) return;
    if (busy || target !== runtime || !writable()) return;
    busy = true; refresh();
    let message = t('wb.settings.saveFailed'), latest = null;
    try {
      for (const { kind, value } of pending) {
        const accepted = await execute(kind === 'model' ? 'set-dream-model' : 'set-dream-effort', { runtime: target, [kind]: value }, { confirmed: true });
        if (accepted === false) break;
        latest = accepted?.dream ?? latest;
        message = t('wb.settings.dream.saved');
      }
    } catch (error) { message = latest ? [t('wb.settings.dream.saved'), error.message].join('\n') : error.message; }
    finally {
      busy = false;
      if (latest && target === runtime) {
        instance = { ...instance, defaults: { ...instance?.defaults, [target]: { ...instance?.defaults?.[target], dream: latest } } };
        draw();
      }
      result.textContent = message;
      refresh();
    }
  }

  function refresh() {
    if (!view) return;
    const locked = busy || !writable();
    for (const node of [view.model, view.custom, view.effort]) node.disabled = locked;
    view.save.disabled = locked || !view.changes().length || (view.model.value === '__custom__' && !view.custom.value.trim());
    view.reset.disabled = locked || (saved.model == null && saved.effort == null);
  }

  draw();
  return {
    refresh,
    /** Newer instance data, or the runtime that is now current: the card follows the instance's current runtime. */
    apply(next, current = next?.default_runtime) {
      if (next) instance = next;
      if (!current || busy) return;
      if (current !== runtime) { runtime = current; result.textContent = ''; draw(); return; }
      // Instance pushes repeat; a value saved elsewhere replaces the shown one unless it is being edited.
      const latest = instance?.defaults?.[runtime]?.dream ?? null;
      if (JSON.stringify(latest) !== JSON.stringify(saved) && !view?.changes().length) draw();
    },
  };
}

function wrap(select) {
  const box = element(select.ownerDocument, 'span', undefined, 'wb-select-wrap');
  box.append(select, icon(select.ownerDocument, 'chev', 'xs'));
  return box;
}
