import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from './schema.js';
import { loadConfig } from './config.js';
import { ConversationCollector } from './collectors/conversation-collector.js';
import { CodexRolloutCollector } from './collectors/codex-rollout-collector.js';
import { ChatAttachments } from './chat/attachments.js';
import { parseSessionGroup, validateGroupName } from '../../../comm-bridge/scripts/c4-session-group.js';
import { ownedPath as resolveOwnedPath } from '../../../comm-bridge/scripts/owned-path.js';

const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const validSession = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const below = (file, root) => file.startsWith(root + path.sep);

const ownedPath = (file, root) => resolveOwnedPath(root, file, () => fail('group_delete_path_unavailable'));
// Recursion may unlink a symlink entry, but its parent must still be an owned
// directory. Top-level targets keep the stricter check including the leaf.
const ownedEntry = (file, root, nested) => nested
  ? path.join(ownedPath(path.dirname(file), root), path.basename(file)) : ownedPath(file, root);
function removeOwned(file, root, nested = false) {
  const candidate = ownedEntry(file, root, nested);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  if (stat.isDirectory()) {
    let removed = 0;
    for (const entry of fs.readdirSync(candidate)) removed += removeOwned(path.join(candidate, entry), root, true);
    fs.rmdirSync(candidate);
    return removed;
  }
  fs.unlinkSync(candidate);
  return 1;
}

