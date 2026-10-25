#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { guard, memoryScope, memoryError } from './sync-lock.js';
import { parseStateHeader, validateStateDocument } from './state-format.js';
import { inputError, isMain, options, parseJson, readInput, runCli } from './sync-cli.js';

const segment = /^inbox\.(\d{8}T\d{9}Z(?:-[1-9]\d*)?)\.md$/;
const absorbedTitle = /^- \[切换来信\] run=(\S+) 共 \d+ 条（#\d+–#\d+）；回复：c4-send\.js --absorbed-reply \1 <id>；全文：c4-fetch\.js --absorbed --run-id \1 --id <id>$/;
const absorbedEntry = /^- #(\d+) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[.*\] .*$/;
const warn = message => console.error(`Warning: ${message}`);
const lines = text => (text.match(/[^\n]*(?:\n|$)/g) || []).filter(Boolean).map(raw => ({ raw, text: raw.replace(/\r?\n$/, '') }));
function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function names(dir) {
  try { return fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const kindFor = async env => (await memoryScope(env)).sessionGroup === null ? 'global' : 'group';
const locked = async (settings, body, deps) => guard({ ...settings, kind: await kindFor(settings.env) }, body, deps);

export function extractAbsorbedBlock(text) {
  const all = lines(text), pending = all.findIndex(line => line.text === '## Pending');
  let start = pending + 1;
  if (pending < 0) return { title: null, entries: [] };
  while (start < all.length && /^\s*$/.test(all[start].text)) start++;
  if (!all[start] || !absorbedTitle.test(all[start].text)) return { title: null, entries: [] };
  const entries = [];
  for (let i = start + 1; i < all.length; i++) {
    const match = absorbedEntry.exec(all[i].text);
    if (!match) break;
    entries.push({ id: Number(match[1]), raw: all[i].raw });
  }
  return { title: all[start].raw, entries };
}
export function composeState(official, temporary, followedUpIds, warning = warn) {
  if (!Array.isArray(followedUpIds) || followedUpIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw inputError('followedUpIds must contain positive integer IDs');
  const block = extractAbsorbedBlock(official), known = new Set(block.entries.map(entry => entry.id));
  if (followedUpIds.some(id => !known.has(id))) throw inputError('followedUpIds contains an ID absent from the official Pending block');
  const followed = new Set(followedUpIds), remaining = block.entries.filter(entry => !followed.has(entry.id));
  let removed = 0;
  const clean = lines(temporary).filter(line => {
    if (absorbedTitle.test(line.text) || absorbedEntry.test(line.text)) { removed++; return false; }
    return true;
  });
  if (removed) warning(`Removed ${removed} copied absorbed-message lines from temporary state`);
  const pending = clean.findIndex(line => line.text === '## Pending');
  if (remaining.length && pending >= 0) {
    let start = pending + 1;
    while (start < clean.length && /^\s*$/.test(clean[start].text)) start++;
    let preserved = block.title + remaining.map(entry => entry.raw).join('');
    if (!preserved.endsWith('\n')) preserved += '\n';
    clean.splice(start, 0, { raw: preserved });
  }
  return clean.map(line => line.raw).join('');
}
function deleteSegments(dir, ids, warning = warn, tolerateFailure = false) {
  for (const id of ids) {
    try { fs.unlinkSync(path.join(dir, `inbox.${id}.md`)); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (!tolerateFailure) throw error;
      warning(`Could not remove committed segment ${id}: ${error.message}`);
    }
  }
}

export async function cleanup(settings = {}, deps = {}) {
  return locked(settings, ({ memoryDir, scope, assertHeld }) => {
    const header = parseStateHeader(readOptional(path.join(memoryDir, 'state.md')), { scope });
    if (header.valid) { assertHeld(); deleteSegments(memoryDir, header.inboxCommitted, deps.warning); }
    else (deps.warning || warn)('Invalid state header; all inbox segments retained');
    for (const name of names(memoryDir)) {
      if (/^state\.md\.[^.]+\.tmp$/.test(name) && name !== `state.md.${settings.token}.tmp`) {
        assertHeld(); fs.unlinkSync(path.join(memoryDir, name));
      }
    }
  }, deps);
}
export async function rotate(settings = {}, deps = {}) {
  return locked(settings, ({ memoryDir, assertHeld }) => {
    const inbox = path.join(memoryDir, 'inbox.md');
    let stat;
    try { stat = fs.statSync(inbox); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.size) return null;
    const id = new Date().toISOString().replace(/[-:.]/g, '');
    let chosen = id, suffix = 0;
    while (fs.existsSync(path.join(memoryDir, `inbox.${chosen}.md`))) chosen = `${id}-${++suffix}`;
    assertHeld(); fs.renameSync(inbox, path.join(memoryDir, `inbox.${chosen}.md`));
    return chosen;
  }, deps);
}
export async function list({ env = process.env } = {}) {
  const { memoryDir, scope } = await memoryScope(env);
  const header = parseStateHeader(readOptional(path.join(memoryDir, 'state.md')), { scope });
  const committed = new Set(header.valid ? header.inboxCommitted : []);
  return names(memoryDir).map(name => segment.exec(name)?.[1]).filter(id => id && !committed.has(id)).sort();
}
export async function checkpoint({ end, summary, noContent = false, ...settings }, deps = {}) {
  return locked(settings, async ({ scope, assertHeld }) => {
    const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
    assertHeld();
    return database.createCheckpoint(scope, end, noContent ? null : summary, { noContent });
  }, deps);
}
export async function commit({ input, ...settings }, deps = {}) {
  const payload = typeof input === 'string' ? parseJson(input) : input;
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' || !Array.isArray(payload.followedUpIds) || payload.followedUpIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw inputError('Expected {followedUpIds:[positive integer IDs]}');
  return locked(settings, ({ memoryDir, scope, assertHeld }) => {
    const officialPath = path.join(memoryDir, 'state.md'), temporaryPath = `${officialPath}.${settings.token}.tmp`;
    const official = readOptional(officialPath);
    let temporary;
    try { temporary = fs.readFileSync(temporaryPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') throw memoryError('STATE_DOCUMENT_INVALID', 'Temporary state is missing'); throw error; }
    const combined = composeState(official, temporary, payload.followedUpIds, deps.warning);
    if (!validateStateDocument(combined, { scope })) throw memoryError('STATE_DOCUMENT_INVALID', 'State header or required sections are invalid');
    const header = parseStateHeader(combined, { scope });
    assertHeld();
    fs.writeFileSync(temporaryPath, combined, 'utf8');
    assertHeld();
    fs.renameSync(temporaryPath, officialPath);
    // Publication is complete. A failed delete cannot roll back the state.
    deleteSegments(memoryDir, header.inboxCommitted, deps.warning, true);
    return { committed: true, inboxCommitted: header.inboxCommitted };
  }, deps);
}

if (isMain(import.meta.url)) await runCli(async () => {
  const [command, ...args] = process.argv.slice(2);
  const parsed = options(args, ['token'], command === 'checkpoint' ? ['no-content'] : []);
  if (!['cleanup', 'rotate', 'list', 'checkpoint', 'commit'].includes(command) || parsed.positional.length !== (command === 'checkpoint' ? 1 : 0) || (command !== 'list' && !parsed.token) || (command === 'list' && parsed.token)) throw inputError('Invalid command or arguments');
  const settings = { token: parsed.token };
  let result;
  if (command === 'cleanup') result = await cleanup(settings);
  if (command === 'rotate') result = await rotate(settings);
  if (command === 'list') result = await list();
  if (command === 'checkpoint') result = await checkpoint({ ...settings, end: Number(parsed.positional[0]), noContent: !!parsed['no-content'], summary: parsed['no-content'] ? null : readInput() });
  if (command === 'commit') result = await commit({ ...settings, input: readInput() });
  if (result !== undefined) console.log(JSON.stringify(result));
});
