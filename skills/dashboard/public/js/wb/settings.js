import { readGroupSnapshot } from './group-data.js';
import { element, icon } from './plain-text.js';
import { createSettingsNavigation } from './settings-navigation.js';

// Grouped by who a setting affects: who may enter this machine, this browser only, the whole machine, other
// machines, the defaults for groups without their own choice, and model prices.
export const settingsSections = ['account', 'general', 'machine', 'fleet', 'defaults', 'pricing'];
const sectionIcons = { account: 'user', general: 'sliders', machine: 'cpu', fleet: 'fleet', defaults: 'bot', pricing: 'dollar' };
// This browser's rows, top to bottom; each holds one control and an optional grey note.
export const prefRows = ['detail', 'lang', 'theme', 'sound'];
// The page's own controls these rows and the account card take over.
const controlSelectors = { detail: '#wb-detail-toggle', sound: '#fleet-sound-toggle', logout: '#logout-btn' };
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
  const body = element(document, 'div', undefined, 'wb-set-body');
  const wrap = element(document, 'div', undefined, 'wb-set-wrap'); body.append(wrap);
  const status = element(document, 'div', undefined, 'wb-set-status'); wrap.append(status);
  const sections = {}, buttons = {}, backButtons = {}, badges = {}, relabels = [];
  for (const name of settingsSections) {
    const section = element(document, 'section', undefined, 'wb-set-sec'); section.id = 'settings-section-' + name;
    const header = element(document, 'div', undefined, 'wb-set-section-head');
    const back = element(document, 'button', undefined, 'wb-icon-btn wb-set-back'); back.type = 'button';
    back.setAttribute('aria-label', t('wb.settings.backToSections'));
    back.append(icon(document, 'back', 'xs'));
    back.addEventListener('click', () => navigation.backToList());
    backButtons[name] = back;
    const heading = element(document, 'h2', t('wb.settings.section.' + name), 'wb-set-h');
    header.append(back, heading);
    const lead = element(document, 'p', t('wb.settings.lead.' + name), 'wb-set-lead');
    section.append(header, lead); sections[name] = section; wrap.append(section);
    const button = element(document, 'button', undefined, 'wb-set-nav-btn'); button.type = 'button'; button.dataset.settingsSection = name;
    const copy = element(document, 'span', undefined, 'wb-set-nav-copy');
    const label = element(document, 'span', t('wb.settings.section.' + name));
    const description = element(document, 'span', t('wb.settings.summary.' + name), 'wb-set-nav-summary');
    copy.append(label, description);
    const badge = element(document, 'span', '', 'wb-set-nav-n'); badge.hidden = true; badges[name] = badge;
    button.append(icon(document, sectionIcons[name]), copy, badge, icon(document, 'chev', 'xs'));
    button.addEventListener('click', () => navigation.pick(name)); nav.append(button); buttons[name] = button;
    relabels.push(() => {
      heading.textContent = label.textContent = t('wb.settings.section.' + name);
      lead.textContent = t('wb.settings.lead.' + name);
      description.textContent = t('wb.settings.summary.' + name);
      back.setAttribute('aria-label', t('wb.settings.backToSections'));
    });
  }
  const move = (source, selector, destination) => { const node = source.querySelector(selector); if (node) destination.append(node); return node; };

  const card = (name, options) => {
    const made = settingsCard(document, { icon: options.icon, title: t(options.title), sub: options.sub ? t(options.sub) : '', id: name });
    relabels.push(() => { made.label.textContent = t(options.title); if (options.sub) made.sub.textContent = t(options.sub); });
    return made;
  };
  const note = (key, className = 'wb-note') => { const text = element(document, 'p', t(key), className); relabels.push(() => { text.textContent = t(key); }); return text; };
  const slot = id => { const node = element(document, 'div'); node.id = id; return node; };
  const control = name => controls.find(node => node?.matches?.(controlSelectors[name]) || node?.querySelector?.(controlSelectors[name]));

  // Account: signing out of this browser, whether other machines may open the conversations, and the keys.
  const login = card('settings-login', { icon: 'power', title: 'wb.settings.login.title' });
  const logout = control('logout'); if (logout) login.card.append(logout);
  login.card.append(note('wb.settings.login.note'));
  const chat = slot('settings-account-chat');
  sections.account.append(login.card, chat);
  move(fleet, '.manage-panel[data-panel="keys"]', sections.account)?.removeAttribute('hidden');

  // This browser.
  const prefsCard = settingsCard(document); prefsCard.head.hidden = true;
  const prefs = {}, prefLabels = {};
  for (const name of prefRows) {
    const row = element(document, 'div', undefined, 'wb-pref'); row.dataset.pref = name;
    const label = element(document, 'span', t('wb.settings.pref.' + name), 'wb-pref-l'); prefLabels[name] = label;
    const cell = element(document, 'div', undefined, 'wb-pref-c');
    row.append(label, cell); prefsCard.card.append(row); prefs[name] = cell;
  }
  const notes = {};
  for (const name of ['detail', 'sound']) {
    const node = control(name); if (!node) continue;
    prefs[name].append(node);
    if (prefNotes.has(name)) { notes[name] = element(document, 'small', t('wb.settings.pref.' + name + 'Note'), 'wb-pref-note'); prefs[name].append(notes[name]); }
  }
  sections.general.append(prefsCard.card);
  relabels.push(() => {
    for (const name of prefRows) prefLabels[name].textContent = t('wb.settings.pref.' + name);
    for (const [name, text] of Object.entries(notes)) text.textContent = t('wb.settings.pref.' + name + 'Note');
  });

  // The whole machine: zylos version, time zone, terminal observer, session mode, then the session hosts.
  const version = card('settings-zylos-version', { icon: 'layers', title: 'wb.settings.version.title' });
  const versionBody = slot('settings-version'); version.card.append(versionBody);
  const timezone = slot('settings-machine-timezone');
  const observer = settings.querySelector('#observer-settings-group');
  const session = card('settings-session-mode', { icon: 'restart', title: 'wb.settings.session.title', sub: 'wb.settings.session.sub' });
  const actionBody = element(document, 'div', undefined, 'modal-body wb-set-fields'); session.card.append(actionBody);
  // Keep mode listeners attached to their generated controls.
  for (const selector of ['#action-mode']) {
    const field = actions.querySelector(selector); if (field) actionBody.append(field.closest('.action-field'));
  }
  // What the two modes mean, in plain words.
  const modes = element(document, 'p', undefined, 'wb-note wb-mode-note');
  const modeText = () => modes.replaceChildren(...['multi', 'single'].flatMap((mode, index) => [
    ...(index ? [element(document, 'span', ' ')] : []), element(document, 'b', t('wb.settings.session.' + mode)), element(document, 'span', t('wb.settings.session.' + mode + 'Note'))]));
  modeText(); relabels.push(modeText); actionBody.append(modes);
  for (const selector of ['#action-mode-status', '#action-instance-status', '#action-restart-status']) move(actions, selector, actionBody);
  const idleReclaim = slot('settings-idle-reclaim'); actionBody.append(idleReclaim);
  const hosts = slot('settings-machine-hosts');
  sections.machine.append(version.card, timezone, ...(observer ? [observer] : []), session.card, hosts);

  // Other machines: this machine's name and address, and the machines added here.
  const fleetPanel = move(fleet, '.manage-panel[data-panel="fleet"]', sections.fleet);
  // The address other machines use to add this one moves here from the keys panel, under this machine's name.
  if (fleetPanel) { fleetPanel.hidden = false; const address = sections.account.querySelector('#settings-address-card'); if (address) fleetPanel.children[0]?.after(address); }

  // AI defaults and prices.
  const defaults = slot('settings-defaults'); sections.defaults.append(defaults);
  const pricingTop = element(document, 'div', undefined, 'wb-set-pricing-top'); pricingTop.id = 'settings-pricing-top'; sections.pricing.append(pricingTop);
  for (const selector of ['#settings-model-pricing-group', '#settings-priority-pricing-group', '#settings-fast-mode-group', '#settings-readonly-note', '#settings-status', '.settings-footer']) move(settings, selector, sections.pricing);
  move(fleet, '#fleet-manage-status', status);
  for (const selector of ['#action-status']) move(actions, selector, status);

  layout.append(nav, body); root.append(layout);
  let current = null;
  function select(name, { focus = false } = {}) {
    if (name !== null && (!sections[name] || buttons[name].hidden)) name = 'account';
    // Clear finished key or machine notices when leaving the section that displayed them.
    const notice = layout.querySelector('#fleet-manage-status');
    if (current && name !== current && notice && !/\bwb-status-running\b/.test(notice.className)) { notice.textContent = ''; notice.hidden = true; }
    current = name;
    layout.classList.toggle('wb-set-list', name === null);
    for (const key of settingsSections) { sections[key].hidden = key !== name; buttons[key].setAttribute('aria-current', String(key === name)); }
    if (focus) {
      document.defaultView.scrollTo(0, 0);
      backButtons[name]?.focus({ preventScroll: true });
    }
  }
  function showList({ focus = false } = {}) {
    const previous = current;
    select(null, { focus });
    if (focus) buttons[previous]?.focus({ preventScroll: true });
  }
  function relabel() {
    nav.setAttribute('aria-label', t('wb.settings'));
    for (const fn of relabels) fn();
  }
  /** Unsaved-change count on a navigation item; zero hides it. */
  function badge(name, count) { badges[name].textContent = count ? String(count) : ''; badges[name].hidden = !count; badges[name].title = count ? t('wb.settings.unsaved') : ''; }
  const navigation = createSettingsNavigation({ layout, select, showList });
  select('account');
  return { sections, prefs, slots: { chat, version: versionBody, timezone, idleReclaim, hosts }, select, relabel, badge, navigation, actionsScope: root };
}

