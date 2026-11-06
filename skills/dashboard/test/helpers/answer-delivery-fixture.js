import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../../src/lib/store.js';
import { ChatAnswers } from '../../src/lib/chat/answers.js';
import { ChatAnswerDelivery } from '../../src/lib/chat/delivery.js';
import { ChatSender } from '../../src/lib/chat/send.js';
import { registerQuestion } from '../../src/lib/chat/questions.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { receive } from '../../../comm-bridge/scripts/c4-receive.js';
import { isDataError } from '../../../comm-bridge/scripts/c4-session-group.js';
import { SKILLS_DIR } from '../../../comm-bridge/scripts/c4-config.js';
import { CONTENT_PREFIX, parseC4Content } from '../../../comm-bridge/scripts/c4-content-schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';

const protocol = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));

// Own two SQLite files, one readonly C4 handle, and no live runtime/HTTP/PM2.
// Real receive uses only fixture route/notification adapters. The official
// runner establishes HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR before imports.
export function answerDeliveryFixture(t) {
  assert.ok(!path.resolve(process.env.HOME).startsWith(os.userInfo().homedir + path.sep));
  assert.ok(SKILLS_DIR.startsWith(process.env.ZYLOS_DIR + path.sep));
  fs.mkdirSync(path.join(SKILLS_DIR, 'dashboard'), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-delivery-'));
  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  const db = new Database(path.join(root, 'c4.db'));
  guardDatabase(db, schema);
  db.pragma('busy_timeout=10');
  const store = new Store(path.join(root, 'components/dashboard/dashboard.db'));
  const readonly = new Database(path.join(root, 'c4.db'), { readonly: true, fileMustExist: true });
  const c4 = createStore(db, { validateComponent: name => name === 'dashboard',
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const namespace = c4.ensureChannelNamespace('dashboard').namespace;
  const counts = { receive: 0, queries: 0, pages: 0, maxPage: 0, notifications: 0 };
  let route = { decision: 'pending', runtime: 'claude' }, invoke = null, queryError = false, notification = 'suppressed', contentProbe = null;
  const observed = new Proxy(readonly, { get(target, key) {
    if (key === 'prepare') return sql => {
      if (sql.includes('FROM conversations INDEXED BY idx_conv_group_id')) {
        counts.queries++;
        if (queryError) throw Error('private lookup unavailable');
        const statement = target.prepare(sql);
        return { all(parameters) {
          const rows = statement.all(parameters);
          counts.pages++; counts.maxPage = Math.max(counts.maxPage, rows.length);
          return rows.map(row => new Proxy(row, { get(target, key) {
            if (key === 'content') contentProbe?.(target);
            return target[key];
          } }));
        } };
      }
      return target.prepare(sql);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const reader = { _open: () => observed };
  const realReceive = args => receive(args, {
    db: c4,
    queryRoute: async () => route,
    appendEntryEvent: async () => true,
    reserveStatusNotice: () => ({ suppressed: notification === 'suppressed' }),
    sendStatusNotice: () => { counts.notifications++; return { outcome: notification }; },
    diagnostic() {},
  });
  const core = { receive: async args => { counts.receive++; return (invoke || realReceive)(args); },
    isDataError, getChannelNamespace: name => c4.getChannelNamespace(name),
    ensureChannelNamespace: name => c4.ensureChannelNamespace(name) };
  const answers = new ChatAnswers({ store });
  const sender = new ChatSender({ conversations: null, c4Reader: reader, loadCore: async () => core, zylosDir: root });
  const makeDelivery = () => new ChatAnswerDelivery({ answers, sender, c4Reader: reader });
  const delivery = makeDelivery();
  let serial = 0;
  function createQuestion({ localId = 'answer-group', name = 'single' } = {}) {
    const envelope = structuredClone(parseC4Content(protocol.valid.find(item => item.name === name).content).envelope);
    serial++;
    envelope.messageId += `_${serial}`;
    envelope.interruptId += `_${serial}`;
    if (!db.prepare('SELECT 1 FROM group_heads WHERE session_group=?').get(`${namespace}:${localId}`)) {
      c4.insertConversation('in', 'dashboard', localId, 'fixture group seed', { groupName: localId });
    }
    const row = c4.insertConversation('out', 'dashboard', localId, CONTENT_PREFIX + JSON.stringify(envelope), { groupName: localId });
    registerQuestion(row, { env: { ZYLOS_DIR: root } });
    return { row, envelope, sessionGroup: row.session_group, endpointId: localId };
  }
  function accept({ question = createQuestion(), actionId = `answer_action_${serial}`, payload = { selected: ['a'] } } = {}) {
    const block = question.envelope.blocks.find(item => item.id === question.envelope.interrupt.blockId);
    const action = { id: actionId, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: question.envelope.messageId, blockId: block.id }, payload };
    return answers.accept({ sessionGroup: question.sessionGroup, endpointId: question.endpointId,
      interruptId: question.envelope.interruptId, action });
  }
  function answerRows(answerId) {
    return db.prepare("SELECT * FROM conversations WHERE direction='in' ORDER BY id").all().filter(row => {
      const parsed = parseC4Content(row.content);
      return parsed.kind === 'envelope' && parsed.envelope.kind === 'answer' && parsed.envelope.metadata.zylos.answerId === answerId;
    });
  }
  t.after(() => { readonly.close(); store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, c4, store, answers, sender, delivery, reader, core, namespace, counts,
    realReceive, createQuestion, accept, answerRows, makeDelivery,
    setInvoke: value => { invoke = value; }, setRoute: value => { route = value; },
    setQueryError: value => { queryError = value; }, setNotification: value => { notification = value; },
    setContentProbe: value => { contentProbe = value; } };
}
