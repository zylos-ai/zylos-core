import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { claudeProjectSlug } from '../claude-project-path.js';
import { HistoryParser, scanTranscript } from './session-log-index.js';
import { parseInbound, parseOutbound, recoverInbound, safeFullText, contentBlocks, binaryBlock, textContent } from './inbound-parser.js';

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export class ClaudeHistory extends HistoryParser {
  constructor(options = {}) {
    super(options);
    this.homeDir = options.homeDir || os.homedir();
    this.zylosDir = options.zylosDir || path.join(this.homeDir, 'zylos');
    this.stateEngine = options.stateEngine;
    this.metadataCache = new Map();
    this.metadataLoads = new Map();
  }
  get projectDir() { return path.join(this.homeDir, '.claude', 'projects', claudeProjectSlug(this.zylosDir)); }
  async listSessions() {
    const sessions = [];
    const paths = new Map();
    const scanned = new Set();
    let root;
    try { root = await fs.realpath(this.projectDir); } catch {
      this.paths = paths;
      this.metadataCache.clear();
      return { runtime: 'claude', current: null, sessions };
    }
    const files = await fs.readdir(root, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const id = file.name.slice(0, -6);
      if (!SESSION_ID.test(id)) continue;
      const filePath = path.join(root, file.name);
      const stat = await fs.stat(filePath);
      scanned.add(filePath);
      const metadata = await this._titleMetadata(filePath, stat);
      sessions.push({ id, parentId: null, kind: 'main', title: metadata.title || id,
        startedAt: metadata.startedAt || stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), bytes: stat.size });
      paths.set(id, filePath);
    }
    // Include orphan subagent directories after /clear, even without .meta.json.
    for (const directory of files) {
      if (!directory.isDirectory() || !SESSION_ID.test(directory.name)) continue;
      const subRoot = path.join(root, directory.name, 'subagents');
      let subFiles;
      try {
        if (await fs.realpath(subRoot) !== subRoot) continue;
        subFiles = await fs.readdir(subRoot, { withFileTypes: true });
      } catch { continue; }
      for (const file of subFiles) {
        if (!file.isFile() || !/^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(file.name)) continue;
        const agent = file.name.slice(0, -6);
        const filePath = path.join(subRoot, file.name);
        const stat = await fs.stat(filePath);
        let title = `Subagent ${agent.slice(6)}`;
        try {
          const metaPath = path.join(subRoot, `${agent}.meta.json`);
          if (await fs.realpath(metaPath) === metaPath) title = JSON.parse(await fs.readFile(metaPath, 'utf8')).description || title;
        } catch { /* Missing metadata is expected across /clear. */ }
        const id = `${directory.name}/${agent}`;
        paths.set(id, filePath);
        sessions.push({ id, parentId: directory.name, kind: 'subagent', title,
          startedAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), bytes: stat.size });
      }
    }
    let current = this.stateEngine?.getCurrentSessionId?.() || null;
    if (!current) {
      try { current = JSON.parse(await fs.readFile(path.join(this.zylosDir, 'activity-monitor', 'statusline.json'), 'utf8')).session_id || null; }
      catch { /* No active Claude session. */ }
    }
    this.paths = paths;
    for (const filePath of this.metadataCache.keys()) {
      if (!scanned.has(filePath)) this.metadataCache.delete(filePath);
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { runtime: 'claude', current: paths.has(current) ? current : null, sessions };
  }
  _titleMetadata(filePath, stat) {
    if (!this.metadataLoads.has(filePath)) {
      this.metadataLoads.set(filePath, this._updateTitleMetadata(filePath, stat)
        .finally(() => this.metadataLoads.delete(filePath)));
    }
    return this.metadataLoads.get(filePath);
  }
  async _updateTitleMetadata(filePath, stat) {
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.metadataCache.get(filePath);
    if (cached?.version === version) return cached;
    const result = { title: cached?.title || '', startedAt: cached?.startedAt || null };
    const cursor = await scanTranscript(filePath, cached?.cursor, (text) => {
      if (text === null) return;
      // Once the fallback title and start time are known, ordinary messages
      // cannot change metadata. Do not parse their potentially large payloads.
      if (result.title && result.startedAt && !/"type"\s*:\s*"ai-title"/.test(text)) return;
      try {
        const record = JSON.parse(text);
        result.startedAt ||= record.timestamp || null;
        if (record.type === 'ai-title') result.title = record.title || record.aiTitle || result.title;
        if (!result.title && record.type === 'user' && !record.isMeta) result.title = textContent(record.message?.content);
      } catch { /* Unknown records do not hide the session. */ }
    }, () => { result.title = ''; result.startedAt = null; });
    Object.assign(result, { cursor, version: `${cursor.identity}:${cursor.size}:${cursor.mtime}` });
    this.metadataCache.set(filePath, result);
    return result;
  }
  async parseRecord(record, offset, state, sessionId) {
    const base = { ts: record.timestamp || null };
    const entry = (kind, fields, extra = {}, block = null) => ({ ...base, id: `o:${offset}${block === null ? '' : `:${block}`}`, kind, fields, ...extra });
    const internal = () => [entry('internal', { body: record })];
    if (record.type === 'attachment' && record.attachment?.type === 'queued_command') {
      const inbound = await recoverInbound(parseInbound(record.attachment.prompt ?? record.attachment.content ?? ''), { zylosDir: this.zylosDir });
      return [{ ...entry('inbound', {}), ...inbound }];
    }
    if (record.isMeta) return internal();
    if (record.type === 'system' && ['api_error', 'compact_boundary', 'session_start'].includes(record.subtype)) {
      return [entry('marker', { body: record })];
    }
    if (!['user', 'assistant'].includes(record.type)) return internal();
    const content = contentBlocks(record.message?.content ?? record.content);
    const entries = [];
    for (const [i, block] of content.entries()) {
      const id = content.length === 1 ? null : i;
      if (block.type === 'tool_result') {
        const call = state.calls.get(block.tool_use_id);
        if (call) {
          let output = block.content ?? record.toolUseResult ?? '';
          if (Array.isArray(output)) output = output.map((part, blockIndex) => {
            const binary = binaryBlock(part);
            if (binary) {
              call.binaries ||= {};
              call.binaries[`output_attachment_${blockIndex}`] = binary;
              return '[Binary attachment available separately]';
            }
            return part.type === 'text' ? part.text : part;
          });
          const persisted = record.toolUseResult?.persistedOutputPath ||
            textContent(block.content).match(/(?:Full output saved to:|Output saved to:|saved to:)\s*([^\n<]+\.txt)/i)?.[1]?.trim();
          if (persisted) {
            const recovered = await safeFullText(persisted, { toolRoot: path.join(this.projectDir, sessionId.split('/')[0], 'tool-results') });
            output = recovered.text ?? `${typeof output === 'string' ? output : JSON.stringify(output)}\n\n${recovered.unavailable}`;
          }
          call.fields.output = output;
          if (record.toolUseResult && !persisted) call.fields.result = record.toolUseResult;
          call.status = block.is_error ? 'error' : 'success';
          call.updatedOffset = offset;
          continue;
        }
        entries.push(entry('internal', { body: block }, {}, id));
      } else if (block.type === 'tool_use') {
        const outbound = /(?:^|\.)Bash$/i.test(block.name || '') ? parseOutbound(block.input?.command) : null;
        const call = entry(outbound?.kind || 'tool', { input: block.input ?? {}, ...(outbound?.fields || {}) },
          { name: block.name, status: 'running', ...(outbound ? { channel: outbound.channel, target: outbound.target, label: outbound.label } : {}) }, id);
        state.calls.set(block.id, call); entries.push(call);
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        entries.push(entry('internal', { body: 'Runtime did not save thinking content.' }, {}, id));
      } else if (binaryBlock(block)) {
        entries.push(entry(record.type === 'user' ? 'inbound' : 'text', {}, { binaries: { attachment: binaryBlock(block) } }, id));
      } else if (typeof block.text === 'string') {
        if (record.type === 'user') {
          const inbound = await recoverInbound(parseInbound(block.text), { zylosDir: this.zylosDir });
          entries.push({ ...entry('inbound', {}, {}, id), ...inbound });
        } else entries.push(entry('text', { body: block.text }, { messageId: record.message?.id || null }, id));
      } else entries.push(entry('internal', { body: block }, {}, id));
    }
    return entries.length ? entries : (content.length ? [] : internal());
  }
}
