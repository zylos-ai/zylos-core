import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { parseUsageFromPane } from './usage-probe-parser.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const UNSUPPORTED_PLAN_RE = /\/usage is only available for subscription plans\./i;

function parseEnvValue(content, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = content.match(re);
  if (!m) return '';
  return m[1].trim().replace(/^(['"])(.*)\\1$/, '$2');
}

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
    // best-effort
  }
}

function sleep(seconds) {
  execFileSync('sleep', [String(seconds)], { timeout: (seconds * 1000) + 500 });
}

function readProbeAuthEnv(zylosDir) {
  const envFile = path.join(zylosDir, '.env');
  const result = {};

  try {
    const envContent = fs.readFileSync(envFile, 'utf8');
    const apiKey = parseEnvValue(envContent, 'ANTHROPIC_API_KEY');
    const oauthToken = parseEnvValue(envContent, 'CLAUDE_CODE_OAUTH_TOKEN');
    if (apiKey) result.ANTHROPIC_API_KEY = apiKey;
    if (oauthToken) result.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  } catch {
    // no .env available
  }

  return result;
}

export function classifyUsageProbePane(paneContent) {
  const usage = parseUsageFromPane(paneContent);
  if (usage) {
    return { ok: true, usage };
  }

  if (UNSUPPORTED_PLAN_RE.test(paneContent || '')) {
    return { ok: false, reason: 'unsupported_plan' };
  }

  return { ok: false, reason: 'parse_failed' };
}

export function runUsageProbe({
  zylosDir,
  timeoutSeconds,
  captureWaitSeconds,
  sessionName,
}) {
  const startedAt = Date.now();
  const authEnv = readProbeAuthEnv(zylosDir);

  const tmuxArgs = ['new-session', '-d', '-s', sessionName, '-e', `PATH=${process.env.PATH}`];
  for (const [key, value] of Object.entries(authEnv)) {
    tmuxArgs.push('-e', `${key}=${value}`);
  }

  const cmd = `cd "${zylosDir}" && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${CLAUDE_BIN} --dangerously-skip-permissions`;
  tmuxArgs.push('--', cmd);

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

    // Wait for session process to boot.
    sleep(1);

    if (!tmuxSessionExists(sessionName)) {
      return {
        ok: false,
        reason: 'sidecar_error',
        durationMs: Date.now() - startedAt,
      };
    }

    sendKeys(sessionName, '/usage');
    sleep(1);
    sendKeys(sessionName, 'Enter');

    const captureDeadline = Math.min(
      sessionDeadline,
      Date.now() + (captureWaitSeconds * 1000)
    );

    let paneContent = '';
    let usage = null;
    let probeFailureReason = 'parse_failed';

    while (Date.now() < captureDeadline) {
      paneContent = capturePane(sessionName);
      const classified = classifyUsageProbePane(paneContent);
      if (classified.ok) {
        usage = classified.usage;
        break;
      }
      probeFailureReason = classified.reason;
      if (probeFailureReason === 'unsupported_plan') {
        break;
      }
      sleep(1);
    }

    sendKeys(sessionName, 'Escape');

    if (!usage) {
      if (Date.now() >= sessionDeadline) {
        return {
          ok: false,
          reason: 'timeout',
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        ok: false,
        reason: probeFailureReason,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      reason: 'success',
      usage,
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
