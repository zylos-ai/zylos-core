/** UI state only. The server resolves target ownership and Core owns the deletion. */
export function deletionPath(item) {
  if (item?.id?.startsWith('d:')) return `/api/chat/drafts/${encodeURIComponent(item.id.slice(2))}`;
  const group = item?.sessionGroup ?? item?.session_group;
  return typeof group === 'string' && group && group !== 'origin'
    ? `/api/workbench/groups/${encodeURIComponent(group)}` : null;
}

export function createConversationDeletion({ request, confirm, t = key => key,
  identity = () => 'local', available = () => false, onChange = () => {}, onDeleted = () => {} } = {}) {
  const operations = new Map();
  let generation = 0;
  const currentIdentity = () => typeof identity === 'function' ? identity() : identity;
  const key = item => JSON.stringify([currentIdentity(), item.id]);
  const status = item => operations.get(key(item)) ?? null;
  async function remove(item) {
    const path = deletionPath(item);
    if (!path || !available(item) || status(item)?.busy) return;
    const owner = currentIdentity(), epoch = generation, id = key(item), previous = operations.get(id);
    const valid = () => generation === epoch && currentIdentity() === owner && available(item);
    const update = value => { operations.set(id, value); if (valid()) onChange(); };
    update({ ...previous, busy: true, state: 'preview' });
    try {
      let operationId = previous?.operationId;
      if (!operationId) {
        const preview = await request(`${path}/deletion`);
        if (!valid()) return;
        if (preview.ok === false) throw { payload: preview };
        const draft = preview.draft === true;
        const message = draft ? t('chat.delete.draftConfirm') :
          t('chat.delete.confirm', { messages: preview.messages ?? 0, attachments: preview.attachments ?? 0 });
        if (!(await confirm(message, { ok: t('chat.delete.button'), danger: true })) || !valid()) {
          update({ ...previous, busy: false }); return;
        }
        operationId = preview.operationId;
      }
      if (typeof operationId !== 'string' || !operationId) throw { code: 'invalid_deletion_preview' };
      update({ ...previous, operationId, busy: true, state: 'deleting' });
      const result = await request(path, { method: 'DELETE', body: { confirmed: true, ...(operationId ? { operationId } : {}) } });
      if (!valid()) return;
      if (result.pending === true) {
        update({ busy: false, state: 'pending', operationId: result.operationId ?? operationId });
      } else if (result.ok === false) throw { payload: result };
      else {
        operations.delete(id);
        await onDeleted(item.id, result);
        if (valid()) onChange();
      }
    } catch (error) {
      if (!valid()) return;
      const payload = error.payload;
      update({ busy: false, state: payload?.pending ? 'pending' : 'error',
        operationId: payload?.operationId ?? operations.get(id)?.operationId ?? previous?.operationId });
    } finally {
      const record = operations.get(id);
      if (record?.busy) operations.set(id, { ...record, busy: false, state: 'error' });
    }
  }
  return { remove, status, invalidate() { generation++; } };
}
