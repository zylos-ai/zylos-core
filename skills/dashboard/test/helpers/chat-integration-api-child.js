import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { createChatSandbox } from './chat-integration-harness.js';
import { createChatApiFixture } from './chat-integration-api.js';

const cleanup = [];
const t = { after: callback => cleanup.push(callback) };
const sandbox = createChatSandbox(t, { existingRoot: path.dirname(process.env.HOME) });
if (!sandbox) throw Error('Explicit integration gate is required');
const fixture = await createChatApiFixture(t, sandbox, { name: 'remote-process', pageApis: process.argv.includes('--page-apis') });
if (process.argv.includes('--lookup-unavailable')) fixture.setLookupUnavailable(true);
await fixture.restartDelivery();
const send = value => process.stdout.write(`CHAT_RPC ${JSON.stringify(value)}\n`);
send({ ready: true, base: fixture.base, cookie: fixture.cookie, tokens: fixture.tokens, root: sandbox.root,
  pid: process.pid, proof: sandbox.assertIsolation() });
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  try {
    let value;
    if (message.operation === 'snapshot') value = { conversations: fixture.db.prepare('SELECT COUNT(*) n FROM conversations').get().n,
      receive: fixture.counts.receive, upstream: fixture.counts.upstream, mode: fixture.readMode(),
      deliveries: fixture.store.db.prepare('SELECT answer_id,state FROM chat_answer_deliveries ORDER BY answer_id LIMIT 10').all() };
    else if (message.operation === 'route') { fixture.setRoute(message.args[0]); value = true; }
    else if (message.operation === 'proxy') { fixture.setProxy(message.args[0]); value = true; }
    else if (message.operation === 'notification') { fixture.setNotification(message.args[0]); value = true; }
    else if (message.operation === 'invoke') {
      if (message.args[0] === 'lostAfterCommit') fixture.setInvoke(async args => { await fixture.realReceive(args); throw Error('controlled lost receipt'); });
      else if (message.args[0] === 'unknownC4Outage') fixture.setInvoke(async () => { fixture.setLookupUnavailable(true); throw Error('controlled unknown receipt'); });
      else fixture.setInvoke(null);
      value = true;
    }
    else if (message.operation === 'answerRows') value = fixture.answerRows(message.args[0]);
    else if (message.operation === 'addOutbound') value = fixture.addOutbound(...message.args);
    else if (message.operation === 'registerAttachment') {
      const [localId, name, kind, base64] = message.args;
      if (path.basename(name) !== name) throw Error('Private fixture filename required');
      const directory = path.join(sandbox.paths.zylos, 'workspace'); fs.mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, name); fs.writeFileSync(filename, Buffer.from(base64, 'base64'));
      value = await fixture.attachments.register(localId, { kind, path: filename });
    }
    else if (message.operation === 'close') {
      await sandbox.close(); send({ id: message.id, value: true }); input.close(); break;
    } else throw Error('Unknown private fixture operation');
    send({ id: message.id, value });
  } catch (error) { send({ id: message.id, error: error.message }); }
}
await sandbox.close();
