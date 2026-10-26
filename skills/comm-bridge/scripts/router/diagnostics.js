import { createJsonlStream } from '../../../../cli/lib/jsonl-stream.js';
import { routerDiagnosticPath, receiveDiagnosticPath } from '../../../../cli/lib/session-group-paths.js';

export function createRouterDiagnostics({ env = process.env, now = Date.now,
  stream = createJsonlStream(routerDiagnosticPath(env)),
  receiveStream = createJsonlStream(receiveDiagnosticPath(env)),
  stderr = text => process.stderr.write(text),
} = {}) {
  const waiting = new Set();
  const report = error => { stderr(`Router diagnostic write failed: ${error.message}\n`); return false; };
  function diagnostic(event, fields = {}) {
    if (event === 'wait_health') {
      const key = JSON.stringify([fields.session_group ?? fields.sessionGroup ?? null, fields.code]);
      if (waiting.has(key)) return Promise.resolve(false);
      waiting.add(key);
    }
    const { sessionGroup, conversationId, sessionId, ...rest } = fields;
    const record = { ...rest, v: 1, ts: now(), event,
      session_group: fields.session_group ?? sessionGroup ?? null,
      conversation_id: fields.conversation_id ?? conversationId ?? null,
      decision: fields.decision ?? event, reason: fields.reason ?? null,
      ...(fields.session_id ?? sessionId ? { session_id: fields.session_id ?? sessionId } : {}),
    };
    try { return Promise.resolve(stream.append(record)).then(() => true, report); }
    catch (error) { return Promise.resolve(report(error)); }
  }
  async function maintain() {
    const results = await Promise.allSettled([stream.maintain(), receiveStream.maintain()]);
    for (const result of results) if (result.status === 'rejected') report(result.reason);
  }
  return { diagnostic, maintain, flush: () => Promise.all([stream.flush(), receiveStream.flush()]) };
}
