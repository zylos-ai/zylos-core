import { element } from './plain-text.js';

// The Core version an instance reports in versions (`zylos --version`). Dashboard ships inside Core and
// has no version of its own. A missing answer, or the CLI's "unknown", is not a version.
export function coreVersion(info) {
  const value = typeof info?.zylos?.installed === 'string' ? info.zylos.installed.trim() : '';
  return value && value !== 'unknown' ? value : null;
}

// The header's version beside the instance name: the viewed instance's own Core version, hidden when it cannot
// be read. Each call uses only the info it is given, so another instance never shows this machine's version.
export function renderBrandVersion(el, info) {
  if (!el) return;
  const core = coreVersion(info);
  el.textContent = core ? 'v' + core : '';
  el.hidden = !core;
}

// This machine's zylos version, as the update check reports it (GET /api/instance/core-update): the version and when
// it was checked; with a newer release, its number on a button that offers the upgrade instruction to copy.
// `update` is undefined while loading and null when it could not be read.
export function renderCoreUpdate(root, update, { document = root.ownerDocument, t = key => key, formatTime = value => value, onUpgrade = () => {} } = {}) {
  const current = typeof update?.current === 'string' && update.current.trim() && update.current.trim() !== 'unknown' ? update.current.trim() : null;
  root.replaceChildren(element(document, 'p', 'zylos · ' + (current ? 'v' + current : t(update === undefined ? 'status.loading' : 'wb.unknown')), 'wb-version-line'));
  const latest = typeof update?.latest === 'string' && update.latest.trim() ? update.latest.trim() : null;
  if (update?.hasUpdate === true && latest) {
    const button = element(document, 'button', t('wb.settings.version.update', { version: 'v' + latest }), 'wb-link-btn'); button.type = 'button'; button.id = 'settings-zylos-update';
    button.addEventListener('click', () => onUpgrade(coreUpgradePrompt(current, latest, t)));
    root.append(button);
  }
  if (update === null) root.append(element(document, 'p', t('wb.readFailed'), 'wb-note'));
  else if (update !== undefined) root.append(element(document, 'p', update.checkedAt ? t('wb.settings.version.checkedAt', { time: formatTime(update.checkedAt) }) : t('wb.settings.version.notChecked'), 'wb-note'));
}

/** The words to give the agent so it upgrades this machine's zylos. */
export function coreUpgradePrompt(current, latest, t = key => key) {
  return t('wb.settings.version.prompt', { from: current ? 'v' + current : t('wb.unknown'), to: 'v' + latest });
}

const engineTitle = runtime => runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude Code' : runtime === 'agy' ? 'Antigravity' : runtime || '';
// The AI engine's CLI version and its upgrade button (the original generated action node), for the engine chosen in
// the default engine card: each engine shows and upgrades its own CLI.
export function renderEngineVersion(root, info, { upgrade, document = root.ownerDocument, t = key => key, readOnly = false, runtime = 'claude' } = {}) {
  const version = info?.[runtime]?.installed, update = info?.[runtime]?.update, codex = runtime === 'codex';
  root.replaceChildren(element(document, 'p', `${engineTitle(runtime)} · ${version ? 'v' + version : t('wb.unknown')}${update ? ' ↑' + update : ''}`, 'wb-version-line'));
  if (upgrade) {
    const label = upgrade.querySelector('#action-cli-label'); if (label) label.textContent = runtime === 'claude' || codex
      ? t(codex ? 'actions.upgrade_codex' : 'actions.upgrade_cc') : t('actions.upgrade_runtime', { runtime: engineTitle(runtime) });
    const badge = upgrade.querySelector('#action-cc-ver'); if (badge) { badge.textContent = version ? ' v' + version : ''; badge.classList.toggle('action-ver-dot', !!update); }
    upgrade.disabled = readOnly; upgrade.title = readOnly ? t('remote.actions_read_only_tooltip') : ''; root.append(upgrade);
  }
}
