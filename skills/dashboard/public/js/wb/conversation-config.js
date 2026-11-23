import { SUPPORTED_RUNTIMES } from '../../runtime-descriptors.js';
import { createGroupDetail } from './detail.js';
import { configText } from './detail-overview.js';
import { reconcileChildren } from './detail-update.js';
import { fetchJson, renderGroupConfig } from './group-config.js';
import { element, icon } from './plain-text.js';
import { runtimeNotFound } from './settings-defaults.js';

export function createConversationConfig({ document, t, request, identity, writable, detail, onConfigSaved }) {
  const anchor = element(document, 'div', undefined, 'conversation-config-anchor');
  const button = element(document, 'button', undefined, 'wb-btn conversation-config-button');
  const summary = element(document, 'span', '', 'conversation-config-summary');
  const scrim = element(document, 'div', undefined, 'conversation-config-scrim');
  const panel = element(document, 'div', undefined, 'conversation-config-panel');
  const grab = element(document, 'div', undefined, 'conversation-config-grab');
  const title = element(document, 'h3', '', 'conversation-config-title');
  const editor = element(document, 'div');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', 'conversation-config-panel');
  button.setAttribute('aria-expanded', 'false');
  button.append(summary, icon(document, 'chev', 'xs'));
  panel.id = 'conversation-config-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'conversation-config-title');
  title.id = 'conversation-config-title';
  grab.setAttribute('aria-hidden', 'true');
  panel.tabIndex = -1;
  panel.append(grab, title, editor);
  anchor.append(button, scrim, panel);
  anchor.hidden = panel.hidden = scrim.hidden = true;
  const phone = document.defaultView?.matchMedia?.('(max-width: 760px)');
  let key = null, owner, current, instance, confirming = false, opening = 0;
  let recheckError = null;
  const controller = createGroupDetail({
    root: panel, document, t, fetch: request, identity, writable, onConfigSaved,
    configView(value) { current = value; draw(); },
  });

  function draw() {
    if (!current) return;
    const { row, config, revision, save } = current;
    const label = t('wb.detail.config');
    const text = configText(row, detail(), t);
    summary.textContent = text;
    button.title = text;
    button.setAttribute('aria-label', label + ' · ' + text);
    title.textContent = t('chat.page.aiConfiguration');
    if (panel.hidden) return;
    if (phone?.matches) panel.setAttribute('aria-modal', 'true');
    else panel.removeAttribute('aria-modal');
    const controls = 'select, input, button';
    const focused = [...editor.querySelectorAll(controls)].indexOf(document.activeElement);
    const desired = element(document, 'div');
    const defaultRuntime = instance?.default_runtime;
    const notFound = SUPPORTED_RUNTIMES.filter(id => runtimeNotFound({ instance }, id));
    renderGroupConfig(desired, config, {
      document, t, writable: writable(), defaultRuntime, notFound, rotationThreshold: row.rotationThreshold,
      async onRecheck() {
        const selected = opening;
        try {
          await fetchJson(request, '/api/instance/actions/recheck-runtime-cli', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          if (selected !== opening) return;
          const updated = await fetchJson(request, '/api/instance');
          if (selected !== opening) return;
          instance = updated;
          if (config.state.error === recheckError) config.state.error = null;
          recheckError = null;
        } catch (error) {
          if (selected !== opening || error.name === 'AbortError') return;
          recheckError = config.state.error = t('status.failed', { error: error.message });
        }
        // The detail controller publishes a revision so a still-blocked form gets a fresh button.
        config.redraw();
      },
      async onSave(changes) {
        if (confirming || !writable()) return;
        confirming = true;
        const selected = opening;
        try {
          // Read the current run before passing the edits to group detail's save handler.
          await controller.reloadConfig(false);
          if (selected === opening) await save(changes);
        } finally {
          if (selected === opening) { confirming = false; draw(); }
        }
      },
      onCancel: () => close(),
    });
    desired.firstElementChild.dataset.updateKey = [revision, writable(), defaultRuntime, row.rotationThreshold, notFound,
      document.documentElement.lang].join(':');
    reconcileChildren(editor, desired);
    if (focused >= 0 && !panel.contains(document.activeElement)) {
      const replacement = editor.querySelectorAll(controls)[focused];
      (replacement?.disabled ? panel : replacement ?? panel).focus({ preventScroll: true });
    }
  }

  function close({ focus = true, force = false } = {}) {
    if (panel.hidden) return;
    if (!force && (confirming || current?.config.state.busy)) return;
    opening++;
    confirming = false;
    panel.hidden = scrim.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (current) current.config.state.draft = {};
    editor.replaceChildren();
    if (focus) button.focus({ preventScroll: true });
  }
  button.addEventListener('pointerdown', event => {
    // On touch browsers the composer can collapse before the ensuing click.
    if (event.button === 0) event.preventDefault();
  });
  button.addEventListener('click', async () => {
    if (!panel.hidden) { close(); return; }
    if (!current) return;
    panel.hidden = scrim.hidden = false;
    const selected = ++opening;
    button.setAttribute('aria-expanded', 'true');
    draw();
    panel.focus({ preventScroll: true });
    const [result] = await Promise.allSettled([
      fetchJson(request, '/api/instance'), controller.reloadConfig(true),
    ]);
    if (selected !== opening || result.status !== 'fulfilled') return;
    instance = result.value;
    draw();
  });
  function outside(event) {
    if (panel.hidden || event.target.closest?.('.wb-modal-bg')) return;
    if (event.target === scrim || !anchor.contains(event.target)) close({ focus: event.target === scrim });
  }
  function keydown(event) {
    if (panel.hidden || event.defaultPrevented || event.target.closest?.('.wb-modal-bg')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key !== 'Tab' || !phone?.matches) return;
    const controls = [...panel.querySelectorAll('select:enabled, input:enabled, button:enabled')];
    const first = controls[0], last = controls.at(-1);
    if (!controls.includes(document.activeElement) || document.activeElement === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    }
  }
  document.addEventListener('click', outside);
  document.addEventListener('keydown', keydown, true);
  phone?.addEventListener('change', draw);
  return {
    anchor,
    update(nextKey) {
      const nextOwner = identity();
      if (nextKey === key && nextOwner === owner) return;
      close({ focus: false, force: true });
      controller.close();
      current = null;
      instance = undefined;
      recheckError = null;
      key = nextKey;
      owner = nextOwner;
      anchor.hidden = !key;
      if (key) void controller.open(key);
    },
    reload(sessionGroup) {
      if (key !== sessionGroup) return;
      void controller.reloadConfig(!panel.hidden || current?.config.state.value != null);
    },
    close: () => close({ focus: false, force: true }),
    redraw: draw,
    destroy() {
      close({ focus: false, force: true });
      controller.destroy();
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', keydown, true);
      phone?.removeEventListener('change', draw);
    },
  };
}
