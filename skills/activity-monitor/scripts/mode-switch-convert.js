import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadCoreModule } from './core-modules.js';
import { parseSessionGroup } from '../../comm-bridge/scripts/c4-session-group.js';
import { formatAbsorbedSummary, replyVia, shellQuote } from '../../comm-bridge/scripts/c4-query-format.js';
import { renderStateSkeleton, validateStateDocument, parseStateHeader, absorbedEntry } from '../../zylos-memory/scripts/state-format.js';

const { groupMemoryDir } = await loadCoreModule('session-group-paths.js');
const { modeSwitchPreviousDir, modeSwitchDonePath, modeSwitchUngroupedPath, modeSwitchGroupPath, handoffPath } = await loadCoreModule('session-memory-paths.js');
const { writeModeSwitchFile, formatModeSwitchHandoff, parseModeSwitchHeader } = await loadCoreModule('mode-switch-files.js');
const binary = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const materialName = name => ['state.md', 'inbox.md', 'handoff.md'].includes(name) || /^inbox\.\d{8}T\d{9}Z(?:-[1-9]\d*)?\.md$/.test(name);
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
  function summary(transition, rows) {
    const items = []; let scopeAfter;
    do {
      const page = JSON.parse(formatAbsorbedSummary({ transition, rows }, { scopeAfter, json: true })).data;
      items.push(...page.items); scopeAfter = page.nextScope;
    } while (scopeAfter !== null);
    return items;
  }
  function exportRows(rows) {
    return rows.map(row => JSON.stringify({ id: row.id, direction: row.direction, channel: row.channel,
      endpoint: row.endpoint_id, timestamp: row.timestamp, content: row.content })).join('\n') + (rows.length ? '\n' : '');
  }
  function sourceMaterials(transition) {
    if (transition.source_mode === 'single') return files(memory);
    const root = path.join(memory, 'session-groups'); let dirs;
    try { dirs = fsImpl.readdirSync(root, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; dirs = []; }
    const groups = [...new Set(['origin', ...dirs.filter(entry => entry.isDirectory() && parseSessionGroup(entry.name)).map(entry => entry.name)])].sort(binary);
    return groups.flatMap(group => files(groupMemoryDir(group, env)));
  }
  function handoffBody(transition, rows, summaries, materials) {
    const lines = ['# 模式切换交接', '', `吸收总数：${rows.length}`, '', '## 吸收来信摘要'];
    for (const item of summaries) lines.push(`- scope=${item.scope} count=${item.count} firstId=${item.firstId} lastId=${item.lastId}`);
    lines.push('', '## 恢复材料', ...materials.map(file => `- material: ${JSON.stringify(file)}`), '',
      '完整读取所有恢复材料，尤其是其中未完成的旧 handoff。多代固定路径身份不明时报告人工核对，不把文件存在当作恢复成功。', '',
      '## 跟进要求', '被吸收来信以 C4 为准，state 中逐条列出、可能截断。按分页的 end/count 标记确认读完；工具输出截断时用更小 --limit 重读，不能把半页当作读完。',
      '先读全文，再核对消息历史和实际进度；出站审计只是线索，不代表已送达。发送结果未知（SEND_FAILED）不得自动重发。',
      'textBytes 超过 8192 的条目在全文命令后加 --out <file>，再用读文件工具读取。回复正文经 stdin 输入；不得从 state 中的显示路由拼接命令。');
    if (transition.target_mode === 'multi') lines.push('Origin 处理 origin 事项并记入自己的 inbox；逐个其余 scope 经 c4-send.js internal G 提示对应组，核对实际进度，允许重复提示。');
    else lines.push('把有效事项按 inbox 格式写入全局 inbox，交下次 Sync；注明冲突，不直接拼接 state。');
    lines.push('Sync 只根据已核实的实际进度提交 followedUpIds；未完成条目保留，不能仅凭出站审计移出。');
    const scripts = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
    if (/[\x00-\x1f\x7f]/.test(scripts)) lines.push(rows.length ? replyVia(rows[0], path.join(scripts, 'c4-send.js')) : '本次没有被吸收来信，无需按 id 回复或读取全文。');
    else {
      lines.push('', `脚本目录：${JSON.stringify(scripts)}`);
      if (rows.length) {
        const id = String(rows[0].id);
        if (!/^[0-9]+$/.test(id)) throw failure('ABSORBED_MISMATCH', 'Invalid absorbed ID');
        lines.push(`以下以 #${id} 为例；处理其他条目时只替换经过 C4 核验的十进制 id。`,
          `node ${shellQuote(path.join(scripts, 'c4-send.js'))} --absorbed-reply ${transition.run_id} ${id}`,
          `node ${shellQuote(path.join(scripts, 'c4-fetch.js'))} --absorbed --run-id ${transition.run_id} --id ${id}`);
      } else lines.push('本次没有被吸收来信，无需按 id 回复或读取全文。');
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
      const summaries = summary(transition, rows);
      const scopes = transition.target_mode === 'single' ? ['*'] : [...new Set(['origin', ...db.listGroupHeads().map(row => row.sessionGroup)])].sort(binary);
      for (const item of summaries) if (!scopes.includes(item.scope)) throw failure('ABSORBED_MISMATCH', 'Absorbed scope is missing from group heads');
      const byScope = new Map(scopes.map(scope => [scope, []]));
      for (const row of rows) byScope.get(transition.target_mode === 'single' ? '*' : row.session_group || 'origin').push({
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
