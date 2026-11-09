import { element, icon } from './plain-text.js?v=105';
import { createSettingsDrawer } from './settings-drawer.js?v=104';

export const settingsSections = ['defaults', 'pricing', 'keys', 'fleet', 'observer', 'ui'];
const sectionIcons = { defaults: 'bot', pricing: 'dollar', keys: 'key', fleet: 'fleet', observer: 'term', ui: 'sliders' };
// Interface rows, top to bottom; each holds one control and an optional grey note.
export const prefRows = ['detail', 'lang', 'theme', 'sound', 'connection', 'version', 'account'];
const prefControls = { '#wb-detail-toggle': 'detail', '#fleet-sound-toggle': 'sound', '#connection-status': 'connection', '#logout-btn': 'account' };
const prefNotes = new Set(['detail', 'sound']);

/** A settings card: icon + title, an optional grey subtitle and a right-aligned action slot. */
export function settingsCard(document, { icon: name, title = '', sub = '', id } = {}) {
  const card = element(document, 'div', undefined, 'wb-set-card');
  if (id) card.id = id;
  const head = element(document, 'div', undefined, 'wb-set-card-h');
  const heading = element(document, 'h4');
  if (name) heading.append(icon(document, name, 'xs'));
  const label = element(document, 'span', title); heading.append(label);
  const subtitle = element(document, 'span', sub, 'wb-set-card-sub'); subtitle.hidden = !sub;
  const acts = element(document, 'span', undefined, 'wb-set-card-acts');
  head.append(heading, subtitle, acts); card.append(head);
  return { card, head, label, sub: subtitle, acts };
}

