import { projectQuestion } from './answers.js';
import { requireChatAccess, requireChatWrite } from './access.js';
import { readJsonBody, sendJson } from '../http.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const respondDenied = (res, denied) => {
  const { status, ...body } = denied;
  sendJson(res, status, body);
};

/** Server-owned conversation routing and saved question constraints govern every action. */
export async function handleChatAnswers(req, res, url, { auth, config, answers, delivery, sender, readMode }) {
  const match = /^\/api\/chat\/conversations\/([^/]+)\/(questions|answers)$/.exec(url.pathname);
  if (!match) return false;
  const read = match[2] === 'questions';
  const preflight = read ? requireChatAccess(req, auth, config)
    : requireChatWrite(req, auth, config, { mode: readMode(), draft: true });
  if (preflight) { respondDenied(res, preflight); return true; }
  if (req.method !== (read ? 'GET' : 'POST')) {
    sendJson(res, 405, { error: 'method_not_allowed' }); return true;
  }
  try {
    let id;
    try { id = decodeURIComponent(match[1]); } catch { throw fail('invalid_chat_conversation'); }
    const allowed = read ? ['limit', 'cursor'] : [];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) ||
        allowed.some(key => url.searchParams.getAll(key).length > 1)) throw fail('invalid_chat_parameters');
    const limit = url.searchParams.get('limit') ?? '50';
    if (read && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100)) throw fail('invalid_chat_question_page');
    const body = read ? null : await readJsonBody(req, 128 * 1024);
    const row = await sender.resolve(id);
    const authorize = () => row.state !== 'active' ? { status: 403, error: 'chat_conversation_forbidden' }
      : requireChatWrite(req, auth, config, {
        mode: readMode(), conversation: row, namespace: row.namespace, localId: row.localId,
      });
    if (read) {
      const denied = requireChatAccess(req, auth, config);
      if (denied) { respondDenied(res, denied); return true; }
      if (!row.namespace) { sendJson(res, 200, { items: [], nextCursor: null }); return true; }
      let afterAnswerId = '';
      do {
        const batch = await delivery.reconcileGroup(row.sessionGroup, { limit: 100, afterAnswerId });
        afterAnswerId = batch.nextCursor;
      } while (afterAnswerId);
      const page = answers.listQuestions(row.sessionGroup, {
        limit: Number(limit), cursor: url.searchParams.get('cursor'),
      });
      const currentAccess = requireChatAccess(req, auth, config);
      if (currentAccess) { respondDenied(res, currentAccess); return true; }
      sendJson(res, 200, { ...page, items: page.items.map(question => {
        if (!question.answerId) return projectQuestion(question);
        const { action, actionError } = answers.get(question.answerId);
        return projectQuestion(question, { action, actionError,
          delivery: delivery.receipt(question.answerId) });
      }) });
      return true;
    }
    const denied = authorize();
    if (denied) { respondDenied(res, denied); return true; }
    if (!object(body) || Object.keys(body).some(key => !['interruptId', 'action', 'retry'].includes(key)) ||
        typeof body.interruptId !== 'string' || !object(body.action) ||
        (Object.hasOwn(body, 'retry') && typeof body.retry !== 'boolean')) throw fail('invalid_chat_parameters');
    const accepted = answers.accept({ sessionGroup: row.sessionGroup, endpointId: row.localId,
      interruptId: body.interruptId, action: body.action });
    const receipt = await delivery.deliver(accepted.answer.answerId, {
      initial: accepted.created, retry: body.retry ?? false, authorize,
    });
    sendJson(res, 200, { answer: accepted.answer, delivery: receipt });
  } catch (error) {
    sendJson(res, error.statusCode || error.status || 502, { error: error.code || error.message || 'chat_answer_failed' });
  }
  return true;
}
