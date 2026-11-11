import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Stands in for the Dashboard process: it runs the installed Dashboard's own modules from `<skills>/dashboard` and
// answers the parent's commands over IPC. Nothing here starts timers, servers, tmux or PM2.
const [dashboard] = process.argv.slice(2);
const zylosDir = process.env.ZYLOS_DIR;
const load = relative => import(pathToFileURL(path.join(dashboard, 'src', relative)).href);

const [{ C4Reader }, { CoreState }, { createGroupSnapshot }, { ChatSender }, { Store }] = await Promise.all([
  load('lib/c4-reader.js'), load('lib/core-state.js'), load('lib/workbench/group-snapshot.js'),
  load('lib/chat/send.js'), load('lib/store.js'),
]);
const reader = new C4Reader(zylosDir);
const coreState = new CoreState({ zylosDir });
const store = new Store(path.join(zylosDir, 'components', 'dashboard', 'dashboard.db'));
// The Core command-line reads run in child processes of their own; this process's driver use is what is measured.
const cli = { runC4Db: async () => [], readOverrides: async () => ({}) };
const snapshot = createGroupSnapshot({ zylosDir, store, c4Reader: reader, cli });

const drivers = () => [...new Set(fs.readFileSync('/proc/self/maps', 'utf8').split('\n')
  .map(line => line.slice(line.indexOf('/'))).filter(file => file.endsWith('/better_sqlite3.node')))];
const latest = () => reader._open()?.prepare('SELECT max(id) AS id FROM conversations').get().id ?? null;

const commands = {
  // One Core state read (the 1-second CoreState tick) and one group snapshot (the 5-second status read).
  async tick() { await coreState.refresh(); await snapshot.getSnapshot(Date.now() + Math.random() * 1e6); return {}; },
  // The chat send path's own Core loader and the channel binding it ensures before a send.
  async send() {
    const core = await new ChatSender({ zylosDir }).loadCore();
    return { namespace: core.ensureChannelNamespace('dashboard').namespace };
  },
  async read() { return { latest: latest() }; },
  async drivers() { return { drivers: drivers() }; },
};

process.on('message', async ({ id, command }) => {
  try { process.send({ id, ok: true, ...(await commands[command]()) }); }
  catch (error) { process.send({ id, ok: false, error: String(error?.stack || error) }); }
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true, latest: latest() });
