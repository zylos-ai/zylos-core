// One table shared by auth and proxy contract tests; add a route with its handler.
export const workbenchWriteRoutes = [
  { method: 'POST', path: '/api/chat/drafts', body: '{"displayName":"Private chat"}' },
  { method: 'PATCH', path: '/api/chat/conversations/d%3Alocal-chat', body: '{"displayName":"Renamed chat"}' },
  { method: 'POST', path: '/api/chat/conversations/local-chat/send', body: '{"content":"Hello"}' },
  { method: 'POST', path: '/api/chat/conversations/local-chat/answers', body: '{"interruptId":"question","action":{}}' },
  { method: 'POST', path: '/api/chat/conversations/local-chat/controls', body: '{"envelope":{}}' },
  { method: 'PUT', path: '/api/workbench/groups/telegram%3Ateam/name', body: '{"name":"Product sync"}' },
  { method: 'DELETE', path: '/api/workbench/groups/telegram%3Ateam/name', body: null },
  { method: 'POST', path: '/api/workbench/groups/telegram%3Ateam/config', body: '{"kind":"runtime","value":"codex"}' },
  ...['interrupt', 'chop-chop', 'restart'].map(action => ({ method: 'POST',
    path: `/api/workbench/groups/telegram%3Ateam/actions/${action}`,
    body: '{"runId":"private-run","sessionId":"private-session"}' })),
  { method: 'POST', path: '/api/workbench/schedule', body: '{"prompt":"Check","schedule":{"kind":"every","value":"1h"}}' },
  { method: 'PUT', path: '/api/workbench/schedule/task-fixture', body: '{"name":"Renamed"}' },
  { method: 'DELETE', path: '/api/workbench/schedule/task-fixture', body: null },
  { method: 'POST', path: '/api/workbench/schedule/task-fixture/pause', body: null },
  { method: 'POST', path: '/api/workbench/schedule/task-fixture/resume', body: null },
];
