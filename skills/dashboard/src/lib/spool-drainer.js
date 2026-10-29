import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest',
  'SubagentStart', 'SubagentStop'
]);

const EVENT_TYPE_MAP = {
  SessionStart: { event_type: 'session_start', category: 'session' },
  PreToolUse: { event_type: 'pre_tool_use', category: 'tool' },
  PostToolUse: { event_type: 'post_tool_use', category: 'tool' },
  UserPromptSubmit: { event_type: 'user_prompt_submit', category: 'turn' },
  Stop: { event_type: 'stop', category: 'turn' },
  PermissionRequest: { event_type: 'permission_request', category: 'permission' },
  SubagentStart: { event_type: 'subagent_start', category: 'subagent' },
  SubagentStop: { event_type: 'subagent_stop', category: 'subagent' }
};

export class SpoolDrainer {
  constructor(store, sanitizer, config) {
    this.store = store;
    this.sanitizer = sanitizer;
    this.config = config;
    this.spoolPath = path.join(config.dataDir, 'spool', 'hook-events.jsonl');
    this.processingPath = this.spoolPath.replace('.jsonl', '.processing.jsonl');
    this._timer = null;
  }

  drainToDb() {
    return this._drain(null);
  }

  drainLive(stateEngine) {
    if (this._draining) return Promise.resolve({ processed: 0, duplicates: 0, errors: 0 });
    this._draining = true;
    this._stopRequested = false;
    this._liveDrain = (async () => {
      try {
        const steps = this._drainSteps(stateEngine);
        let started = performance.now();
        while (true) {
          const step = steps.next(this._stopRequested);
          if (step.done) return step.value;
          if (performance.now() - started >= 50) {
            await new Promise(resolve => setImmediate(resolve));
            started = performance.now();
          }
        }
      } finally {
        this._draining = false;
      }
    })();
    return this._liveDrain;
  }

  startPeriodicDrain(stateEngine, intervalMs = 30_000) {
    this.stopPeriodicDrain();
    this._timer = setInterval(() => {
      this.drainLive(stateEngine).catch(err => {
        process.stderr.write(`[spool-drainer] Live drain error: ${err.message}\n`);
      });
    }, intervalMs);
    this._timer.unref();
  }

  stopPeriodicDrain() {
    this._stopRequested = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this._liveDrain;
  }

  _drain(stateEngine) {
    if (this._draining) return { processed: 0, duplicates: 0, errors: 0 };
    this._draining = true;
    try {
      const steps = this._drainSteps(stateEngine);
      let step;
      do { step = steps.next(); } while (!step.done);
      return step.value;
    } finally {
      this._draining = false;
    }
  }

  *_drainSteps(stateEngine) {
    const result = { processed: 0, duplicates: 0, errors: 0 };

    try {
      fs.renameSync(this.spoolPath, this.processingPath);
    } catch {
      return result;
    }

    let lines;
    try {
      const content = fs.readFileSync(this.processingPath, 'utf8');
      lines = content.split('\n').filter(l => l.trim());
    } catch (err) {
      process.stderr.write(`[spool-drainer] Read error: ${err.message}\n`);
      return result;
    }

    const failedLines = [];
    let lastProcessedRuntime = null;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      try {
        const record = JSON.parse(line);
        const { ingest_id, hook_event_name, data, received_at, runtime } = record;

        if (!ALLOWED_EVENTS.has(hook_event_name)) {
          if (yield) { failedLines.push(...lines.slice(index + 1)); break; }
          continue;
        }

        const payload = data || record;
        const sanitized = this.sanitizer.sanitizeHookPayload(hook_event_name, payload);
        const { event_type, category } = EVENT_TYPE_MAP[hook_event_name];

        const event = {
          id: crypto.randomUUID(),
          ingest_id: ingest_id || crypto.randomUUID(),
          timestamp: received_at || new Date().toISOString(),
          runtime: runtime || process.env.ZYLOS_RUNTIME || 'claude',
          session_id: sanitized.session_id,
          event_type,
          category,
          summary: sanitized.summary,
          duration_ms: sanitized.duration_ms,
          metadata: sanitized.metadata,
          source: 'spool',
          confidence: 'actual'
        };

        const { inserted } = this.store.insertEvent(event);

        if (event.runtime === 'codex' && sanitized.metadata?.transcript_path && sanitized.session_id) {
          this.store.upsertCodexRolloutPath?.({
            runtime: event.runtime,
            sessionId: sanitized.session_id,
            transcriptPath: sanitized.metadata.transcript_path,
            lastEventAt: event.timestamp
          });
        }

        if (inserted) {
          result.processed++;
          lastProcessedRuntime = event.runtime;
          if (stateEngine) {
            stateEngine.onEvent(event);
          }
        } else {
          result.duplicates++;
        }
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
          result.duplicates++;
        } else {
          result.errors++;
          failedLines.push(line);
          process.stderr.write(`[spool-drainer] Line error: ${err.message}\n`);
        }
      }
      if (yield) {
        // Shutdown may arrive while the live drain is yielded. Preserve the
        // unprocessed tail alongside failures before the database is closed.
        failedLines.push(...lines.slice(index + 1));
        break;
      }
    }

    if (failedLines.length > 0) {
      try {
        fs.writeFileSync(this.spoolPath, failedLines.join('\n') + '\n', { flag: 'a' });
      } catch (err) {
        process.stderr.write(`[spool-drainer] Failed to requeue ${failedLines.length} lines: ${err.message}\n`);
      }
    }

    try {
      fs.unlinkSync(this.processingPath);
    } catch (err) {
      process.stderr.write(`[spool-drainer] Cleanup error: ${err.message}\n`);
    }

    if (result.processed > 0) {
      const now = new Date().toISOString();
      this.store.upsertSourceHealth('hook_handler', 'collector_liveness', 'healthy', { last_success: now });
      this.store.upsertSourceHealth('hook_events', 'runtime_progress', 'healthy', {
        last_success: now,
        runtime: lastProcessedRuntime || this.config.runtime || process.env.ZYLOS_RUNTIME || 'claude'
      });
    }

    return result;
  }
}
