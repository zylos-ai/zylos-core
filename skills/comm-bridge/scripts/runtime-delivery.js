import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb } from './c4-db.js';
import { TMUX_SESSION } from './c4-config.js';
import { readRuntimeGeneration, readProcessStart, runtimeRoot } from '../../activity-monitor/scripts/runtime-generation.js';

let lastCleanupAt = 0;
export function cleanupFailureNoticeHistory(database, identity, now = Date.now()) {
  const cutoff = now - 7 * 86400000;
  return database.transaction(() => {
    const oldAttempts = database.prepare(`SELECT notice_key FROM status_notice_attempts a
      WHERE status IN ('sent','failed','uncertain') AND updated_at<?
      AND NOT EXISTS (SELECT 1 FROM runtime_notice_intents n WHERE n.claim_key=a.notice_key AND n.status='pending') LIMIT 500`)
      .all(Math.floor(cutoff/1000));
    for (const attempt of oldAttempts) {
      let episode;
      try { episode = JSON.parse(attempt.notice_key)[1]; } catch { continue; }
      let expired = typeof episode === 'string' && episode.startsWith('failure:');
      const persistent = typeof episode === 'string' && episode.match(/^(claude|codex):(\d+)$/);
      if (persistent) {
        const row = database.prepare('SELECT state_json FROM runtime_health_state WHERE runtime_id=?').get(persistent[1]);
        if (row) {
          const state = JSON.parse(row.state_json);
          expired = Number(persistent[2]) < state.episode || (state.health === 'ok' && Number(persistent[2]) === state.episode);
        }
      }
      // Current outage uncertainty must outlive retention so inbound traffic
      // cannot retry it merely because the first notice's history expired.
      if (expired) database.prepare('DELETE FROM status_notice_attempts WHERE notice_key=?').run(attempt.notice_key);
    }
    database.prepare(`DELETE FROM runtime_notice_intents WHERE event_id IN
      (SELECT event_id FROM runtime_notice_intents WHERE status!='pending' AND updated_at<? LIMIT 500)`).run(cutoff);
    database.prepare(`DELETE FROM runtime_deliveries WHERE id IN (SELECT d.id FROM runtime_deliveries d
      WHERE d.started_at<? AND NOT EXISTS (SELECT 1 FROM runtime_notice_intents n WHERE n.delivery_id=d.id AND n.status='pending')
      AND d.id!=COALESCE((SELECT MAX(id) FROM runtime_deliveries WHERE runtime_id=? AND runtime_generation=? AND session_id=?),-1)
      LIMIT 500)`).run(cutoff,identity?.runtime || '',identity?.runtime_generation || '',identity?.session_id || '');
  }).immediate();
}

export function sameDeliveryIdentity(a, b) {
  return !!a && !!b && ['runtime','runtime_generation','session_id','process_start','claude_pid']
    .every(key => a[key] != null && a[key] === b[key]);
}

export function readDeliveryIdentity({ zylosDir = runtimeRoot(), session = TMUX_SESSION,
  read = fs.readFileSync, run = execFileSync, generationReader = readRuntimeGeneration, processStart = readProcessStart } = {}) {
  try {
    const generation = generationReader(zylosDir);
    const foreground = JSON.parse(read(path.join(zylosDir, 'activity-monitor/foreground-session.json'), 'utf8'));
    if (generation?.runtime !== 'claude' || foreground.runtime_generation !== generation.runtime_generation ||
        !foreground.session_id || !foreground.process_start || processStart(foreground.claude_pid) !== foreground.process_start) return null;
    const pane = Number(run('tmux', ['display-message','-p','-t',session,'#{pane_pid}'], {
      encoding:'utf8', timeout:2000, stdio:'pipe',
    }).trim());
    let pid = foreground.claude_pid;
    for (let depth = 0; depth < 8 && pid > 1; depth++) {
      if (pid === pane) return { ...generation, session_id:foreground.session_id,
        process_start:foreground.process_start, claude_pid:foreground.claude_pid };
      const stat = read(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
  } catch { /* Missing runtime proof cannot authorize a notice target. */ }
  return null;
}

export function beginRuntimeDelivery(item, identity, { now = Date.now(), database = getDb() } = {}) {
  if (item.type !== 'conversation' || !identity?.session_id || !identity?.process_start || !identity?.runtime_generation ||
      !item.endpoint_id || ['void','system','control','scheduler'].includes(item.channel)) return null;
  if (now - lastCleanupAt >= 3600000) {
    cleanupFailureNoticeHistory(database,identity,now);
    lastCleanupAt = now;
  }
  const result = database.prepare(`INSERT INTO runtime_deliveries
    (conversation_id,runtime_id,runtime_generation,session_id,process_start,channel,endpoint,status,started_at)
    VALUES (?,?,?,?,?,?,?,'submitting',?)`).run(item.id,identity.runtime,identity.runtime_generation,
      identity.session_id,identity.process_start,item.channel,item.endpoint_id || '',now);
  return { id:Number(result.lastInsertRowid), identity };
}

export function finishRuntimeDelivery(record, item, outcome, identity, { now = Date.now(), database = getDb() } = {}) {
  return database.transaction(() => {
    if (outcome === 'submitted') database.prepare("UPDATE conversations SET status='delivered' WHERE id=? AND direction='in'").run(item.id);
    if (!record) return;
    const verified = outcome === 'submitted' && sameDeliveryIdentity(record.identity,identity);
    database.prepare("UPDATE runtime_deliveries SET status=?,submitted_at=? WHERE id=? AND status='submitting'")
      .run(verified?'delivered':'uncertain',verified?now:null,record.id);
  }).immediate();
}
