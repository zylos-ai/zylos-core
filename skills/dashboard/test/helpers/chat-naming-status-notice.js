import { sendStatusNotice } from '../../../comm-bridge/scripts/status-notice.js';

const result = await sendStatusNotice({ channel: 'dashboard', endpoint: 'one' },
  '[C4] Status: runtime unavailable.', {}, { diagnostic: false });
if (result.outcome !== 'sent') process.exitCode = 1;
