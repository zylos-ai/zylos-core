import crypto from 'node:crypto';
import { readJsonBody } from './http.js';
import { sendJson } from './http.js';

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

const DEFAULT_SLOW_EVENT_WARN_MS = 100;

export class IngestHandler {
  constructor(store, sanitizer, stateEngine, config) {
    this.store = store;
    this.sanitizer = sanitizer;
    this.stateEngine = stateEngine;
    this.config = config;
    this.slowEventWarnMs = config?.observability?.slow_ingest_warn_ms ?? DEFAULT_SLOW_EVENT_WARN_MS;
    this.queue = null;
  }

  attachQueue(queue) {
    this.queue = queue;
  }

  async handle(req, res) {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }

    if (this.config.ingestToken) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${this.config.ingestToken}`) {
        sendJson(res, 403, { error: 'invalid_token' });
        return;
      }
    }

    let body;
    try {
      body = await readJsonBody(req, 64 * 1024);
    } catch (err) {
      const status = err.status || 400;
      sendJson(res, status, { error: err.message });
      return;
    }

    const { ingest_id, hook_event_name } = body;
    if (!ingest_id || !hook_event_name) {
      sendJson(res, 400, { error: 'missing ingest_id or hook_event_name' });
      return;
    }

    if (!ALLOWED_EVENTS.has(hook_event_name)) {
      sendJson(res, 200, { ok: true, ignored: true });
      return;
    }

    // Decoupled path (#260): ACK as soon as the event is queued; processing
    // runs in yielded batches off the request path. A full queue answers 503
    // so the hook falls back to its durable spool.
    if (this.queue) {
      if (!this.queue.push(body)) {
        sendJson(res, 503, { error: 'queue_full' });
        return;
      }
      sendJson(res, 200, { ok: true, queued: true });
      return;
    }

    // Inline fallback when no queue is attached (tests, minimal embeddings).
    try {
      this.processEvent(body);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      process.stderr.write(`[ingest-handler] Error: ${err.message}\n`);
      sendJson(res, 500, { error: 'internal_error' });
    }
  }

  // Synchronous processing for one validated event body. Called inline (no
  // queue) or from the IngestQueue drain loop. Throws on failure; the queue
  // routes failed bodies to the spool for retry.
  processEvent(body) {
    const { ingest_id, hook_event_name } = body;
    // Every step below runs synchronously on the event loop; under hook storms
    // (#260) the per-event cost is what starves HTTP. Time it so the slow step
    // is identifiable in logs while it happens.
    const startedNs = process.hrtime.bigint();
    const sanitized = this.sanitizer.sanitizeHookPayload(hook_event_name, body);
    const { event_type, category } = EVENT_TYPE_MAP[hook_event_name];

    const event = {
      id: crypto.randomUUID(),
      ingest_id,
      timestamp: body.received_at || new Date().toISOString(),
      runtime: body.runtime || process.env.ZYLOS_RUNTIME || 'claude',
      session_id: sanitized.session_id,
      event_type,
      category,
      summary: sanitized.summary,
      duration_ms: sanitized.duration_ms,
      metadata: sanitized.metadata,
      source: 'hook',
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

    if (inserted && this.stateEngine) {
      this.stateEngine.onEvent(event);
    }

    const now = new Date().toISOString();
    this.store.upsertSourceHealth('hook_handler', 'collector_liveness', 'healthy', { last_success: now });
    this.store.upsertSourceHealth('hook_events', 'runtime_progress', 'healthy', {
      last_success: now,
      runtime: event.runtime
    });

    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    if (elapsedMs >= this.slowEventWarnMs) {
      // Payload size computed only on the slow path — keeps the per-event
      // hot-path cost to two hrtime reads.
      const payloadBytes = Buffer.byteLength(JSON.stringify(body));
      process.stderr.write(`[ingest-handler] slow event: ${hook_event_name} took ${Math.round(elapsedMs)}ms (payload ${payloadBytes}B)\n`);
    }
  }
}
