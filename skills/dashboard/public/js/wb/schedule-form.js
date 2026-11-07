import { element } from './plain-text.js?v=94';
import { createFetchGuard } from './fetch-guard.js?v=85';

const pad = value => String(value).padStart(2, '0');

/** Local `YYYY-MM-DDTHH:MM` of an epoch second in `tz`, as a datetime-local input expects. */
export function localInputValue(epochSeconds, tz) {
  if (epochSeconds == null) return '';
  const parts = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz ?? 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
  });
  for (const { type, value } of format.formatToParts(new Date(epochSeconds * 1000))) parts[type] = value;
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function intervalText(seconds) {
  if (!(seconds > 0)) return '';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Create and edit share one form. It has no target-group or reply fields: those are agent-only. */
export function initialForm(task = null, { reenable = false, tz = null } = {}) {
  if (!task) {
    return { name: '', prompt: '', kind: 'cron', value: '', priority: '3', missThreshold: '300', requireIdle: false };
  }
  const kind = task.type === 'recurring' ? 'cron' : task.type === 'interval' ? 'every' : 'at';
  const value = kind === 'cron' ? task.cron ?? '' : kind === 'every' ? intervalText(task.intervalSeconds)
    : reenable ? '' : localInputValue(task.nextRunAt, tz);
  return {
    name: task.name ?? '',
    prompt: task.prompt ?? '',
    kind,
    value,
    priority: String(task.priority ?? 3),
    missThreshold: String(task.missThreshold ?? 300),
    requireIdle: Boolean(task.requireIdle),
  };
}

/** Request body. The schedule is sent only when it is new, changed or being re-enabled. */
export function formPayload(state, original = null, { reenable = false } = {}) {
  const body = {
    name: state.name,
    prompt: state.prompt,
    priority: state.priority,
    missThreshold: state.missThreshold,
    requireIdle: state.requireIdle,
  };
  if (!original || reenable || original.kind !== state.kind || original.value !== state.value) {
    body.schedule = { kind: state.kind, value: state.value };
  }
  return body;
}

export function previewPath(state, { reenable = false, locale = 'zh' } = {}) {
  const query = new URLSearchParams({ kind: state.kind, value: state.value, locale });
  if (reenable) query.set('reenable', '1');
  return '/api/workbench/schedule/preview?' + query.toString();
}

/** A preview that is invalid blocks saving; an unknown preview leaves validation to the scheduler. */
export function saveAllowed(state, preview, { creating = false, reenable = false } = {}) {
  if (preview?.valid === false) return false;
  if (!state.value.trim() && (creating || reenable)) return false;
  if (creating && !state.prompt.trim()) return false;
  if (!/^\d{1,9}$/.test(String(state.missThreshold ?? '').trim())) return false;
  return true;
}

export function createPreviewer({ fetchPreview, onResult, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const guard = createFetchGuard();
  let timer;
  return {
    request(path) {
      clearTimer(timer);
      const gen = guard.next();
      timer = setTimer(async () => {
        let value;
        try {
          value = await fetchPreview(path);
        } catch {
          value = { valid: null, error: 'preview_unavailable' };
        }
        if (guard.current(gen)) onResult(value);
      }, 300);
    },
    destroy() {
      clearTimer(timer);
      guard.invalidate();
    },
  };
}

function field(document, label, control, hint) {
  const wrap = element(document, 'label', undefined, 'wb-sched-field');
  wrap.append(element(document, 'span', label, 'wb-sched-label'), control);
  if (hint) wrap.append(element(document, 'small', hint, 'wb-sched-hint'));
  return wrap;
}

function input(document, type, value, onInput) {
  const node = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') node.type = type;
  if (type !== 'checkbox') node.className = 'wb-input';
  if (type === 'checkbox') node.checked = Boolean(value);
  else node.value = value;
  node.addEventListener(type === 'checkbox' ? 'change' : 'input', () => onInput(type === 'checkbox' ? node.checked : node.value));
  return node;
}

function previewText(preview, { t, formatTime }) {
  if (!preview) return '';
  if (preview.valid === null) return t('wb.schedule.preview.unavailable');
  if (preview.valid === false) return t('wb.schedule.error.' + preview.error);
  const times = (preview.runs ?? []).map(formatTime).join(' · ');
  return [preview.text, times].filter(Boolean).join(' · ');
}

function select(document, values, label, current, onSelect) {
  const node = document.createElement('select');
  node.className = 'wb-input wb-select';
  for (const value of values) {
    const option = element(document, 'option', label(value));
    option.value = value;
    node.append(option);
  }
  node.value = current;
  node.addEventListener('change', () => onSelect(node.value));
  return node;
}

const MISS_CHOICES = ['300', '1800', '3600', '86400'];
const MISS_KEYS = { 300: 'm5', 1800: 'm30', 3600: 'h1', 86400: 'd1' };
const PLACEHOLDER = { cron: '0 9 * * 1-5', every: 'wb.schedule.form.everyPlaceholder' };

/**
 * Builds the form once; typing updates state in place so inputs keep focus.
 * `onChange(state)` lets the caller request a preview for the new schedule.
 * The title is returned separately so the drawer can place it in its header.
 */
export function createForm(document, { state: initial, t = key => key, creating = false, reenable = false,
  tzLabel = '', formatTime = String, onChange = () => {}, onSave = () => {}, onCancel = () => {} }) {
  const state = { ...initial };
  let preview = null, busy = false;
  const root = element(document, 'form', undefined, 'wb-sched-form');
  const titleKey = creating ? 'wb.schedule.form.new' : reenable ? 'wb.schedule.reenable' : 'wb.schedule.form.edit';
  const title = element(document, 'h3', t(titleKey), 'wb-d-title');
  const save = element(document, 'button', t(creating ? 'wb.schedule.create' : 'wb.schedule.save'), 'wb-btn wb-btn-primary wb-sched-save');
  const previewLine = element(document, 'p', '', 'wb-sched-preview');
  const message = element(document, 'p', '', 'wb-sched-message');
  const sync = () => {
    save.disabled = busy || !saveAllowed(state, preview, { creating, reenable });
    previewLine.textContent = previewText(preview, { t, formatTime });
    previewLine.className = 'wb-sched-preview' + (preview?.valid === false ? ' wb-sched-invalid'
      : preview?.valid ? ' wb-sched-valid' : '');
  };
  const set = (key, scheduleChanged = false) => value => {
    state[key] = value;
    if (scheduleChanged) preview = null;
    sync();
    onChange({ ...state }, scheduleChanged);
  };
  const name = input(document, 'text', state.name, set('name'));
  name.placeholder = t('wb.schedule.form.namePlaceholder');
  root.append(field(document, t('wb.schedule.form.name'), name));
  const prompt = input(document, 'textarea', state.prompt, set('prompt'));
  prompt.placeholder = t('wb.schedule.form.promptPlaceholder');
  prompt.rows = 6;
  root.append(field(document, t('wb.schedule.form.prompt'), prompt));
  const time = input(document, state.kind === 'at' ? 'datetime-local' : 'text', state.value, set('value', true));
  time.required = creating || reenable;
  const tzNote = element(document, 'small', '', 'wb-sched-hint');
  const placeholder = () => {
    time.placeholder = state.kind === 'cron' ? PLACEHOLDER.cron : state.kind === 'every' ? t(PLACEHOLDER.every) : '';
    tzNote.textContent = state.kind === 'at' ? tzLabel : '';
  };
  const kind = element(document, 'div', undefined, 'wb-seg wb-sched-kind');
  kind.setAttribute('role', 'group');
  kind.setAttribute('aria-label', t('wb.schedule.form.kind'));
  const kinds = ['cron', 'every', 'at'].map(value => {
    const item = element(document, 'button', t('wb.schedule.kind.' + value));
    item.type = 'button';
    item.dataset.kind = value;
    item.disabled = reenable;
    item.addEventListener('click', () => {
      if (state.kind === value) return;
      state.kind = value;
      state.value = '';
      time.type = value === 'at' ? 'datetime-local' : 'text';
      time.value = '';
      kinds.forEach(other => other.setAttribute('aria-pressed', String(other.dataset.kind === value)));
      placeholder();
      set('value', true)('');
    });
    item.setAttribute('aria-pressed', String(state.kind === value));
    kind.append(item);
    return item;
  });
  placeholder();
  const timeWrap = element(document, 'div', undefined, 'wb-sched-field');
  timeWrap.append(element(document, 'span', t('wb.schedule.form.time'), 'wb-sched-label'), kind, time, previewLine, tzNote);
  root.append(timeWrap);
  const pair = element(document, 'div', undefined, 'wb-sched-pair');
  pair.append(field(document, t('wb.schedule.form.priority'),
    select(document, ['1', '2', '3'], value => `P${value} ${t('wb.schedule.priority.' + value)}`, state.priority, set('priority')),
    t('wb.schedule.form.priorityHint')));
  const misses = MISS_CHOICES.includes(String(state.missThreshold)) ? MISS_CHOICES
    : [...MISS_CHOICES, String(state.missThreshold)];
  pair.append(field(document, t('wb.schedule.form.missThreshold'),
    select(document, misses, value => MISS_KEYS[value] ? t('wb.schedule.miss.' + MISS_KEYS[value])
      : t('wb.schedule.miss.seconds', { n: value }), String(state.missThreshold), set('missThreshold')),
    t('wb.schedule.form.missHint')));
  root.append(pair);
  const idle = element(document, 'label', undefined, 'wb-sched-check');
  const idleText = element(document, 'span');
  idleText.append(element(document, 'span', t('wb.schedule.form.requireIdle')),
    element(document, 'small', t('wb.schedule.form.requireIdleHint'), 'wb-sched-hint'));
  idle.append(input(document, 'checkbox', state.requireIdle, set('requireIdle')), idleText);
  root.append(idle);
  root.append(element(document, 'p', t('wb.schedule.form.deliveryNote'), 'wb-sched-note'), message);
  save.type = 'submit';
  const cancel = element(document, 'button', t('wb.schedule.cancel'), 'wb-btn');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  root.addEventListener('submit', event => {
    event?.preventDefault?.();
    if (!save.disabled) onSave({ ...state });
  });
  const acts = element(document, 'div', undefined, 'wb-sched-form-acts');
  acts.append(save, cancel, element(document, 'small', t('wb.schedule.form.saveNote'), 'wb-sched-hint'));
  root.append(acts);
  sync();
  return {
    root,
    title,
    save,
    state: () => ({ ...state }),
    setPreview(value) {
      preview = value;
      sync();
    },
    setMessage(text) {
      message.textContent = text ?? '';
    },
    setBusy(value) {
      busy = value;
      sync();
    },
  };
}
