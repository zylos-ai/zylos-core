import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createGroupDeletion } from './group-delete.js';

export async function runGroupDeletionCli(args, { io = process, create = createGroupDeletion } = {}) {
  const options = {}, flags = new Set();
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flags.has(flag)) throw new Error('Duplicate option');
      flags.add(flag);
      if (['--yes', '--preview', '--json'].includes(flag)) { options[flag.slice(2)] = true; continue; }
      if (!['--group', '--draft-local-id', '--operation-id', '--actor', '--cutoff-id', '--generation-id', '--target-key'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid deletion option');
      options[flag.slice(2)] = args[++i];
    }
    if (options['cutoff-id'] !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(options['cutoff-id']) || !Number.isSafeInteger(Number(options['cutoff-id']))) throw new Error('Invalid deletion cutoff');
      options.cutoffId = Number(options['cutoff-id']);
    }
    if (options['generation-id'] !== undefined) {
      options.generationId = JSON.parse(options['generation-id']);
      if (!(options.generationId === null || typeof options.generationId === 'string' && options.generationId)) throw new Error('Invalid deletion generation');
    }
    if (Boolean(options.group) === Boolean(options['draft-local-id']) || options.yes && options.preview) throw new Error('Choose exactly one conversation target');
  } catch (cause) {
    const result = { ok: false, error: { code: 'INVALID_ARGUMENT', message: cause.message } };
    io.stderr.write(`${JSON.stringify(result)}\n`); return 1;
  }
  const service = create({ zylosDir: process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos') });
  try {
    const target = options.group ? { sessionGroup: options.group } : { draftLocalId: options['draft-local-id'] };
    let confirmation = { confirmed: true, actor: options.actor ?? `cli:${os.userInfo().username}`, operationId: options['operation-id'],
      cutoffId: options.cutoffId, generationId: options.generationId, targetKey: options['target-key'] };
    if (options.yes && !options['operation-id'] && options.cutoffId === undefined && options.generationId === undefined && options['target-key'] === undefined) {
      const preview = await service.preview(target);
      if (preview.ok === false) throw Object.assign(new Error(preview.error?.message ?? 'Preview failed'), { code: preview.error?.code ?? 'GROUP_DELETE_FAILED' });
      confirmation = { ...confirmation, operationId: preview.operationId, cutoffId: preview.cutoffId, generationId: preview.generationId, targetKey: preview.targetKey };
    }
    const result = options.yes ? await service.delete(target, confirmation) : await service.preview(target);
    if (options.json) io.stdout.write(`${JSON.stringify(result)}\n`);
    else if (!result.ok) io.stderr.write(`Error [${result.error.code}]: ${result.error.message}\n`);
    else if (!options.yes) io.stdout.write(`Conversation: ${options.group ?? options['draft-local-id']}\nMessages: ${result.messages}; attachments: ${result.attachments}; files: ${result.files}.\nDeletion is irreversible. Only messages through this preview cutoff and data proven to belong to them are removed; later messages, uncertain data, main memory, usage and backups remain.\nConfirm with --yes --operation-id ${result.operationId} --cutoff-id ${result.cutoffId} --generation-id '${JSON.stringify(result.generationId)}' --target-key '${result.targetKey}'.\n`);
    else io.stdout.write(result.pending ? `Deletion pending (${result.reason ?? 'retry'}); retry with --operation-id ${result.operationId}.\n` : `Deleted conversation. ${JSON.stringify(result.counts)}${result.countsEstimated ? ' Counts are estimates after an interrupted cleanup.' : ''}\n`);
    return result.ok ? 0 : 1;
  } catch (cause) {
    const result = { ok: false, error: { code: cause.code ?? 'GROUP_DELETE_FAILED', message: cause.message,
      ...((cause.statusCode ?? cause.status) ? { status: cause.statusCode ?? cause.status } : {}) } };
    (options.json ? io.stdout : io.stderr).write(options.json ? `${JSON.stringify(result)}\n` : `Error [${result.error.code}]: ${result.error.message}\n`);
    return 1;
  } finally { service.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGroupDeletionCli(process.argv.slice(2));
}
