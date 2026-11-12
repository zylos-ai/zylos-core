async function phone(page) {
  return (page.viewportSize()?.width ?? await page.evaluate(() => innerWidth)) <= 760;
}

export async function openMobileMore(page) {
  const sheet = page.locator('#wb-mobile-more-sheet');
  if (!await sheet.isVisible()) await page.locator('#wb-mobile-more').click();
  await sheet.waitFor({ state: 'visible' });
  return sheet;
}

export async function openDashboardTab(page, name) {
  if (!await phone(page)) {
    return page.locator(name === 'settings' ? '#wb-settings-btn' : `.tab[data-tab="${name}"]`).click();
  }
  if (['overview', 'chat', 'schedule', 'memory'].includes(name)) {
    return page.locator(`[data-mobile-tab="${name}"]`).click();
  }
  await openMobileMore(page);
  return page.locator(`[data-mobile-action="${name === 'trends' ? 'usage' : name}"]`).click();
}

export async function openConversationMenu(page) {
  const menu = page.locator('#wb-chat .conversation-menu-sheet');
  if (!await menu.isVisible()) await page.locator('#wb-chat .conversation-menu-toggle').click();
  await menu.waitFor({ state: 'visible' });
  return menu;
}

export async function conversationAction(page, name, { keyboard = false } = {}) {
  const actions = {
    group: ['[data-action="page.groupInfo"]', '[data-action="page.menuGroup"]'],
    rename: ['.conversation-title-line [data-action="rename"]', '[data-action="page.menuRename"]'],
  };
  if (!Object.hasOwn(actions, name)) throw new Error(`Unknown conversation action: ${name}`);
  const mobile = await phone(page);
  if (mobile) await openConversationMenu(page);
  const control = page.locator('#wb-chat ' + actions[name][Number(mobile)]);
  if (keyboard) { await control.focus(); await page.keyboard.press('Enter'); }
  else await control.click();
}

export const openGroupDetail = (page, options) => conversationAction(page, 'group', options);
export const openObserver = page => openDashboardTab(page, 'observer');
