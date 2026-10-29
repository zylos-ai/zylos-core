import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { loadCoreModule } from './core-modules.js';
import { Sanitizer } from './sanitizer.js';
import { createRedactor, UNAVAILABLE } from './redaction/engine.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = row => `${row.file_dev}:${row.file_ino}`;
const HOOKS = {
  session_start: ['SessionStart', 'session_start', 'session'],
  prompt: ['UserPromptSubmit', 'user_prompt_submit', 'turn'],
  pre_tool: ['PreToolUse', 'pre_tool_use', 'tool'],
  post_tool: ['PostToolUse', 'post_tool_use', 'tool'],
  post_tool_failure: ['PostToolUseFailure', 'post_tool_failure', 'tool'],
  permission_request: ['PermissionRequest', 'permission_request', 'permission'],
  stop: ['Stop', 'stop', 'turn'], idle: ['Notification', 'idle', 'session'],
  subagent_start: ['SubagentStart', 'subagent_start', 'subagent'],
  subagent_stop: ['SubagentStop', 'subagent_stop', 'subagent'],
};
const DIAGNOSTIC_FIELDS = ['decision', 'reason', 'request_id', 'conversation_id', 'control_id',
  'phase', 'result', 'action', 'target_run_id', 'ready', 'starting', 'reclaiming', 'waiting',
  'capacity', 'busy', 'idle', 'queue_depth', 'from', 'to', 'error_code', 'error',
  'requestId', 'runId', 'sessionId', 'oldSessionId', 'sessionGroup',
  'type', 'reason_code', 'channel', 'endpoint', 'detail'];
const IDENTITY_FIELDS = new Set(['sessionGroup', 'runId', 'sessionId', 'oldSessionId',
  'target_run_id', 'requestId', 'request_id', 'control_id', 'conversation_id']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value)
  ? value : typeof value === 'number' && Number.isFinite(value) ? value : null;
const string = value => typeof value === 'string' && value.length > 0 ? value : null;

/** Serial, restartable observer. Never drives current state or Core decisions. */
export class CoreLogImporter {
  constructor({ store, zylosDir, sanitizer = new Sanitizer(zylosDir), redactor,
    batchLines = 200, batchBytes = 256 * 1024, intervalMs = 1000,
    onImport = () => {}, statFile = handle => handle.stat(), transactionObserver,
    readDirectory = dir => fs.readdir(dir) } = {}) {
    this.store = store;
    this.zylosDir = zylosDir;
    this.sanitizer = sanitizer;
    this.redactor = redactor || createRedactor({ zylosDir });
    this.ownsRedactor = !redactor;
    this.batchLines = Math.max(1, batchLines);
    this.batchBytes = Math.max(4096, batchBytes);
    this.intervalMs = intervalMs;
    this.onImport = onImport;
    this.statFile = statFile;
    this.transactionObserver = transactionObserver;
    this.readDirectory = readDirectory;
    this.stopping = false;
    this.running = null;
    this.timer = null;
    this.current = store.db.prepare(`SELECT * FROM core_log_cursors
      WHERE stream = ? AND file_dev = ? AND file_ino = ? ORDER BY generation DESC LIMIT 1`);
    this.cursors = store.db.prepare(`SELECT c.* FROM core_log_cursors c WHERE stream = ?
      AND generation = (SELECT MAX(generation) FROM core_log_cursors n
        WHERE n.stream=c.stream AND n.file_dev=c.file_dev AND n.file_ino=c.file_ino)`);
    this.put = store.db.prepare(`INSERT INTO core_log_cursors
      (stream,file_dev,file_ino,generation,anchor_len,anchor_sha256,file_name,byte_offset,status)
      VALUES (@stream,@file_dev,@file_ino,@generation,@anchor_len,@anchor_sha256,@file_name,@byte_offset,@status)
      ON CONFLICT(stream,file_dev,file_ino,generation) DO UPDATE SET
      anchor_len=excluded.anchor_len,anchor_sha256=excluded.anchor_sha256,file_name=excluded.file_name,
      byte_offset=excluded.byte_offset,status=excluded.status,updated_at=datetime('now')`);
    this.mark = store.db.prepare(`UPDATE core_log_cursors SET status=?,updated_at=datetime('now')
      WHERE stream=? AND file_dev=? AND file_ino=? AND generation=? AND status='active'`);
  }

