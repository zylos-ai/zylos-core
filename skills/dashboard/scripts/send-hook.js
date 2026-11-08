#!/usr/bin/env node
import fs from 'node:fs';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES, parseC4Content, readC4Envelope, validateAttachmentData, validateHookInput } from '../../comm-bridge/scripts/c4-content-schema.js';
import { isMainModule } from '../../comm-bridge/scripts/is-main-module.js';
import { resolveUploadRoot } from '../../web-console/scripts/attachment-utils.js';
import { withChatAttachments } from '../src/lib/chat/attachments.js';

const abort = message => ({ version: 1, decision: 'abort', message });
const registerAgain = () => abort('Attachment reference unavailable. Please register again on the target machine and use the returned attachment ID.');
const replyVia = () => abort('Invalid attachment destination. Send using the original reply-via command, including --session-group.');
const attachment = block => block && ['x-zylos.image', 'x-zylos.file'].includes(block.type);

/** Validate Dashboard output before C4 storage without performing registration. */
export function evaluateBeforeSend(input, { env = process.env } = {}) {
  if (!validateHookInput(input) || input.hook_id !== 'dashboard.content' || input.request.channel !== 'dashboard') {
    return abort('Invalid Dashboard BeforeSend input.');
  }
  const content = input.request.content;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return abort('Dashboard content exceeds 65536 UTF-8 bytes.');
  }
  if (content.startsWith(CONTENT_PREFIX)) {
    // Extraction is not validation. Inspect only the required path hint before
    // the closed schema rejects it; every continuing request is parsed below.
    const raw = readC4Envelope(content);
    if (raw.kind === 'envelope' && Array.isArray(raw.envelope?.blocks)
        && raw.envelope.blocks.some(block => attachment(block) && block.data
          && Object.hasOwn(block.data, 'path'))) {
      return abort('File blocks accept attachment IDs only. Run the Dashboard attachment register command first.');
    }
    const parsed = parseC4Content(content);
    if (parsed.kind !== 'envelope') {
      return raw.kind === 'envelope' && Array.isArray(raw.envelope?.blocks)
        && raw.envelope.blocks.some(block => attachment(block) && !validateAttachmentData(block.data))
        ? registerAgain() : abort('Invalid Dashboard structured content.');
    }
    if (parsed.viewError) return abort('Invalid Dashboard view: ' + parsed.viewError);
    const blocks = parsed.envelope.kind === 'message' ? parsed.envelope.blocks.filter(attachment) : [];
    if (blocks.length) {
      const { endpoint, options } = input.request;
      if (options.wholeGroup || endpoint !== options.groupName) return replyVia();
      try {
        withChatAttachments(resolveUploadRoot(env), { readonly: true }, service => {
          service.validateAgentReferences(endpoint, blocks);
        });
      } catch (error) {
        if (error.code === 'invalid_chat_attachment_destination') return replyVia();
        if (['chat_attachment_core_unavailable', 'chat_attachment_schema_unavailable'].includes(error.code)) {
          return abort('Dashboard attachment service unavailable.');
        }
        return registerAgain();
      }
    }
  }
  return { version: 1, decision: 'continue' };
}

if (isMainModule(import.meta.url)) {
  let output;
  try { output = evaluateBeforeSend(JSON.parse(fs.readFileSync(0, 'utf8'))); }
  catch { output = abort('Invalid Dashboard BeforeSend input.'); }
  process.stdout.write(JSON.stringify(output) + '\n');
}
