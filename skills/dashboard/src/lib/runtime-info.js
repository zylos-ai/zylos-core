import { isNewerVersion } from './version-utils.js';

export function codexRuntimeFields(reported, configured = {}) {
  return {
    model: reported?.model || reported?.model_id || null,
    model_id: reported?.model_id || null,
    effort: reported?.reasoning_effort || reported?.effort || null,
    service_tier: reported?.service_tier || null,
    configured_model: configured.model || null,
    configured_effort: configured.effort || null,
  };
}

export function applyVersionUpdateFields(info, latest, {
  zylosVersion,
  ccEffectiveVersion,
  codexInstalledVersion,
}) {
  if (latest.cc && ccEffectiveVersion && isNewerVersion(latest.cc, ccEffectiveVersion)) {
    info.cc_update = latest.cc;
  }
  if (latest.zylos && zylosVersion && isNewerVersion(latest.zylos, zylosVersion)) {
    info.zylos_update = latest.zylos;
  }
  if (latest.codex) {
    info.codex_latest = latest.codex;
    if (codexInstalledVersion && isNewerVersion(latest.codex, codexInstalledVersion)) {
      info.codex_update = latest.codex;
    }
  }
  return info;
}
