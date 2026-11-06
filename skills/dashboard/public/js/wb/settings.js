import { element } from './plain-text.js?v=85';

export const settingsSections = ['defaults', 'pricing', 'keys', 'observer', 'fleet', 'ui'];
// Both views: reuse the actual control nodes so their original listeners survive.
export function composeSettings(root, { settings, fleet, actions, controls = [], document = root.ownerDocument, t = key => key }) {
  root.replaceChildren();
  const layout = element(document, 'div'); layout.style.display = 'flex'; layout.style.flexWrap = 'wrap'; layout.style.gap = '20px';
  const nav = element(document, 'nav'); nav.setAttribute('aria-label', t('wb.settings'));
  nav.style.display = 'flex'; nav.style.flexWrap = 'wrap'; nav.style.alignContent = 'start'; nav.style.gap = '8px';
  const body = element(document, 'div'); body.style.flex = '1 1 360px'; body.style.minWidth = '0'; body.style.maxHeight = 'none';
  const sections = {}, buttons = {};
  for (const name of settingsSections) {
    const section = element(document, 'section', undefined, 'wb-card'); section.id = 'settings-section-' + name;
    section.append(element(document, 'h2', t('wb.settings.section.' + name))); sections[name] = section; body.append(section);
    const button = element(document, 'button', t('wb.settings.section.' + name), 'action-btn'); button.type = 'button'; button.dataset.settingsSection = name;
    button.addEventListener('click', () => select(name)); nav.append(button); buttons[name] = button;
  }
  const move = (source, selector, destination) => { const node = source.querySelector(selector); if (node) destination.append(node); return node; };
  for (const selector of ['#settings-model-pricing-group', '#settings-priority-pricing-group', '#settings-fast-mode-group', '#settings-readonly-note', '#settings-status', '.settings-footer']) move(settings, selector, sections.pricing);
  move(settings, '#observer-settings-group', sections.observer);
  for (const [panel, name] of [['fleet', 'fleet'], ['keys', 'keys']]) { const node = move(fleet, `.manage-panel[data-panel="${panel}"]`, sections[name]); if (node) node.hidden = false; }
  move(fleet, '#fleet-manage-status', root);
  const actionsScope = root;
  const actionBody = element(document, 'div', undefined, 'modal-body'); sections.defaults.append(actionBody);
  // Keep mode/threshold listeners attached to their generated controls.
  for (const selector of ['#action-mode', '#action-threshold']) {
    const control = actions.querySelector(selector); if (control) actionBody.append(control.closest('.action-field'));
  }
  for (const selector of ['#action-mode-status', '#action-instance-status', '#action-restart-status']) move(actions, selector, actionBody);
  move(actions, '[data-action="upgrade-cc"]', sections.ui);
  for (const node of controls) if (node) sections.ui.append(node);
  layout.append(nav, body); root.append(layout);
  for (const selector of ['#action-status', '#action-confirm']) move(actions, selector, actionsScope);
  function select(name) {
    if (!sections[name]) name = 'defaults';
    for (const key of settingsSections) { sections[key].hidden = key !== name; buttons[key].setAttribute('aria-current', String(key === name)); }
  }
  function detail(level) { const hidden = level !== 'technical'; buttons.observer.hidden = hidden; if (hidden && !sections.observer.hidden) select('defaults'); }
  function relabel() {
    nav.setAttribute('aria-label', t('wb.settings'));
    for (const name of settingsSections) {
      const label = t('wb.settings.section.' + name);
      sections[name].querySelector('h2').textContent = label;
      buttons[name].textContent = label;
    }
  }
  select('defaults'); detail(document.documentElement?.dataset.detail);
  return { sections, select, detail, relabel, actionsScope };
}

// One snapshot and one first batch per open; search owns subsequent user requests.
export function createSettingsLoader({ read, onLoad }) {
  let generation = 0;
  return {
    async open() {
      const current = ++generation;
      const paths = ['/api/workbench/groups', '/api/workbench/runtime-overrides', '/api/settings?all=1', '/api/workbench/pricing', '/api/actions/meta?runtime=claude', '/api/actions/meta?runtime=codex'];
      const values = await Promise.allSettled(paths.map(path => read(path)));
      if (current !== generation) return;
      const value = index => values[index].status === 'fulfilled' ? values[index].value : null;
      onLoad({ snapshot: value(0), page: value(1), prices: value(2), usage: value(3), metadata: { claude: value(4), codex: value(5) } });
    },
    invalidate() { generation++; },
  };
}

export function resetSettingsDrafts(root) {
  for (const selector of ['#settings-defaults', '#settings-price-rows', '#settings-priority-price-rows']) root.querySelector(selector)?.replaceChildren();
  for (const node of root.querySelectorAll('#settings-save, #settings-add-model, #settings-add-priority-model, #settings-fast-multiplier, #action-mode, #action-threshold, #action-threshold-apply')) node.disabled = true;
  const status = root.querySelector('#settings-status'); if (status) { status.hidden = true; status.textContent = ''; }
}
