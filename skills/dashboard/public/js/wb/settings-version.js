import { DEFAULT_RUNTIME } from '../../runtime-descriptors.js';
import { element, runtimeName } from './plain-text.js';

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

// The AI engine's CLI version and its upgrade button (the original generated action node), for the engine chosen in
// the default engine card: each engine shows and upgrades its own CLI.
export function renderEngineVersion(root, info, { upgrade, document = root.ownerDocument, t = key => key, readOnly = false, runtime = DEFAULT_RUNTIME } = {}) {
  const name = runtimeName(runtime);
  const version = info?.[runtime];
  const unsupported = version?.update_check === 'unsupported';
  const latest = unsupported ? null : version?.latest;
  const update = latest ? version.update : null;
  const installed = version?.installed ? 'v' + version.installed : t('wb.unknown');
  const updateNote = unsupported ? ` · ${t('wb.settings.updateCheckUnsupported')}` : '';
  root.replaceChildren(element(document, 'p', `${name} · ${installed}${updateNote}`, 'wb-version-line'));
  if (!upgrade || (latest && !update)) return;

  const label = upgrade.querySelector('#action-cli-label');
  if (label) label.textContent = t('actions.upgrade_runtime', { runtime: name }) + (update ? ' v' + update : '');
  upgrade.disabled = readOnly;
  upgrade.title = readOnly ? t('remote.actions_read_only_tooltip') : '';
  root.append(upgrade);
}
