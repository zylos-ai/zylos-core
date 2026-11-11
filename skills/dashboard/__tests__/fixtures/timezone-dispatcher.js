import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const { main } = await import('../../../comm-bridge/scripts/c4-dispatcher.js');
const { createDispatcher } = await import('../../../comm-bridge/scripts/router/factory.js');
const root = process.env.ZYLOS_DIR, socket = process.env.TIMEZONE_TEST_SOCKET;
const tmux = args => execFileSync('tmux', ['-S', socket, ...args], { env: process.env, encoding: 'utf8', timeout: 3000 });
const target = { present: true, ready: true, runtime: 'codex', runId: 'dispatcher-run',
  sessionId: 'dispatcher-session', paneId: '%0', serverGeneration: '1:1', runtimeSessionId: 'dispatcher-session',
  tmuxName: 'zylos-group-origin', createdAt: Date.now() / 1000 };
const current = { runId: target.runId, sessionId: target.runtimeSessionId, startupControlIds: [] };
let checks = 0;
const verifyRetries = Number(process.argv[2] || 0);
const adapter = {
  async sendText({ text }) {
    tmux(['send-keys', '-t', 'zylos-group-origin:', '-l', text]);
    fs.appendFileSync(path.join(root, 'paste-receipts.jsonl'), JSON.stringify({ pid: process.pid, text }) + '\n');
  },
  async sendKeys() { tmux(['send-keys', '-t', 'zylos-group-origin:', 'C-u', 'Enter']); },
  async captureScreen() { return '❯ '; },
};
await main({ create: () => createDispatcher({
  readSessionMode: () => ({ mode: 'single', keyPresent: true }),
  readLiveIdentity: async () => target, readCurrentSession: async () => current,
  readSessionState: async () => ({ identity: target, status: { valid: true,
    value: { state: 'idle', idle_seconds: 60, health: 'ok', proc: { alive: true } } } }),
  listGroupTmuxSessions: async () => [{ sessionGroup: 'origin', tmuxName: target.tmuxName }],
  readRuntimeHealth: () => ({ health: 'ok' }), getSessionAdapter: () => adapter,
  resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
  openTmuxConnection: async () => ({ close: async () => {}, async command(args) {
    if (args.at(-1) !== '#{cursor_x}') return '0';
    const verdict = ++checks <= verifyRetries ? '4' : '0';
    fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify({ pid: process.pid, checks, verdict }));
    return verdict;
  } }),
  prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
  notifyDelivered: () => {}, maintainDiagnostics: () => {},
  diagnostic(event, fields) { if (event === 'deliver') fs.writeFileSync(path.join(root, 'delivery-settled.json'), JSON.stringify({ pid: process.pid, ...fields })); },
}, { delivery: { captureEnabled: false, periodicEnabled: false }, pollIntervalMs: 100 }) });
fs.writeFileSync(path.join(root, 'c4-dispatcher.json'), JSON.stringify({ pid: process.pid, tz: process.env.TZ }));