// The compact list supplies live groups. Detail distinguishes inherited settings from overrides.
export async function readSettingsGroupSnapshot(read) {
  const snapshot = await readGroupSnapshot(read);
  const details = await Promise.allSettled(snapshot.rows.map(row => read('/api/groups/' + encodeURIComponent(row.sessionGroup) + '?include=')));
  if (details.some(result => result.status === 'rejected')) return { ...snapshot, overrides: null };
  const rows = details.map(result => result.value);
  const overrides = rows.some(row => row.runtimeOverridden === null) ? null
    : { runtime: rows.filter(row => row.runtimeOverridden === true), model: rows.filter(row => row.modelOverridden === true) };
  return { ...snapshot, rows, overrides };
}

// One snapshot and one first batch per open; search owns subsequent user requests.
export function createSettingsLoader({ read, onLoad }) {
  let generation = 0;
  return {
    async open() {
      const current = ++generation;
      const paths = [null, '/api/groups/runtime-overrides', '/api/settings/pricing', '/api/usage/pricing', '/api/instance/runtime-options?runtime=claude', '/api/instance/runtime-options?runtime=codex'];
      const values = await Promise.allSettled(paths.map(path => path === null ? readSettingsGroupSnapshot(read) : read(path)));
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
  root.querySelector('#settings-zylos-copied')?.remove();
}
