import fs from 'node:fs';
import path from 'node:path';

const transactions = path.join(fs.realpathSync(process.env.ZYLOS_DIR), '.backup', 'self-upgrade');
const renameSync = fs.renameSync;

fs.renameSync = (source, destination) => {
  renameSync(source, destination);
  if (typeof destination !== 'string' || path.basename(destination) !== 'journal.json'
    || path.dirname(path.dirname(destination)) !== transactions) return;
  const journal = JSON.parse(fs.readFileSync(destination, 'utf8'));
  if (journal.phase === 'prepared') process.kill(process.pid, 'SIGSTOP');
};