  start() {
    if (this.timer || this.stopping) return;
    const tick = () => { this.poll().catch(() => {}); };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
    tick();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    await this.running;
    if (this.ownsRedactor) this.redactor.close();
  }

  poll() {
    if (this.stopping) return Promise.resolve();
    this.running ??= this._poll().catch(error => {
      this.health('core-log', 'error', { reason: 'import_failed', error_code: error.code || 'import_failed' });
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async _poll() {
    const sources = await this.discover();
    this.recoverHealth('core-log');
    for (const source of sources) {
      if (this.stopping) break;
      try { await this.importStream(source); }
      catch (error) {
        this.health(`core:${source.stream}`, 'error', {
          stream: source.stream, reason: 'read_failed', error_code: error.code || 'read_failed',
        });
      }
      await yieldLoop();
    }
  }

  async discover() {
    const p = await loadCoreModule('session-group-paths.js');
    const env = { ZYLOS_DIR: this.zylosDir };
    const sources = [
      ['router', p.routerDiagnosticPath(env)], ['supervisor', p.supervisorDiagnosticPath(env)],
      ['pool', p.poolMetricsPath(env)], ['receive', p.receiveDiagnosticPath(env)],
    ].map(([stream, file]) => ({ stream, file }));
    const groups = new Set(this.store.db.prepare("SELECT DISTINCT stream FROM core_log_cursors WHERE stream LIKE 'events:%'").all()
      .map(row => row.stream.slice(7)));
    try {
      for (const item of await fs.readdir(path.dirname(p.groupRunDir('origin', env)), { withFileTypes: true })) {
        if (item.isDirectory()) groups.add(item.name);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const group of groups) {
      try { p.assertSessionGroup(group); }
      catch { continue; }
      sources.push({ stream: `events:${group}`, file: path.join(p.groupRunDir(group, env), p.RUN_FILES.EVENTS) });
    }
    return sources;
  }

  health(name, status, extra) {
    // A quiet poll must not rewrite an unchanged health observation.
    const previous = this.store.db.prepare("SELECT status,extra FROM source_health WHERE name=? AND signal_type='history'").get(name);
    if (previous?.status === status && previous.extra === JSON.stringify(extra)) return;
    this.store.upsertSourceHealth(name, 'history', status, extra);
  }

  recoverHealth(name) {
    this.store.db.prepare("UPDATE source_health SET status='healthy',updated_at=datetime('now') WHERE name=? AND signal_type='history' AND status!='healthy'").run(name);
  }

  diagnostic(stream, reason, details = {}, suffix = reason) {
    this.health(`core:${stream}:${suffix}`, 'warning', { stream, reason, ...details });
  }

  async importStream({ stream, file }) {
    const dir = path.dirname(file);
    const base = path.basename(file, '.jsonl');
    let names;
    try { names = await this.readDirectory(dir); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.store.db.transaction(() => {
        for (const row of this.cursors.all(stream)) this.mark.run('source_missing', stream, row.file_dev, row.file_ino, row.generation);
        this.diagnostic(stream, 'source_missing');
      }).immediate();
      this.recoverHealth(`core:${stream}`);
      return;
    }
    const orderedNames = entries => [
      ...entries.filter(name => name.startsWith(`${base}.`) && name.endsWith('.jsonl') && /^\d+$/.test(name.slice(base.length + 1, -6)))
        .sort((a, b) => Number(a.slice(base.length + 1, -6)) - Number(b.slice(base.length + 1, -6))),
      ...(entries.includes(path.basename(file)) ? [path.basename(file)] : []),
    ];
    const opened = [];
    const retained = new Set();
    const scan = async entries => {
      for (const name of orderedNames(entries)) {
        let handle;
        try {
          handle = await fs.open(path.join(dir, name), 'r');
          const stat = await this.statFile(handle);
          const key = `${stat.dev}:${stat.ino}`;
          if (retained.has(key)) {
            // A rescan can discover a descriptor under its rotated name.
            opened.find(item => `${item.stat.dev}:${item.stat.ino}` === key).name = name;
            await handle.close();
          } else {
            retained.add(key);
            opened.push({ handle, name, stat });
          }
        } catch (error) {
          await handle?.close();
          if (error.code !== 'ENOENT') throw error;
        }
      }
    };
    try {
      await scan(names);
      const cursors = this.cursors.all(stream);
      if (cursors.some(row => row.status === 'active' && !retained.has(identity(row)))) {
        // Rotation between readdir and open may hide the old active filename.
        // Reconcile one fresh directory view before declaring history missing.
        try { names = await this.readDirectory(dir); }
        catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
        await scan(names);
      }
      const order = orderedNames(names);
      opened.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      this.store.db.transaction(() => {
        for (const row of cursors) {
          if (row.status === 'active' && !retained.has(identity(row))) {
            this.mark.run('gap', stream, row.file_dev, row.file_ino, row.generation);
            this.diagnostic(stream, 'file_missing', { file_dev: row.file_dev, file_ino: row.file_ino,
              generation: row.generation, byte_offset: row.byte_offset }, `${identity(row)}:g${row.generation}:missing`);
          }
        }
      }).immediate();
      if (!opened.length && cursors.length) this.diagnostic(stream, 'source_missing');
      for (const { handle, name } of opened) {
        if (this.stopping) return;
        await this.importFile(stream, path.join(dir, name), name !== path.basename(file), handle);
      }
      if (!this.stopping) {
        if (opened.length || !cursors.length) this.recoverHealth(`core:${stream}:source_missing`);
        this.recoverHealth(`core:${stream}`);
      }
    } finally {
      await Promise.all(opened.map(({ handle }) => handle.close()));
    }
  }

  async prefix(handle, length) {
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, read);
      if (!result.bytesRead) throw Object.assign(new Error('File changed during read'), { code: 'SOURCE_CHANGED' });
      read += result.bytesRead;
    }
    return bytes;
  }

  async anchor(handle, size) {
    // Scan backwards in bounded chunks: a trailing partial line may be arbitrarily
    // large. C is the snapshot's last newline, never the first batch boundary.
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - this.batchBytes);
      const bytes = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) throw Object.assign(new Error('File changed during read'), { code: 'SOURCE_CHANGED' });
      const newline = bytes.lastIndexOf(10);
      if (newline !== -1) {
        const length = Math.min(4096, start + newline + 1);
        return { anchor_len: length, anchor_sha256: sha(await this.prefix(handle, length)) };
      }
      end = start;
      await yieldLoop();
    }
    return { anchor_len: 0, anchor_sha256: null };
  }

  async readBatch(handle, size, offset) {
    const lines = [];
    let position = offset, start = offset, chunks = [], buffered = 0;
    while (position < size) {
      const bytes = Buffer.alloc(Math.min(this.batchBytes, size - position));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      if (!bytesRead) break;
      const data = bytes.subarray(0, bytesRead);
      let from = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        chunks.push(data.subarray(from, i)); buffered += i - from;
        const end = position + i + 1;
        lines.push({ offset: start, text: Buffer.concat(chunks, buffered).toString('utf8') });
        chunks = []; buffered = 0; from = i + 1; start = end;
        if (lines.length >= this.batchLines || end - offset >= this.batchBytes) return { lines, offset: end };
      }
      chunks.push(data.subarray(from)); buffered += data.length - from;
      position += bytesRead;
      await yieldLoop();
    }
    return { lines, offset: start };
  }

  async normalize(text, stream, ingestId) {
    let row;
    try { row = JSON.parse(text); } catch { return { warning: 'malformed_line' }; }
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Number.isInteger(row.v) || row.v < 1 ||
      !Number.isSafeInteger(row.ts) || row.ts < 0 || Number.isNaN(new Date(row.ts).valueOf())) return { warning: 'invalid_record' };
    const healthEvent = stream.startsWith('events:') && row.type === 'runtime_health';
    const hook = stream.startsWith('events:') && !healthEvent ? HOOKS[row.event] : null;
    const safe = hook ? this.sanitizer.sanitizeHookPayload(hook[0], row) : { metadata: {}, summary: string(row.event) || 'Unknown event' };
    const metadata = { ...safe.metadata, stream, v: row.v };
    for (const key of DIAGNOSTIC_FIELDS) {
      const value = row[key];
      if (IDENTITY_FIELDS.has(key)) {
        const id = identifier(value);
        if (id !== null) metadata[key] = id;
      } else if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) metadata[key] = value;
    }
    const event = {
      id: randomUUID(), ingest_id: ingestId, timestamp: new Date(row.ts).toISOString(),
      runtime: string(row.runtime) || 'unknown', session_group: string(row.session_group),
      run_id: string(row.run_id) || (!stream.startsWith('events:') ? string(row.runId) : null),
      session_id: string(row.session_id) || (!stream.startsWith('events:') ? string(row.sessionId) : null),
      event_type: healthEvent ? `runtime_health:${string(row.event) || 'unknown'}` : stream === 'pool' ? 'pool_sample' : hook?.[1] || string(row.event) || 'unknown',
      category: healthEvent ? 'runtime_health' : hook?.[2] || 'diagnostic', summary: this.sanitizer.safeSummary(safe.summary),
      duration_ms: Number.isFinite(row.duration_ms) ? row.duration_ms : null,
      metadata, source: 'core-log', confidence: 'actual',
    };
    for (const field of ['event_type', 'runtime']) {
      const value = event[field];
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value) || this.sanitizer.redactCredentials(value) !== value) {
        metadata[field] = value;
        event[field] = 'unknown';
      }
    }
    return { event, warning: row.v > 1 ? 'unknown_version' : null };
  }

  sanitizeValue(value) {
    if (typeof value === 'string') return this.sanitizer.redactCredentials(value);
    if (Array.isArray(value)) return value.map(item => this.sanitizeValue(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.sanitizeValue(item)]));
    return value;
  }

  async redactContents(records, context) {
    const parts = records.map(record => {
      const gap = Object.hasOwn(record, 'extra');
      const field = gap ? 'extra' : 'metadata';
      const { stream, ...text } = record[field] || {};
      const identities = {};
      for (const key of IDENTITY_FIELDS) {
        if (!Object.hasOwn(text, key)) continue;
        const id = identifier(text[key]);
        if (id !== null) identities[key] = id;
        delete text[key];
      }
      return { field, stream, identities, payload: gap ? { extra: text } : { metadata: text, summary: record.summary } };
    });
    const result = await this.redactor.redactValue(this.sanitizeValue(parts.map(part => part.payload)), context);
    const valid = Array.isArray(result.value) && result.value.length === records.length
      && result.value.every(item => item && typeof item === 'object' && !Array.isArray(item));
    return { value: records.map((record, index) => {
      const { field, stream, identities } = parts[index];
      const content = valid ? result.value[index] : {};
      const details = content[field] && typeof content[field] === 'object' && !Array.isArray(content[field]) ? content[field] : {};
      return { ...record,
        ...(field === 'metadata' ? { summary: typeof content.summary === 'string' || content.summary === null ? content.summary : UNAVAILABLE } : {}),
        [field]: { ...details, ...identities, ...(stream !== undefined ? { stream } : {}) },
      };
    }), failed: result.failed || !valid };
  }

  async sanitizeEvents(events) {
    return (await this.redactContents(events, 'timeline')).value;
  }

  async importFile(stream, file, rotated = false, openedHandle) {
    let handle = openedHandle;
    try { handle ||= await fs.open(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      while (!this.stopping) {
        const stat = await this.statFile(handle);
        const old = this.current.get(stream, stat.dev, stat.ino);
        if (stat.nlink === 0 && old?.status === 'active') {
          this.store.db.transaction(() => {
            this.mark.run('gap', stream, stat.dev, stat.ino, old.generation);
            this.diagnostic(stream, 'file_missing', { file_dev: stat.dev, file_ino: stat.ino,
              generation: old.generation, byte_offset: old.byte_offset }, `${stat.dev}:${stat.ino}:g${old.generation}:missing`);
          }).immediate();
          return;
        }
        let reason;
        if (old?.anchor_len) {
          if (stat.size < old.anchor_len) reason = 'shorter_than_anchor';
          else if (stat.size < old.byte_offset) reason = 'shorter_than_offset';
          else if (sha(await this.prefix(handle, old.anchor_len)) !== old.anchor_sha256) reason = 'anchor_mismatch';
        }
        const generation = reason ? old.generation + 1 : old?.generation || 1;
        const offset = reason ? 0 : old?.byte_offset || 0;
        const anchor = !reason && old?.anchor_len ? { anchor_len: old.anchor_len, anchor_sha256: old.anchor_sha256 } : await this.anchor(handle, stat.size);
        const batch = await this.readBatch(handle, stat.size, offset);
        const prepared = [];
        for (const line of batch.lines) {
          const key = `core:${stream}:${stat.dev}:${stat.ino}:g${generation}:${line.offset}`;
          prepared.push({ ...await this.normalize(line.text, stream, key), offset: line.offset });
        }
        const eventItems = prepared.filter(item => item.event);
        if (eventItems.length) {
          const result = await this.redactContents(eventItems.map(item => item.event),
            `core:${stream}:${stat.dev}:${stat.ino}:g${generation}:${offset}:${batch.offset}`);
          for (const [index, item] of eventItems.entries()) {
            item.event = result.value[index];
            if (result.failed) item.warning = 'redaction_failed';
          }
        }
        const row = { stream, file_dev: stat.dev, file_ino: stat.ino, generation, ...anchor,
          file_name: path.basename(file), byte_offset: batch.offset,
          status: rotated && (batch.offset === stat.size || batch.offset === offset) ? 'done' : 'active' };
        if (!reason && old && Object.entries(row).every(([key, value]) => old[key] === value)) break;
        let inserted = 0;
        const committed = this.store.db.transaction(() => {
          const now = this.current.get(stream, stat.dev, stat.ino);
          if (JSON.stringify(now) !== JSON.stringify(old)) return false;
          if (reason) this.mark.run('gap', stream, stat.dev, stat.ino, old.generation);
          for (const item of prepared) {
            if (item.event && this.store.insertEvent(item.event).inserted) inserted++;
            if (item.warning) this.diagnostic(stream, item.warning, { file_dev: stat.dev, file_ino: stat.ino,
              generation, byte_offset: item.offset }, `${stat.dev}:${stat.ino}:g${generation}:${item.warning}`);
          }
          this.transactionObserver?.('afterInsert');
          this.put.run(row);
          if (reason) this.diagnostic(stream, reason, { file_dev: stat.dev, file_ino: stat.ino,
            old_generation: old.generation, generation, old_byte_offset: old.byte_offset }, `${stat.dev}:${stat.ino}:g${generation}:replaced`);
          this.transactionObserver?.('beforeCommit');
          return true;
        }).immediate();
        if (!committed) return;
        this.transactionObserver?.('afterCommit');
        if (inserted) this.onImport({ stream, inserted });
        if (batch.offset === offset || batch.offset >= stat.size) break;
        await yieldLoop();
      }
    } finally { if (!openedHandle) await handle.close(); }
  }
}
