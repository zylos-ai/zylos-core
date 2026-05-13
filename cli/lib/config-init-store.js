#!/usr/bin/env node
// Copyright (c) 2026 Lark Technologies Pte. Ltd.
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const SERVICE = "lark-cli";
const SECRET_KEY_PREFIX = "appsecret:";
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAC_FILE_MASTER_KEY_NAME = "master.key.file";

class KeychainNotFoundError extends Error {}
class KeychainNotInitializedError extends Error {}
class KeychainCorruptedError extends Error {}
class KeychainAccessBlockedError extends Error {}

function secretAccountKey(appId) {
  return SECRET_KEY_PREFIX + appId;
}

function accountKey(appId, userOpenId) {
  return `${appId}:${userOpenId}`;
}

function parseBrand(value) {
  return value === "lark" ? "lark" : "feishu";
}

function detectWorkspaceFromEnv(env = process.env) {
  if (
    env.OPENCLAW_CLI === "1" ||
    env.OPENCLAW_HOME ||
    env.OPENCLAW_STATE_DIR ||
    env.OPENCLAW_CONFIG_PATH ||
    env.OPENCLAW_SERVICE_MARKER ||
    env.OPENCLAW_SERVICE_VERSION ||
    env.OPENCLAW_GATEWAY_PORT ||
    env.OPENCLAW_SHELL
  ) {
    return "openclaw";
  }
  if (
    env.HERMES_HOME ||
    env.HERMES_QUIET === "1" ||
    env.HERMES_EXEC_ASK === "1" ||
    env.HERMES_GATEWAY_TOKEN ||
    env.HERMES_SESSION_KEY
  ) {
    return "hermes";
  }
  if (env.LARK_CHANNEL === "1") {
    return "lark-channel";
  }
  return "";
}

function homeDir(env = process.env) {
  return env.HOME || os.homedir() || "";
}

function getBaseConfigDir(env = process.env) {
  if (env.LARKSUITE_CLI_CONFIG_DIR) {
    return env.LARKSUITE_CLI_CONFIG_DIR;
  }
  return path.join(homeDir(env), ".lark-cli");
}

function getRuntimeDir(options = {}) {
  const env = options.env || process.env;
  const workspace = normalizeWorkspace(options.workspace, env);
  const base = getBaseConfigDir(env);
  return workspace ? path.join(base, workspace) : base;
}

function getConfigPath(options = {}) {
  return path.join(getRuntimeDir(options), "config.json");
}

function normalizeWorkspace(workspace, env) {
  if (workspace === undefined || workspace === null || workspace === "auto") {
    return detectWorkspaceFromEnv(env);
  }
  if (workspace === "" || workspace === "local") {
    return "";
  }
  if (workspace === "openclaw" || workspace === "hermes" || workspace === "lark-channel") {
    return workspace;
  }
  throw new Error(`invalid workspace ${JSON.stringify(workspace)}; valid values: local, auto, openclaw, hermes, lark-channel`);
}

function rejectControlChars(value, label) {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(`${label} contains control characters`);
    }
  }
}

