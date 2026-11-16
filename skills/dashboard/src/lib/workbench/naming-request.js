import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export const ORIGINAL_GROUP_NAME_PATH = '~/zylos/.claude/skills/dashboard/scripts/group-name.js';
export const NAME_PROMPT = `请给 Dashboard 里还没有名字的会话组起个名字：

1. 运行 node ~/zylos/.claude/skills/dashboard/scripts/group-name.js list --unnamed --active 3d，列出最近 3 天有活动、还没有名字的组。
2. 给每个组找出一个人能认出来的名字：群聊用群名，私聊用对方的名字。不同渠道拿名字的办法不一样，你自己判断：有的消息开头就写着（比如「[TG GROUP:产品周会]」「howard said」），有的只有编号，要用这个渠道的工具或接口去查。实在查不到就先跳过，最后告诉我。
3. 用 group-name.js set <组键> "名字" 设置。名字要短，让人一眼认出是哪个群、或者和谁的私聊。
4. 已经有名字的组不要动。
5. 做完列出你给每个组起的名字。`;

/** Preserve the supplied prompt verbatim apart from its known CLI path. */
export function namePromptText(scriptPath, template, originalPath) {
  if (typeof template !== 'string' || typeof originalPath !== 'string' || !originalPath || !template.includes(originalPath)) {
    throw new Error('name_prompt_path_missing');
  }
  return template.replace(originalPath, () => scriptPath);
}

function envelope(text) {
  try { const value = JSON.parse(String(text ?? '').trim()); return typeof value?.ok === 'boolean' ? value : null; }
  catch { return null; }
}
const unknown = message => ({ ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN', message } });

/**
 * Hand the naming prompt to Origin as one control. `readMode` reads this instance's session mode. Multi mode
 * addresses the `origin` group; otherwise the target stays empty, which C4 accepts only while the instance really
 * is in single mode (its one session). A queued control is the whole result: nothing waits for, or reports, the
 * naming itself.
 */
export function createNamingRequest({ zylosDir, readMode, execute = promisify(execFile), env = process.env }) {
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  return async function sendNamingPrompt() {
    const sessionGroup = await readMode() === 'multi' ? 'origin' : null;
    const script = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    const content = namePromptText(path.join(zylosDir, '.claude', 'skills', 'dashboard', 'scripts', 'group-name.js'),
      NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH);
    const argv = [script, 'enqueue', '--content', content, '--no-ack-suffix',
      ...(sessionGroup ? ['--group', sessionGroup] : []), '--json'];
    let reply;
    try {
      const { stdout } = await execute(process.execPath, argv, { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
      reply = envelope(stdout) ?? unknown('Core returned no result envelope');
    } catch (error) {
      reply = envelope(error.stdout) ?? unknown(error.message ?? 'Core command failed');
    }
    if (reply.ok && !Number.isSafeInteger(reply.data?.id)) reply = unknown('Core returned no control identifier');
    if (!reply.ok) return { ok: false, ...(reply.unknown ? { unknown: true } : {}), sessionGroup,
      error: { code: reply.error?.code ?? 'RESULT_UNKNOWN', message: reply.error?.message ?? '' } };
    return { ok: true, controlId: reply.data.id, sessionGroup };
  };
}
