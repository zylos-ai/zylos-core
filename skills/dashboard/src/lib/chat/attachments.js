import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { C4Reader } from '../c4-reader.js';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from '../schema.js';
import {
  MAX_ATTACHMENTS, sanitizedExtension, uploadKind,
  resolveAllowedPathSync, sniffImage, readUploadLimit,
} from '../../../scripts/attachment-utils.js';
import { sanitizeDisplayName, parseAttachmentAnnotation } from '../../../../comm-bridge/scripts/attachment-annotations.js';
import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { validateGroupName, validNamespace } from '../../../../comm-bridge/scripts/c4-session-group.js';

export const ATTACHMENT_SEND_WINDOW_MS = 25 * 60 * 1000;
export const ATTACHMENT_TTL_MS = 30 * 60 * 1000;
export const ATTACHMENT_GC_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 100;
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const placeholders = values => values.map(() => '?').join(',');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const rowFields = ['direction', 'channel', 'endpoint_id', 'session_group', 'content'];

/** Private copies and their authoritative message references belong to Dashboard. */
export class ChatAttachments {
  constructor({ store, db = store?.db, c4Reader, zylosDir, now = Date.now, readonly = false }) {
    this.db = db;
    this.c4Reader = c4Reader;
    this.zylosDir = fs.realpathSync(zylosDir);
    const media = path.join(this.zylosDir, 'components', 'dashboard', 'media');
    if (!readonly) fs.mkdirSync(media, { recursive: true, mode: 0o700 });
    this.mediaDir = fs.realpathSync(media);
    this.now = now;
    this.maxUploadBytes = readUploadLimit(this.zylosDir);
    this.directory = null;
    this.gcRunning = null;
  }

  config() { return { maxUploadBytes: this.maxUploadBytes, maxAttachments: MAX_ATTACHMENTS }; }

  _core() {
    const db = this.c4Reader._open();
    if (!db) throw fail('chat_attachment_core_unavailable', 502);
    return db;
  }

  _conversation(conversation) {
    const localId = typeof conversation === 'string' ? conversation : conversation?.localId;
    try { validateGroupName(localId); } catch { throw fail('invalid_chat_conversation'); }
    const row = this.db.prepare('SELECT local_id,namespace FROM chat_conversations WHERE local_id=?').get(localId);
    if (!row) throw fail('chat_conversation_not_found', 404);
    const binding = this._core().prepare("SELECT namespace FROM channel_namespaces WHERE component_name='dashboard'").get();
    if (!binding || !validNamespace(binding.namespace) || (row.namespace && row.namespace !== binding.namespace)
        || (typeof conversation === 'object' && (conversation.channel !== 'dashboard'
          || conversation.namespace && conversation.namespace !== binding.namespace))) {
      throw fail('chat_conversation_forbidden', 403);
    }
    return { localId, channel: 'dashboard', namespace: binding.namespace, sessionGroup: `${binding.namespace}:${localId}` };
  }

  _watermark() {
    const id = this._core().prepare('SELECT COALESCE(MAX(id),0) AS id FROM conversations').get()?.id;
    if (!Number.isSafeInteger(id) || id < 0) throw fail('chat_attachment_core_unavailable', 502);
    return id;
  }

  captureWatermark() { return this._watermark(); }

  _record(id, conversation) {
    if (!validId(id)) throw fail('chat_attachment_unavailable', 404);
    const group = this._conversation(conversation);
    const record = this.db.prepare(`SELECT a.*, EXISTS(SELECT 1 FROM chat_attachment_messages m
      WHERE m.attachment_id=a.id) AS linked FROM chat_attachments a
      WHERE a.id=? AND a.local_id=? AND a.namespace=?`).get(id, group.localId, group.namespace);
    if (!record) throw fail('chat_attachment_unavailable', 404);
    return record;
  }

  _file(record) {
    if (path.basename(record.storage_name) !== record.storage_name) throw fail('chat_attachment_unavailable', 404);
    const candidate = path.join(this.mediaDir, record.storage_name);
    const resolved = resolveAllowedPathSync(candidate, [this.mediaDir]);
    if (resolved !== candidate) throw fail('chat_attachment_unavailable', 404);
    try {
      if (!fs.statSync(resolved).isFile()) throw Error();
      fs.accessSync(resolved, fs.constants.R_OK);
    } catch { throw fail('chat_attachment_unavailable', 404); }
    return resolved;
  }

