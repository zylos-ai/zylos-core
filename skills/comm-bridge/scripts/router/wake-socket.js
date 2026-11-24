import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR } from '../c4-config.js';
import { parseSessionGroup } from '../c4-session-group.js';

const defaultSocketPath = path.join(DATA_DIR, 'dispatcher.sock');

export function notifyQueued(group, {
  socketPath = defaultSocketPath, timeoutMs = 5, createConnection = net.createConnection,
} = {}) {
  // Keep the socket and timer referenced so one-shot writers can flush the hint.
  return new Promise(resolve => {
    let socket;
    const done = () => {
      clearTimeout(timer);
      socket?.destroy();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      socket = createConnection(socketPath);
      socket.once('error', done);
      socket.once('close', done);
      socket.once('connect', () => {
        try { socket.end(group + '\n', done); } catch { done(); }
      });
    } catch { done(); }
  });
}

async function removeStaleSocket(socketPath) {
  const stat = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!stat?.isSocket()) return;
  const stale = await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.setTimeout(5, () => { probe.destroy(); resolve(false); });
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) return;
  const current = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (current?.dev === stat.dev && current.ino === stat.ino) fs.unlinkSync(socketPath);
}

export async function listenForWake(wake, {
  socketPath = defaultSocketPath,
  onError = () => {},
} = {}) {
  const clients = new Set();
  const server = net.createServer(client => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(1000, () => client.destroy());
    let line = '';
    client.setEncoding('utf8');
    client.on('data', chunk => {
      line += chunk;
      if (line.length > 129) client.destroy();
    });
    client.once('end', () => {
      const group = line.slice(0, -1);
      if (line.endsWith('\n') && !group.includes('\n') && parseSessionGroup(group)) wake(group);
    });
  });
  await removeStaleSocket(socketPath);
  await new Promise((resolve, reject) => {
    const startupFailed = error => reject(error);
    server.once('error', startupFailed);
    server.once('listening', () => {
      server.off('error', startupFailed);
      server.on('error', onError);
      resolve();
    });
    // Unix socket permissions are set at bind time, before accepting clients.
    const previous = process.umask(0o177);
    try { server.listen(socketPath); }
    finally { process.umask(previous); }
  });
  return () => new Promise(resolve => {
    // Node removes the Unix socket path when it closes the listener.
    server.close(resolve);
    for (const client of clients) client.destroy();
  });
}
