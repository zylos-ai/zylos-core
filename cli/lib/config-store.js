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
  const allowed = new Set(['set', 'setIfAbsent', 'merge', 'mergeIfAbsent']);
  for (const key of Object.keys(update)) {
    if (!allowed.has(key)) throw new TypeError(`unknown config update operation: ${key}`);
  }
  const operations = Object.fromEntries([...allowed].map(key => [key, update[key] ?? {}]));
  const used = new Set();
  for (const [operation, values] of Object.entries(operations)) {
    if (!isPlainObject(values)) throw new TypeError(`${operation} must be an object`);
    assertJsonValue(values, operation);
    for (const key of Object.keys(values)) {
      if (used.has(key)) throw new TypeError(`config key appears in multiple operations: ${key}`);
      used.add(key);
    }
  }
  if (!used.size) throw new TypeError('config update must contain at least one key');
  return operations;
}

function define(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}
function mergeLeaves(current, incoming, onlyAbsent) {
  const result = Object.fromEntries(Object.entries(current));
  for (const [key, value] of Object.entries(incoming)) {
    const present = Object.hasOwn(current, key);
    if (isPlainObject(value) && (!present || isPlainObject(current[key]))) {
      define(result, key, mergeLeaves(present ? current[key] : {}, value, onlyAbsent));
    } else if (!onlyAbsent || !present) {
      define(result, key, value);
    }
  }
  return result;
}

export function evaluateConfigUpdate(current, update) {
  const operations = validateUpdateIntent(update);
  const config = Object.fromEntries(Object.entries(current));
  const previous = {};
  const written = [];
  const skipped = [];
  for (const [operation, values] of Object.entries(operations)) {
    for (const [key, value] of Object.entries(values)) {
      const present = Object.hasOwn(current, key);
      if (present) define(previous, key, current[key]);
      if (operation === 'setIfAbsent' && present) { skipped.push(key); continue; }
      let next = value;
      if (operation === 'merge' || operation === 'mergeIfAbsent') {
        if (operation === 'mergeIfAbsent' && present && !isPlainObject(current[key])) {
          skipped.push(key); continue;
        }
        next = isPlainObject(value)
          ? mergeLeaves(isPlainObject(current[key]) ? current[key] : {}, value, operation === 'mergeIfAbsent')
          : operation === 'mergeIfAbsent' && present ? current[key] : value;
      }
      const equal = present && (Object.is(current[key], next)
        || ((operation === 'merge' || operation === 'mergeIfAbsent')
          && typeof next === 'object' && JSON.stringify(current[key]) === JSON.stringify(next)));
      if (equal) { if (operation === 'mergeIfAbsent') skipped.push(key); continue; }
      define(config, key, next);
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