function resolveNearestAncestor(inputPath) {
  const tail = [];
  let cur = inputPath;
  for (;;) {
    try {
      fs.lstatSync(cur);
      const real = fs.realpathSync(cur);
      return path.join(real, ...tail);
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return path.join(cur, ...tail);
      }
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function safeEnvDirPath(raw, envName) {
  rejectControlChars(raw, envName);
  const cleaned = path.normalize(raw);
  if (!path.isAbsolute(cleaned)) {
    throw new Error(`${envName} must be an absolute path, got ${JSON.stringify(cleaned)}`);
  }
  return resolveNearestAncestor(cleaned);
}

function storageDir(service, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  if (platform === "darwin") {
    const home = homeDir(env);
    if (!home) {
      return path.join(".lark-cli", "keychain", service);
    }
    return path.join(home, "Library", "Application Support", service);
  }

  if (platform === "linux") {
    if (env.LARKSUITE_CLI_DATA_DIR) {
      try {
        return path.join(safeEnvDirPath(env.LARKSUITE_CLI_DATA_DIR, "LARKSUITE_CLI_DATA_DIR"), service);
      } catch (_) {
        // Match Go: invalid LARKSUITE_CLI_DATA_DIR falls back to the default.
      }
    }
    return path.join(homeDir(env), ".local", "share", service);
  }

  return "";
}

function safeFileName(account) {
  return account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
}

function encryptData(plaintext, key, iv = crypto.randomBytes(IV_BYTES)) {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
    throw new Error("invalid AES-256 key");
  }
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
    throw new Error("invalid AES-GCM iv");
  }
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

function decryptData(data, key) {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
    throw new Error("invalid AES-256 key");
  }
  if (!Buffer.isBuffer(data)) {
    data = Buffer.from(data);
  }
  if (data.length < IV_BYTES + TAG_BYTES) {
    throw new Error("invalid encrypted data");
  }
  const iv = data.subarray(0, IV_BYTES);
  const body = data.subarray(IV_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function randomSuffix() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function readStrictFile(filePath, expectedLen) {
  const data = fs.readFileSync(filePath);
  if (data.length !== expectedLen) {
    throw new KeychainCorruptedError("keychain is corrupted");
  }
  return data;
}

function linuxMasterKey(service, allowCreate, options = {}) {
  const dir = storageDir(service, options);
  const keyPath = path.join(dir, "master.key");
  try {
    return readStrictFile(keyPath, MASTER_KEY_BYTES);
  } catch (err) {
    if (err instanceof KeychainCorruptedError) {
      throw err;
    }
    if (err.code && err.code !== "ENOENT") {
      throw err;
    }
  }

  if (!allowCreate) {
    throw new KeychainNotInitializedError("keychain not initialized");
  }

  ensureDir(dir, 0o700);
  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  const tmpPath = path.join(dir, `master.key.${randomSuffix()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, key, { mode: 0o600 });
    fs.renameSync(tmpPath, keyPath);
  } catch (err) {
    try {
      return readStrictFile(keyPath, MASTER_KEY_BYTES);
    } catch (_) {
      throw err;
    }
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (_) {
      // Best-effort cleanup, matching Go.
    }
  }
  return key;
}

function macFileMasterKey(service, allowCreate, options = {}) {
  const dir = storageDir(service, { ...options, platform: "darwin" });
  const keyPath = path.join(dir, MAC_FILE_MASTER_KEY_NAME);
  try {
    return readStrictFile(keyPath, MASTER_KEY_BYTES);
  } catch (err) {
    if (err instanceof KeychainCorruptedError) {
      throw err;
    }
    if (err.code && err.code !== "ENOENT") {
      throw err;
    }
  }

  if (!allowCreate) {
    throw new KeychainNotInitializedError("keychain not initialized");
  }

  ensureDir(dir, 0o700);
  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  let fd = null;
  let created = false;
  let writeFailed = false;
  try {
    fd = fs.openSync(keyPath, "wx", 0o600);
    created = true;
    writeFailed = true;
    fs.writeFileSync(fd, key);
    fs.closeSync(fd);
    fd = null;
    writeFailed = false;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    if (err.code === "EEXIST") {
      for (let i = 0; i < 3; i++) {
        try {
          return readStrictFile(keyPath, MASTER_KEY_BYTES);
        } catch (readErr) {
          if (i === 2) {
            throw readErr;
          }
        }
      }
    }
    throw err;
  } finally {
    if (created && writeFailed) {
      try {
        fs.rmSync(keyPath, { force: true });
      } catch (_) {}
    }
  }

  return readStrictFile(keyPath, MASTER_KEY_BYTES);
}

function macSecurityFind(service, account, options = {}) {
  if (options.macKeychain && options.macKeychain.get) {
    return options.macKeychain.get(service, account);
  }
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch (err) {
    const stderr = String(err.stderr || "");
    if (err.status === 44 || /could not be found|The specified item could not be found/i.test(stderr)) {
      throw new KeychainNotFoundError("keychain item not found");
    }
    throw new KeychainAccessBlockedError("keychain access blocked");
  }
}

function macSecuritySet(service, account, password, options = {}) {
  if (options.macKeychain && options.macKeychain.set) {
    return options.macKeychain.set(service, account, password);
  }
  execFileSync("/usr/bin/security", ["add-generic-password", "-s", service, "-a", account, "-w", password, "-U"], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5000,
  });
}

function macSystemMasterKey(service, allowCreate, options = {}) {
  try {
    const encoded = macSecurityFind(service, "master.key", options);
    const key = Buffer.from(encoded, "base64");
    if (key.length !== MASTER_KEY_BYTES) {
      throw new KeychainCorruptedError("keychain is corrupted");
    }
    return key;
  } catch (err) {
    if (err instanceof KeychainCorruptedError) {
      throw err;
    }
    if (!(err instanceof KeychainNotFoundError)) {
      throw err;
    }
  }

  if (!allowCreate) {
    throw new KeychainNotInitializedError("keychain not initialized");
  }

  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  macSecuritySet(service, "master.key", key.toString("base64"), options);
  return key;
}

function registryPathForService(service) {
  return "Software\\LarkCli\\keychain\\" + safeRegistryComponent(service);
}

function safeRegistryComponent(value) {
  return value.replace(/\\/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function base64RawUrl(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function valueNameForAccount(account) {
  return base64RawUrl(account);
}

function dpapiEntropy(service, account) {
  return Buffer.from(`${service}\0${account}`, "utf8");
}

function runPowerShell(script, extraEnv = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

function dpapiProtect(data, entropy) {
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$d=[Convert]::FromBase64String($env:LARK_CLI_DPAPI_DATA_B64);" +
    "$e=[Convert]::FromBase64String($env:LARK_CLI_DPAPI_ENTROPY_B64);" +
    "$p=[System.Security.Cryptography.ProtectedData]::Protect($d,$e,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Console]::Out.Write([Convert]::ToBase64String($p));";
  const out = runPowerShell(script, {
    LARK_CLI_DPAPI_DATA_B64: Buffer.from(data).toString("base64"),
    LARK_CLI_DPAPI_ENTROPY_B64: Buffer.from(entropy).toString("base64"),
  });
  return Buffer.from(out.trim(), "base64");
}

function dpapiUnprotect(data, entropy) {
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$d=[Convert]::FromBase64String($env:LARK_CLI_DPAPI_DATA_B64);" +
    "$e=[Convert]::FromBase64String($env:LARK_CLI_DPAPI_ENTROPY_B64);" +
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($d,$e,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
    "[Console]::Out.Write([Convert]::ToBase64String($p));";
  const out = runPowerShell(script, {
    LARK_CLI_DPAPI_DATA_B64: Buffer.from(data).toString("base64"),
    LARK_CLI_DPAPI_ENTROPY_B64: Buffer.from(entropy).toString("base64"),
  });
  return Buffer.from(out.trim(), "base64");
}

function registryGet(service, account) {
  const script =
    "$ErrorActionPreference='Stop';" +
    "$name=$env:LARK_CLI_REG_NAME;" +
    "try {" +
    "  $item=Get-ItemProperty -Path $env:LARK_CLI_REG_PATH -Name $name -ErrorAction Stop;" +
    "  [Console]::Out.Write([string]$item.PSObject.Properties[$name].Value);" +
    "} catch { exit 2 }";
  try {
    return runPowerShell(script, {
      LARK_CLI_REG_PATH: "HKCU:\\" + registryPathForService(service),
      LARK_CLI_REG_NAME: valueNameForAccount(account),
    });
  } catch (_) {
    return null;
  }
}

function registrySet(service, account, protectedData) {
  const script =
    "$ErrorActionPreference='Stop';" +
    "New-Item -Path $env:LARK_CLI_REG_PATH -Force | Out-Null;" +
    "New-ItemProperty -Path $env:LARK_CLI_REG_PATH -Name $env:LARK_CLI_REG_NAME -Value $env:LARK_CLI_REG_VALUE -PropertyType String -Force | Out-Null;";
  runPowerShell(script, {
    LARK_CLI_REG_PATH: "HKCU:\\" + registryPathForService(service),
    LARK_CLI_REG_NAME: valueNameForAccount(account),
    LARK_CLI_REG_VALUE: Buffer.from(protectedData).toString("base64"),
  });
}

function registryRemove(service, account) {
  const script =
    "Remove-ItemProperty -Path $env:LARK_CLI_REG_PATH -Name $env:LARK_CLI_REG_NAME -ErrorAction SilentlyContinue;";
  try {
    runPowerShell(script, {
      LARK_CLI_REG_PATH: "HKCU:\\" + registryPathForService(service),
      LARK_CLI_REG_NAME: valueNameForAccount(account),
    });
  } catch (_) {
    // Go treats missing registry keys as a successful remove.
  }
}

function platformGet(service, account, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    const encoded = registryGet(service, account);
    if (!encoded) {
      return "";
    }
    const plain = dpapiUnprotect(Buffer.from(encoded, "base64"), dpapiEntropy(service, account));
    return plain.toString("utf8");
  }

  const dir = storageDir(service, options);
  const filePath = path.join(dir, safeFileName(account));
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return "";
    }
    throw err;
  }

  if (platform === "darwin") {
    try {
      return decryptData(data, macFileMasterKey(service, false, options));
    } catch (_) {
      const key = macSystemMasterKey(service, false, options);
      return decryptData(data, key);
    }
  }

  return decryptData(data, linuxMasterKey(service, false, options));
}

function platformSet(service, account, value, options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "win32") {
    const protectedData = dpapiProtect(Buffer.from(value, "utf8"), dpapiEntropy(service, account));
    registrySet(service, account, protectedData);
    return;
  }

  let key;
  if (platform === "darwin") {
    try {
      key = macFileMasterKey(service, false, options);
    } catch (_) {
      try {
        key = macSystemMasterKey(service, true, options);
      } catch (_) {
        key = macFileMasterKey(service, true, options);
      }
    }
  } else {
    key = linuxMasterKey(service, true, options);
  }

  const dir = storageDir(service, options);
  ensureDir(dir, 0o700);
  const encrypted = encryptData(value, key);
  const targetPath = path.join(dir, safeFileName(account));
  const tmpPath = path.join(dir, `${safeFileName(account)}.${randomSuffix()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, encrypted, { mode: 0o600 });
    fs.renameSync(tmpPath, targetPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (_) {}
  }
}

function platformRemove(service, account, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    registryRemove(service, account);
    return;
  }
  const filePath = path.join(storageDir(service, options), safeFileName(account));
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}

function keychainGet(service, account, options = {}) {
  return platformGet(service, account, options);
}

function keychainSet(service, account, value, options = {}) {
  platformSet(service, account, value, options);
}

function keychainRemove(service, account, options = {}) {
  platformRemove(service, account, options);
}

function forStorage(appId, plainSecret, options = {}) {
  const key = secretAccountKey(appId);
  keychainSet(SERVICE, key, plainSecret, options);
  return { source: "keychain", id: key };
}

function removeSecretStore(appSecret, options = {}) {
  if (appSecret && typeof appSecret === "object" && appSecret.source === "keychain" && appSecret.id) {
    try {
      keychainRemove(SERVICE, appSecret.id, options);
    } catch (_) {
      // Best-effort cleanup.
    }
  }
}

function removeStoredToken(appId, userOpenId, options = {}) {
  try {
    keychainRemove(SERVICE, accountKey(appId, userOpenId), options);
  } catch (_) {
    // Best-effort cleanup.
  }
}

function loadMultiAppConfig(options = {}) {
  try {
    const data = fs.readFileSync(getConfigPath(options), "utf8");
    const parsed = JSON.parse(data);
    if (!parsed || !Array.isArray(parsed.apps) || parsed.apps.length === 0) {
      throw new Error("invalid config format: no apps");
    }
    return normalizeMultiFromJSON(parsed);
  } catch (_) {
    return null;
  }
}

function normalizeMultiFromJSON(raw) {
  const multi = {};
  if (raw.strictMode) multi.strictMode = raw.strictMode;
  if (raw.currentApp) multi.currentApp = raw.currentApp;
  if (raw.previousApp) multi.previousApp = raw.previousApp;
  multi.apps = Array.isArray(raw.apps) ? raw.apps.map(normalizeAppFromJSON) : [];
  return multi;
}

function normalizeAppFromJSON(raw) {
  const app = {};
  if (raw.name) app.name = raw.name;
  app.appId = raw.appId || "";
  app.appSecret = normalizeSecretInput(raw.appSecret);
  app.brand = raw.brand || "";
  if (raw.lang) app.lang = raw.lang;
  if (raw.defaultAs) app.defaultAs = raw.defaultAs;
  if (Object.prototype.hasOwnProperty.call(raw, "strictMode") && raw.strictMode !== null && raw.strictMode !== undefined) {
    app.strictMode = raw.strictMode;
  }
  app.users = Array.isArray(raw.users) ? raw.users.map(normalizeUserFromJSON) : null;
  return app;
}

function normalizeUserFromJSON(raw) {
  return {
    userOpenId: raw.userOpenId || "",
    userName: raw.userName || "",
  };
}

function normalizeSecretInput(raw) {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw && typeof raw === "object" && raw.source && raw.id) {
    if (raw.source !== "file" && raw.source !== "keychain") {
      throw new Error("appSecret must be a string or {source, id} object");
    }
    const ref = { source: raw.source };
    if (raw.provider) ref.provider = raw.provider;
    ref.id = raw.id;
    return ref;
  }
  return "";
}

function normalizeAppForJSON(app) {
  const out = {};
  if (app.name) out.name = app.name;
  out.appId = app.appId;
  out.appSecret = app.appSecret;
  out.brand = app.brand;
  if (app.lang) out.lang = app.lang;
  if (app.defaultAs) out.defaultAs = app.defaultAs;
  if (Object.prototype.hasOwnProperty.call(app, "strictMode") && app.strictMode !== null && app.strictMode !== undefined) {
    out.strictMode = app.strictMode;
  }
  out.users = app.users === null ? null : (Array.isArray(app.users) ? app.users : []);
  return out;
}

function normalizeMultiForJSON(multi) {
  const out = {};
  if (multi.strictMode) out.strictMode = multi.strictMode;
  if (multi.currentApp) out.currentApp = multi.currentApp;
  if (multi.previousApp) out.previousApp = multi.previousApp;
  out.apps = Array.isArray(multi.apps) ? multi.apps.map(normalizeAppForJSON) : [];
  return out;
}

function saveMultiAppConfig(config, options = {}) {
  const dir = getRuntimeDir(options);
  ensureDir(dir, 0o700);
  const data = JSON.stringify(normalizeMultiForJSON(config), null, 2) + "\n";
  atomicWrite(getConfigPath(options), Buffer.from(data, "utf8"), 0o600);
}

function atomicWrite(filePath, data, mode) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix()}.tmp`);
  let fd = null;
  let success = false;
  try {
    fd = fs.openSync(tmpPath, "wx", mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
    success = true;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    if (!success) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch (_) {}
    }
  }
}

function validateProfileName(name) {
  if (!name) {
    throw new Error("profile name cannot be empty");
  }
  if (Array.from(name).length > 64) {
    throw new Error(`profile name ${JSON.stringify(name)} is too long (max 64 characters)`);
  }
  const invalid = new Set([" ", "\t", "/", "\\", "\"", "'", "`", "$", "#", "!", "&", "|", ";", "(", ")", "{", "}", "[", "]", "<", ">", "?", "*", "~"]);
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(`invalid profile name ${JSON.stringify(name)}: contains control characters`);
    }
    if (invalid.has(ch)) {
      throw new Error(`invalid profile name ${JSON.stringify(name)}: contains invalid character ${JSON.stringify(ch)}`);
    }
  }
}

