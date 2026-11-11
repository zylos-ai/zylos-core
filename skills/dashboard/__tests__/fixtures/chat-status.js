// Shared with conversation views: operation receipts do not override row state.
export const chatStatusCases = [
  { status: 'pending', delivery_action: null, expected: 'pending' },
  { status: 'running', delivery_action: null, expected: 'running' },
  { status: 'delivered', delivery_action: null, expected: 'delivered' },
  { status: 'failed', delivery_action: 'auth_rejected', expected: 'auth_rejected' },
  { status: 'failed', delivery_action: 'suppressed', expected: 'suppressed' },
  { status: 'failed', delivery_action: 'delivered', expected: 'failed' },
  { status: 'switch_absorbed', delivery_action: null, expected: 'switch_absorbed' },
  { status: 'unrecognized', delivery_action: null, expected: 'pending_reconciliation' },
  { status: null, delivery_action: null, expected: 'pending_reconciliation' },
];
