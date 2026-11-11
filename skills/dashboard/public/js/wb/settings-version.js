import { element } from './plain-text.js?v=106';

// The Core version an instance reports in runtime_info (`zylos --version`). Dashboard ships inside Core and
// has no version of its own. A missing answer, or the CLI's "unknown", is not a version.
export function coreVersion(info) {
  const value = typeof info?.zylos_version === 'string' ? info.zylos_version.trim() : '';
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

// The viewed instance's Core version with its update hint, the AI engine CLI and its upgrade button
// (the original generated action node), in both views.
export function renderVersion(root, info, { upgrade, document = root.ownerDocument, t = key => key, readOnly = false, onHint = () => {} } = {}) {
  const ri = info ?? {}, core = coreVersion(ri);
  root.replaceChildren(element(document, 'p', 'zylos · ' + (core ? 'v' + core : t('wb.unknown'))));
  if (ri.zylos_update) {
    const hint = element(document, 'button', t('wb.settings.updateTo', { version: ri.zylos_update }), 'wb-link-btn'); hint.type = 'button'; hint.id = 'settings-zylos-update';
    hint.title = t('info.zylos_update_hint', { version: ri.zylos_update }); hint.addEventListener('click', () => onHint(hint)); root.append(hint);
  }
  const codex = (ri.runtime_cli ?? ri.configured_runtime ?? ri.runtime) === 'codex';
  const version = codex ? ri.codex_running || ri.codex_version || ri.codex_installed : ri.cc_version;
  const update = codex ? ri.codex_restart || ri.codex_update : ri.cc_restart || ri.cc_update;
  root.append(element(document, 'p', `${codex ? 'Codex' : 'CC'} · ${version ? 'v' + version : t('wb.unknown')}${update ? ' ↑' + update : ''}`));
  if (upgrade) {
    const label = upgrade.querySelector('#action-cli-label'); if (label) label.textContent = t(codex ? 'actions.upgrade_codex' : 'actions.upgrade_cc');
    const badge = upgrade.querySelector('#action-cc-ver'); if (badge) { badge.textContent = version ? ' v' + version : ''; badge.classList.toggle('action-ver-dot', !!update); }
    upgrade.disabled = readOnly; upgrade.title = readOnly ? t('remote.actions_read_only_tooltip') : ''; root.append(upgrade);
  }
}