// Both views: reuse the actual control nodes so their original listeners survive.
export function composeSettings(root, { settings, fleet, actions, controls = [], document = root.ownerDocument, t = key => key }) {
  root.replaceChildren();
  const layout = element(document, 'div', undefined, 'wb-set');
  const nav = element(document, 'nav', undefined, 'wb-set-nav'); nav.setAttribute('aria-label', t('wb.settings')); nav.id = 'settings-nav';
  // Phones: the section list is a drawer with its own title and close button, opened from a button naming the current section.
  const drawerHead = element(document, 'div', undefined, 'wb-set-drawer-h');
  const drawerTitle = element(document, 'b', t('wb.settings.sections'));
  const drawerClose = element(document, 'button', undefined, 'wb-icon-btn wb-set-drawer-x'); drawerClose.type = 'button';
  drawerClose.setAttribute('aria-label', t('wb.settings.sectionsClose')); drawerClose.append(icon(document, 'x'));
  drawerHead.append(drawerTitle, drawerClose); nav.append(drawerHead);
  const scrim = element(document, 'div', undefined, 'wb-set-scrim'); scrim.setAttribute('aria-hidden', 'true');
  const body = element(document, 'div', undefined, 'wb-set-body');
  const toggle = element(document, 'button', undefined, 'wb-set-drawer-btn'); toggle.type = 'button';
  toggle.setAttribute('aria-haspopup', 'true'); toggle.setAttribute('aria-controls', 'settings-nav'); toggle.setAttribute('aria-expanded', 'false');
  const toggleCurrent = element(document, 'span', undefined, 'wb-set-drawer-cur');
  toggle.append(icon(document, 'menu'), toggleCurrent, icon(document, 'chev', 'xs')); body.append(toggle);
  const wrap = element(document, 'div', undefined, 'wb-set-wrap'); body.append(wrap);
  const status = element(document, 'div', undefined, 'wb-set-status'); wrap.append(status);
  const sections = {}, buttons = {}, labels = {}, badges = {}, relabels = [];
  for (const name of settingsSections) {
    const section = element(document, 'section', undefined, 'wb-set-sec'); section.id = 'settings-section-' + name;
    const heading = element(document, 'h2', t('wb.settings.section.' + name), 'wb-set-h');
    const lead = element(document, 'p', t('wb.settings.lead.' + name), 'wb-set-lead');
    section.append(heading, lead); sections[name] = section; wrap.append(section);
    relabels.push(() => { heading.textContent = t('wb.settings.section.' + name); lead.textContent = t('wb.settings.lead.' + name); });
    const button = element(document, 'button', undefined, 'wb-set-nav-btn'); button.type = 'button'; button.dataset.settingsSection = name;
    const label = element(document, 'span', t('wb.settings.section.' + name)); labels[name] = label;
    const badge = element(document, 'span', '', 'wb-set-nav-n'); badge.hidden = true; badges[name] = badge;
    button.append(icon(document, sectionIcons[name]), label, badge);
    button.addEventListener('click', () => { select(name); drawer.close(); }); nav.append(button); buttons[name] = button;
  }
  const move = (source, selector, destination) => { const node = source.querySelector(selector); if (node) destination.append(node); return node; };

  const defaults = element(document, 'div'); defaults.id = 'settings-defaults'; sections.defaults.append(defaults);
  const session = settingsCard(document, { icon: 'restart', title: t('wb.settings.session.title'), sub: t('wb.settings.session.sub') });
  relabels.push(() => { session.label.textContent = t('wb.settings.session.title'); session.sub.textContent = t('wb.settings.session.sub'); });
  const actionBody = element(document, 'div', undefined, 'modal-body wb-set-fields'); session.card.append(actionBody); sections.defaults.append(session.card);
  // Keep mode listeners attached to their generated controls.
  for (const selector of ['#action-mode']) {
    const control = actions.querySelector(selector); if (control) actionBody.append(control.closest('.action-field'));
  }
  for (const selector of ['#action-mode-status', '#action-instance-status', '#action-restart-status']) move(actions, selector, actionBody);
  const idleReclaim = element(document, 'div'); idleReclaim.id = 'settings-idle-reclaim'; actionBody.append(idleReclaim);

  const pricingTop = element(document, 'div', undefined, 'wb-set-pricing-top'); pricingTop.id = 'settings-pricing-top'; sections.pricing.append(pricingTop);
  for (const selector of ['#settings-model-pricing-group', '#settings-priority-pricing-group', '#settings-fast-mode-group', '#settings-readonly-note', '#settings-status', '.settings-footer']) move(settings, selector, sections.pricing);
  for (const name of ['keys', 'fleet']) { const node = move(fleet, `.manage-panel[data-panel="${name}"]`, sections[name]); if (node) node.hidden = false; }
  move(settings, '#observer-settings-group', sections.observer);
  move(fleet, '#fleet-manage-status', status);
  for (const selector of ['#action-status']) move(actions, selector, status);

  const prefsCard = settingsCard(document); prefsCard.head.hidden = true;
  const prefs = {}, prefLabels = {};
  for (const name of prefRows) {
    const row = element(document, 'div', undefined, 'wb-pref'); row.dataset.pref = name;
    const label = element(document, 'span', t('wb.settings.pref.' + name), 'wb-pref-l'); prefLabels[name] = label;
    const cell = element(document, 'div', undefined, 'wb-pref-c');
    row.append(label, cell); prefsCard.card.append(row); prefs[name] = cell;
  }
  const notes = {};
  for (const node of controls) {
    if (!node) continue;
    const name = Object.entries(prefControls).find(([selector]) => node.matches?.(selector) || node.querySelector?.(selector))?.[1];
    const cell = prefs[name] ?? prefs.account; cell.append(node);
    if (prefNotes.has(name)) { notes[name] = element(document, 'small', t('wb.settings.pref.' + name + 'Note'), 'wb-pref-note'); cell.append(notes[name]); }
  }
  const upgrade = actions.querySelector('[data-action="upgrade-cc"]'); if (upgrade) prefs.version.append(upgrade);
  sections.ui.append(prefsCard.card);
  relabels.push(() => {
    for (const name of prefRows) prefLabels[name].textContent = t('wb.settings.pref.' + name);
    for (const [name, note] of Object.entries(notes)) note.textContent = t('wb.settings.pref.' + name + 'Note');
  });

  layout.append(nav, scrim, body); root.append(layout);
  const drawer = createSettingsDrawer({ layout, nav, toggle, closeButton: drawerClose, scrim, window: document.defaultView });
  let current = null;
  function showCurrent() { if (!current) return; toggleCurrent.replaceChildren(icon(document, sectionIcons[current]), element(document, 'span', t('wb.settings.section.' + current))); }
  function select(name) {
    if (!sections[name] || buttons[name].hidden) name = 'defaults';
    // A finished key or machine notice belongs to the section it came from; one still running stays visible.
    const notice = status.querySelector('#fleet-manage-status');
    if (current && name !== current && notice && !/\bwb-status-running\b/.test(notice.className)) { notice.textContent = ''; notice.hidden = true; }
    current = name;
    for (const key of settingsSections) { sections[key].hidden = key !== name; buttons[key].setAttribute('aria-current', String(key === name)); }
    showCurrent();
  }
  function detail(level) { const hidden = level !== 'technical'; buttons.observer.hidden = hidden; if (hidden && !sections.observer.hidden) select('defaults'); }
  function relabel() {
    nav.setAttribute('aria-label', t('wb.settings'));
    drawerTitle.textContent = t('wb.settings.sections'); drawerClose.setAttribute('aria-label', t('wb.settings.sectionsClose'));
    for (const name of settingsSections) labels[name].textContent = t('wb.settings.section.' + name);
    showCurrent();
    for (const fn of relabels) fn();
  }
  /** Unsaved-change count on a navigation item; zero hides it. */
  function badge(name, count) { badges[name].textContent = count ? String(count) : ''; badges[name].hidden = !count; badges[name].title = count ? t('wb.settings.unsaved') : ''; }
  select('defaults'); detail(document.documentElement?.dataset.detail);
  return { sections, prefs, select, detail, relabel, badge, drawer, actionsScope: root };
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
  for (const selector of ['#settings-defaults', '#settings-idle-reclaim', '#settings-price-rows', '#settings-priority-price-rows']) root.querySelector(selector)?.replaceChildren();
  for (const node of root.querySelectorAll('#settings-save, #settings-add-model, #settings-add-priority-model, #settings-fast-multiplier, #action-mode')) node.disabled = true;
  const status = root.querySelector('#settings-status'); if (status) { status.hidden = true; status.textContent = ''; }
}
