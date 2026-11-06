import { element } from './plain-text.js?v=82';
import { createFetchGuard } from './fetch-guard.js?v=82';

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

function field(document, label, control) {
  const wrap = element(document, 'label', undefined, 'wb-sched-field');
  wrap.append(element(document, 'span', label), control);
  return wrap;
}

function input(document, type, value, onInput) {
  const node = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') node.type = type;
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
  for (const value of values) {
    const option = element(document, 'option', label(value));
    option.value = value;
    node.append(option);
  }
  node.value = current;
  node.addEventListener('change', () => onSelect(node.value));
  return node;
}

/**
 * Builds the form once; typing updates state in place so inputs keep focus.
 * `onChange(state)` lets the caller request a preview for the new schedule.
 */
export function createForm(document, { state: initial, t = key => key, creating = false, reenable = false,
  tzLabel = '', formatTime = String, onChange = () => {}, onSave = () => {}, onCancel = () => {} }) {
  const state = { ...initial };
  let preview = null, busy = false;
  const root = element(document, 'form', undefined, 'wb-sched-form');
  const title = creating ? 'wb.schedule.form.new' : reenable ? 'wb.schedule.reenable' : 'wb.schedule.form.edit';
  root.append(element(document, 'h3', t(title)));
  const save = element(document, 'button', t('wb.schedule.save'), 'wb-sched-save');
  const previewLine = element(document, 'p', '', 'wb-sched-preview');
  const message = element(document, 'p', '', 'wb-sched-message');
  const sync = () => {
    save.disabled = busy || !saveAllowed(state, preview, { creating, reenable });
    previewLine.textContent = previewText(preview, { t, formatTime });
    previewLine.className = 'wb-sched-preview' + (preview?.valid === false ? ' wb-sched-invalid' : '');
  };
  const set = (key, scheduleChanged = false) => value => {
    state[key] = value;
    if (scheduleChanged) preview = null;
    sync();
    onChange({ ...state }, scheduleChanged);
  };
  root.append(field(document, t('wb.schedule.form.name'), input(document, 'text', state.name, set('name'))));
  root.append(field(document, t('wb.schedule.form.prompt'), input(document, 'textarea', state.prompt, set('prompt'))));
  const time = input(document, state.kind === 'at' ? 'datetime-local' : 'text', state.value, set('value', true));
  time.required = creating || reenable;
  const timeLabel = element(document, 'span', '');
  const labelTime = () => {
    timeLabel.textContent = t('wb.schedule.form.time') + (state.kind === 'at' ? ' · ' + tzLabel : '');
  };
  const kind = select(document, ['cron', 'every', 'at'], value => t('wb.schedule.kind.' + value), state.kind, value => {
    state.kind = value;
    state.value = '';
    time.type = value === 'at' ? 'datetime-local' : 'text';
    time.value = '';
    labelTime();
    set('value', true)('');
  });
  kind.disabled = reenable;
  root.append(field(document, t('wb.schedule.form.kind'), kind));
  labelTime();
  const timeWrap = element(document, 'label', undefined, 'wb-sched-field');
  timeWrap.append(timeLabel, time);
  root.append(timeWrap, previewLine);
  root.append(field(document, t('wb.schedule.form.priority'),
    select(document, ['1', '2', '3'], value => t('wb.schedule.priority.' + value), state.priority, set('priority'))));
  root.append(field(document, t('wb.schedule.form.missThreshold'),
    input(document, 'number', state.missThreshold, set('missThreshold'))));
  root.append(field(document, t('wb.schedule.form.requireIdle'),
    input(document, 'checkbox', state.requireIdle, set('requireIdle'))));
  root.append(element(document, 'p', t('wb.schedule.form.deliveryNote'), 'wb-sched-note'), message);
  save.type = 'submit';
  const cancel = element(document, 'button', t('wb.schedule.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  root.addEventListener('submit', event => {
    event?.preventDefault?.();
    if (!save.disabled) onSave({ ...state });
  });
  root.append(save, cancel);
  sync();
  return {
    root,
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