function findProfileIndexByName(multi, profileName) {
  if (!multi || !Array.isArray(multi.apps)) return -1;
  return multi.apps.findIndex((app) => app.name === profileName);
}

function findAppIndexByAppID(multi, appID) {
  if (!multi || !Array.isArray(multi.apps)) return -1;
  return multi.apps.findIndex((app) => app.appId === appID);
}

function cleanupOldConfig(existing, skipAppID, options = {}) {
  if (!existing || !Array.isArray(existing.apps)) {
    return;
  }
  for (const app of existing.apps) {
    if (app.appId === skipAppID) {
      continue;
    }
    removeSecretStore(app.appSecret, options);
    for (const user of app.users || []) {
      removeStoredToken(app.appId, user.userOpenId, options);
    }
  }
}

function saveAsOnlyApp(appId, secretRef, brand, lang, options = {}) {
  saveMultiAppConfig({
    apps: [{
      appId,
      appSecret: secretRef,
      brand,
      lang,
      users: [],
    }],
  }, options);
}

function saveAsProfile(existing, profileName, appId, secretRef, brand, lang, options = {}) {
  const multi = existing || { apps: [] };
  if (!Array.isArray(multi.apps)) {
    multi.apps = [];
  }

  const idx = findProfileIndexByName(multi, profileName);
  if (idx >= 0) {
    if (multi.apps[idx].appId !== appId) {
      removeSecretStore(multi.apps[idx].appSecret, options);
      for (const user of multi.apps[idx].users || []) {
        removeStoredToken(multi.apps[idx].appId, user.userOpenId, options);
      }
      multi.apps[idx].users = [];
    }
    multi.apps[idx].appId = appId;
    multi.apps[idx].appSecret = secretRef;
    multi.apps[idx].brand = brand;
    multi.apps[idx].lang = lang;
  } else {
    if (findAppIndexByAppID(multi, profileName) >= 0) {
      throw new Error(`profile name ${JSON.stringify(profileName)} conflicts with existing appId`);
    }
    multi.apps.push({
      name: profileName,
      appId,
      appSecret: secretRef,
      brand,
      lang,
      users: [],
    });
  }

  saveMultiAppConfig(multi, options);
}

