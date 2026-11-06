// One table shared by auth and proxy contract tests; add a route with its handler.
export const workbenchWriteRoutes = [
  { method: 'PUT', path: '/api/workbench/groups/telegram%3Ateam/name', body: '{"name":"Product sync"}' },
  { method: 'DELETE', path: '/api/workbench/groups/telegram%3Ateam/name', body: null },
];
