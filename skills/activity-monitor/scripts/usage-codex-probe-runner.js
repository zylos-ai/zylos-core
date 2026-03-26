import { execSync, execFileSync } from 'node:child_process';
import { parseCodexStatusFromPane } from './usage-codex-status-parser.js';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEFAULT_BYPASS = process.env.CODEX_BYPASS_PERMISSIONS !== 'false';

function tmuxSessionExists(sessionName) {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function capturePane(sessionName) {
  try {
    return execSync(`tmux capture-pane -t "${sessionName}" -p 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
  } catch {
    return '';
  }
}

function sendKeys(sessionName, keys) {
  execSync(`tmux send-keys -t "${sessionName}" ${keys} 2>/dev/null`, { timeout: 3000, stdio: 'pipe' });
}

function killSession(sessionName) {
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000, stdio: 'pipe' });
  } catch {
    // best effort
  }
}

function sleep(seconds) {
  execFileSync('sleep', [String(seconds)], { timeout: (seconds * 1000) + 500 });
}

function maybeDismissStartupMenu(sessionName, paneContent, alreadyDismissed) {
  if (alreadyDismissed) return alreadyDismissed;
  const hasMenu = /›\s+\d+\./m.test(paneContent) || /press enter to continue/i.test(paneContent);
  const hasStatus = /Context window:/i.test(paneContent) || /·\s*\d+%\s*left\s*·/.test(paneContent);
  if (!hasMenu || hasStatus) return alreadyDismissed;

  try {
    sendKeys(sessionName, '1');
    sendKeys(sessionName, 'Enter');
    return true;
  } catch {
    return alreadyDismissed;
  }
}

export function classifyCodexStatusProbePane(paneContent) {
  const status = parseCodexStatusFromPane(paneContent);
  if (status) {
    return { ok: true, status };
  }
  return { ok: false, reason: 'parse_failed' };
}

export function isCompleteCodexPanel(status) {
  return status?.statusShape === 'panel' &&
    status.weeklyAllPercent !== null &&
    status.weeklyAllPercent !== undefined;
}

function statusScore(status) {
  if (!status) return -1;

  let score = 0;
  if (status.statusShape === 'panel') score += 10;
  if (status.statusShape === 'statusline') score += 1;

  if (status.sessionPercent !== null && status.sessionPercent !== undefined) score += 1;
  if (status.fiveHourPercent !== null && status.fiveHourPercent !== undefined) score += 2;
  if (status.weeklyAllPercent !== null && status.weeklyAllPercent !== undefined) score += 4;
  if (status.weeklyAllResets) score += 1;

  return score;
}

export function pickPreferredCodexStatus(previous, candidate) {
  if (!candidate) return previous || null;
  if (!previous) return candidate;
  if (statusScore(candidate) >= statusScore(previous)) return candidate;
  return previous;
}

export function runCodexStatusProbe({
  zylosDir,
  timeoutSeconds,
  captureWaitSeconds,
  sessionName,
}) {
  const startedAt = Date.now();
  const bypassFlag = DEFAULT_BYPASS ? ' --dangerously-bypass-approvals-and-sandbox' : '';
  const cmd = `cd "${zylosDir}" && ${CODEX_BIN}${bypassFlag}`;
  const tmuxArgs = ['new-session', '-d', '-s', sessionName, '-e', `PATH=${process.env.PATH}`, '--', cmd];

  try {
    execFileSync('tmux', tmuxArgs, { stdio: 'pipe', timeout: 5000 });
  } catch {
    return {
      ok: false,
      reason: 'sidecar_error',
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const sessionDeadline = Date.now() + (timeoutSeconds * 1000);

    sleep(1);
    if (!tmuxSessionExists(sessionName)) {
      return {
        ok: false,
        reason: 'sidecar_error',
        durationMs: Date.now() - startedAt,
      };
    }

    sendKeys(sessionName, '/status');
    sleep(1);
    sendKeys(sessionName, 'Enter');

    let captureDeadline = Math.min(
      sessionDeadline,
      Date.now() + (captureWaitSeconds * 1000)
    );

    let paneContent = '';
    let status = null;
    let fallbackStatus = null;
    let startupMenuDismissed = false;
    let extendedForPanel = false;

    while (Date.now() < captureDeadline) {
      paneContent = capturePane(sessionName);
      const classified = classifyCodexStatusProbePane(paneContent);
      if (classified.ok) {
        const candidate = classified.status;
        fallbackStatus = pickPreferredCodexStatus(fallbackStatus, candidate);

        if (isCompleteCodexPanel(candidate)) {
          status = candidate;
          break;
        }

        if (!extendedForPanel) {
          // /status can render incrementally (statusline or partial panel first).
          // Extend once to session timeout and keep polling for a full panel.
          captureDeadline = sessionDeadline;
          extendedForPanel = true;
        }
      } else {
        startupMenuDismissed = maybeDismissStartupMenu(sessionName, paneContent, startupMenuDismissed);
      }

      sleep(1);
    }

    sendKeys(sessionName, 'Escape');

    if (!status && fallbackStatus) {
      status = fallbackStatus;
    }

    if (!status) {
      if (Date.now() >= sessionDeadline) {
        return {
          ok: false,
          reason: 'timeout',
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        ok: false,
        reason: 'parse_failed',
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      reason: 'success',
      status,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      ok: false,
      reason: 'sidecar_error',
      durationMs: Date.now() - startedAt,
    };
  } finally {
    killSession(sessionName);
  }
}