function saveInitConfig(profileName, existing, appId, secretRef, brand, lang, options = {}) {
  if (profileName) {
    return saveAsProfile(existing, profileName, appId, secretRef, brand, lang, options);
  }
  cleanupOldConfig(existing, appId, options);
  return saveAsOnlyApp(appId, secretRef, brand, lang, options);
}

function saveLarkCliConfig(input, options = {}) {
  const appId = String(input.appId || "").trim();
  const appSecret = String(input.appSecret || "").trim();
  if (!appId) {
    throw new Error("App ID cannot be empty");
  }
  if (!appSecret) {
    throw new Error("App Secret cannot be empty");
  }

  const profileName = input.profileName || input.name || "";
  if (profileName) {
    validateProfileName(profileName);
  }

  const env = input.env || options.env || process.env;
  const platform = input.platform || options.platform || process.platform;
  const workspace = input.workspace !== undefined ? input.workspace : options.workspace;
  const storageOptions = {
    ...options,
    env,
    platform,
    workspace,
  };
  const brand = parseBrand(input.brand || "feishu");
  const lang = input.lang === undefined ? "zh" : input.lang;
  const existing = loadMultiAppConfig(storageOptions);
  const secretRef = forStorage(appId, appSecret, storageOptions);
  saveInitConfig(profileName, existing, appId, secretRef, brand, lang, storageOptions);

  return {
    appId,
    appSecret: "****",
    brand,
    configPath: getConfigPath(storageOptions),
    keychainID: secretRef.id,
    workspace: normalizeWorkspace(workspace, env) || "local",
  };
}

