import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadCoreModule } from './core-modules.js';
import { parseSessionGroup } from '../../comm-bridge/scripts/c4-session-group.js';
import { absorbedSummaryItems, binaryCompare as binary, scopeFor, replyVia, shellQuote } from '../../comm-bridge/scripts/c4-query-format.js';
import { renderStateSkeleton, validateStateDocument, parseStateHeader, absorbedEntry, inboxSegmentName } from '../../zylos-memory/scripts/state-format.js';

const { groupMemoryDir } = await loadCoreModule('session-group-paths.js');
const { projectC4Content } = await loadCoreModule('content-projection.js');
const { modeSwitchPreviousDir, modeSwitchDonePath, modeSwitchUngroupedPath, modeSwitchGroupPath, handoffPath } = await loadCoreModule('session-memory-paths.js');
const { writeModeSwitchFile, formatModeSwitchHandoff, parseModeSwitchHeader } = await loadCoreModule('mode-switch-files.js');
const materialName = name => ['state.md', 'inbox.md', 'handoff.md'].includes(name) || inboxSegmentName.test(name);
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Deterministic file conversion only. D9, fences, cutover and launches belong to the caller. */
export function createModeSwitchConverter({ db, zylosDir, fsImpl = fs, renderState = renderStateSkeleton, writeFile = writeModeSwitchFile } = {}) {
  const env = { ZYLOS_DIR: zylosDir };
  const memory = path.join(zylosDir, 'memory');
  const scopeDir = scope => scope === '*' ? memory : groupMemoryDir(scope, env);
  const stat = file => { try { return fsImpl.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const files = dir => {
    let names;
    try { names = fsImpl.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.filter(materialName).sort(binary).map(name => {
      const file = path.join(dir, name);
      if (!fsImpl.statSync(file).isFile()) throw failure('EINVAL', 'Memory material is not a regular file');
      return file;
    });
  };
  const write = (file, body) => {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    try { return writeFile(file, body, { fsImpl }); }
    catch (error) {
      // Preserve the underlying I/O code while retaining phase/persisted evidence.
      if (error.cause?.code) error.code = error.cause.code;
      throw error;
    }
  };
  function archive(runId, scope) {
    const previous = modeSwitchPreviousDir(runId, scope === '*' ? '_global' : scope, env);
    const done = modeSwitchDonePath(runId, scope === '*' ? '_global' : scope, env);
    if (stat(done)) return previous;
    fsImpl.mkdirSync(previous, { recursive: true });
    const sourceFiles = files(scopeDir(scope));
    // Inspect every conflict before moving any member of this scope.
    for (const source of sourceFiles) if (stat(path.join(previous, path.basename(source)))) throw failure('EEXIST', 'Source and archive both contain a memory material');
    for (const source of sourceFiles) fsImpl.renameSync(source, path.join(previous, path.basename(source)));
    write(done, '');
    return previous;
  }
  function exportRows(rows) {
    return rows.map(row => JSON.stringify({ id: row.id, direction: row.direction, channel: row.channel,
      endpoint: row.endpoint_id, timestamp: row.timestamp, content: projectC4Content(row.content, { c4Id: row.id }) })).join('\n') + (rows.length ? '\n' : '');
  }
  function sourceMaterials(transition) {
    if (transition.source_mode === 'single') return files(memory);
    const root = path.join(memory, 'session-groups'); let dirs;
    try { dirs = fsImpl.readdirSync(root, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; dirs = []; }
    const groups = [...new Set(['origin', ...dirs.filter(entry => entry.isDirectory() && parseSessionGroup(entry.name)).map(entry => entry.name)])].sort(binary);
    return groups.flatMap(group => files(groupMemoryDir(group, env)));
  }
  function handoffBody(transition, rows, summaries, materials) {
    const lines = ['# Mode Switch Handoff', '', `Total absorbed: ${rows.length}`, '', '## Absorbed Message Summary'];
    for (const item of summaries) lines.push(`- scope=${item.scope} count=${item.count} firstId=${item.firstId} lastId=${item.lastId}`);
    lines.push('', '## Recovery Materials', ...materials.map(file => `- material: ${JSON.stringify(file)}`), '',
      'Read all recovery materials completely, especially unfinished earlier handoffs. If fixed paths from multiple generations have ambiguous identities, report them for manual review; file existence does not mean recovery succeeded.', '',
      '## Follow-up Requirements', 'C4 is authoritative for absorbed messages; state lists each message and may truncate it. Confirm completeness with each page\'s end/count markers. If tool output is truncated, reread with a smaller --limit; a partial page is not complete.',
      'Read the full text first, then check message history and actual progress. Outbound audit records are only clues, not proof of delivery. Do not automatically resend when the send outcome is unknown (SEND_FAILED).',
      'For entries with textBytes over 8192, append --out <file> to the full-text command, then read the file with a file-reading tool. Supply reply bodies via stdin; do not construct commands from display routes in state.');
    if (transition.target_mode === 'multi') lines.push('Origin handles origin items and records them in its own inbox. For each other scope, use c4-send.js internal G to prompt the corresponding group and verify actual progress. Repeated prompts are allowed.');
    else lines.push('Write valid items to the global inbox in inbox format for the next Sync; note conflicts and do not concatenate state directly.');
    lines.push('Sync submits followedUpIds only for verified actual progress. Keep incomplete entries; do not remove them based solely on outbound audit records.');
    const scripts = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
    if (/[\x00-\x1f\x7f]/.test(scripts)) lines.push(rows.length ? replyVia(rows[0], path.join(scripts, 'c4-send.js')) : 'No messages were absorbed in this transition; no per-ID replies or full-text reads are needed.');
    else {
      lines.push('', `Scripts directory: ${JSON.stringify(scripts)}`);
      if (rows.length) {
        const id = String(rows[0].id);
        lines.push(`The commands below use #${id} as an example; for other entries, change only the ID, using a decimal ID verified against C4.`,
          `node ${shellQuote(path.join(scripts, 'c4-send.js'))} --absorbed-reply ${transition.run_id} ${id}`,
          `node ${shellQuote(path.join(scripts, 'c4-fetch.js'))} --absorbed --run-id ${transition.run_id} --id ${id}`);
      } else lines.push('No messages were absorbed in this transition; no per-ID replies or full-text reads are needed.');
    }
    return lines.join('\n') + '\n';
  }
  return function convert(input) {
    let step = 'check';
    try {
      const transition = db.getModeTransition({ runId: input.run_id });
      if (!transition || transition.phase !== 'converting' || transition.cutoff === null || !Array.isArray(transition.absorbed_ids) || !transition.coverage_snapshot) throw failure('ABSORBED_MISMATCH', 'Transition has no authoritative absorbed snapshot');
      const rows = db.getAbsorbedConversations(transition.run_id);
      if (!isDeepStrictEqual(rows.map(row => row.id), transition.absorbed_ids)) throw failure('ABSORBED_MISMATCH', 'Absorbed rows do not match the transition');
      const summaries = absorbedSummaryItems({ transition, rows });
      const scopes = transition.target_mode === 'single' ? ['*'] : [...new Set(['origin', ...db.listGroupHeads().map(row => row.sessionGroup)])].sort(binary);
      for (const item of summaries) if (!scopes.includes(item.scope)) throw failure('ABSORBED_MISMATCH', 'Absorbed scope is missing from group heads');
      const byScope = new Map(scopes.map(scope => [scope, []]));
      for (const row of rows) byScope.get(scopeFor(transition, row)).push({
        id: row.id, timestamp: row.timestamp, sessionGroup: row.session_group, channel: row.channel, endpointId: row.endpoint_id, content: row.content,
      });
      step = 'archive';
      const archives = scopes.map(scope => archive(transition.run_id, scope));
      const materials = [...sourceMaterials(transition), ...archives.flatMap(dir => files(dir).filter(file => path.basename(file) === 'handoff.md'))];
      step = 'skeleton';
      const expected = new Map();
      const syncedAt = new Date(transition.created_at * 1000).toISOString();
      for (const scope of scopes) {
        const scopedRows = byScope.get(scope);
        const body = renderState({ scope, syncedAt, absorbed: scopedRows.length ? { runId: transition.run_id, followUp: scope === '*' || scope === 'origin' ? 'main' : 'group', rows: scopedRows } : null });
        expected.set(scope, body); write(path.join(scopeDir(scope), 'state.md'), body);
      }
      step = 'export';
      if (transition.source_mode === 'single') {
        const file = modeSwitchUngroupedPath(transition.run_id, env);
        write(file, exportRows(db.getGlobalUnsummarizedConversations({ upToConversationId: transition.cutoff }).filter(row => !row.session_group))); materials.push(file);
      } else {
        for (const group of Object.keys(transition.coverage_snapshot).sort(binary)) {
          const upToConversationId = Math.min(db.getDeliveredFrontier(group), transition.cutoff);
          const file = modeSwitchGroupPath(transition.run_id, group, env);
          write(file, exportRows(db.getUnsummarizedConversations(group, { upToConversationId }))); materials.push(file);
        }
      }
      const sortedMaterials = [...new Set(materials)].sort(binary);
      const header = { runId: transition.run_id, cutoff: transition.cutoff, source: transition.source_mode, target: transition.target_mode };
      const handoff = handoffPath(transition.target_mode === 'multi' ? 'origin' : null, env);
      step = 'handoff';
      write(handoff, formatModeSwitchHandoff(header, handoffBody(transition, rows, summaries, sortedMaterials)));
      step = 'check';
      for (const scope of scopes) {
        const actual = fsImpl.readFileSync(path.join(scopeDir(scope), 'state.md'), 'utf8');
        const parsed = parseStateHeader(actual, { scope });
        if (!validateStateDocument(actual, { scope }) || parsed.coverage !== null || parsed.inboxCommitted.length || actual !== expected.get(scope)) throw failure('ABSORBED_MISMATCH', 'Written state does not match its complete skeleton');
        const pending = actual.split('\n## Pending\n')[1]?.split('\n## Commitments\n')[0] ?? '';
        const ids = pending.split('\n').map(line => absorbedEntry.exec(line)?.[1]).filter(Boolean);
        const item = summaries.find(item => item.scope === scope);
        if (ids.length !== (item?.count ?? 0) || (ids.length && (ids[0] !== String(item.firstId) || ids.at(-1) !== String(item.lastId))) || (!ids.length && pending.trim())) throw failure('ABSORBED_MISMATCH', 'Written Pending does not match the complete absorbed summary');
      }
      const actualHandoff = fsImpl.readFileSync(handoff, 'utf8');
      if (!isDeepStrictEqual(parseModeSwitchHeader(actualHandoff), header)) throw failure('ABSORBED_MISMATCH', 'Handoff header mismatch');
      const actualMaterials = actualHandoff.split('\n').filter(line => line.startsWith('- material: ')).map(line => JSON.parse(line.slice(12)));
      if (!isDeepStrictEqual(actualMaterials, sortedMaterials)) throw failure('ABSORBED_MISMATCH', 'Handoff omits recovery material');
      for (const file of actualMaterials) if (!fsImpl.statSync(file).isFile()) throw failure('ENOENT', 'Recovery material is missing');
      return { runId: transition.run_id, scopes, handoff, materials: sortedMaterials };
    } catch (error) { error.step = step; throw error; }
  };
}
