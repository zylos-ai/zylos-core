/** Test-only explicit authentication and native-hook preflight. Never imports host auth. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from '../../../../cli/lib/auth-parsers.js';
import { desiredClaudeHooks } from '../../../../cli/lib/sync-runtime-hooks.js';
import { renderCodexProjectConfig } from '../../../../cli/lib/runtime-setup.js';
import {
  ensureCodexHooksTrusted, isCodexTrustValid, readHooksState, codexGlobalConfigPath,
  codexHooksPath, readCodexHooksConfig, hookKeyFor,
} from '../../../../cli/lib/codex-hooks.js';

export function authError(code) { return Object.assign(new Error(code), { code }); }

export function readClaudeCredential(source, now = Date.now()) {
  if (!source) throw authError('claude_credentials_missing');
  let value;
  try { value = JSON.parse(fs.readFileSync(source, 'utf8')); }
  catch { throw authError('claude_credentials_unreadable'); }
  const oauth = value?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken ||
      !Number.isFinite(oauth.expiresAt)) throw authError('claude_credentials_invalid');
  if (oauth.expiresAt - now < 2 * 60 * 60 * 1000) throw authError('claude_credentials_expiring');
  return value;
}

export function preflightInputs(runtimes, env = process.env, now = Date.now()) {
  for (const runtime of runtimes) {
    if (runtime === 'claude') readClaudeCredential(env.READY_MEASURE_CLAUDE_CREDENTIALS, now);
    else if (runtime === 'codex' && !env.READY_MEASURE_CODEX_API_KEY?.trim()) throw authError('codex_credentials_missing');
  }
  return { explicitCredentials: true };
}

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// No inherited credential selectors or explicit input secret reaches the runtime.
export function authRuntimeEnv(env, home) {
  return Object.fromEntries(Object.entries({ ...env, HOME: home }).filter(([key]) =>
    !key.startsWith('READY_MEASURE_') && !['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key)));
}

/** Fresh app-server read after trust write. Only known safe fields leave this function. */
export async function verifyCodexHooks({ binary, root, env, home, timeoutMs = 20000 }) {
  const result = await new Promise((resolve, reject) => {
    const app = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '', answer, failure, finished = false;
    let forceTimer;
    function finish(value, error) {
      if (finished) return;
      finished = true; answer = value; failure = error;
      clearTimeout(timer);
      app.stdin.end();
      app.kill('SIGTERM');
      forceTimer = setTimeout(() => app.kill('SIGKILL'), 1000);
    }
    const timer = setTimeout(() => finish(null, 'codex_hooks_list_timeout'), timeoutMs);
    app.on('error', () => finish(null, 'codex_hooks_list_spawn_failed'));
    app.stdin.on('error', () => {});
    app.on('close', () => {
      clearTimeout(timer); clearTimeout(forceTimer);
      if (failure || !answer) reject(authError(failure || 'codex_hooks_list_exit'));
      else resolve(answer);
    });
    app.stdout.on('data', chunk => {
      if (finished) return;
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return finish(null, 'codex_hooks_list_oversize');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 0) {
          if (message.error) return finish(null, 'codex_hooks_initialize_failed');
          app.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          app.stdin.write(`${JSON.stringify({ id: 1, method: 'hooks/list', params: { cwds: [root] } })}\n`);
        } else if (message.id === 1) {
          if (message.error || !Array.isArray(message.result?.data)) return finish(null, 'codex_hooks_list_failed');
          return finish(message.result.data);
        }
      }
    });
    app.stdin.write(`${JSON.stringify({ id: 0, method: 'initialize', params: {
      clientInfo: { name: 'zylos_ready_measure', version: '1.0.0' }, capabilities: { experimentalApi: true },
    } })}\n`);
  });
  const config = readCodexHooksConfig(codexHooksPath(root));
  const expected = [];
  for (const [event, groups] of Object.entries(config.hooks || {})) {
    for (const [groupIndex, group] of groups.entries()) {
      for (const hookIndex of (group.hooks || []).keys()) expected.push(hookKeyFor({ zylosDir: root, event, groupIndex, hookIndex }));
    }
  }
  const listed = result.flatMap(entry => entry.hooks || []);
  const state = readHooksState(codexGlobalConfigPath(home));
  const hooks = expected.map((key, index) => {
    const hook = listed.find(item => item.key === key);
    return { index, listed: !!hook, hasCurrentHash: typeof hook?.currentHash === 'string' && !!hook.currentHash,
      enabled: state[key]?.enabled === true,
      trusted: !!hook?.currentHash && state[key]?.trusted_hash === hook.currentHash };
  });
  if (!hooks.length || hooks.some(hook => !hook.listed || !hook.hasCurrentHash || !hook.enabled || !hook.trusted)) {
    const error = authError('codex_hooks_verification_failed');
    error.details = { hooks }; // booleans only, never command output/auth data
    throw error;
  }
  return { listed: hooks.length, trusted: true, hooks };
}

