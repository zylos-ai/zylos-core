import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HistoryParser, SessionLogIndex } from './session-log-index.js';
import { parseInbound, parseOutbound, recoverInbound, contentBlocks, binaryBlock } from './inbound-parser.js';

function toolArguments(value) {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return value; }
}
function injectedUser(text) {
  return /^(?:# AGENTS\.md instructions|System startup trigger|<environment_context>|<INSTRUCTIONS>)/.test(text.trim());
}
export class CodexHistory extends HistoryParser {
  constructor(options = {}) {
    super(options);
    this.store = options.store;
    this.metadataCache = new Map();
    this.homeDir = options.homeDir || os.homedir();
    this.zylosDir = options.zylosDir || path.join(this.homeDir, 'zylos');
  }
  async listSessions() {
    const rows = this.store?.listCodexRolloutPaths?.('codex') || this.store?.db?.prepare(
      'SELECT * FROM codex_rollout_paths WHERE runtime = ? ORDER BY updated_at DESC'
    ).all('codex') || [];
    const sessions = [], paths = new Map();
    const scanned = new Set();
    let root;
    try { root = await fs.realpath(path.join(this.homeDir, '.codex', 'sessions')); }
    catch {
      this.paths = paths;
      this.metadataCache.clear();
      return { runtime: 'codex', current: null, sessions };
    }
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.session_id)) continue;
      try {
        const filePath = await fs.realpath(row.transcript_path);
        if (!filePath.startsWith(root + path.sep) || !/^rollout-[^/]+\.jsonl$/.test(path.basename(filePath))) continue;
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        // Hidden subagent rollouts also need warm metadata on the next list.
        scanned.add(filePath);
        let metadata = this.metadataCache.get(filePath);
        if (!metadata || metadata.ino !== stat.ino) {
          const index = await new SessionLogIndex(filePath).update();
          metadata = { title: row.session_id, startedAt: stat.birthtime.toISOString(), subagent: false, ino: stat.ino };
          for (const line of index.lines.slice(0, 8)) {
            if (line.deferred) continue;
            const record = JSON.parse(await index.readLine(line));
            if (record.type !== 'session_meta') continue;
            metadata.startedAt = record.timestamp || metadata.startedAt;
            metadata.subagent = Boolean(record.payload?.source?.subagent || record.payload?.forked_from_id ||
              record.payload?.subagent_history_start_ordinal !== undefined || record.payload?.source === 'subagent');
            break;
          }
          this.metadataCache.set(filePath, metadata);
        }
        if (metadata.subagent) continue;
        paths.set(row.session_id, filePath);
        sessions.push({ id: row.session_id, parentId: null, kind: 'main', title: metadata.title,
          startedAt: metadata.startedAt, updatedAt: stat.mtime.toISOString(), bytes: stat.size });
      } catch { /* Missing/invalid rollout paths do not break the list. */ }
    }
    this.paths = paths;
    for (const filePath of this.metadataCache.keys()) {
      if (!scanned.has(filePath)) this.metadataCache.delete(filePath);
    }
    const latest = this.store?.latestCodexRolloutPath?.('codex');
    const current = paths.has(latest?.session_id) ? latest.session_id : null;
    return { runtime: 'codex', current, sessions };
  }
  async parseRecord(record, offset, state) {
    const payload = record.payload || {};
    const entry = (kind, fields, extra = {}, block = null) => ({ id: `o:${offset}${block === null ? '' : `:${block}`}`,
      ts: record.timestamp || payload.timestamp || null, kind, fields, ...extra });
    const internal = () => [entry('internal', { body: record })];
    if (record.type === 'turn_context' || payload.type === 'task_started') {
      state.turn = payload.turn_id || payload.id || state.turn;
      return internal();
    }
    if (record.type === 'session_meta' || ['compacted', 'turn_aborted'].includes(record.type) ||
        ['compacted', 'turn_aborted'].includes(payload.type)) return [entry('marker', { body: record })];
    const item = record.type === 'response_item' ? payload : payload.type === 'response_item' ? (payload.item || payload) : null;
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const input = toolArguments(item.arguments ?? item.input);
      const name = item.name || 'Tool';
      const command = typeof input === 'string' ? input : input.cmd || input.command || input.code;
      const outbound = /(?:^|\.)(?:exec|exec_command)$/.test(name) ? parseOutbound(command) : null;
      const call = entry(outbound?.kind || 'tool', { input, ...(outbound?.fields || {}) },
        { name, status: 'running', ...(outbound ? { channel: outbound.channel, target: outbound.target, label: outbound.label } : {}) });
      state.calls.set(item.call_id, call);
      state.nearest.set(payload.turn_id || state.turn || '', call);
      return [call];
    }
    if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      const call = state.calls.get(item.call_id);
      if (!call) return internal();
      call.fields.output = item.output ?? '';
      call.status = /(?:Process exited with code [1-9]|"exit_code"\s*:\s*[1-9]|"isError"\s*:\s*true)/.test(String(item.output)) ? 'error' : 'success';
      if (call.commandOutputs?.length) {
        call.fields.commands = call.commandOutputs;
        if (/truncated output|output.*truncated/i.test(String(item.output))) {
          call.fields.modelOutput = item.output;
          call.fields.output = call.commandOutputs.map(command => command.output).join('\n');
        }
      }
      call.updatedOffset = offset;
      return [];
    }
    if (payload.type === 'item_completed' && ['CommandExecution', 'command_execution'].includes(payload.item?.type)) {
      const turn = payload.turn_id || state.turn || '';
      const call = state.nearest.get(turn);
      if (!call) return internal();
      const command = payload.item;
      call.commandOutputs ||= [];
      call.commandOutputs.push({ command: command.command, output: command.aggregated_output ?? command.formatted_output ?? '',
        status: command.status, exitCode: command.exit_code });
      call.fields.commands = call.commandOutputs;
      if (typeof call.fields.output === 'string' && /truncated output|output.*truncated/i.test(call.fields.output)) {
        call.fields.modelOutput = call.fields.output;
        call.fields.output = call.commandOutputs.map(command => command.output).join('\n');
      } else if (call.fields.modelOutput) {
        call.fields.output = call.commandOutputs.map(command => command.output).join('\n');
      }
      // Output visible to the model can be truncated; retain it and expose the
      // complete command output separately without losing command boundaries.
      call.status = command.exit_code != null && command.exit_code !== 0 ? 'error' : command.status === 'in_progress' ? 'running' : 'success';
      call.updatedOffset = offset;
      return [];
    }
    if (item?.type === 'reasoning' || payload.item?.type === 'Reasoning') {
      return [entry('internal', { body: 'Runtime did not save thinking content.' })];
    }
    if (item?.type === 'message') {
      const entries = [];
      const blocks = contentBlocks(item.content);
      for (const [i, block] of blocks.entries()) {
        const blockId = blocks.length === 1 ? null : i;
        const binary = binaryBlock(block);
        if (binary) entries.push(entry(item.role === 'user' ? 'inbound' : item.role === 'assistant' ? 'text' : 'internal', {},
          { binaries: { attachment: binary } }, blockId));
        else if (typeof block.text === 'string') {
          if (item.role === 'user' && !injectedUser(block.text)) {
            const inbound = await recoverInbound(parseInbound(block.text), { zylosDir: this.zylosDir });
            entries.push({ ...entry('inbound', {}, {}, blockId), ...inbound });
          } else entries.push(entry(item.role === 'assistant' ? 'text' : 'internal', { body: block.text }, {}, blockId));
        } else entries.push(entry('internal', { body: block }, {}, blockId));
      }
      return entries.length ? entries : internal();
    }
    return internal();
  }
}
