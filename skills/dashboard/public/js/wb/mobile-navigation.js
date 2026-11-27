import { element, icon } from './plain-text.js';

const PAGE_TITLES = {
  fleet: 'wb.fleet.title',
  overview: 'wb.nav.overview',
  chat: 'chat.title',
  trends: 'wb.nav.usage',
  schedule: 'wb.nav.schedule',
  memory: 'tab.memory',
  observer: 'tab.observer',
  settings: 'wb.settings',
};

const SECTIONS = [
  ['overview', 'wb.nav.overview', 'activity'],
  ['chat', 'wb.mobile.chats', 'chat'],
  ['trends', 'wb.mobile.usage', 'chart'],
];

/** Mobile chrome delegates to the same navigation and controls as the desktop header. */
export function mountMobileNavigation({ document, t, getView = () => ({ tab: 'overview', fleet: false }),
  onTab = name => document.querySelector(`.tab[data-tab="${name}"]`)?.click() }) {
  const view = document.defaultView;
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const original = selector => document.querySelector(selector);
  const topbar = node('header', undefined, 'wb-mobile-topbar');
  const heading = node('h1');
  const title = node('span'); title.id = 'wb-mobile-title';
  const brand = node('span', undefined, 'wb-mobile-brand'); brand.id = 'wb-mobile-brand';
  heading.append(title, brand); topbar.append(heading);
  const labels = [];
  const menuAvailable = target => Boolean(target && !target.hidden);
  const button = (cls, ico, key) => {
    const el = node('button', undefined, cls); el.type = 'button';
    if (ico) el.append(icon(document, ico));
    const label = node('span'); el.append(label); labels.push({ el, label, key });
    return el;
  };
  // Same as the App's list bar: Search and New at the top right; the list updates itself, so no refresh.
  const listSearch = button('wb-mobile-icon-button', 'search', 'chat.page.search');
  listSearch.id = 'wb-mobile-list-search';
  const listCreate = button('wb-mobile-icon-button', 'plus', 'chat.create');
  listCreate.id = 'wb-mobile-list-create';
  topbar.append(listSearch, listCreate);

  const nav = node('nav', undefined, 'wb-mobile-tabs'); nav.id = 'wb-mobile-nav';
  const fleetSelector = '#fleet-manage-btn';
  const fleetTab = button('wb-mobile-tab', 'server', 'wb.mobile.fleet');
  fleetTab.dataset.mobileTab = 'fleet';
  fleetTab.addEventListener('click', () => original(fleetSelector)?.click());
  nav.append(fleetTab);
  const tabs = SECTIONS.map(([name, key, ico]) => {
    const el = button('wb-mobile-tab', ico, key); el.dataset.mobileTab = name;
    el.addEventListener('click', () => {
      onTab(name);
      sync();
    });
    nav.append(el); return el;
  });
  const more = button('wb-mobile-tab', 'menu', 'wb.mobile.more');
  more.id = 'wb-mobile-more'; more.setAttribute('aria-controls', 'wb-mobile-more-sheet');
  more.setAttribute('aria-expanded', 'false'); nav.append(more);
  const scrim = node('button', undefined, 'wb-mobile-scrim'); scrim.type = 'button'; scrim.hidden = true;
  const sheet = node('section', undefined, 'wb-mobile-sheet');
  sheet.id = 'wb-mobile-more-sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  const grab = node('div', undefined, 'wb-mobile-sheet-grab'); grab.setAttribute('aria-hidden', 'true');
  const sheetTitle = node('h2'); sheetTitle.id = 'wb-mobile-more-title';
  sheet.setAttribute('aria-labelledby', sheetTitle.id); sheet.append(grab, sheetTitle);
  const menuRows = [];
  const addMenu = (name, ico, key, selector, toggle = false, tab = null) => {
    const el = button('wb-mobile-sheet-item', ico, key); el.dataset.mobileAction = name;
    const mark = toggle ? node('i', undefined, 'wb-mobile-switch') : null;
    if (mark) { mark.setAttribute('aria-hidden', 'true'); el.append(mark); el.setAttribute('role', 'switch'); }
    el.addEventListener('click', () => {
      const target = original(selector);
      if (!menuAvailable(target) || target.disabled) return;
      if (!toggle) close(false);
      if (tab) onTab(tab); else target.click();
      sync();
    });
    sheet.append(el); menuRows.push({ el, name, selector, toggle });
    return el;
  };
  addMenu('schedule', 'clock', 'wb.nav.schedule', '.tab[data-tab="schedule"]', false, 'schedule');
  addMenu('memory', 'book', 'tab.memory', '.tab[data-tab="memory"]', false, 'memory');
  addMenu('settings', 'gear', 'wb.settings', '#wb-settings-btn');
  addMenu('machines', 'server', 'wb.fleet.title', fleetSelector);
  const separator = node('div', undefined, 'wb-mobile-sheet-separator'); sheet.append(separator);
  addMenu('detail', 'code', 'wb.detail', '#wb-tech-btn', true);
  addMenu('theme', 'moon', 'wb.mobile.darkTheme', '#wb-theme-toggle', true);

  function close(restore = true) {
    const wasOpen = !sheet.hidden;
    sheet.hidden = true; scrim.hidden = true; more.setAttribute('aria-expanded', 'false');
    if (wasOpen && restore) more.focus();
  }
  function open() {
    sync(); sheet.hidden = false; scrim.hidden = false; more.setAttribute('aria-expanded', 'true');
    sheet.querySelector('button:not([hidden])')?.focus();
  }
  more.addEventListener('click', () => sheet.hidden ? open() : close());
  scrim.addEventListener('click', () => close());
  const keydown = event => {
    if (sheet.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const buttons = [...sheet.querySelectorAll('button')].filter(el => !el.hidden && !el.disabled);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const proxyList = (proxy, selector) => {
    proxy.addEventListener('click', () => {
      const target = original(selector);
      if (target && !target.hidden && !target.disabled) target.click();
      sync();
    });
  };
  proxyList(listSearch, '.conversation-search-open'); proxyList(listCreate, '.conversation-create');
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  function sync() {
    const current = getView(), active = current.fleet ? 'fleet' : current.tab;
    setText(title, t(PAGE_TITLES[active] ?? PAGE_TITLES.settings));
    const instance = ['#tab-bar-agent-name', '#tab-bar-core-version'].map(selector => original(selector))
      .filter(el => el && !el.hidden && el.textContent.trim()).map(el => el.textContent.trim());
    setText(brand, instance.join(' · '));
    for (const record of labels) {
      setText(record.label, t(record.key)); record.el.setAttribute('aria-label', t(record.key));
    }
    setText(sheetTitle, t('wb.mobile.more')); scrim.setAttribute('aria-label', t('wb.close'));
    nav.setAttribute('aria-label', t('wb.mobile.sections'));
    const fleetTarget = original(fleetSelector);
    fleetTab.hidden = !current.multiAgent || !menuAvailable(fleetTarget);
    fleetTab.disabled = Boolean(fleetTarget?.disabled);
    for (const tab of tabs) {
      const target = original(`.tab[data-tab="${tab.dataset.mobileTab}"]`);
      tab.hidden = !menuAvailable(target); tab.disabled = Boolean(target?.disabled);
    }
    let hasActiveTab = false;
    for (const tab of [fleetTab, ...tabs]) {
      const selected = !tab.hidden && tab.dataset.mobileTab === active;
      tab.classList.toggle('active', selected);
      if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
      hasActiveTab ||= selected;
    }
    more.classList.toggle('active', !hasActiveTab);
    if (hasActiveTab) more.removeAttribute('aria-current'); else more.setAttribute('aria-current', 'true');
    for (const row of menuRows) {
      const target = original(row.selector);
      row.el.hidden = !menuAvailable(target) || (row.name === 'machines' && !fleetTab.hidden); row.el.disabled = Boolean(target?.disabled);
      if (row.toggle) row.el.setAttribute('aria-checked', String(row.name === 'detail'
        ? original('#wb-detail-toggle')?.checked === true : document.documentElement.dataset.theme === 'dark'));
    }
    for (const [proxy, selector] of [[listSearch, '.conversation-search-open'], [listCreate, '.conversation-create']]) {
      const target = original(selector);
      watch(target);
      proxy.hidden = active !== 'chat' || !target || target.hidden;
      proxy.disabled = Boolean(target?.disabled);
      const label = target?.getAttribute('aria-label') || target?.getAttribute('title');
      if (label) proxy.setAttribute('aria-label', label);
    }
    if (document.documentElement.dataset.conversationFocus === 'true' || view.innerWidth > 760) close(false);
  }
  original('.app-header')?.after(topbar); document.body.append(nav, scrim, sheet);
  document.documentElement.classList.add('wb-mobile-ready');
  const mutations = view.MutationObserver ? new view.MutationObserver(sync) : null;
  mutations?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-detail', 'data-conversation-focus'] });
  // Navigation and identity changes call sync() through the app. Only source
  // controls' availability can change independently; message DOM is not a source.
  const controls = [
    ...SECTIONS.map(([name]) => original(`.tab[data-tab="${name}"]`)),
    ...menuRows.map(row => original(row.selector)),
    original('.conversation-search-open'), original('.conversation-create'),
  ];
  const watched = new Set();
  function watch(control) {
    if (!control || watched.has(control)) return;
    watched.add(control);
    mutations?.observe(control, { attributes: true, attributeFilter: ['hidden', 'disabled'] });
  }
  controls.forEach(watch);
  const detailToggle = original('#wb-detail-toggle'); detailToggle?.addEventListener('change', sync);
  document.addEventListener('dashboard-locale-change', sync); document.addEventListener('keydown', keydown);
  view.addEventListener('resize', sync);
  sync();
  return { sync, close, destroy() {
    close(false); mutations?.disconnect();
    detailToggle?.removeEventListener('change', sync); view.removeEventListener('resize', sync);
    document.removeEventListener('dashboard-locale-change', sync); document.removeEventListener('keydown', keydown);
    topbar.remove(); nav.remove(); scrim.remove(); sheet.remove(); document.documentElement.classList.remove('wb-mobile-ready');
  } };
}