function parseArgs(argv) {
  const out = {
    brand: "feishu",
    lang: "zh",
    workspace: "auto",
    appSecretStdin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--app-id") out.appId = next();
    else if (arg.startsWith("--app-id=")) out.appId = arg.slice("--app-id=".length);
    else if (arg === "--app-secret-stdin") out.appSecretStdin = true;
    else if (arg === "--app-secret-env") out.appSecretEnv = next();
    else if (arg.startsWith("--app-secret-env=")) out.appSecretEnv = arg.slice("--app-secret-env=".length);
    else if (arg === "--brand") out.brand = next();
    else if (arg.startsWith("--brand=")) out.brand = arg.slice("--brand=".length);
    else if (arg === "--lang") out.lang = next();
    else if (arg.startsWith("--lang=")) out.lang = arg.slice("--lang=".length);
    else if (arg === "--name") out.profileName = next();
    else if (arg.startsWith("--name=")) out.profileName = arg.slice("--name=".length);
    else if (arg === "--workspace") out.workspace = next();
    else if (arg.startsWith("--workspace=")) out.workspace = arg.slice("--workspace=".length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function readSecretFromStdin() {
  const input = fs.readFileSync(0, "utf8");
  const firstLine = input.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) {
    throw new Error("stdin is empty, expected app secret");
  }
  return firstLine;
}

function usage() {
  return [
    "Usage:",
    "  printf '%s\\n' \"$APP_SECRET\" | node scripts/config-init-store.js --app-id <app_id> --app-secret-stdin [--brand feishu|lark] [--lang zh|en]",
    "  APP_SECRET=... node scripts/config-init-store.js --app-id <app_id> --app-secret-env APP_SECRET",
    "",
    "Options:",
    "  --app-id <id>             App ID to store.",
    "  --app-secret-stdin        Read App Secret from the first stdin line.",
    "  --app-secret-env <name>   Read App Secret from an environment variable.",
    "  --brand <brand>           feishu or lark. Other values match Go and become feishu.",
    "  --lang <lang>             Stored prompt language. Defaults to zh.",
    "  --name <profile>          Create/update a named profile, matching config init --name.",
    "  --workspace <value>       auto, local, openclaw, hermes, or lark-channel. Defaults to auto.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  let appSecret = "";
  if (args.appSecretStdin) {
    appSecret = readSecretFromStdin();
  } else if (args.appSecretEnv) {
    appSecret = String(process.env[args.appSecretEnv] || "").trim();
    if (!appSecret) {
      throw new Error(`environment variable ${args.appSecretEnv} is empty, expected app secret`);
    }
  } else {
    throw new Error("app secret must be provided via --app-secret-stdin or --app-secret-env");
  }

  const result = saveLarkCliConfig({
    appId: args.appId,
    appSecret,
    brand: args.brand,
    lang: args.lang,
    profileName: args.profileName,
    workspace: args.workspace,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}

export {
  SERVICE,
  KeychainAccessBlockedError,
  KeychainCorruptedError,
  KeychainNotFoundError,
  KeychainNotInitializedError,
  accountKey,
  decryptData,
  detectWorkspaceFromEnv,
  encryptData,
  forStorage,
  getBaseConfigDir,
  getConfigPath,
  getRuntimeDir,
  keychainGet,
  keychainRemove,
  keychainSet,
  parseBrand,
  safeEnvDirPath,
  safeFileName,
  saveLarkCliConfig,
  secretAccountKey,
  storageDir,
  validateProfileName,
};

export default {
  SERVICE,
  KeychainAccessBlockedError,
  KeychainCorruptedError,
  KeychainNotFoundError,
  KeychainNotInitializedError,
  accountKey,
  decryptData,
  detectWorkspaceFromEnv,
  encryptData,
  forStorage,
  getBaseConfigDir,
  getConfigPath,
  getRuntimeDir,
  keychainGet,
  keychainRemove,
  keychainSet,
  parseBrand,
  safeEnvDirPath,
  safeFileName,
  saveLarkCliConfig,
  secretAccountKey,
  storageDir,
  validateProfileName,
};