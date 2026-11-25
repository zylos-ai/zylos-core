import { UNSUPPORTED } from '../contract.js';
import { safeBasename, skillNameFromPath } from '../activity-path.js';

export default Object.freeze({
  toolEvents: 'hooks',
  stepLabel(event, { tool, detail }) {
    const skill = tool === 'Read' ? skillNameFromPath(detail)
      : tool === 'Skill' && detail && !detail.includes('/') ? safeBasename(detail) : null;
    if (skill) return { key: 'skill', arg: skill };
    if (['Read', 'Edit', 'Write'].includes(tool)) return detail ? { key: tool.toLowerCase(), arg: detail } : { key: 'tool' };
    if (tool === 'Bash') return detail && event.meta.detail_source === 'description' ? { key: 'described', arg: detail } : { key: 'runCommand' };
    if (tool === 'WebSearch' && detail) return { key: 'search', arg: detail };
    if (tool === 'WebFetch' && detail) return { key: 'open', arg: detail };
    return { key: 'tool' };
  },
  opensStep: UNSUPPORTED,
  subagentLaunchTools: Object.freeze(['Agent', 'Task']),
  resumesCells: false,
});
