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

// What the API says is fixed English chosen here, never text from the child: its error message carries the command
// line (with the whole prompt), install paths and stacks. The code is kept when it looks like one.
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
function commandFailure(error) {
  if (error?.killed && error?.signal === 'SIGTERM') return 'Send command timed out';
  if (Number.isInteger(error?.code)) return `Send command failed (exit ${error.code})`;
  if (typeof error?.signal === 'string' && error.signal) return `Send command stopped (${error.signal})`;
  return 'Send command could not start';
}

/**
 * Hand the naming prompt to Origin as one control. A configured session mode addresses the `origin` group;
 * instances without the session_mode key keep the legacy empty target. A queued control is the whole result: nothing waits for, or reports, the
 * naming itself. Failures answer with an error code and a fixed sentence; the child's own message and stderr go to
 * `log` (the service log) only.
 */
export function createNamingRequest({ zylosDir, readMode, execute = promisify(execFile), env = process.env,
  log = message => console.error(message) }) {
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  return async function sendNamingPrompt() {
    const sessionGroup = ['single', 'multi'].includes(await readMode()) ? 'origin' : null;
    const script = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');
    const content = namePromptText(path.join(zylosDir, '.claude', 'skills', 'dashboard', 'scripts', 'group-name.js'),
      NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH);
    const argv = [script, 'enqueue', '--content', content, '--no-ack-suffix',
      ...(sessionGroup ? ['--group', sessionGroup] : []), '--json'];
    const failed = (answer, raw) => {
      log(`[dashboard] Automatic naming was not queued (${answer.error.code}): ${raw}`);
      return { ok: false, ...answer, sessionGroup };
    };
    const unknown = (message, raw) => failed({ unknown: true, error: { code: 'RESULT_UNKNOWN', message } }, raw);
    let stdout, error;
    try { ({ stdout } = await execute(process.execPath, argv, { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 })); }
    catch (thrown) { error = thrown; stdout = thrown?.stdout; }
    const reply = envelope(stdout);
    const raw = [reply?.error?.message, error?.message, error?.stderr, reply ? '' : stdout].filter(Boolean).join('\n');
    if (reply && !reply.ok) {
      const code = CODE.test(reply.error?.code ?? '') ? reply.error.code : 'ENQUEUE_REJECTED';
      return failed({ error: { code, message: 'C4 did not queue the naming prompt' } }, raw);
    }
    if (!reply) return unknown(error ? commandFailure(error) : 'Core returned no result envelope', raw);
    if (!Number.isSafeInteger(reply.data?.id)) return unknown('Core returned no control identifier', raw || String(stdout));
    return { ok: true, controlId: reply.data.id, sessionGroup };
  };
}
