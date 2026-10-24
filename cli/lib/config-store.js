import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function configUnreadable(error, message = 'Zylos configuration is unreadable') {
  const wrapped = new Error(`${message}: ${error?.message || error}`);
  wrapped.code = 'CONFIG_UNREADABLE';
  wrapped.cause = error;
  return wrapped;
}
export function readConfigStrict(configFile, { readFileSync = fs.readFileSync } = {}) {
  let source;
  try {
    source = readFileSync(configFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'error', error };
  }

  try {
    const config = JSON.parse(source);
    if (config === null || Array.isArray(config) || typeof config !== 'object') {
      throw new TypeError('config.json root must be a JSON object');
    }
    return { state: 'ok', config };
  } catch (error) {
    return { state: 'error', error };
  }
}
function isPlainObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value, location = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError(`${location} is not a JSON value`);
  if (seen.has(value)) throw new TypeError(`${location} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${location}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${location} must be a plain JSON object`);
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${location}.${key}`, seen);
  }
  seen.delete(value);
}

export function validateUpdateIntent(update) {
  if (!isPlainObject(update)) throw new TypeError('config update must be an object');
  const allowed = new Set(['set', 'setIfAbsent']);
  for (const key of Object.keys(update)) {
    if (!allowed.has(key)) throw new TypeError(`unknown config update operation: ${key}`);
  }
  const set = update.set ?? {};
  const setIfAbsent = update.setIfAbsent ?? {};
  if (!isPlainObject(set) || !isPlainObject(setIfAbsent)) {
    throw new TypeError('set and setIfAbsent must be objects');
  }
  if (Object.keys(set).length === 0 && Object.keys(setIfAbsent).length === 0) {
    throw new TypeError('config update must contain at least one key');
  }
  for (const key of Object.keys(set)) {
    if (Object.hasOwn(setIfAbsent, key)) {
      throw new TypeError(`config key appears in both set and setIfAbsent: ${key}`);
    }
  }
  assertJsonValue(set, 'set');
  assertJsonValue(setIfAbsent, 'setIfAbsent');
  return { set, setIfAbsent };
}

export function evaluateConfigUpdate(current, update) {
  const { set, setIfAbsent } = validateUpdateIntent(update);
  const config = Object.fromEntries(Object.entries(current));
  const previous = {};
  const written = [];
  const skipped = [];
  const touched = [...Object.keys(set), ...Object.keys(setIfAbsent)];

  for (const key of touched) {
    if (Object.hasOwn(current, key)) {
      Object.defineProperty(previous, key, {
        value: current[key], enumerable: true, writable: true, configurable: true,
      });
    }
  }
  for (const [key, value] of Object.entries(set)) {
    if (!Object.hasOwn(current, key) || !Object.is(current[key], value)) {
      Object.defineProperty(config, key, {
        value, enumerable: true, writable: true, configurable: true,
      });
      written.push(key);
    }
  }
  for (const [key, value] of Object.entries(setIfAbsent)) {
    if (Object.hasOwn(current, key)) {
      skipped.push(key);
    } else {
      Object.defineProperty(config, key, {
        value, enumerable: true, writable: true, configurable: true,
      });
      written.push(key);
    }
  }
  return { changed: written.length > 0, written, skipped, previous, config };
}

function writeFailure(error, phase, persisted) {
  const wrapped = new Error(`Failed to write Zylos configuration (${phase}): ${error?.message || error}`);
  wrapped.code = 'CONFIG_WRITE_FAILED';
  wrapped.phase = phase;
  wrapped.persisted = persisted;
  wrapped.cause = error;
  return wrapped;
}

export function updateConfigStore(configFile, update, {
  mkdirSync = fs.mkdirSync,
  openSync = fs.openSync,
  writeFileSync = fs.writeFileSync,
  fsyncSync = fs.fsyncSync,
  closeSync = fs.closeSync,
  renameSync = fs.renameSync,
  unlinkSync = fs.unlinkSync,
  randomUUID = crypto.randomUUID,
  read = readConfigStrict,
  faultInjector = () => {},
} = {}) {
  const strict = read(configFile);
  if (strict.state === 'error') throw configUnreadable(strict.error);
  const result = evaluateConfigUpdate(strict.state === 'ok' ? strict.config : {}, update);
  if (!result.changed) return result;

  const configDir = path.dirname(configFile);
  const tempFile = path.join(configDir, `.${path.basename(configFile)}.tmp.${process.pid}.${randomUUID()}`);
  let tempFd;
  let renamed = false;
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    tempFd = openSync(tempFile, 'wx', 0o600);
    writeFileSync(tempFd, JSON.stringify(result.config, null, 2) + '\n', 'utf8');
    fsyncSync(tempFd);
    faultInjector('after_temp_fsync', { tempFile, configFile });
    closeSync(tempFd);
    tempFd = undefined;
    faultInjector('before_rename', { tempFile, configFile });
    renameSync(tempFile, configFile);
    renamed = true;
    faultInjector('after_rename', { tempFile, configFile, result });
    const dirFd = openSync(configDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return result;
  } catch (error) {
    if (tempFd !== undefined) {
      try { closeSync(tempFd); } catch {}
    }
    if (!renamed) {
      try { unlinkSync(tempFile); } catch {}
    }
    throw writeFailure(error, renamed ? 'after_rename' : 'before_rename', renamed ? null : []);
  }
}