export async function setupAuth({ runtime, home, root, env, binary }) {
  preflightInputs([runtime], env);
  const childEnv = authRuntimeEnv(env, home);
  const options = { cwd: root, env: childEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 };
  if (runtime === 'claude') {
    privateJson(path.join(home, '.claude/.credentials.json'), readClaudeCredential(env.READY_MEASURE_CLAUDE_CREDENTIALS));
    // Equivalent minimal writes to preAcceptClaudeTerms + approveApiKey's project trust.
    privateJson(path.join(home, '.claude.json'), { hasCompletedOnboarding: true, projects: {
      [path.resolve(root)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    } });
    privateJson(path.join(home, '.claude/settings.json'), {
      skipDangerousModePermissionPrompt: true, hooks: desiredClaudeHooks({ zylosDir: root }),
    });
    const status = spawnSync(binary, ['auth', 'status', '--json'], options);
    if (status.error || status.status !== 0 || !parseClaudeAuthStatus(status.stdout)) throw authError('claude_auth_preflight_failed');
    return { loggedIn: true, credentialsMode: 'explicit_file_copy_0600', onboarding: 'product_equivalent_minimal', projectTrusted: true };
  }
  if (runtime !== 'codex') throw authError('unsupported_runtime');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true, mode: 0o700 });
  // Exact minimal project trust + native hooks; no implicit OPENAI_BASE_URL lookup.
  fs.writeFileSync(path.join(home, '.codex/config.toml'), `[features]\nhooks = true\n[projects.${JSON.stringify(path.resolve(root))}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.codex/config.toml'), renderCodexProjectConfig(), { mode: 0o600 });
  const login = spawnSync(binary, ['login', '--with-api-key'], { ...options, input: `${env.READY_MEASURE_CODEX_API_KEY.trim()}\n` });
  if (login.error || login.status !== 0) throw authError('codex_login_failed');
  const status = spawnSync(binary, ['login', 'status'], options);
  if (status.error || status.status !== 0 || !parseCodexLoginStatus((status.stdout || '') + (status.stderr || ''))) throw authError('codex_auth_preflight_failed');
  let version;
  try {
    version = execFileSync(binary, ['--version'], options).trim();
    ensureCodexHooksTrusted({ zylosDir: root, projectDir: root, homeDir: home, codexBin: binary,
      execFileSyncImpl: (file, args, opts) => execFileSync(file, args, { ...opts, env: childEnv, cwd: root }),
      spawnSyncImpl: (file, args, opts) => spawnSync(file, args, { ...opts, env: {
        ...childEnv, ZYLOS_CODEX_TRUST_CWD: root, ZYLOS_CODEX_BIN: binary,
      } }),
    });
  } catch { throw authError('codex_hook_trust_failed'); }
  if (!isCodexTrustValid({ zylosDir: root, projectDir: root, homeDir: home, codexVersion: version }).valid) throw authError('codex_hook_trust_invalid');
  const hooksList = await verifyCodexHooks({ binary, root, env: childEnv, home });
  return { loggedIn: true, credentialsMode: 'explicit_key_stdin', projectTrusted: true, hooksList };
}
