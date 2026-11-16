import fs from 'node:fs';
const version = fs.readFileSync(process.env.SINGLETON_VERSION_FILE, 'utf8').trim();
if (!['v1', 'v2'].includes(version)) throw new Error('Unknown immutable fixture entry version');
await import(`./${version}.js`);
