import { execFileSync } from 'node:child_process';

// This deliberately cannot name a normal tmux client (/dev/pts/N or client-PID).
export const NO_CLIENT = 'zylos-no-client';

export function parseTmuxVersion(output) {
  const match = String(output).trim().match(/^tmux (\d+)\.(\d+)([a-z]*)(?:[-\s].*)?$/i);
  if (!match) return { version: 'unknown', useClientFlag: false, reason: 'unrecognized tmux -V output' };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return { version: `${match[1]}.${match[2]}${match[3]}`, major, minor,
    useClientFlag: major > 3 || (major === 3 && minor >= 4), reason: null };
}

export function describeTmuxSendKeys(capability) {
  if (capability.version === 'unknown') return `tmux unknown (${capability.reason}); send-keys -c disabled (legacy argv)`;
  return `tmux ${capability.version}; send-keys -c ${capability.useClientFlag ? 'enabled (zylos-no-client)' : 'disabled (legacy argv)'}`;
}

// A factory permits isolated binaries in integration tests; production uses PATH tmux.
export function createTmuxSender({ binary = 'tmux', prefix = [], exec = execFileSync,
  warn = message => process.stderr.write(`${message}\n`) } = {}) {
  let capability;
  function getCapability() {
    if (!capability) {
      try {
        capability = parseTmuxVersion(exec(binary, ['-V'], {
          encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe']
        }));
      } catch (error) {
        capability = { version: 'unknown', useClientFlag: false,
          reason: `tmux -V failed (code=${error.code ?? 'none'}, status=${error.status ?? 'none'})` };
      }
      if (capability.version === 'unknown') warn(`[tmux-send-keys] ${describeTmuxSendKeys(capability)}`);
    }
    return capability;
  }
  function sendKeys(session, keys, options = {}) {
    const flags = getCapability().useClientFlag ? ['-c', NO_CLIENT] : [];
    return exec(binary, [...prefix, 'send-keys', ...flags, '-t', session, ...keys], options);
  }
  return { getCapability, sendKeys };
}

const sender = createTmuxSender();
export const getTmuxCapability = sender.getCapability;
export const sendTmuxKeys = sender.sendKeys;

// Never log Error.message: child_process includes the command and its key arguments.
export function tmuxFailureDetails(error) {
  return { code: error.code ?? null, status: error.status ?? null, signal: error.signal ?? null,
    stderr: String(error.stderr ?? '').trim() };
}
