import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Invoked by the native model, with paths it observed in the actual incoming
// attachment annotations. No expected digest or annotation path is saved here.
const [endpoint, phase, imagePath, filePath] = process.argv.slice(2);
assert.match(endpoint || '', /^[A-Za-z0-9_-]+$/);
assert.ok(['original', 'fresh'].includes(phase));
const root = fs.realpathSync(process.env.ZYLOS_DIR);
const media = path.join(root, 'components/dashboard/media');
const run = (script, args, input) => {
  const child = spawnSync(process.execPath, [path.join(root, '.claude/skills', script), ...args], {
    cwd: root, env: process.env, input, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
};
const read = (filename, kind) => {
  assert.ok(path.isAbsolute(filename));
  const actual = fs.realpathSync(filename);
  assert.equal(path.dirname(actual), media, 'Model must provide a target-owned annotated media path');
  const bytes = fs.readFileSync(actual);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const copy = path.join(root, 'workspace', `${phase}-reply.${kind === 'image' ? 'png' : 'txt'}`);
  fs.writeFileSync(copy, bytes, { mode: 0o600 });
  const record = JSON.parse(run('dashboard/scripts/attachments.js', [
    'register', '--conversation', endpoint, '--kind', kind, '--path', copy,
  ]));
  assert.equal(record.ok, true);
  assert.ok(record.attachmentId);
  return { record, hash, path: actual };
};
const image = read(imagePath, 'image'), file = read(filePath, 'file');
const receipt = `FIXTURE_ATTACHMENT_ACK:${phase}:${image.hash}:${file.hash}`;
const block = (id, kind, record) => ({ id, type: `x-zylos.${kind}`, schemaVersion: 1,
  data: { attachmentId: record.attachmentId, nameSnapshot: record.name }, fallbackText: record.name });
const content = '[C4-JSON]\n' + JSON.stringify({ version: 1, kind: 'message',
  messageId: `native_attachment_${phase}_${crypto.randomUUID()}`, fallbackText: receipt,
  blocks: [
    { id: 'read-receipt', type: 'markdown', schemaVersion: 1, data: { text: receipt } },
    block('image', 'image', image.record),
    { id: 'between', type: 'markdown', schemaVersion: 1, data: { text: 'The registered file follows the registered image.' } },
    block('file', 'file', file.record),
  ] });
run('comm-bridge/scripts/c4-send.js', ['dashboard', endpoint, '--session-group', endpoint], content);
fs.writeFileSync(path.join(root, 'workspace', `fixture-attachment-observed-${phase}.json`), JSON.stringify({
  endpoint, phase, paths: [image.path, file.path], hashes: [image.hash, file.hash]
}), { flag: 'wx', mode: 0o600 });
