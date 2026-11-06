import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
if (process.argv[1]?.endsWith('/dashboard/scripts/send.js')) {
  fs.appendFileSync(process.env.CHANNEL_SEND_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
}
const blocked = () => {
  fs.appendFileSync(process.env.CHANNEL_HTTP_LOG, 'attempt\n');
  throw new Error('Network is forbidden in this delivery fixture');
};
http.request = http.get = https.request = https.get = net.connect = net.createConnection = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
