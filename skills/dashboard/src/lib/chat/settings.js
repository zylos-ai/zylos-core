import { mutateConfig } from '../config-mutation.js';
import { readJsonBody, sendJson } from '../http.js';
import { CHAT_SETTINGS_PATH, requireChatSettingsAccess } from './access.js';

export async function handleChatSettings(req, res, url, { auth, config, onChange = () => {} }) {
  if (url.pathname !== CHAT_SETTINGS_PATH) return false;
  const denied = requireChatSettingsAccess(req, auth);
  if (denied) { const { status, ...body } = denied; sendJson(res, status, body); return true; }
  if (req.method === 'GET') {
    sendJson(res, 200, { chat_allow_remote: config.chat?.allowRemote === true });
    return true;
  }
  if (req.method !== 'PUT') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
  try {
    const body = await readJsonBody(req);
    if (!body || typeof body.chat_allow_remote !== 'boolean' || Object.keys(body).some(key => key !== 'chat_allow_remote')) {
      sendJson(res, 400, { error: 'invalid_chat_settings' }); return true;
    }
    const saved = await mutateConfig(config.configPath, existing => {
      existing.chat = { ...(existing.chat || {}), allowRemote: body.chat_allow_remote };
    });
    config.chat = { ...saved.config.chat };
    sendJson(res, 200, { ok: true, chat_allow_remote: config.chat.allowRemote });
    // The switch also governs the terminal observer; listeners close remote access and republish state.
    try { onChange(config.chat); } catch { /* the setting is saved; a failed listener must not undo the reply */ }
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.status ? error.message : 'chat_settings_write_failed' });
  }
  return true;
}