  _public(record) {
    return { id: record.id, name: record.name, size: record.size, mime: record.mime, kind: record.kind };
  }

  async _copy(group, { name, mime, kind, source, principal, stream, watermark = this._watermark() }) {
    if (!Number.isSafeInteger(watermark) || watermark < 0) throw fail('chat_attachment_core_unavailable', 502);
    const id = randomUUID();
    const storageName = `attachment-${randomUUID()}${sanitizedExtension(name)}`;
    const temporary = path.join(this.mediaDir, `${storageName}.part`);
    const final = path.join(this.mediaDir, storageName);
    let handle, registered = false;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      let size = 0;
      let prefix = Buffer.alloc(0);
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (!Number.isSafeInteger(size) || size > this.maxUploadBytes) throw fail('chat_attachment_too_large', 413);
        if (prefix.length < 12) prefix = Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
        await handle.writeFile(bytes);
      }
      if (source === 'agent' && kind === 'image' && !sniffImage(prefix)) throw fail('chat_attachment_not_image');
      await handle.sync();
      await handle.close();
      handle = null;
      // A stalled writer may have been collected by another process. Never
      // publish its record or ID after its temporary name has disappeared.
      if (!(await fs.promises.lstat(temporary)).isFile()) throw fail('chat_attachment_unavailable', 404);
      const createdAt = this.now();
      this.db.prepare(`INSERT INTO chat_attachments
        (id,local_id,namespace,storage_name,name,size,mime,kind,source,principal,created_at,
          c4_watermark,scanned_c4_id,next_check_at)
        VALUES (@id,@localId,@namespace,@storageName,@name,@size,@mime,@kind,@source,@principal,@createdAt,
          @watermark,@watermark,@nextCheckAt)`).run({ id, ...group, storageName,
        name: sanitizeDisplayName(name), size, mime: String(mime || 'application/octet-stream'),
        kind, source, principal, createdAt, watermark, nextCheckAt: createdAt + ATTACHMENT_TTL_MS });
      registered = true;
      await fs.promises.rename(temporary, final);
      return { ...this._public(this._record(id, group)), expiresAt: createdAt + ATTACHMENT_SEND_WINDOW_MS };
    } catch (error) {
      if (!registered) await fs.promises.unlink(temporary).catch(() => {});
      if (error.statusCode) throw error;
      throw fail('chat_attachment_write_failed', 502);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async prepareUser(conversation, { name, mime, stream, principal, watermark }) {
    const group = this._conversation(conversation);
    if (typeof principal !== 'string' || !principal) throw fail('chat_attachment_principal_required', 403);
    const kind = uploadKind({ originalname: name, mimetype: mime });
    return this._copy(group, { name, mime, kind, source: 'user', principal, stream, watermark });
  }

  async register(conversation, { kind, path: sourcePath }) {
    const group = this._conversation(conversation);
    if (!['image', 'file'].includes(kind) || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw fail('invalid_chat_attachment');
    }
    const roots = [this.mediaDir, path.join(this.zylosDir, 'workspace'), '/tmp'];
    const resolved = resolveAllowedPathSync(sourcePath, roots);
    if (!resolved) throw fail('chat_attachment_source_forbidden', 403);
    const watermark = this._watermark();
    let handle;
    try {
      handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail('chat_attachment_source_forbidden', 403);
      if (process.platform === 'linux') {
        const openedPath = await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
        if (resolveAllowedPathSync(openedPath, roots) !== openedPath) throw fail('chat_attachment_source_forbidden', 403);
      } else {
        // Platforms without procfs must still prove that the allowed path
        // resolves to the same file opened above after traversing its parents.
        const current = resolveAllowedPathSync(resolved, roots);
        const currentStat = current && await fs.promises.stat(current);
        if (!currentStat || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
          throw fail('chat_attachment_source_forbidden', 403);
        }
      }
      if (stat.size > this.maxUploadBytes) throw fail('chat_attachment_too_large', 413);
      const result = await this._copy(group, { name: path.basename(sourcePath), mime: 'application/octet-stream',
        kind, source: 'agent', principal: null, stream: handle.createReadStream({ autoClose: false }), watermark });
      return { ok: true, attachmentId: result.id, name: result.name, kind: result.kind, expiresAt: result.expiresAt };
    } catch (error) {
      if (error.statusCode) throw error;
      throw fail('chat_attachment_source_unreadable', 404);
    } finally { await handle?.close().catch(() => {}); }
  }

  resolve(conversation, id) { return this._file(this._record(id, conversation)); }

  prepareSend(conversation, ids, principal) {
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some(id => !validId(id))
        || new Set(ids).size !== ids.length) throw fail('invalid_chat_attachments');
    if (!ids.length) return [];
    const group = this._conversation(conversation);
    const rows = this.db.prepare(`SELECT a.*, EXISTS(SELECT 1 FROM chat_attachment_messages m
      WHERE m.attachment_id=a.id) AS linked FROM chat_attachments a
      WHERE a.id IN (${placeholders(ids)}) AND a.namespace=? AND a.local_id=?`)
      .all(...ids, group.namespace, group.localId);
    const records = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => {
      const row = records.get(id);
      if (!row || !row.linked && (row.source !== 'user' || row.principal !== principal
          || this.now() - row.created_at >= ATTACHMENT_SEND_WINDOW_MS || this.now() < row.created_at)) {
        throw fail('chat_attachment_unavailable', 404);
      }
      return { ...this._public(row), path: this._file(row) };
    });
  }

  /** Read-only producer check; an ID alone never establishes ownership. */
  validateAgentReferences(conversation, blocks) {
    if (!Array.isArray(blocks) || blocks.length > MAX_ATTACHMENTS
        || new Set(blocks.map(block => block.data?.attachmentId)).size !== blocks.length) {
      throw fail('invalid_chat_attachments');
    }
    let group;
    try { group = this._conversation(conversation); }
    catch (error) {
      if (['invalid_chat_conversation', 'chat_conversation_not_found', 'chat_conversation_forbidden'].includes(error.code)) {
        throw fail('invalid_chat_attachment_destination');
      }
      throw error;
    }
    // Core falls back to the namespace when an explicit outbound group does
    // not exist. A reference must target the exact registered conversation.
    if (!this._core().prepare('SELECT 1 FROM group_heads WHERE session_group=?').get(group.sessionGroup)) {
      throw fail('invalid_chat_attachment_destination');
    }
    const now = this.now();
    for (const block of blocks) {
      const record = this._record(block.data?.attachmentId, conversation);
      const kind = block.type === 'x-zylos.image' ? 'image' : block.type === 'x-zylos.file' ? 'file' : null;
      if (record.kind !== kind || !record.linked && (record.source !== 'agent'
          || now < record.created_at || now - record.created_at >= ATTACHMENT_SEND_WINDOW_MS)) {
        throw fail('chat_attachment_unavailable', 404);
      }
      this._file(record);
    }
  }

  _references(row) {
    if (row.direction === 'in') {
      return String(row.content).split('\n').map(parseAttachmentAnnotation).filter(Boolean).slice(0, MAX_ATTACHMENTS)
        .map(attachment => ({ ...attachment, storageName: this._storageName(attachment.path) }));
    }
    const parsed = parseC4Content(row.content);
    if (parsed.kind !== 'envelope' || parsed.envelope.kind !== 'message') return [];
    return parsed.envelope.blocks.filter(block => ['x-zylos.image', 'x-zylos.file'].includes(block.type))
      .slice(0, MAX_ATTACHMENTS).map(block => ({ id: block.data.attachmentId,
        name: block.data.nameSnapshot, kind: block.type === 'x-zylos.image' ? 'image' : 'file' }));
  }

  _storageName(annotationPath) {
    try {
      if (path.resolve(annotationPath) !== annotationPath
          || fs.realpathSync(path.dirname(annotationPath)) !== this.mediaDir) return null;
      return path.basename(annotationPath);
    } catch { return null; }
  }

  _matches(record, row, reference) {
    return row.channel === 'dashboard' && row.endpoint_id === record.local_id
      && row.session_group === `${record.namespace}:${record.local_id}`
      && row.id > record.c4_watermark && reference.kind === record.kind
      && (row.direction === 'in' ? reference.storageName === record.storage_name && (record.source === 'user' || record.linked)
        : row.direction === 'out' && reference.id === record.id && (record.source === 'agent' || record.linked));
  }

  _authoritativeRows(rows) {
    if (!rows.length) return [];
    const ids = [...new Set(rows.map(row => Number(row.id)))];
    const actual = this._core().prepare(`SELECT id,direction,channel,endpoint_id,session_group,content
      FROM conversations WHERE id IN (${placeholders(ids)})`).all(...ids);
    const expected = new Map(rows.map(row => [Number(row.id), row]));
    return actual.filter(row => rowFields.every(field => row[field] === expected.get(row.id)[field]));
  }

  /** One bounded Core read and one attachment read for an entire history batch. */
  metadata(rows) {
    if (!Array.isArray(rows) || rows.length > BATCH || rows.some(row => !row
        || !Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1)) {
      throw fail('invalid_chat_message_ids');
    }
    const unavailable = reference => ({ name: reference.name, kind: reference.kind, available: false });
    let actual;
    try { actual = this._authoritativeRows(rows); }
    catch { return new Map(rows.map(row => [Number(row.id), this._references(row).map(unavailable)])); }
    const result = new Map(rows.map(row => [Number(row.id), []]));
    const references = actual.map(row => ({ row, references: this._references(row) }));
    for (const item of references) result.set(item.row.id, item.references.map(unavailable));
    const ids = [...new Set(references.flatMap(item => item.references.map(reference => reference.id).filter(validId)))];
    const names = [...new Set(references.flatMap(item => item.references.map(reference => reference.storageName).filter(Boolean)))];
    if (!ids.length && !names.length) return result;
    const conditions = [ids.length && `a.id IN (${placeholders(ids)})`, names.length && `a.storage_name IN (${placeholders(names)})`].filter(Boolean);
    let records, insert;
    try {
      records = this.db.prepare(`SELECT a.*, EXISTS(SELECT 1 FROM chat_attachment_messages m
        WHERE m.attachment_id=a.id) AS linked FROM chat_attachments a WHERE ${conditions.join(' OR ')}`).all(...ids, ...names);
      insert = this.db.prepare('INSERT OR IGNORE INTO chat_attachment_messages(attachment_id,c4_id) VALUES(?,?)');
    } catch { return result; }
    const byId = new Map(records.map(record => [record.id, record]));
    const byName = new Map(records.map(record => [record.storage_name, record]));
    for (const { row, references: refs } of references) {
      const items = [];
      for (const reference of refs) {
        const record = reference.id ? byId.get(reference.id) : byName.get(reference.storageName);
        if (!record || !this._matches(record, row, reference)) { items.push(unavailable(reference)); continue; }
        try {
          insert.run(record.id, row.id);
          record.linked = 1;
          this._file(record);
          items.push({ ...this._public(record), available: true });
        } catch { items.push(unavailable(reference)); }
      }
      result.set(row.id, items);
    }
    return result;
  }

  linkRow(row) { return this.metadata([row]).get(Number(row.id)) ?? []; }

  download(conversation, id) {
    const record = this._record(id, conversation);
    if (!record.linked) throw fail('chat_attachment_unavailable', 404);
    const ids = this.db.prepare('SELECT c4_id FROM chat_attachment_messages WHERE attachment_id=? ORDER BY c4_id LIMIT ?')
      .all(id, BATCH).map(row => row.c4_id);
    if (!ids.length) throw fail('chat_attachment_unavailable', 404);
    const rows = this._core().prepare(`SELECT id,direction,channel,endpoint_id,session_group,content
      FROM conversations WHERE id IN (${placeholders(ids)})`).all(...ids);
    if (!rows.some(row => this._references(row).some(reference => this._matches(record, row, reference)))) {
      throw fail('chat_attachment_unavailable', 404);
    }
    return { ...this._public(record), path: this._file(record) };
  }

  async _remove(record) {
    // Hold the writer lock over the final reference check and both bounded
    // file removals so another process cannot link a file during deletion.
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM chat_attachment_messages WHERE attachment_id=? LIMIT 1').get(record.id)) return;
      for (const suffix of ['', '.part']) {
        try { fs.unlinkSync(path.join(this.mediaDir, record.storage_name + suffix)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.db.prepare('DELETE FROM chat_attachments WHERE id=?').run(record.id);
    }).immediate();
  }

  async _collect(record, now) {
    const core = this._core();
    if (record.scan_upper_id === null) {
      record.scan_upper_id = this._watermark();
      this.db.prepare('UPDATE chat_attachments SET scan_upper_id=? WHERE id=? AND scan_upper_id IS NULL')
        .run(record.scan_upper_id, record.id);
    }
    for (let page = 0; page < 2; page++) {
      const rows = core.prepare(`SELECT id,direction,channel,endpoint_id,session_group,content FROM conversations
        WHERE id>? AND id<=? AND channel='dashboard' AND endpoint_id=? AND session_group=? AND direction=?
        ORDER BY id LIMIT ?`).all(record.scanned_c4_id, record.scan_upper_id, record.local_id,
        `${record.namespace}:${record.local_id}`, record.source === 'user' ? 'in' : 'out', BATCH);
      for (const row of rows) {
        if (this._references(row).some(reference => this._matches(record, row, reference))) {
          this.db.prepare('INSERT OR IGNORE INTO chat_attachment_messages(attachment_id,c4_id) VALUES(?,?)').run(record.id, row.id);
          return;
        }
      }
      record.scanned_c4_id = rows.length < BATCH ? record.scan_upper_id : rows.at(-1).id;
      this.db.prepare('UPDATE chat_attachments SET scanned_c4_id=? WHERE id=?').run(record.scanned_c4_id, record.id);
      if (record.scanned_c4_id >= record.scan_upper_id) { await this._remove(record); return; }
    }
    this.db.prepare('UPDATE chat_attachments SET next_check_at=? WHERE id=?').run(now + ATTACHMENT_GC_INTERVAL_MS, record.id);
  }

  async _sweepDirectory(now) {
    if (!this.directory) this.directory = await fs.promises.opendir(this.mediaDir);
    for (let count = 0; count < BATCH; count++) {
      const entry = await this.directory.read();
      if (!entry) { await this.directory.close(); this.directory = null; return; }
      const name = entry.name.endsWith('.part') ? entry.name.slice(0, -5) : entry.name;
      if (this.db.prepare('SELECT 1 FROM chat_attachments WHERE storage_name=?').get(name)) continue;
      const candidate = path.join(this.mediaDir, entry.name);
      try {
        const stat = await fs.promises.lstat(candidate);
        if (!stat.isDirectory() && now - stat.mtimeMs >= ATTACHMENT_TTL_MS) await fs.promises.unlink(candidate);
      } catch { /* Retry unreadable entries on the next directory pass. */ }
    }
  }

  async _gc() {
    const now = this.now();
    const records = this.db.prepare(`SELECT a.*,0 AS linked FROM chat_attachments a
      WHERE next_check_at<=? AND NOT EXISTS(SELECT 1 FROM chat_attachment_messages m WHERE m.attachment_id=a.id)
      ORDER BY next_check_at,id LIMIT ?`).all(now, BATCH);
    for (const record of records) {
      try { await this._collect(record, now); }
      catch { this.db.prepare('UPDATE chat_attachments SET next_check_at=? WHERE id=?').run(now + ATTACHMENT_GC_INTERVAL_MS, record.id); }
    }
    await this._sweepDirectory(now);
    return { checked: records.length };
  }

  gc() {
    if (!this.gcRunning) this.gcRunning = this._gc().finally(() => { this.gcRunning = null; });
    return this.gcRunning;
  }

  async close() {
    await this.gcRunning;
    await this.directory?.close();
    this.directory = null;
  }
}

/** Open existing attachment storage without initialization or migration. */
export function withChatAttachments(zylosDir, { readonly = false } = {}, callback) {
  let db, reader;
  try {
    db = new Database(path.join(zylosDir, 'components', 'dashboard', 'dashboard.db'), { readonly, fileMustExist: true });
    let compatible = false;
    try { compatible = inspectDatabase(db).currentVersion === TARGET_SCHEMA_VERSION; }
    catch { /* Unsupported schema metadata or layout is a service failure. */ }
    if (!compatible) throw fail('chat_attachment_schema_unavailable', 502);
    reader = new C4Reader(zylosDir);
    return callback(new ChatAttachments({ db, c4Reader: reader, zylosDir, readonly: true }));
  } finally {
    reader?.close();
    db?.close();
  }
}
