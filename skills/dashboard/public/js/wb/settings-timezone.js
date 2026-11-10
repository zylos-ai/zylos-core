import { element, icon } from './plain-text.js?v=106';
import { canonicalTimezoneName, timezoneOptions } from './timezone-names.js?v=2';
import { settingsCard } from './settings.js?v=116';

export function validTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || canonicalTimezoneName(value.trim()) !== value.trim()) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: value.trim() }); return true; } catch { return false; }
}

/** Instance-scoped settings: saving never restarts a service; restarting asks separately. */
export function mountTimezoneSettings(root, { document = root.ownerDocument, t = key => key,
  read, write, restart, confirm = async () => false, writable = () => true, available = () => true, identity = () => '', target = () => null,
  onSaved = () => {} } = {}) {
  const card = settingsCard(document, { icon: 'clock', title: t('wb.settings.timezone.title'), id: 'settings-timezone' });
  const label = element(document, 'label', t('wb.settings.timezone.label'), 'wb-fld-l');
  label.setAttribute('for', 'settings-timezone-value');
  const input = element(document, 'select', undefined, 'wb-input wb-select'); input.id = 'settings-timezone-value';
  const options = timezoneOptions(), selectable = new Set(options);
  function setValue(value) {
    const groups = new Map();
    for (const zone of options) {
      const region = zone.includes('/') ? zone.split('/')[0] : 'UTC';
      if (!groups.has(region)) { const group = element(document, 'optgroup'); group.label = region; groups.set(region, group); }
      const option = element(document, 'option', zone); option.value = zone; groups.get(region).append(option);
    }
    input.replaceChildren(...groups.values());
    if (!selectable.has(value)) {
      const original = element(document, 'option', value || '—'); original.value = value; original.disabled = true;
      input.prepend(original);
    }
    input.value = value;
  }
  const canSave = () => selectable.has(input.value) && validTimezone(input.value);
  input.setAttribute('aria-describedby', 'settings-timezone-help');
  const save = element(document, 'button', t('btn.save'), 'wb-btn wb-btn-primary'); save.id = 'settings-timezone-save'; save.type = 'button';
  const selectWrap = element(document, 'span', undefined, 'wb-select-wrap'); selectWrap.append(input, icon(document, 'chev', 'xs'));
  const row = element(document, 'div', undefined, 'wb-set-inline wb-timezone-controls'); row.append(selectWrap, save);
  const help = element(document, 'p', t('wb.settings.timezone.help'), 'wb-note'); help.id = 'settings-timezone-help';
  const policy = element(document, 'p', '', 'wb-note'); policy.id = 'settings-timezone-policy';
  const notice = element(document, 'p', '', 'wb-note'); notice.id = 'settings-timezone-result'; notice.setAttribute('role', 'status');
  const pending = element(document, 'div', undefined, 'wb-timezone-pending'); pending.id = 'settings-timezone-pending'; pending.hidden = true;
  const pendingTitle = element(document, 'p', t('wb.settings.timezone.restartNeeded'), 'wb-note');
  const list = element(document, 'ul'); list.id = 'settings-timezone-services';
  const discovery = element(document, 'p', '', 'wb-note');
  const restartButton = element(document, 'button', t('wb.settings.timezone.restart'), 'wb-btn'); restartButton.type = 'button'; restartButton.id = 'settings-timezone-restart';
  const retry = element(document, 'button', t('wb.settings.timezone.retry'), 'wb-btn'); retry.type = 'button'; retry.id = 'settings-timezone-retry';
  const pendingActions = element(document, 'div', undefined, 'wb-set-inline'); pendingActions.append(restartButton, retry);
  pending.append(pendingTitle, list, discovery, pendingActions);
  const notes = element(document, 'p', t('wb.settings.timezone.notes'), 'wb-note');
  card.card.append(label, row, help, policy, notice, pending, notes); root.append(card.card);
  let generation = 0, owner = null, loaded = false, busy = false, saved = false, model = null, restartAttempted = false;
  const current = (token, machine) => generation === token && owner === machine && identity() === machine;
  const editable = () => loaded && owner === identity() && model?.writable === true && writable() && available();
  const serviceName = name => ({ scheduler: t('wb.settings.timezone.scheduler'), 'web-console': t('wb.settings.timezone.webConsole'),
    'activity-monitor': t('wb.settings.timezone.activityMonitor'), 'c4-dispatcher': t('wb.settings.timezone.dispatcher') })[name] ?? name;
  const services = () => Array.isArray(model?.restart_services) ? model.restart_services : [];
  function render() {
    card.label.textContent = t('wb.settings.timezone.title'); label.textContent = t('wb.settings.timezone.label');
    help.textContent = t('wb.settings.timezone.help'); notes.textContent = t('wb.settings.timezone.notes');
    save.textContent = t('btn.save'); restartButton.textContent = t('wb.settings.timezone.restart'); retry.textContent = t('wb.settings.timezone.retry');
    input.disabled = busy || !editable();
    save.disabled = busy || !editable() || !canSave();
    policy.textContent = !loaded ? '' : !writable() ? t('wb.settings.timezone.readOnlyRemote')
      : !model.writable ? t('wb.settings.timezone.readOnly')
      : model.tz == null ? t('wb.settings.timezone.unknown') : '';
    pending.hidden = !saved;
    pendingTitle.textContent = t('wb.settings.timezone.restartNeeded');
    list.replaceChildren(...services().map(service => element(document, 'li', serviceName(service.name))));
    const known = model?.restart_status === 'known';
    discovery.textContent = t(!known ? 'wb.settings.timezone.discoveryUnknown' : services().length ? 'wb.settings.timezone.restartExplain' : 'wb.settings.timezone.noRestart');
    retry.hidden = known;
    retry.disabled = busy || !editable();
    restartButton.hidden = known && !services().length;
    restartButton.disabled = busy || !editable() || !known || !services().length || input.value.trim() !== model?.tz;
  }
  function errorText(error, fallback) {
    const keys = { invalid_timezone: 'invalid', timezone_changed: 'changed',
      forbidden: 'readOnlyRemote', timezone_unavailable_on_host: 'hostUnsupported',
      service_discovery_unavailable: 'discoveryUnknown', confirmation_required: 'confirmationRequired' };
    return t('wb.settings.timezone.' + (keys[error?.code || error?.message] ?? fallback));
  }
  function invalidate() {
    generation++; owner = null; loaded = false; busy = false; saved = false; model = null; restartAttempted = false;
    setValue(''); notice.textContent = ''; render();
  }
  async function refresh() {
    invalidate(); const token = generation, machine = owner = identity();
    busy = true; render();
    try {
      const value = await read();
      if (!current(token, machine)) return;
      if (!value || typeof value.writable !== 'boolean') throw Error('invalid_timezone_settings');
      model = value; loaded = true; setValue(value.tz ?? '');
    } catch (error) { if (current(token, machine)) notice.textContent = errorText(error, 'readFailed'); }
    finally { if (current(token, machine)) { busy = false; render(); } }
  }
  const confirmation = text => { const remote = target(); return remote ? `${text}\n${t('confirm.remote_target', { agent: remote })}` : text; };
  input.addEventListener('change', render);
  save.addEventListener('click', async () => {
    if (busy || !editable() || !canSave()) return;
    const tz = input.value.trim(), token = generation, machine = owner;
    busy = true; render();
    try {
      if (!(await confirm(confirmation(t('wb.settings.timezone.saveConfirm', { tz })), { danger: false }))) return;
      if (!current(token, machine) || !editable()) return;
      const value = await write({ tz });
      if (!current(token, machine)) return;
      model = value; restartAttempted = false; setValue(value.tz ?? tz); saved = true; notice.textContent = t('wb.settings.timezone.saved');
      onSaved(value.tz);
    } catch (error) { if (current(token, machine)) notice.textContent = errorText(error, 'saveFailed'); }
    finally { if (current(token, machine)) { busy = false; render(); } }
  });
  function applyRestartProgress(value) {
    restartAttempted = true;
    model = { ...model, restart_services: value.restart_services ?? model.restart_services, restart_status: value.restart_status ?? model.restart_status };
  }
  restartButton.addEventListener('click', async () => {
    if (restartButton.disabled || !saved || !editable()) return;
    const tz = model.tz, token = generation, machine = owner;
    const confirmedServices = services().map(service => service.name);
    busy = true; render();
    try {
      const body = t('wb.settings.timezone.restartConfirm', { tz, services: confirmedServices.map(serviceName).join('\n') });
      if (!(await confirm(confirmation(body)))) return;
      if (!current(token, machine) || !editable() || input.value.trim() !== tz) return;
      const value = await restart({ tz, confirm: true, services: confirmedServices });
      if (!current(token, machine)) return;
      applyRestartProgress(value);
      if (value.error) notice.textContent = errorText({ code: value.error }, 'restartError');
      else if (value.failed?.length) notice.textContent = t('wb.settings.timezone.restartFailed', { services: value.failed.map(service => serviceName(service.name)).join(', ') });
      else if (value.ok === false) notice.textContent = t('wb.settings.timezone.restartError');
      else { saved = false; notice.textContent = t('wb.settings.timezone.restarted'); }
    } catch (error) {
      if (current(token, machine)) {
        const progress = error?.result;
        if (Array.isArray(progress?.restarted) && Array.isArray(progress?.failed) && Array.isArray(progress?.restart_services)) applyRestartProgress(progress);
        notice.textContent = errorText(error, 'restartError');
      }
    }
    finally { if (current(token, machine)) { busy = false; render(); } }
  });
  retry.addEventListener('click', async () => {
    if (busy || !saved || !editable()) return;
    const token = generation, machine = owner;
    const pendingServices = restartAttempted ? new Set(services().map(service => service.name)) : null;
    busy = true; render();
    try {
      const value = await read();
      if (!current(token, machine)) return;
      if (value.tz !== model.tz) { saved = false; notice.textContent = t('wb.settings.timezone.changed'); }
      else if (pendingServices) value.restart_services = (value.restart_services ?? []).filter(service => pendingServices.has(service.name));
      model = value; setValue(value.tz ?? '');
    } catch (error) { if (current(token, machine)) notice.textContent = errorText(error, 'readFailed'); }
    finally { if (current(token, machine)) { busy = false; render(); } }
  });
  render();
  return { refresh, invalidate, refreshLocks: render };
}
