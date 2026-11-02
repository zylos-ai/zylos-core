import fs from 'node:fs';
import path from 'node:path';
import { acquire, withMemoryLock, memoryScope } from '../../sync-lock.js';
import { appendInbox } from '../../memory-append.js';
let rotating = false;
process.on('message', async message => {
  try {
    if (message.op === 'acquire') {
      const token = await acquire({ kind: 'group' }, { currentRunId: async scope => scope.runId });
      process.send({ token });
    } else if (message.op === 'append') {
      for (let i = 0; i < 1000; i++) await appendInbox({ kind: 'fact', content: `${message.prefix}-${i}` });
      process.send({ count: 1000 });
    } else if (message.op === 'append-stop') {
      const io = { ...fs, openSync(...args) {
        const fd = fs.openSync(...args);
        process.send({ opened: true });
        process.kill(process.pid, 'SIGSTOP');
        return fd;
      } };
      await appendInbox({ kind: 'fact', content: 'opened-before-stop' }, { io });
      process.send({ appended: true });
    } else if (message.op === 'rotate') {
      rotating = true;
      const scope = await memoryScope(); let rotations = 0;
      while (rotating) {
        await new Promise(resolve => setTimeout(resolve, 10));
        await withMemoryLock(scope.runDir, () => {
          const inbox = path.join(scope.memoryDir, 'inbox.md');
          try {
            if (fs.statSync(inbox).size) fs.renameSync(inbox, path.join(scope.memoryDir, `inbox.rotated-${rotations++}.md`));
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        });
      }
      process.send({ rotations });
    } else if (message.op === 'stop-rotation') rotating = false;
  } catch (error) { process.send({ code: error.code || 'ERROR', message: error.message }); }
});
