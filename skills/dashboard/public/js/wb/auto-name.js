import { element } from './plain-text.js?v=84';

export const ORIGINAL_GROUP_NAME_PATH = '~/zylos/.claude/skills/dashboard/scripts/group-name.js';
export const NAME_PROMPT = `请给 Dashboard 里还没有名字的会话组起个名字：

1. 运行 node ~/zylos/.claude/skills/dashboard/scripts/group-name.js list --unnamed --active 3d，列出最近 3 天有活动、还没有名字的组。
2. 给每个组找出一个人能认出来的名字：群聊用群名，私聊用对方的名字。不同渠道拿名字的办法不一样，你自己判断：有的消息开头就写着（比如「[TG GROUP:产品周会]」「howard said」），有的只有编号，要用这个渠道的工具或接口去查。实在查不到就先跳过，最后告诉我。
3. 用 group-name.js set <组键> "名字" 设置。名字要短，让人一眼认出是哪个群、或者和谁的私聊。
4. 已经有名字的组不要动。
5. 做完列出你给每个组起的名字。`;


export async function loadNamePrompt({ request }) {
  return request('/api/workbench/name-prompt');
}

export async function copyNamePrompt(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard?.writeText) throw new Error('clipboard_unavailable');
  await clipboard.writeText(text);
}

export function renderAutoName(root, value, { document = root.ownerDocument, t = key => key,
  clipboard = globalThis.navigator?.clipboard, onClose = () => {} } = {}) {
  root.replaceChildren();
  root.append(element(document, 'h3', t('wb.name.auto')));
  const prompt = element(document, 'textarea'); prompt.value = value.text ?? ''; prompt.readOnly = true;
  prompt.setAttribute('aria-label', t('wb.name.prompt'));
  const todo = element(document, 'ul');
  for (const name of value.todo ?? []) todo.append(element(document, 'li', name));
  const copy = element(document, 'button', t('wb.name.copy')); copy.type = 'button';
  const status = element(document, 'p', '');
  copy.addEventListener('click', async () => {
    try { await copyNamePrompt(value.text ?? '', clipboard); status.textContent = t('wb.name.copied'); }
    catch (error) { status.textContent = error.message; }
  });
  const close = element(document, 'button', t('wb.close')); close.type = 'button'; close.addEventListener('click', onClose);
  root.append(prompt, todo, copy, close, status);
  return { copy, prompt, todo };
}

/** Preserve the supplied prompt verbatim apart from its known CLI path. */
export function namePromptText(scriptPath, template, originalPath) {
  if (typeof template !== 'string' || typeof originalPath !== 'string' || !originalPath || !template.includes(originalPath)) {
    throw new Error('name_prompt_path_missing');
  }
  return template.replace(originalPath, () => scriptPath);
}