export function createGroupDeletionStorage({ zylosDir, homeDir = os.homedir(), store = null, c4Db = null,
  tmpdir = os.tmpdir(), uid = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username } = {}) {
  zylosDir = fs.realpathSync(zylosDir);
  homeDir = fs.realpathSync(homeDir);
  tmpdir = fs.realpathSync(tmpdir);
  const dbPath = path.join(zylosDir, 'components/dashboard/dashboard.db');
  let ownedStore = false;
  if (!store && fs.existsSync(dbPath)) {
    const probe = new Database(dbPath, { readonly: true });
    try {
      if (inspectDatabase(probe).currentVersion !== TARGET_SCHEMA_VERSION) throw fail('group_delete_dashboard_unavailable', 503);
    } finally { probe.close(); }
    store = new Store(dbPath); ownedStore = true;
  }
  const db = store?.db ?? null;
  const core = () => { if (!c4Db) throw fail('group_delete_core_unavailable', 503); return c4Db; };
  const dashboardBinding = () => core().prepare("SELECT namespace FROM channel_namespaces WHERE component_name='dashboard'").get()?.namespace ?? null;
  const groupExists = group => !!core().prepare(`SELECT 1 FROM group_heads WHERE session_group=?
    UNION ALL SELECT 1 FROM conversations WHERE session_group=? LIMIT 1`).get(group, group);
  const draftRow = localId => {
    try { validateGroupName(localId); } catch { throw fail('invalid_chat_conversation', 400); }
    const row = db?.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(localId);
    if (!row) throw fail('chat_conversation_not_found', 404);
    return row;
  };
  function resolveTarget(target) {
    if (target?.draftLocalId !== undefined) {
      let row;
      try { row = draftRow(target.draftLocalId); }
      catch (error) {
        if (error.code !== 'chat_conversation_not_found') throw error;
        const audit = core().prepare(`SELECT target_key FROM group_deletion_audit
          WHERE draft_local_id=? AND session_group IS NULL AND status='started'`).get(target.draftLocalId);
        let key;
        try { key = JSON.parse(audit?.target_key); } catch { throw error; }
        if (!Array.isArray(key) || key.length !== 3 || key[0] !== 'draft' || key[2] !== target.draftLocalId ||
            !parseSessionGroup(`${key[1]}:${key[2]}`)) throw error;
        const namespace = key[1];
        return { sessionGroup: null, localId: target.draftLocalId, namespace, draft: true };
      }
      const namespace = row.namespace ?? dashboardBinding();
      if (!namespace) throw fail('group_delete_core_unavailable', 503);
      const sessionGroup = namespace ? `${namespace}:${row.local_id}` : null;
      if (row.state === 'active' || sessionGroup && groupExists(sessionGroup)) {
        if (!sessionGroup) throw fail('group_delete_core_unavailable', 503);
        return { sessionGroup, localId: row.local_id, namespace, draft: false };
      }
      if (row.state !== 'draft') throw fail('group_delete_send_pending');
      return { sessionGroup: null, localId: row.local_id, namespace, draft: true };
    }
    const parsed = parseSessionGroup(target?.sessionGroup);
    if (!parsed || target.sessionGroup === 'origin') throw fail('group_delete_forbidden', 403);
    const dashboard = parsed.namespace === dashboardBinding();
    return { sessionGroup: target.sessionGroup, localId: dashboard ? parsed.groupName : null,
      namespace: dashboard ? parsed.namespace : null, draft: false };
  }
  const mappings = group => db ? db.prepare('SELECT * FROM usage_transcripts WHERE session_group=? ORDER BY parent_path IS NOT NULL, transcript_path').all(group) : [];
  function transcriptFile(row) {
    if (!validSession(row.session_id) || !path.isAbsolute(row.transcript_path)) throw fail('group_delete_path_unavailable');
    const root = path.join(homeDir, row.runtime === 'claude' ? '.claude/projects' : '.codex/sessions');
    const file = ownedPath(row.transcript_path, root);
    if (row.runtime === 'claude') {
      if (row.parent_path) {
        const parent = mappings(row.session_group).find(item => item.transcript_path === row.parent_path && item.session_id === row.session_id);
        if (!parent || !below(file, path.join(path.dirname(parent.transcript_path), row.session_id, 'subagents'))) throw fail('group_delete_path_unavailable');
      } else if (path.basename(file) !== `${row.session_id}.jsonl`) throw fail('group_delete_path_unavailable');
    } else if (row.runtime !== 'codex' || !/^rollout-[^/]+\.jsonl$/.test(path.basename(file))) throw fail('group_delete_path_unavailable');
    return file;
  }
  function runtimeTargets(rows) {
    const targets = [];
    const sharedSession = sid => !!db.prepare('SELECT 1 FROM usage_transcripts WHERE session_id=? AND session_group IS NOT ? LIMIT 1')
      .get(sid, rows[0]?.session_group);
    for (const row of rows) {
      const file = transcriptFile(row);
      targets.push([file, path.join(homeDir, row.runtime === 'claude' ? '.claude/projects' : '.codex/sessions')]);
      if (row.runtime === 'claude' && !row.parent_path) {
        targets.push([path.join(path.dirname(file), row.session_id), path.join(homeDir, '.claude/projects')],
          [path.join(tmpdir, `claude-${uid}`, path.basename(path.dirname(file)), row.session_id), path.join(tmpdir, `claude-${uid}`)]);
        if (!sharedSession(row.session_id)) targets.push(
          [path.join(homeDir, '.claude/session-env', row.session_id), path.join(homeDir, '.claude/session-env')]);
      }
    }
    for (const sid of new Set(rows.map(row => row.session_id))) {
      if (!sharedSession(sid)) targets.push([path.join(tmpdir, `zylos-shard-spill-${uid}`, sid), path.join(tmpdir, `zylos-shard-spill-${uid}`)]);
    }
    return targets;
  }
  function countOwnedTargets(targets) {
    const found = new Set();
    const visit = (file, root, nested = false) => {
      const candidate = ownedEntry(file, root, nested);
      let stat;
      try { stat = fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isDirectory()) for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name), root, true);
      else found.add(candidate);
    };
    for (const [file, root] of targets) visit(file, root);
    return found.size;
  }
  function retainedMessages({ sessionGroup, cutoffId = Number.MAX_SAFE_INTEGER }) {
    return sessionGroup ? core().prepare(`SELECT * FROM conversations WHERE session_group=? AND
      (id>? OR (direction='in' AND status IN ('pending','running')))`).all(sessionGroup, cutoffId) : [];
  }
  function removableAttachments(target) {
    const { localId, namespace, sessionGroup, cutoffId = Number.MAX_SAFE_INTEGER } = target;
    if (!localId) return [];
    if (!namespace) throw fail('group_delete_core_unavailable', 503);
    const media = path.join(zylosDir, 'components/dashboard/media');
    const retained = retainedMessages(target);
    const owner = retained.length && fs.existsSync(media) ? new ChatAttachments({ store, c4Reader: { _open: core }, zylosDir, readonly: true }) : null;
    const rows = db.prepare('SELECT * FROM chat_attachments WHERE local_id=? AND namespace=?').all(localId, namespace);
    return rows.filter(row => {
      const links = db.prepare('SELECT c4_id FROM chat_attachment_messages WHERE attachment_id=?').all(row.id);
      if (!links.length) return false;
      for (const link of links) {
        const message = core().prepare('SELECT session_group,id,direction,status FROM conversations WHERE id=?').get(link.c4_id);
        if (!message || message.session_group !== sessionGroup || message.id > cutoffId ||
            message.direction === 'in' && ['pending','running'].includes(message.status)) return false;
      }
      const record = { ...row, linked: links.length > 0 ? 1 : 0 };
      return !owner || !retained.some(message => owner._references(message).some(reference => owner._matches(record, message, reference)));
    });
  }
  function finalizeTranscripts(target) {
    const { sessionGroup, processExited = false, deadlineAt = Infinity, now = Date.now } = target;
    const withinBudget = () => { if (now() >= deadlineAt) throw fail('group_delete_usage_pending'); };
    withinBudget();
    if (!processExited) throw fail('group_delete_usage_pending');
    if (!db) return { transcripts: 0 };
    if (target.hasRetainedMessages === true || retainedMessages(target).length) return { transcripts: 0 };
    const config = { ...loadConfig({ zylosDir }), homeDir, zylosDir };
    const claude = new ConversationCollector(store, config), codex = new CodexRolloutCollector(store, config);
    const rows = mappings(sessionGroup);
    // The known mapped main also owns its bounded subagent directory. Discover
    // it before finalizing so a just-written child cannot be removed unbilled.
    for (const row of rows) {
      if (row.runtime !== 'claude' || row.parent_path) continue;
      transcriptFile(row);
      const directory = path.join(path.dirname(row.transcript_path), row.session_id, 'subagents');
      let names;
      try { names = fs.readdirSync(ownedPath(directory, path.join(homeDir, '.claude/projects'))); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of names) if (name.endsWith('.jsonl')) {
        withinBudget();
        store.insertUsageTranscript({ ...row, transcript_path: path.join(directory, name), parent_path: row.transcript_path, byte_offset: 0 }, new Date().toISOString());
      }
    }
    let completed = 0;
    for (const row of mappings(sessionGroup)) {
      const file = transcriptFile(row);
      let identity;
      try { identity = fs.statSync(file); }
      catch (error) { if (error.code === 'ENOENT' && row.status === 'finished') continue; throw fail('group_delete_usage_pending'); }
      let offset = row.byte_offset;
      try {
        if (row.runtime === 'claude') {
          claude._offsets.set(file, offset);
          claude._seenUuids.clear();
          claude._collectFile(file, { sessionId: row.session_id, group: sessionGroup, runId: row.run_id,
            agentId: row.parent_path ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null,
            usageOnly: Boolean(row.parent_path), origin: false });
          offset = claude._offsets.get(file);
          claude._offsets.delete(file);
        } else {
          while (offset < identity.size) {
            withinBudget();
            codex.collectMapping({ ...row, isOriginCurrent: false });
            const next = store.getCodexRolloutCursor(file)?.byte_offset ?? 0;
            if (next <= offset) throw fail('group_delete_usage_pending');
            offset = next;
          }
        }
        withinBudget();
        const current = fs.statSync(file);
        if (current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size || offset !== current.size) throw fail('group_delete_usage_pending');
        store.updateUsageTranscript(file, { byte_offset: offset, status: 'finished', now: new Date().toISOString() });
        completed++;
      } catch { throw fail('group_delete_usage_pending'); }
    }
    return { transcripts: completed };
  }
  function preview(target) {
    const resolved = target?.draft !== undefined ? target : { ...resolveTarget(target), cutoffId: target.cutoffId };
    if (!db) return { ...resolved, attachments: 0, files: 0 };
    const attachments = removableAttachments(resolved);
    const media = path.join(zylosDir, 'components/dashboard/media');
    const mediaTargets = attachments.flatMap(row => {
      if (path.basename(row.storage_name) !== row.storage_name) throw fail('group_delete_path_unavailable');
      return [[path.join(media, row.storage_name), media], [path.join(media, row.storage_name + '.part'), media]];
    });
    const rows = resolved.sessionGroup && !retainedMessages(resolved).length ? mappings(resolved.sessionGroup) : [];
    return { ...resolved, attachments: attachments.length,
      files: countOwnedTargets([...runtimeTargets(rows), ...mediaTargets]) };
  }
  function cleanup(target) {
    const { removeGroupSources = () => 0, onFilePhase = () => {} } = target;
    const resolved = target.draft !== undefined ? target : { ...resolveTarget(target), cutoffId: target.cutoffId };
    if (!db) { onFilePhase(); return { attachments: 0, files: Number(removeGroupSources()) || 0, records: 0 }; }
    return db.transaction(() => {
      if (resolved.draft) {
        const fresh = resolveTarget({ draftLocalId: resolved.localId });
        if (!fresh.draft || fresh.namespace !== resolved.namespace) throw fail('group_delete_send_pending');
      }
      const { sessionGroup, localId, namespace } = resolved;
      const retained = retainedMessages({ ...resolved, cutoffId: target.cutoffId });
      const preserveGroup = target.hasRetainedMessages === true || retained.length > 0;
      const pending = new Set();
      if (sessionGroup) {
        const media = path.join(zylosDir, 'components/dashboard/media');
        const attachmentOwner = fs.existsSync(media) ? new ChatAttachments({ store,
          c4Reader: { _open: core }, zylosDir, readonly: true }) : null;
        for (const row of retained) {
          pending.add(Number(row.id));
          attachmentOwner?.linkRow(row);
        }
      }
      let files = 0, attachments = 0, records = 0;
      const rows = sessionGroup && !preserveGroup ? mappings(sessionGroup) : [];
      const finished = rows.filter(row => row.status === 'finished');
      if (finished.length !== rows.length) throw fail('group_delete_usage_pending');
      const runtimeFiles = runtimeTargets(finished);
      const media = path.join(zylosDir, 'components/dashboard/media');
      if (localId && !namespace) throw fail('group_delete_core_unavailable', 503);
      const attachmentsToRemove = removableAttachments({ ...resolved, cutoffId: target.cutoffId }).filter(attachment => {
        if (path.basename(attachment.storage_name) !== attachment.storage_name) throw fail('group_delete_path_unavailable');
        return true;
      });
      countOwnedTargets([...runtimeFiles, ...attachmentsToRemove.flatMap(attachment => [
        [path.join(media, attachment.storage_name), media], [path.join(media, attachment.storage_name + '.part'), media],
      ])]);
      onFilePhase();
      for (const [file, root] of runtimeFiles) files += removeOwned(file, root);
      // Shared Claude history stays intact: unrelated runtimes may append or
      // retain open descriptors while this group's runtime has already stopped.
      if (localId) {
        for (const attachment of attachmentsToRemove) {
          files += removeOwned(path.join(media, attachment.storage_name), media);
          files += removeOwned(path.join(media, attachment.storage_name + '.part'), media);
          records += db.prepare('DELETE FROM chat_attachment_messages WHERE attachment_id=?').run(attachment.id).changes;
          records += db.prepare('DELETE FROM chat_attachments WHERE id=?').run(attachment.id).changes;
          attachments++;
        }
      }
      files += Number(removeGroupSources()) || 0;
      for (const row of finished) {
        records += db.prepare('DELETE FROM codex_rollout_cursors WHERE transcript_path=?').run(row.transcript_path).changes;
        records += db.prepare('DELETE FROM codex_rollout_paths WHERE transcript_path=?').run(row.transcript_path).changes;
      }
      if (sessionGroup) {
        const keepQuestions = new Set();
        for (const answer of db.prepare(`SELECT a.*,d.c4_id FROM chat_answers a LEFT JOIN chat_answer_deliveries d ON d.answer_id=a.answer_id WHERE a.session_group=?`).all(sessionGroup)) {
          const question = core().prepare('SELECT session_group,id,direction,status FROM conversations WHERE id=?').get(answer.question_c4_id);
          const delivery = core().prepare('SELECT session_group,id,direction,status FROM conversations WHERE id=?').get(answer.c4_id);
          const ownedMessage = message => message && message.session_group === sessionGroup && message.id <= (target.cutoffId ?? Number.MAX_SAFE_INTEGER)
            && !pending.has(Number(message.id));
          if (!ownedMessage(question) || !ownedMessage(delivery)) { keepQuestions.add(String(answer.question_c4_id)); continue; }
          records += db.prepare('DELETE FROM chat_answer_deliveries WHERE answer_id=?').run(answer.answer_id).changes;
          records += db.prepare('DELETE FROM chat_answers WHERE answer_id=?').run(answer.answer_id).changes;
        }
        for (const question of db.prepare('SELECT c4_id FROM chat_questions WHERE session_group=?').all(sessionGroup)) {
          const message = core().prepare('SELECT session_group,id FROM conversations WHERE id=?').get(question.c4_id);
          if (!message || message.session_group !== sessionGroup || message.id > (target.cutoffId ?? Number.MAX_SAFE_INTEGER) ||
              pending.has(Number(question.c4_id)) || keepQuestions.has(String(question.c4_id))) continue;
          records += db.prepare('DELETE FROM chat_question_controls WHERE question_c4_id=?').run(question.c4_id).changes;
          records += db.prepare('DELETE FROM chat_questions WHERE c4_id=?').run(question.c4_id).changes;
        }
        if (!preserveGroup) {
          records += db.prepare('DELETE FROM group_display_names WHERE session_group=?').run(sessionGroup).changes;
          records += db.prepare('DELETE FROM runtime_events WHERE session_group=?').run(sessionGroup).changes;
          records += db.prepare('DELETE FROM core_log_cursors WHERE stream=?').run(`events:${sessionGroup}`).changes;
        }
      }
      if (localId && !preserveGroup) records += resolved.draft
        ? db.prepare("DELETE FROM chat_conversations WHERE local_id=? AND state='draft' AND (namespace=? OR namespace IS NULL)").run(localId, namespace).changes
        : db.prepare('DELETE FROM chat_conversations WHERE local_id=? AND namespace=?').run(localId, namespace).changes;
      return { attachments, files, records };
    }).immediate();
  }
  return { resolveTarget, preview, finalizeTranscripts, cleanup, close() { if (ownedStore) store.close(); } };
}
